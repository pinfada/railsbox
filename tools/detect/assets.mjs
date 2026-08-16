// Où précompiler les assets d'une application Rails ? La réponse ne dépend ni
// du goût ni de la version de Rails, mais d'un fait d'architecture : le guest
// railsbox est un i386, et deux familles d'outils d'assets ne publient AUCUN
// binaire pour cette architecture.
//
//  - les gems à exécutable précompilé : `tailwindcss-ruby` (dont dépend
//    tailwindcss-rails) ne publie que aarch64-linux, x86_64-linux, *-darwin et
//    mingw ; `dartsass-ruby` télécharge un binaire x86_64 (vérifié sur
//    rubygems le 2026-08-16) ;
//  - les chaînes npm (esbuild, sass, tailwindcss en paquet npm), livrées elles
//    aussi en exécutables par plateforme.
//
// Ce n'est pas une impasse de fond : ces outils produisent du CSS et du JS
// ORDINAIRES, indépendants de l'architecture. On les exécute donc sur un étage
// amd64 — l'hôte de construction en est un — puis on copie `public/assets`
// dans le disque applicatif i386. Le guest n'exécute jamais ces binaires.
//
// Ce module est pur : il ne lit aucun fichier, il classe.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Étage sur lequel la précompilation des assets doit avoir lieu.
 * Les valeurs sont celles qui transitent en `--build-arg` : elles font partie
 * du contrat entre l'auto-détection et les scripts de construction.
 */
export const ASSET_STAGE = Object.freeze({
  /** Aucun pipeline d'assets détecté : rien à précompiler. */
  NONE: "aucun",
  /** Précompilation avec le Ruby i386 du guest, pendant le build du disque. */
  GUEST: "i386",
  /** Précompilation sur un étage amd64, puis copie de public/assets. */
  HOST: "amd64",
});

/** Gems trahissant un pipeline d'assets à précompiler. */
export const ASSET_PIPELINE_GEMS = Object.freeze([
  "propshaft",
  "sprockets-rails",
  "sprockets",
  "dartsass-rails",
  "tailwindcss-rails",
  "cssbundling-rails",
  "jsbundling-rails",
  "importmap-rails",
]);

/**
 * Gems dont la précompilation passe par un EXÉCUTABLE publié par plateforme,
 * et jamais pour i386. Les enveloppes Rails et les gems de binaire sont toutes
 * deux listées : le Gemfile.lock résout les deux, et nommer précisément ce qui
 * a déclenché l'étage amd64 vaut mieux qu'un raccourci.
 */
export const BINARY_ASSET_GEMS = Object.freeze([
  "dartsass-rails",
  "dartsass-ruby",
  "tailwindcss-rails",
  "tailwindcss-ruby",
]);

/**
 * Verrous de dépendances front reconnus, et gestionnaire correspondant.
 * railsbox n'installe qu'avec npm : les autres verrous sont signalés, pas
 * exécutés (embarquer trois gestionnaires de paquets dans l'étage amd64
 * coûterait plus que ce que cela rapporte).
 */
export const NPM_LOCKFILES = Object.freeze({
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
});

/** Verrous que `npm ci` sait relire. */
const NPM_NATIVE_LOCKFILES = Object.freeze(["package-lock.json", "npm-shrinkwrap.json"]);

/** Installation reproductible (verrou npm présent). */
const NPM_CI = "npm ci --no-audit --no-fund";

/** Installation de repli : résolution depuis package.json seul. */
const NPM_INSTALL = "npm install --no-audit --no-fund";

/**
 * Gems à outillage binaire présentes dans le verrou.
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @returns {string[]} noms détectés, triés
 */
export function binaryAssetGems(specs) {
  if (!(specs instanceof Map)) return [];
  return BINARY_ASSET_GEMS.filter((gem) => specs.has(gem)).sort();
}

/**
 * Commande d'installation des dépendances front à exécuter sur l'étage amd64.
 * @param {readonly string[]} lockfiles verrous présents à la racine de l'app
 * @returns {string} commande npm
 */
export function npmInstallCommand(lockfiles) {
  const found = Array.isArray(lockfiles) ? lockfiles : [];
  return found.some((name) => NPM_NATIVE_LOCKFILES.includes(name)) ? NPM_CI : NPM_INSTALL;
}

