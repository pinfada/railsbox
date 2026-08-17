// Lecture de `railsbox.yml` : le fichier par lequel un projet corrige ou
// complète l'auto-détection. On analyse un sous-ensemble strict de YAML à la
// main — le projet s'interdit toute dépendance runtime, et le schéma est assez
// petit pour que l'analyseur reste plus court qu'une bibliothèque.
import { sanitizeOutputDirs } from "./asset-output.mjs";
import { SEVERITY, createFinding } from "./findings.mjs";
import { sqliteDriverFindings } from "./sqlite.mjs";
import { KEEP_FORCE_SSL_VALUE, KEEP_FORCE_SSL_VARIABLE } from "./ssl.mjs";
import { validateSystemPackages } from "./paquets-systeme.mjs";
import { normalizeScripts, normalizeText, parseScalar, stripComment } from "./yaml-subset.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */
/** @typedef {import("./gems.mjs").NativeGem} NativeGem */

/**
 * Manifeste de build. Toutes les clés sont optionnelles : le manifeste déclaré
 * ne renseigne qu'une partie de ce que la détection produit.
 * @typedef {object} Manifest
 * @property {string|null} [ruby] version de Ruby retenue (série, étage amd64)
 * @property {string|null} [rubySource] fichier ayant fourni la version
 * @property {string|null} [base] version de l'image de base visée
 * @property {string|null} [baseRuby] Ruby réellement fourni par cette base
 * @property {{requirements: readonly string[], source: string}|null} [rubyRequirement] contrainte du Gemfile
 * @property {{forceSsl: string|null, forceSslEnv: string|null, assumeSsl: string|null, enforced: boolean}} [ssl] réglages SSL de production
 * @property {string|null} [rails] version de Rails résolue
 * @property {string|null} [database] adaptateur de base de données
 * @property {string} [databasePrepare] préparation de la base (schema ou migrate)
 * @property {readonly string[]} [dataMigrations] migrations qui écrivent des lignes
 * @property {readonly string[]} [databaseAdapters] adaptateurs vus dans config/database.yml
 * @property {import("./sqlite.mjs").SqliteDriverState} [sqliteDriver] disponibilité du pilote sqlite3
 * @property {string|null} [bundler] version de Bundler ayant produit le lock
 * @property {{npm?: boolean, scripts?: readonly string[], tools?: readonly string[], stage?: string, binaryGems?: readonly string[], install?: string, output?: readonly string[]}} [assets] pipeline d'assets, étage de précompilation et répertoires exportés
 * @property {readonly NativeGem[]} [nativeGems] gems à extension native
 * @property {{redis?: boolean, sidekiq?: boolean}} [services] services d'arrière-plan
 * @property {{command?: string, autoLogin?: string, autoLoginCode?: string}} [seed] amorçage des données
 * @property {Record<string, string>} [env] variables d'environnement déclarées
 * @property {readonly string[]} [systemPackages] paquets Debian de la surcouche applicative
 */

/**
 * État mutable de l'analyse d'un fichier `railsbox.yml`.
 * @typedef {{manifest: Manifest, findings: Finding[], block: string|null}} ParseState
 */

/** Indentation unique acceptée pour le niveau imbriqué. */
const NEST_INDENT = 2;

/** Blocs imbriqués reconnus, avec la correspondance clé YAML → clé manifeste. */
const NESTED_KEYS = Object.freeze({
  seed: Object.freeze({
    command: "command",
    auto_login: "autoLogin",
    auto_login_code: "autoLoginCode",
  }),
  assets: Object.freeze({ scripts: "scripts", output: "output" }),
});

/** Valeurs acceptées pour `database:`. */
const DATABASE_VALUES = Object.freeze(["postgresql", "sqlite3"]);

