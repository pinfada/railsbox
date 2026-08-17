// Quels répertoires produits par l'étage amd64 doivent redescendre dans le
// disque applicatif i386 ?
//
// La question n'était pas posée : l'étage n'exportait que `public/assets` et
// `app/assets/builds`. C'est le compte exact pour sprockets/propshaft et pour
// `jsbundling-rails`, qui écrit dans `app/assets/builds` — et pour personne
// d'autre. `vite_rails` écrit dans `public/vite`, Shakapacker dans
// `public/packs`, un `vite build` nu dans ce que dit sa configuration. Ces
// bundles partaient donc à la poubelle SANS que rien n'échoue : la
// construction réussissait, la sandbox bootait, et le SPA manquait à
// l'affichage. C'est la pire forme de panne — celle qui ne se signale pas.
//
// Ce module est pur : il ne lit aucun fichier, il classe et il valide.
//
// SÉCURITÉ : les valeurs traitées ici viennent d'un dépôt TIERS (railsbox.yml,
// config/vite.json, config/shakapacker.yml) et finissent dans une boucle shell
// de l'étage amd64, puis dans un chemin de copie. C'est une FRONTIÈRE :
// `normalizeOutputDir` n'accepte qu'un chemin relatif, sans segment `..`, sans
// caractère qui puisse être interprété par un shell (espace, `$`, `;`, `*`,
// guillemet, barre oblique inverse). Tout le reste est rejeté avec un
// diagnostic — jamais assaini en silence.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Répertoires TOUJOURS exportés de l'étage amd64 vers le disque applicatif.
 * `public/assets` est la sortie de `assets:precompile` ; `app/assets/builds`
 * celle de jsbundling/cssbundling, relue ensuite par le pipeline.
 */
export const DEFAULT_OUTPUT_DIRS = Object.freeze(["public/assets", "app/assets/builds"]);

/** Longueur maximale d'un chemin déclaré (borne de sûreté, pas une limite utile). */
const MAX_PATH_LENGTH = 128;

/** Nombre maximal de segments d'un chemin déclaré. */
const MAX_SEGMENTS = 6;

/** Un segment de chemin acceptable : ni `.` ni `..`, aucun métacaractère shell. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Sortie par défaut de vite_ruby, relative au répertoire public. */
const VITE_DEFAULT_OUTPUT = "vite";

/** Répertoire public par défaut de vite_ruby et de Shakapacker. */
const PUBLIC_DEFAULT = "public";

/**
 * Gems dont la sortie de build échappe aux deux répertoires par défaut, et
 * répertoire qu'elles écrivent quand rien ne les reconfigure.
 */
const BUNDLER_GEMS = Object.freeze({
  vite_rails: `${PUBLIC_DEFAULT}/${VITE_DEFAULT_OUTPUT}`,
  vite_ruby: `${PUBLIC_DEFAULT}/${VITE_DEFAULT_OUTPUT}`,
  shakapacker: `${PUBLIC_DEFAULT}/packs`,
  webpacker: `${PUBLIC_DEFAULT}/packs`,
});

// `public_output_path: packs` / `public_root_path: public` où qu'ils soient
// dans le fichier. Shakapacker s'écrit avec des ancres YAML (`<<: *default`)
// et plusieurs environnements : un analyseur de sous-ensemble ne le lirait pas.
// On relève donc TOUTES les valeurs déclarées et on les exporte toutes — un
// répertoire absent au moment de la copie ne coûte rien, un bundle perdu si.
const SHAKAPACKER_OUTPUT = /^[ \t]*public_output_path:[ \t]*(\S+)[ \t]*$/gm;
const SHAKAPACKER_ROOT = /^[ \t]*public_root_path:[ \t]*(\S+)[ \t]*$/gm;

/**
 * Valide un répertoire de sortie déclaré par un dépôt tiers.
 *
 * Rendre `null` est la seule issue en cas de doute : le chemin part dans une
 * commande de construction, il n'y a pas de « presque acceptable ».
 * @param {*} value valeur brute (chaîne attendue)
 * @returns {string|null} chemin relatif normalisé, ou `null` s'il est refusé
 */
export function normalizeOutputDir(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed.length > MAX_PATH_LENGTH) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  // Un chemin Windows (`C:\...`, `dossier\sous`) n'a aucun sens dans l'étage
  // Linux et masquerait un `\` interprétable : refusé sans discussion.
  if (trimmed.includes("\\") || /^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split("/");
  if (segments.length > MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
    if (!SEGMENT.test(segment)) return null;
  }
  return trimmed;
}

/**
 * Assainit une liste de répertoires déclarés, en séparant retenus et refusés.
 * @param {readonly *[]} values valeurs brutes
 * @returns {{dirs: string[], rejected: string[]}} chemins retenus et refusés
 */
export function sanitizeOutputDirs(values) {
  /** @type {string[]} */
  const dirs = [];
  /** @type {string[]} */
  const rejected = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeOutputDir(value);
    if (normalized === null) rejected.push(String(value).slice(0, MAX_PATH_LENGTH));
    else if (!dirs.includes(normalized)) dirs.push(normalized);
  }
  return { dirs, rejected };
}

