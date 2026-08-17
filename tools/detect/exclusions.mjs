// Que faut-il VRAIMENT embarquer dans le disque applicatif ?
//
// Le disque applicatif a une géométrie FIXE de 512 Mo (ADR 0002). Jusqu'ici la
// construction y déversait l'arbre du dépôt tel quel — `COPY . .` — donc aussi
// l'historique git, les gems vendorisées d'un autre Ruby et les assets
// précompilés que la construction régénère. Sur la première application tierce
// réelle, cela faisait 261 Mo AVANT même le `bundle install` : 143 Mo de
// `vendor/bundle` compilé pour Ruby 2.5.0, 65 Mo de `public/assets` réémis par
// l'étage amd64, 54 Mo de `.git`. Le refus de volumétrie tombait à 589 Mo sans
// que rien ne dise d'où venaient ces mégaoctets.
//
// Ce module décide de ce qui n'entre pas dans le contexte de construction. Il
// est PUR : il ne lit aucun fichier, il classe et il valide.
//
// La règle de prudence qui gouverne la liste : une exclusion qui casse une
// application coûte plus cher que 100 Mo de trop. Chaque entrée par défaut doit
// donc tenir sur un argument vérifiable — « le guest ne l'exécute jamais », ou
// « la construction le régénère plus loin ». Tout ce qui demande une hypothèse
// sur les intentions du dépôt est laissé au mainteneur, par la clé `exclude:`
// de railsbox.yml.
//
// SÉCURITÉ : les valeurs de `exclude:` viennent d'un dépôt TIERS et finissent
// en arguments `--exclude=` d'un `tar` exécuté sur le runner de CI du
// mainteneur. C'est une FRONTIÈRE : chemin relatif à la racine de
// l'application, aucun segment « .. », aucun caractère qu'un shell puisse
// interpréter, jamais de tiret en tête (qui deviendrait une option de `tar`).
// Tout le reste est refusé avec un diagnostic — jamais assaini en silence.
import { ASSET_STAGE } from "./assets.mjs";
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * @typedef {object} Exclusion
 * @property {string} path chemin relatif à la racine de l'application
 * @property {string} reason justification française, citée dans la documentation
 * @property {string} source `defaut`, `assets` ou `railsbox.yml`
 */

/** Longueur maximale d'un chemin déclaré (borne de sûreté, pas une limite utile). */
export const MAX_PATH_LENGTH = 128;

/** Nombre maximal de segments d'un chemin déclaré. */
export const MAX_SEGMENTS = 6;

/** Nombre maximal d'exclusions déclarées : coupe court à une liste absurde. */
export const MAX_DECLARED_EXCLUDES = 64;

/**
 * Un segment de chemin acceptable : ni `.` ni `..`, aucun métacaractère de
 * shell, et JAMAIS un tiret en tête — `-C` ou `--strip-components` serait lu
 * comme une OPTION par `tar`, et le comportement ne dépendrait plus de nous.
 * Le point est admis en tête : `.git` et `.github` sont des exclusions
 * légitimes, et c'est même l'usage principal de la clé.
 */
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/;

/**
 * Chemins qu'une exclusion ne peut JAMAIS désigner : sans eux il n'y a plus
 * d'application Rails à construire, et l'échec surviendrait très loin de la
 * ligne de railsbox.yml qui l'a causé — au `bundle check`, à la précompilation
 * ou au premier boot. Un refus immédiat, nommé, coûte infiniment moins cher.
 *
 * `vendor` en fait partie alors que `vendor/bundle` est exclu par défaut :
 * c'est précisément la distinction qui compte, `vendor/cache` (gems empaquetées
 * par `bundle package`) et `vendor/javascript` (importmap) étant vitaux.
 */
export const PROTECTED_PATHS = Object.freeze([
  "app",
  "bin",
  "config",
  "config.ru",
  "db",
  "Gemfile",
  "Gemfile.lock",
  "lib",
  "public",
  "Rakefile",
  "railsbox.yml",
  "vendor",
]);

/**
 * Exclusions appliquées à TOUTE application, avec leur justification.
 *
 * L'ordre est celui du journal de construction : le plus lourd d'abord, dans
 * l'expérience, puis ce qui relève de l'hygiène.
 */