/**
 * Valeurs acceptées pour `database_prepare:` — COMMENT la base est préparée,
 * quand `database:` dit seulement AVEC QUOI.
 *
 * - `schema` (défaut) : `db:prepare`, donc chargement de db/schema.rb. Rapide,
 *   insensible aux vieilles migrations qui ne tournent plus, et fidèle à ce que
 *   fait Rails lui-même sur une base neuve.
 * - `migrate` : `db:create db:migrate`, tout l'historique rejoué. ÉCHAPPATOIRE
 *   explicite pour qui ne peut pas corriger son application tout de suite ; ne
 *   la corrige pas ailleurs, et coûte le rejeu complet à chaque construction.
 *
 * Aucune valeur « auto » : la bascule automatique a été écartée délibérément
 * (voir le diagnostic data-bearing-migration) — railsbox signale un défaut
 * applicatif, il ne le masque pas.
 */
export const DATABASE_PREPARE_VALUES = Object.freeze(["schema", "migrate"]);

/** Clés scalaires de premier niveau. */
const SCALAR_KEYS = Object.freeze(["ruby", "database", "database_prepare"]);

/** Correspondance clé YAML → clé du manifeste, pour les scalaires renommés. */
const SCALAR_TARGETS = Object.freeze({ database_prepare: "databasePrepare" });

/**
 * Clés de premier niveau portant une LISTE (`clé: [a, b]` ou `clé: a`).
 * `system_packages` déclare les paquets Debian de la surcouche applicative
 * (ADR 0006) : ceux que l'application veut sans que la base mutualisée ait à
 * les porter pour tout le monde.
 */
const LIST_KEYS = Object.freeze(["system_packages"]);

/** Correspondance clé YAML → clé du manifeste, pour les listes. */
const LIST_TARGETS = Object.freeze({ system_packages: "systemPackages" });

/** Nom de variable d'environnement conforme à POSIX, longueur bornée. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const ENTRY = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
const RUBY_VALUE = /^[0-9A-Za-z.\-+]+$/;

/** Sentinelle : bloc ouvert par une clé inconnue, dont on ignore le contenu. */
const UNKNOWN_BLOCK = "\u0000unknown";

/**
 * Gèle récursivement une valeur (le manifeste ne doit jamais muter après coup).
 * @param {*} value valeur à geler
 * @returns {*} la même valeur, gelée en profondeur
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Analyse le sous-ensemble YAML de `railsbox.yml`.
 * Aucune entrée malformée n'interrompt l'analyse : tout devient un diagnostic.
 * @param {string} text contenu du fichier
 * @returns {{manifest: Manifest, findings: readonly Finding[]}} manifeste déclaré et diagnostics
 * @throws {TypeError} si `text` n'est pas une chaîne
 */
export function parseRailsboxYml(text) {
  if (typeof text !== "string") {
    throw new TypeError("parseRailsboxYml attend le contenu texte de railsbox.yml");
  }
  /** @type {ParseState} */
  const state = { manifest: {}, findings: [], block: null };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    // handleLine rend le nombre de lignes SUPPLÉMENTAIRES qu'il a absorbées :
    // un scalaire en bloc (`clé: |`) s'étend sur les lignes suivantes.
    index += handleLine(state, lines[index], index + 1, lines, index);
  }
  return { manifest: deepFreeze(state.manifest), findings: Object.freeze(state.findings) };
}

/**
 * Traite une ligne du fichier et met à jour l'état d'analyse.
 * @param {ParseState} state état mutable de l'analyse
 * @param {string} rawLine ligne brute
 * @param {number} lineNumber numéro de ligne, pour les diagnostics
 * @param {string[]} [lines] toutes les lignes, pour les scalaires en bloc
 * @param {number} [index] position de cette ligne dans `lines`
 * @returns {number} lignes supplémentaires absorbées (0 hors scalaire en bloc)
 */
