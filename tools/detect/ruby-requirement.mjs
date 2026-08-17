// La contrainte de Ruby que Bundler fait RÉELLEMENT respecter, et son
// évaluation contre la version fournie par l'image de base.
//
// Distinction structurante, et source du défaut que ce module corrige : un
// `.ruby-version` seul n'engage PAS Bundler (il ne parle qu'à rbenv, rvm,
// chruby). Seule la directive `ruby` du Gemfile lève un
// `Bundler::RubyVersionMismatch`, et elle prend plusieurs formes :
//
//   ruby "3.3.10"                  égalité stricte  → refuse 3.3.12
//   ruby "~> 3.3.10"               série 3.3 depuis 3.3.10 → accepte 3.3.12
//   ruby "~> 3.3"                  toute la série 3.3      → accepte 3.3.12
//   ruby ">= 3.1", "< 3.5"         intervalle              → accepte 3.3.12
//   ruby file: ".ruby-version"     le fichier devient une égalité stricte
//   (aucune directive)             Bundler n'exige rien
//
// Refuser autre chose que ce qui est réellement incompatible serait pire que
// le défaut d'origine : railsbox rejetterait des applications qui marchent.

/** Opérateurs de contrainte reconnus par Gem::Requirement. */
const OPERATORS = Object.freeze(["~>", ">=", "<=", "!=", "=", ">", "<"]);

// `3.3.10p91`, `ruby-3.3.10`, `~> 3.3` : on ne garde que les composants
// numériques. Vit ici plutôt que dans detect.mjs parce que l'analyse des
// contraintes en dépend et que l'inverse créerait un cycle d'imports.
const RUBY_VERSION = /^(?:ruby-)?v?(\d+(?:\.\d+){0,2})/;

/**
 * Normalise une version de Ruby quelle que soit sa forme d'écriture.
 * @param {string|null|undefined} raw valeur brute (`ruby-3.3.10`, `~> 3.3`, `3.3.10p91`...)
 * @returns {string|null} version canonique `X.Y.Z`, ou `null` si illisible
 */
export function normalizeRubyVersion(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/^[~^>=<\s]+/, "")
    .trim();
  const match = RUBY_VERSION.exec(cleaned);
  return match ? match[1] : null;
}