/**
 * @typedef {object} AssetPlan
 * @property {string} stage une des valeurs de {@link ASSET_STAGE}
 * @property {boolean} npm l'application a un package.json
 * @property {readonly string[]} scripts scripts npm de build à déclencher
 * @property {readonly string[]} tools outils front déclarés dans package.json
 * @property {readonly string[]} binaryGems gems d'assets à binaire précompilé
 * @property {string} install commande d'installation npm, vide sans package.json
 */

/**
 * Classe le pipeline d'assets et choisit l'étage de précompilation.
 *
 * La fonction est idempotente : rejouée sur un manifeste déjà planifié (après
 * fusion d'un railsbox.yml, par exemple), elle conserve la commande
 * d'installation déjà déduite des verrous — que le manifeste ne transporte pas.
 * @param {{assets?: {npm?: boolean, scripts?: readonly string[], tools?: readonly string[], install?: string}, specs?: Map<string, string>, lockfiles?: readonly string[]}} input contexte d'analyse
 * @returns {{plan: AssetPlan, findings: Finding[]}} plan gelé et diagnostics
 */
export function planAssets({ assets, specs, lockfiles = [] } = {}) {
  const resolved = specs instanceof Map ? specs : new Map();
  const npm = Boolean(assets?.npm);
  const scripts = [...(assets?.scripts ?? [])];
  const tools = [...(assets?.tools ?? [])];
  const binaryGems = binaryAssetGems(resolved);
  const pipeline = ASSET_PIPELINE_GEMS.some((gem) => resolved.has(gem));
  const stage = chooseStage({ npm, binaryGems, pipeline });
  const install = npm ? assets?.install || npmInstallCommand(lockfiles) : "";

  /** @type {Finding[]} */
  const findings = [];
  if (stage === ASSET_STAGE.HOST) {
    findings.push(
      createFinding(
        SEVERITY.INFO,
        "assets-amd64-stage",
        `Assets précompilés sur un étage amd64 (${hostReasons({ npm, binaryGems }).join(", ")}) : ` +
          "le guest i386 n'exécutera aucun binaire d'assets.",
        { binaryGems, npm },
      ),
    );
  }
  if (npm && !lockfileIsNpm(lockfiles)) {
    findings.push(
      createFinding(SEVERITY.WARNING, "npm-lockfile-absent", describeMissingLock(lockfiles), {
        lockfiles: [...lockfiles],
      }),
    );
  }
  return {
    plan: Object.freeze({
      stage,
      npm,
      scripts: Object.freeze(scripts),
      tools: Object.freeze(tools),
      binaryGems: Object.freeze(binaryGems),
      install,
    }),
    findings,
  };
}

/**
 * Choisit l'étage de précompilation à partir des indices relevés.
 * @param {{npm: boolean, binaryGems: readonly string[], pipeline: boolean}} indices indices de classification
 * @returns {string} une des valeurs de {@link ASSET_STAGE}
 */
function chooseStage({ npm, binaryGems, pipeline }) {
  if (npm || binaryGems.length > 0) return ASSET_STAGE.HOST;
  return pipeline ? ASSET_STAGE.GUEST : ASSET_STAGE.NONE;
}

/**
 * Énumère ce qui impose l'étage amd64, pour un diagnostic qui explique.
 * @param {{npm: boolean, binaryGems: readonly string[]}} indices indices de classification
 * @returns {string[]} raisons lisibles
 */
function hostReasons({ npm, binaryGems }) {
  const reasons = [];
  if (binaryGems.length > 0) reasons.push(binaryGems.join(", "));
  if (npm) reasons.push("chaîne npm");
  return reasons;
}

/**
 * Indique si un verrou relisible par `npm ci` est présent.
 * @param {readonly string[]} lockfiles verrous présents
 * @returns {boolean} vrai si npm peut installer de façon reproductible
 */
function lockfileIsNpm(lockfiles) {
  return lockfiles.some((name) => NPM_NATIVE_LOCKFILES.includes(name));
}

/**
 * Message expliquant l'absence de verrou npm exploitable.
 * @param {readonly string[]} lockfiles verrous présents
 * @returns {string} message français
 */
function describeMissingLock(lockfiles) {
  const foreign = lockfiles.filter((name) => !NPM_NATIVE_LOCKFILES.includes(name));
  if (foreign.length > 0) {
    return (
      `Verrou « ${foreign.join(", ")} » non relu : railsbox installe les dépendances front ` +
      "avec npm, la résolution se fera depuis package.json seul."
    );
  }
  return (
    "Aucun package-lock.json : les dépendances front seront résolues depuis package.json, " +
    "donc pas à l'identique du dépôt."
  );
}