function handleLine(state, rawLine, lineNumber, lines = [], index = 0) {
  const line = stripComment(rawLine);
  if (line.trim() === "") return 0;
  const indent = line.length - line.trimStart().length;
  if (indent !== 0 && indent !== NEST_INDENT) {
    pushMalformed(state, lineNumber, "indentation non supportée (0 ou 2 espaces attendus)");
    return 0;
  }
  const entry = ENTRY.exec(line.trim());
  if (!entry) {
    pushMalformed(state, lineNumber, "format « clé: valeur » attendu");
    return 0;
  }
  const key = entry[1];

  // Scalaire en bloc littéral : `clé: |` (ou `|-`). Le contenu est pris
  // VERBATIM sur les lignes plus indentées qui suivent — sans retrait des
  // commentaires, puisqu'un « # » y est du texte et non un commentaire YAML.
  // Indispensable à `auto_login_code`, qui porte du Ruby multiligne.
  const blockMarker = /^\|([-+]?)$/.exec(entry[2].trim());
  if (blockMarker) {
    const { value, consumed } = readBlockScalar(lines, index, indent, blockMarker[1]);
    if (indent === 0) applyTopLevel(state, key, value, lineNumber);
    else applyNested(state, key, value, lineNumber);
    return consumed;
  }

  const value = parseScalar(entry[2]);
  if (indent === 0) {
    applyTopLevel(state, key, value, lineNumber);
    return 0;
  }
  applyNested(state, key, value, lineNumber);
  return 0;
}

/**
 * Lit le contenu d'un scalaire en bloc littéral.
 *
 * Les lignes retenues sont celles, vides ou plus indentées que la clé, qui
 * suivent immédiatement. Le retrait commun est ôté — c'est ce qui permet
 * d'écrire du Ruby lisible dans le YAML sans qu'il hérite de son indentation.
 * @param {string[]} lines toutes les lignes du document
 * @param {number} keyIndex position de la ligne portant la clé
 * @param {number} keyIndent indentation de cette clé
 * @param {string} chomping indicateur YAML : « - » retire le saut final
 * @returns {{ value: string, consumed: number }}
 */