// Une directive `ruby` occupe toute la ligne ; « ruby » y est suivi d'un blanc
// ou d'une parenthèse, ce qui écarte `ruby_version`, `rubygems` ou un
// `gem "ruby-vips"` (qui, lui, commence par « gem »).
const DIRECTIVE_LINE = /^[ \t]*ruby[ \t(]/;
const QUOTED = /["']([^"']+)["']/g;
const FILE_KEYWORD = /\bfile:\s*["']([^"']+)["']/;
const FILE_READ = /\bFile\.read\(\s*["']([^"']+)["']/;
// Une contrainte commence par un opérateur ou par un chiffre : « .ruby-version »
// et « jruby » n'en sont pas.
const LOOKS_LIKE_REQUIREMENT = /^\s*(?:~>|>=|<=|!=|=|>|<)?\s*\d/;

/**
 * @typedef {object} RubyDirective
 * @property {"inline"|"file"} kind forme de la directive
 * @property {readonly string[]} [requirements] contraintes littérales (forme `inline`)
 * @property {string} [path] fichier lu (forme `file`)
 * @property {string} raw texte de la ligne, pour les messages
 */

/**
 * Retire le commentaire d'une ligne Ruby.
 *
 * Les contraintes de version ne contiennent jamais de « # » : couper au
 * premier dièse hors chaîne suffit, et évite qu'un exemple commenté
 * (`# ruby "3.4.0"`) soit pris pour la directive réelle.
 * @param {string} line ligne brute
 * @returns {string} ligne sans commentaire
 */
export function stripRubyComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

/**
 * Lit la directive `ruby` d'un Gemfile.
 * @param {string|null|undefined} gemfileText contenu du Gemfile
 * @returns {RubyDirective|null} directive trouvée, ou `null` si Bundler n'exige rien
 */
export function parseRubyDirective(gemfileText) {
  if (typeof gemfileText !== "string") return null;
  for (const rawLine of gemfileText.split(/\r?\n/)) {
    const line = stripRubyComment(rawLine);
    if (!DIRECTIVE_LINE.test(line)) continue;
    const fileMatch = FILE_KEYWORD.exec(line) ?? FILE_READ.exec(line);
    if (fileMatch) return { kind: "file", path: fileMatch[1], raw: line.trim() };
    const requirements = [...line.matchAll(QUOTED)]
      .map((match) => match[1].trim())
      .filter((value) => LOOKS_LIKE_REQUIREMENT.test(value));
    if (requirements.length === 0) continue;
    return { kind: "inline", requirements: Object.freeze(requirements), raw: line.trim() };
  }
  return null;
}

/**
 * Résout la directive en contraintes littérales, en lisant le fichier désigné.
 * @param {RubyDirective|null} directive directive issue de {@link parseRubyDirective}
 * @param {string|null} referencedFile contenu du fichier désigné par `file:`
 * @returns {{requirements: readonly string[], source: string}|null} contraintes et provenance
 */
export function resolveRubyRequirement(directive, referencedFile) {
  if (!directive) return null;
  if (directive.kind === "inline") {
    return { requirements: directive.requirements, source: "Gemfile" };
  }
  const raw = typeof referencedFile === "string" ? referencedFile.trim() : "";
  if (raw === "") return null;
  // Bundler lit le fichier et en fait une ÉGALITÉ stricte : `ruby file:` n'est
  // pas plus permissif que `ruby "3.3.10"`, c'est le même refus par un autre
  // chemin. Le préfixe « ruby- » que posent rbenv et consorts est retiré.
  const version = normalizeRubyVersion(raw.split(/\s+/)[0]);
  if (!version) return null;
  return {
    requirements: Object.freeze([version]),
    source: `Gemfile (file: ${directive.path})`,
  };
}

/**
 * Découpe une contrainte en opérateur et version.
 * @param {string} requirement contrainte littérale (« ~> 3.3.10 », « 3.3.10 »)
 * @returns {{operator: string, segments: number[]}|null} contrainte analysée
 */
function parseRequirement(requirement) {
  const trimmed = String(requirement).trim();
  const operator = OPERATORS.find((candidate) => trimmed.startsWith(candidate)) ?? "=";
  const rest = trimmed.startsWith(operator) ? trimmed.slice(operator.length) : trimmed;
  const version = normalizeRubyVersion(rest.trim());
  if (!version) return null;
  return { operator, segments: version.split(".").map((part) => Number(part)) };
}

/**
 * Compare deux listes de segments numériques, en complétant par des zéros.
 * @param {number[]} left segments de gauche
 * @param {number[]} right segments de droite
 * @returns {number} négatif, nul ou positif
 */
function compareSegments(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Borne haute exclusive d'une contrainte pessimiste `~>`.
 * `~> 3.3.10` → `< 3.4`, `~> 3.3` → `< 4.0`, `~> 3` → `< 4`.
 * @param {number[]} segments segments de la contrainte
 * @returns {number[]} segments de la borne
 */
function pessimisticBound(segments) {
  if (segments.length <= 1) return [segments[0] + 1];
  const bound = segments.slice(0, -1);
  bound[bound.length - 1] += 1;
  return bound;
}

/**
 * Indique si une version satisfait une contrainte unique.
 * @param {number[]} version segments de la version candidate
 * @param {{operator: string, segments: number[]}} requirement contrainte analysée
 * @returns {boolean} vrai si la contrainte est satisfaite
 */
function satisfiesOne(version, requirement) {
  const comparison = compareSegments(version, requirement.segments);
  switch (requirement.operator) {
    case "=":
      return comparison === 0;
    case "!=":
      return comparison !== 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "~>":
      return (
        comparison >= 0 && compareSegments(version, pessimisticBound(requirement.segments)) < 0
      );
    default:
      return false;
  }
}

/**
 * Indique si une version de Ruby satisfait TOUTES les contraintes déclarées.
 * @param {string|null|undefined} version version candidate (celle de la base)
 * @param {readonly string[]|null|undefined} requirements contraintes littérales
 * @returns {boolean|null} verdict, ou `null` si rien n'est vérifiable
 */
export function satisfiesRubyRequirement(version, requirements) {
  const normalized = normalizeRubyVersion(version);
  if (!normalized || !Array.isArray(requirements) || requirements.length === 0) return null;
  const segments = normalized.split(".").map((part) => Number(part));
  const parsed = requirements.map(parseRequirement);
  // Une contrainte illisible (« ruby engine », une variable) ne doit pas
  // produire un refus : on préfère laisser passer que bloquer à tort.
  if (parsed.some((requirement) => requirement === null)) return null;
  return parsed.every((requirement) => satisfiesOne(segments, requirement));
}