/**
 * Fusionne plusieurs listes de répertoires en conservant l'ordre et en
 * écartant les doublons, ainsi que les chemins déjà couverts par un ancêtre
 * (`public/vite/assets` sous `public/vite` n'apporte rien).
 * @param {...readonly string[]} lists listes à fusionner
 * @returns {string[]} liste ordonnée, sans doublon ni redondance
 */
export function mergeOutputDirs(...lists) {
  /** @type {string[]} */
  const merged = [];
  for (const list of lists) {
    for (const dir of list ?? []) {
      if (typeof dir !== "string" || dir === "") continue;
      if (merged.some((kept) => kept === dir || dir.startsWith(`${kept}/`))) continue;
      merged.push(dir);
    }
  }
  return merged;
}

/**
 * Sortie déclarée par `config/vite.json` (vite_ruby / vite_rails).
 *
 * Le fichier porte des sections par environnement (`all`, `development`,
 * `production`, `test`) : on relève chacune, parce qu'un dépôt qui déclare une
 * sortie de production différente de sa sortie par défaut la mettrait sinon
 * hors d'atteinte.
 * @param {string|null} text contenu de config/vite.json, `null` s'il est absent
 * @returns {string[]} chemins relatifs à la racine de l'application
 */
export function viteOutputDirs(text) {
  if (typeof text !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const sections = [parsed, parsed.all, parsed.production, parsed.development, parsed.test];
  /** @type {string[]} */
  const dirs = [];
  for (const section of sections) {
    if (section === null || typeof section !== "object" || Array.isArray(section)) continue;
    const publicDir = pickString(section.publicDir) ?? PUBLIC_DEFAULT;
    const output = pickString(section.publicOutputDir) ?? VITE_DEFAULT_OUTPUT;
    dirs.push(`${publicDir}/${output}`);
  }
  return dirs;
}

/**
 * Sortie déclarée par `config/shakapacker.yml` (ou `config/webpacker.yml`).
 * @param {string|null} text contenu du fichier, `null` s'il est absent
 * @returns {string[]} chemins relatifs à la racine de l'application
 */
export function shakapackerOutputDirs(text) {
  if (typeof text !== "string") return [];
  const roots = [...text.matchAll(SHAKAPACKER_ROOT)].map((match) => match[1]);
  const outputs = [...text.matchAll(SHAKAPACKER_OUTPUT)].map((match) => match[1]);
  if (outputs.length === 0) return [];
  const bases = roots.length > 0 ? roots : [PUBLIC_DEFAULT];
  /** @type {string[]} */
  const dirs = [];
  for (const base of bases) {
    for (const output of outputs) dirs.push(`${stripQuotes(base)}/${stripQuotes(output)}`);
  }
  return dirs;
}

/**
 * Déduit les répertoires de sortie supplémentaires d'une application.
 *
 * L'auto-détection doit couvrir le cas courant SANS que le mainteneur écrive
 * quoi que ce soit : `assets.output` n'est là que pour les chaînes que
 * personne ne peut deviner (un `vite build` nu, un script maison).
 * @param {{specs?: Map<string, string>, viteJson?: string|null, shakapackerYml?: string|null, webpackerYml?: string|null}} sources
 * @returns {{dirs: string[], findings: Finding[]}} répertoires détectés et diagnostics
 */
export function detectOutputDirs({ specs, viteJson, shakapackerYml, webpackerYml } = {}) {
  const resolved = specs instanceof Map ? specs : new Map();
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const candidates = [];
  /** @type {string[]} */
  const reasons = [];

  const configured = [
    ...viteOutputDirs(viteJson ?? null),
    ...shakapackerOutputDirs(shakapackerYml ?? null),
    ...shakapackerOutputDirs(webpackerYml ?? null),
  ];
  const clean = sanitizeOutputDirs(configured);
  candidates.push(...clean.dirs);
  if (clean.rejected.length > 0) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "invalid-asset-output",
        `Répertoire de sortie refusé (${clean.rejected.join(", ")}) : ` +
          "un chemin relatif à la racine de l'application est attendu.",
        { rejected: clean.rejected },
      ),
    );
  }

  for (const [gem, fallback] of Object.entries(BUNDLER_GEMS)) {
    if (!resolved.has(gem)) continue;
    reasons.push(gem);
    // Défaut de la gem : n'ajoute rien quand la configuration l'a déjà donné.
    candidates.push(fallback);
  }

  const dirs = mergeOutputDirs(candidates).filter(
    (dir) => !DEFAULT_OUTPUT_DIRS.some((base) => dir === base || dir.startsWith(`${base}/`)),
  );
  if (dirs.length > 0) {
    findings.push(
      createFinding(
        SEVERITY.INFO,
        "assets-output-detected",
        `Répertoires de sortie supplémentaires exportés vers le disque : ${dirs.join(", ")}` +
          `${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}.`,
        { dirs, gems: reasons },
      ),
    );
  }
  return { dirs, findings };
}

/**
 * Première chaîne non vide d'une valeur JSON, `null` sinon.
 * @param {*} value valeur lue dans la configuration
 * @returns {string|null} chaîne nettoyée
 */
function pickString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Retire les guillemets YAML entourant une valeur scalaire.
 * @param {string} value valeur brute
 * @returns {string} valeur sans guillemets
 */
function stripQuotes(value) {
  return String(value).replace(/^["']|["']$/g, "");
}