function readBlockScalar(lines, keyIndex, keyIndent, chomping) {
  const collected = [];
  let cursor = keyIndex + 1;
  for (; cursor < lines.length; cursor += 1) {
    const candidate = lines[cursor];
    if (candidate.trim() === "") {
      collected.push("");
      continue;
    }
    const candidateIndent = candidate.length - candidate.trimStart().length;
    if (candidateIndent <= keyIndent) break;
    collected.push(candidate);
  }
  // Les lignes vides finales appartiennent au document, pas au bloc.
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();

  const indents = collected
    .filter((entry) => entry.trim() !== "")
    .map((entry) => entry.length - entry.trimStart().length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  const body = collected.map((entry) => entry.slice(common)).join("\n");
  return {
    value: chomping === "-" || body === "" ? body : `${body}\n`,
    consumed: collected.length,
  };
}

/**
 * Applique une entrée de premier niveau.
 * @param {ParseState} state état mutable de l'analyse
 * @param {string} key clé YAML
 * @param {*} value valeur analysée
 * @param {number} lineNumber numéro de ligne
 * @returns {void}
 */
function applyTopLevel(state, key, value, lineNumber) {
  state.block = null;
  if (key === "env" || key in NESTED_KEYS) {
    if (value !== "") {
      pushInvalidValue(state, key, lineNumber, "un bloc imbriqué est attendu, pas une valeur");
      state.block = UNKNOWN_BLOCK;
      return;
    }
    state.block = key;
    return;
  }
  if (LIST_KEYS.includes(key)) {
    const liste = normalizeScripts(value);
    if (liste === null) {
      pushInvalidValue(
        state,
        key,
        lineNumber,
        "liste attendue (ex. [libmagic-dev, libsodium-dev])",
      );
      return;
    }
    // Validation ICI, au plus près de la lecture du fichier tiers : ces noms
    // finiront en arguments d'apt-get sur un runner de CI (ADR 0006).
    const { packages, findings } = validateSystemPackages(
      liste,
      `railsbox.yml ligne ${lineNumber}`,
    );
    state.findings.push(...findings);
    state.manifest[LIST_TARGETS[key]] = packages;
    return;
  }
  if (!SCALAR_KEYS.includes(key)) {
    state.block = UNKNOWN_BLOCK;
    state.findings.push(
      createFinding(SEVERITY.WARNING, "unknown-manifest-key", `Clé « ${key} » inconnue, ignorée.`, {
        key,
        line: lineNumber,
      }),
    );
    return;
  }
  if (key === "ruby") {
    if (typeof value !== "string" || !RUBY_VALUE.test(value)) {
      pushInvalidValue(state, "ruby", lineNumber, "version Ruby attendue (ex. 3.3.10)");
      return;
    }
    state.manifest.ruby = value;
    return;
  }
  if (key === "database_prepare") {
    if (typeof value !== "string" || !DATABASE_PREPARE_VALUES.includes(value)) {
      pushInvalidValue(
        state,
        "database_prepare",
        lineNumber,
        `valeurs admises : ${DATABASE_PREPARE_VALUES.join(", ")}`,
      );
      return;
    }
    state.manifest.databasePrepare = value;
    return;
  }
  if (typeof value !== "string" || !DATABASE_VALUES.includes(value)) {
    pushInvalidValue(
      state,
      "database",
      lineNumber,
      `valeurs admises : ${DATABASE_VALUES.join(", ")}`,
    );
    return;
  }
  state.manifest.database = value;
}

/**
 * Applique une entrée imbriquée au bloc courant.
 * @param {ParseState} state état mutable de l'analyse
 * @param {string} key clé YAML
 * @param {*} value valeur analysée
 * @param {number} lineNumber numéro de ligne
 * @returns {void}
 */
function applyNested(state, key, value, lineNumber) {
  if (state.block === UNKNOWN_BLOCK) return;
  if (state.block === null) {
    pushMalformed(state, lineNumber, "ligne indentée sans bloc parent");
    return;
  }
  if (state.block === "env") {
    applyEnvEntry(state, key, value, lineNumber);
    return;
  }
  const path = `${state.block}.${key}`;
  const target = NESTED_KEYS[state.block][key];
  if (!target) {
    state.findings.push(
      createFinding(
        SEVERITY.WARNING,
        "unknown-manifest-key",
        `Clé « ${path} » inconnue, ignorée.`,
        {
          key: path,
          line: lineNumber,
        },
      ),
    );
    return;
  }
  const normalized =
    state.block === "assets"
      ? normalizeAssetsValue(state, key, value, path, lineNumber)
      : normalizeText(value);
  if (normalized === null) {
    if (state.block !== "assets")
      pushInvalidValue(state, path, lineNumber, "valeur texte attendue");
    return;
  }
  if (!state.manifest[state.block]) state.manifest[state.block] = {};
  state.manifest[state.block][target] = normalized;
}

/**
 * Normalise une valeur du bloc `assets:`.
 *
 * SÉCURITÉ : `output` est une FRONTIÈRE. Ses valeurs viennent d'un dépôt tiers
 * et finissent dans une boucle shell de l'étage amd64 puis dans un chemin de
 * copie. Tout ce qui sortirait de l'arbre applicatif (`../`, chemin absolu) ou
 * porterait un caractère interprétable par un shell est REFUSÉ ici, avec un
 * diagnostic nommant l'entrée fautive — jamais assaini en silence.
 * @param {ParseState} state état mutable de l'analyse
 * @param {string} key clé YAML du bloc assets
 * @param {*} value valeur analysée
 * @param {string} path chemin complet de la clé, pour les diagnostics
 * @param {number} lineNumber numéro de ligne
 * @returns {string[]|null} liste normalisée, ou `null` si rien n'est exploitable
 */
function normalizeAssetsValue(state, key, value, path, lineNumber) {
  const list = normalizeScripts(value);
  if (list === null) {
    pushInvalidValue(state, path, lineNumber, "valeur texte attendue");
    return null;
  }
  if (key !== "output") return list;
  const { dirs, rejected } = sanitizeOutputDirs(list);
  for (const entry of rejected) {
    state.findings.push(
      createFinding(
        SEVERITY.WARNING,
        "invalid-asset-output",
        `railsbox.yml ligne ${lineNumber} : répertoire de sortie « ${entry} » refusé ` +
          "(chemin relatif à la racine de l'application attendu, sans « .. »).",
        { key: path, line: lineNumber, value: entry },
      ),
    );
  }
  return dirs.length > 0 ? dirs : null;
}

/**
 * Applique une entrée du bloc `env:` après validation du nom de variable.
 * @param {ParseState} state état mutable de l'analyse
 * @param {string} key nom de variable
 * @param {*} value valeur analysée
 * @param {number} lineNumber numéro de ligne
 * @returns {void}
 */
function applyEnvEntry(state, key, value, lineNumber) {
  if (!ENV_NAME.test(key)) {
    state.findings.push(
      createFinding(
        SEVERITY.WARNING,
        "invalid-env-name",
        `Nom de variable « ${key} » invalide, entrée ignorée.`,
        { key, line: lineNumber },
      ),
    );
    return;
  }
  if (Array.isArray(value)) {
    pushInvalidValue(state, `env.${key}`, lineNumber, "valeur texte attendue");
    return;
  }
  if (!state.manifest.env) state.manifest.env = {};
  state.manifest.env[key] = String(value);
}

/**
 * Fusionne le manifeste déclaré dans le manifeste détecté (le déclaré gagne).
 * @param {Manifest} detected manifeste issu de l'auto-détection
 * @param {Manifest} declared manifeste issu de `railsbox.yml`
 * @returns {{manifest: Manifest, findings: readonly Finding[]}} manifeste gelé et diagnostics
 * @throws {TypeError} si l'un des arguments n'est pas un objet
 */
export function mergeManifest(detected, declared) {
  if (!isObject(detected) || !isObject(declared)) {
    throw new TypeError("mergeManifest attend deux manifestes sous forme d'objets");
  }
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Manifest} */
  const merged = { ...detected };
  for (const key of SCALAR_KEYS) {
    // La clé YAML sert au message (c'est ce que le mainteneur a écrit), la clé
    // du manifeste au transport : `database_prepare` → `databasePrepare`.
    const target = SCALAR_TARGETS[key] ?? key;
    if (declared[target] === undefined) continue;
    recordOverride(findings, key, detected[target], declared[target]);
    merged[target] = declared[target];
  }
  findings.push(...describeDatabasePrepare(detected, declared.databasePrepare));
  // La provenance doit suivre la valeur, sinon le rapport ment sur sa source.
  if (declared.ruby !== undefined) {
    merged.rubySource = "railsbox.yml";
    findings.push(...describeRubyKey(detected, declared.ruby));
  }
  for (const block of ["seed", "env"]) {
    if (!isObject(declared[block])) continue;
    const base = isObject(detected[block]) ? detected[block] : {};
    for (const [key, value] of Object.entries(declared[block])) {
      recordOverride(findings, `${block}.${key}`, base[key], value);
    }
    merged[block] = { ...base, ...declared[block] };
  }
  // `database:` change la base retenue : la disponibilité du pilote doit être
  // rejugée avec la NOUVELLE valeur. Sans cela, « database: sqlite3 » sur une
  // application dont la gem sqlite3 vit dans `group :development` passait
  // l'analyse et échouait dans la VM sur un LoadError.
  if (declared.database !== undefined && declared.database !== detected.database) {
    findings.push(
      ...sqliteDriverFindings({
        state: detected.sqliteDriver,
        database: merged.database,
        adapters: detected.databaseAdapters ?? [],
      }),
    );
  }
  // La parade de railsbox est désarmée par une variable du bloc `env:`. Le
  // dire ici, et pas seulement dans la documentation : une application en
  // force_ssl dont la neutralisation est désarmée répond 301 en boucle, panne
  // parfaitement opaque depuis un navigateur.
  if (detected.ssl?.enforced && merged.env?.[KEEP_FORCE_SSL_VARIABLE] === KEEP_FORCE_SSL_VALUE) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "force-ssl-kept",
        `${KEEP_FORCE_SSL_VARIABLE}=${KEEP_FORCE_SSL_VALUE} désarme la neutralisation de ` +
          "config.force_ssl : l'application redirigera en 301 vers https, que le pont série " +
          "ne sert pas.",
        { variable: KEEP_FORCE_SSL_VARIABLE },
      ),
    );
  }
  // Les paquets système s'AJOUTENT au lieu de remplacer : la détection les
  // déduit des gems natives, la déclaration couvre ce qu'aucune gem ne trahit
  // (un exécutable appelé en `system()`, par exemple). Écraser l'un par l'autre
  // ferait perdre la moitié de l'information.
  if (Array.isArray(declared.systemPackages)) {
    const base = Array.isArray(detected.systemPackages) ? detected.systemPackages : [];
    merged.systemPackages = [...new Set([...base, ...declared.systemPackages])].sort();
  }
  if (isObject(declared.assets)) {
    const base = isObject(detected.assets) ? detected.assets : {};
    /** @type {Record<string, *>} */
    const assets = { ...base };
    if (Array.isArray(declared.assets.scripts)) {
      // Une liste détectée vide n'est pas une valeur remplacée mais une absence.
      const previous = base.scripts?.length ? base.scripts.join(", ") : undefined;
      recordOverride(findings, "assets.scripts", previous, declared.assets.scripts.join(", "));
      assets.scripts = [...declared.assets.scripts];
    }
    // `output` COMPLÈTE la détection au lieu de la remplacer : le mainteneur
    // ajoute ce que railsbox ne sait pas deviner, il ne retire jamais la sortie
    // de assets:precompile — la lui laisser retirer rendrait la sandbox muette.
    if (Array.isArray(declared.assets.output)) {
      assets.output = [...(base.output ?? []), ...declared.assets.output];
    }
    if (Object.keys(assets).length > 0) merged.assets = assets;
  }
  return { manifest: deepFreeze(merged), findings: Object.freeze(findings) };
}