export const DEFAULT_EXCLUSIONS = Object.freeze(
  [
    {
      path: ".git",
      reason:
        "historique de version : la VM n'embarque pas git et aucune application Rails ne " +
        "lit .git pour servir une requête. C'est le poste le plus lourd d'un dépôt réel " +
        "(54 Mo sur l'application témoin, sans compter les dépôts à gros binaires).",
    },
    {
      path: "vendor/bundle",
      reason:
        "bundle vendorisé du dépôt. La construction réinstalle les gems sous " +
        "/app/vendor/bundle (BUNDLE_PATH) AVANT le COPY : un bundle versionné ne peut que " +
        "s'écraser par-dessus. Compilé pour un autre Ruby il est mort ; compilé pour le " +
        "même il remplace des gems natives i386 par des binaires x86_64 — donc une panne. " +
        "vendor/cache (bundle package) et vendor/javascript, eux, sont conservés.",
    },
    {
      path: "node_modules",
      reason:
        "dépendances front réinstallées par l'étage amd64 (npm ci / npm install) quand " +
        "l'application a une chaîne npm. Le guest i386 n'a aucun Node : ce répertoire n'y " +
        "sert jamais à rien.",
    },
    {
      path: "tmp",
      reason:
        "caches et pid de développement. La construction fait déjà `rm -rf tmp/*` juste " +
        "avant la fabrication de l'ext2 : les exclure évite seulement de les traîner.",
    },
    {
      path: "log",
      reason: "journaux de développement, effacés eux aussi avant la fabrication de l'ext2.",
    },
    {
      path: "coverage",
      reason:
        "rapports de couverture (SimpleCov) : produits par la suite de tests, jamais lus à " +
        "l'exécution.",
    },
    {
      path: ".github",
      reason:
        "workflows d'intégration continue du dépôt : ils s'exécutent chez GitHub, jamais " +
        "dans la VM.",
    },
    {
      path: ".idea",
      reason: "réglages d'éditeur (JetBrains), sans effet sur l'exécution.",
    },
    {
      path: ".vscode",
      reason: "réglages d'éditeur (VS Code), sans effet sur l'exécution.",
    },
  ].map((entry) => Object.freeze({ ...entry, source: "defaut" })),
);

/**
 * Valide un chemin d'exclusion déclaré par un dépôt tiers.
 *
 * Rendre `null` est la seule issue en cas de doute : la valeur part dans une
 * commande de construction, il n'y a pas de « presque acceptable ».
 * @param {*} value valeur brute (chaîne attendue)
 * @returns {string|null} chemin relatif normalisé, ou `null` s'il est refusé
 */
export function normalizeExcludePath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed.length > MAX_PATH_LENGTH) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  // Un chemin Windows (`C:\...`, `dossier\sous`) n'a aucun sens dans le
  // contexte Linux et masquerait un `\` interprétable : refusé sans discussion.
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
 * Assainit une liste d'exclusions déclarées, en séparant retenues, refusées
 * pour cause de forme, et refusées parce qu'elles décapiteraient l'application.
 * @param {readonly *[]} values valeurs brutes
 * @param {string} [source] origine, citée dans les diagnostics
 * @returns {{paths: readonly string[], findings: readonly Finding[]}} chemins retenus et diagnostics
 */
export function sanitizeExcludePaths(values, source = "railsbox.yml") {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const paths = [];
  const brut = Array.isArray(values) ? values : [];
  for (const value of brut) {
    const normalized = normalizeExcludePath(value);
    if (normalized === null) {
      findings.push(
        createFinding(
          SEVERITY.WARNING,
          "invalid-exclude-path",
          `Exclusion refusée dans ${source} : « ${apercu(value)} » — un chemin RELATIF à la ` +
            "racine de l'application est attendu, sans « .. », sans chemin absolu et sans " +
            "caractère qu'un shell interprète.",
          { path: apercu(value), source },
        ),
      );
      continue;
    }
    if (PROTECTED_PATHS.includes(normalized)) {
      findings.push(
        createFinding(
          SEVERITY.WARNING,
          "protected-exclude-path",
          `Exclusion refusée dans ${source} : « ${normalized} » — sans lui il n'y a plus ` +
            "d'application Rails à construire. Visez un sous-chemin (« vendor/bundle », " +
            "« public/uploads ») plutôt que la racine.",
          { path: normalized, source },
        ),
      );
      continue;
    }
    if (!paths.includes(normalized)) paths.push(normalized);
  }
  if (paths.length > MAX_DECLARED_EXCLUDES) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "too-many-excludes",
        `${paths.length} exclusions déclarées dans ${source} : ${MAX_DECLARED_EXCLUDES} au ` +
          "maximum sont retenues.",
        { count: paths.length, source },
      ),
    );
    return { paths: Object.freeze(paths.slice(0, MAX_DECLARED_EXCLUDES)), findings };
  }
  return { paths: Object.freeze(paths), findings: Object.freeze(findings) };
}