/**
 * Dit ce que coûte l'échappatoire `database_prepare: migrate`.
 *
 * Elle est légitime — un mainteneur ne peut pas toujours corriger son
 * application avant de la montrer — mais elle ne doit pas passer pour un
 * correctif : elle ne répare que la sandbox, l'application reste cassée sur
 * toute autre base recréée depuis le schéma, et le rejeu complet de
 * l'historique est plus lent et peut trébucher sur une migration ancienne.
 * @param {Manifest} detected manifeste détecté (porte les migrations relevées)
 * @param {string|undefined} declared valeur déclarée dans railsbox.yml
 * @returns {Finding[]} diagnostics
 */
function describeDatabasePrepare(detected, declared) {
  if (declared !== "migrate") return [];
  const migrations = detected.dataMigrations ?? [];
  const constat =
    migrations.length > 0
      ? `les données de ${migrations.join(", ")} seront bien insérées dans la sandbox, mais ` +
        "l'application reste cassée partout où sa base est recréée depuis db/schema.rb " +
        "(rails db:setup, base de CI, review app)"
      : "aucune migration porteuse de données n'a pourtant été relevée : la clé ne fait " +
        "que ralentir la construction";
  return [
    createFinding(
      SEVERITY.WARNING,
      "database-prepare-migrate",
      "database_prepare: migrate rejoue TOUT l'historique des migrations à chaque " +
        `construction (db:create db:migrate au lieu de db:prepare) : ${constat}.`,
      { files: migrations },
    ),
  ];
}

/**
 * Explique ce que la clé `ruby:` de railsbox.yml pilote réellement.
 *
 * Elle laisse croire qu'on choisit la version de Ruby : c'est faux. Le Ruby du
 * guest est compilé dans l'image de base mutualisée et immuable (ADR 0004).
 * La clé ne désigne que la SÉRIE — donc quelle base sera prise — et l'image
 * `ruby:X.Y.Z-slim` de l'étage amd64 de précompilation des assets. Un
 * mainteneur qui y écrit `3.3.10` en croyant contraindre le guest doit le lire
 * ici plutôt que le découvrir dans un `bundle install` en échec.
 * @param {Manifest} detected manifeste détecté (porte la base et son Ruby)
 * @param {string} declared valeur déclarée dans railsbox.yml
 * @returns {Finding[]} diagnostics
 */
function describeRubyKey(detected, declared) {
  const baseRuby = detected.baseRuby ?? null;
  const base = detected.base ?? null;
  if (!baseRuby || !base) return [];
  const declaredSeries = String(declared).split(".").slice(0, 2).join(".");
  const baseSeries = baseRuby.split(".").slice(0, 2).join(".");
  if (declaredSeries !== baseSeries) {
    return [
      createFinding(
        SEVERITY.WARNING,
        "ruby-key-series-mismatch",
        `railsbox.yml demande Ruby ${declared} (série ${declaredSeries}) alors que la base ` +
          `${base} fournit ${baseRuby} : la clé ruby: ne change pas l'interpréteur du guest.`,
        { declared, provided: baseRuby, base },
      ),
    ];
  }
  if (declared === baseRuby) return [];
  return [
    createFinding(
      SEVERITY.INFO,
      "ruby-key-series-only",
      `railsbox.yml demande Ruby ${declared} : la clé ne choisit que la SÉRIE (${baseSeries}) ` +
        `et l'image de l'étage amd64 ; le guest exécutera ${baseRuby}, celui de la base ${base}.`,
      { declared, provided: baseRuby, base },
    ),
  ];
}