/**
 * Répertoires de sortie d'assets que la construction RÉGÉNÈRE, et qu'il est
 * donc inutile — voire nuisible — de recopier depuis le dépôt.
 *
 * La règle tient en une phrase : sous `public/`, un répertoire de sortie est un
 * ARTEFACT ; sous `app/`, c'est une SOURCE. `public/assets` est intégralement
 * réémis par `assets:precompile` (les empreintes du dépôt ne sont alors que du
 * poids mort, et un mélange d'anciennes empreintes est une source de bugs) ;
 * `app/assets/builds`, lui, est un chemin de recherche du pipeline — une
 * application peut parfaitement y versionner un CSS que rien ne reconstruit,
 * et l'exclure la laisserait sans feuille de style.
 *
 * Rien n'est exclu quand aucun pipeline n'a été détecté (`aucun`) : les assets
 * versionnés sont alors les SEULS que la sandbox servira.
 * @param {{stage?: string, outputDirs?: readonly string[]}} input plan d'assets
 * @returns {Exclusion[]} exclusions conditionnelles, justifiées
 */
export function assetExclusions({ stage, outputDirs = [] } = {}) {
  if (stage !== ASSET_STAGE.GUEST && stage !== ASSET_STAGE.HOST) return [];
  const où = stage === ASSET_STAGE.HOST ? "l'étage amd64" : "la précompilation i386";
  return outputDirs
    .filter((dir) => typeof dir === "string" && dir.startsWith("public/"))
    .map((dir) =>
      Object.freeze({
        path: dir,
        reason: `répertoire de sortie d'assets régénéré par ${où} : la version versionnée dans le dépôt serait recouverte, empreintes périmées comprises.`,
        source: "assets",
      }),
    );
}

/**
 * Construit la liste complète des exclusions du contexte de construction.
 *
 * Les exclusions déclarées s'AJOUTENT aux exclusions par défaut : la clé
 * `exclude:` sert à retirer ce que railsbox ne peut pas deviner (un dossier de
 * médias de démonstration, un jeu de fixtures lourd), jamais à réintroduire ce
 * que la construction régénère.
 * @param {{declared?: readonly string[], assetStage?: string, assetOutputDirs?: readonly string[]}} input contexte
 * @returns {{entries: readonly Exclusion[], paths: readonly string[]}} exclusions ordonnées et leurs chemins
 */
export function planExclusions({ declared = [], assetStage, assetOutputDirs = [] } = {}) {
  /** @type {Exclusion[]} */
  const entries = [];
  /** @type {Set<string>} */
  const vus = new Set();
  const ajouter = (entry) => {
    if (vus.has(entry.path)) return;
    vus.add(entry.path);
    entries.push(entry);
  };
  for (const entry of DEFAULT_EXCLUSIONS) ajouter(entry);
  for (const entry of assetExclusions({ stage: assetStage, outputDirs: assetOutputDirs })) {
    ajouter(entry);
  }
  for (const path of declared) {
    ajouter(Object.freeze({ path, reason: "déclaré dans railsbox.yml", source: "railsbox.yml" }));
  }
  return {
    entries: Object.freeze(entries),
    paths: Object.freeze(entries.map((entry) => entry.path)),
  };
}

/**
 * Tronque une valeur pour la citer sans inonder le rapport.
 * @param {*} value valeur brute
 * @returns {string} extrait borné
 */
function apercu(value) {
  const texte = typeof value === "string" ? value : String(value);
  return texte.length > MAX_PATH_LENGTH ? `${texte.slice(0, MAX_PATH_LENGTH)}…` : texte;
}