/**
 * Enregistre un remplacement de valeur détectée par une valeur déclarée.
 * @param {Finding[]} findings liste de diagnostics à compléter
 * @param {string} key chemin de la clé concernée
 * @param {*} previous valeur détectée
 * @param {*} next valeur déclarée
 * @returns {void}
 */
function recordOverride(findings, key, previous, next) {
  // Rien à signaler quand la détection n'avait rien trouvé : ce n'est pas un
  // remplacement mais un simple complément.
  if (previous === undefined || previous === null || previous === next) return;
  findings.push(
    createFinding(
      SEVERITY.INFO,
      "manifest-override",
      `railsbox.yml remplace « ${key} » : ${previous} → ${next}.`,
      { key },
    ),
  );
}

/**
 * Teste si une valeur est un objet simple exploitable comme manifeste.
 * @param {*} value valeur à tester
 * @returns {boolean} vrai pour un objet non nul et non tableau
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ajoute un diagnostic de ligne malformée.
 * @param {ParseState} state état mutable de l'analyse
 * @param {number} lineNumber numéro de ligne
 * @param {string} reason explication française
 * @returns {void}
 */
function pushMalformed(state, lineNumber, reason) {
  state.findings.push(
    createFinding(
      SEVERITY.WARNING,
      "malformed-manifest-line",
      `railsbox.yml ligne ${lineNumber} : ${reason}.`,
      { line: lineNumber },
    ),
  );
}

/**
 * Ajoute un diagnostic de valeur invalide.
 * @param {ParseState} state état mutable de l'analyse
 * @param {string} key chemin de la clé concernée
 * @param {number} lineNumber numéro de ligne
 * @param {string} reason explication française
 * @returns {void}
 */
function pushInvalidValue(state, key, lineNumber, reason) {
  state.findings.push(
    createFinding(
      SEVERITY.WARNING,
      "invalid-manifest-value",
      `railsbox.yml ligne ${lineNumber} : valeur invalide pour « ${key} » (${reason}).`,
      { key, line: lineNumber },
    ),
  );
}
