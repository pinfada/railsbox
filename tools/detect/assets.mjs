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
import { DEFAULT_OUTPUT_DIRS, mergeOutputDirs } from "./asset-output.mjs";
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
 *
 * railsbox exécute npm, pnpm et yarn. Bun est SIGNALÉ, pas exécuté, et
 * l'installation retombe alors sur npm.
 *
 * Cette note disait auparavant que railsbox n'installait qu'avec npm, au
 * motif qu'embarquer trois gestionnaires coûterait plus que cela ne
 * rapporterait. L'argument portait sur des gestionnaires EMBARQUÉS : Corepack,
 * livré avec Node dans l'image d'assets, ne coûte qu'un shim et provisionne la
 * version exacte que le projet DÉCLARE. Une application qui épingle
 * `packageManager: "pnpm@10.22.0"` a fait un choix reproductible, et le
 * respecter est moins cher que de le contourner — mesuré sur tryzealot/zealot,
 * dont `jsbundling-rails` exige pnpm quoi que railsbox installe.
 *
 * Yarn est resté dehors tant que ses DEUX GÉNÉRATIONS n'étaient pas
 * distinguées : Classic verrouille avec `--frozen-lockfile`, Berry avec
 * `--immutable`, et les mêler produirait une commande fausse pour l'un des
 * deux. Le verrou le dit lui-même — c'est `yarnGeneration` qui le lit, et rien
 * n'est deviné quand il se tait.
 *
 * Ce qui a fait bouger la ligne : woofed-crm, deuxième application tierce
 * candidate, dont npm REFUSE l'arbre (ERESOLVE — `trix@^1.2.0` contre le pair
 * `trix@^2.0.0` de `@rails/actiontext`). Le repli npm n'était plus une
 * dégradation, c'était un échec de construction.
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
 * Installation pnpm. `--frozen-lockfile` est le point entier : un verrou
 * périmé doit ARRÊTER la construction, jamais être réécrit en silence — c'est
 * la contrepartie de « respecter le gestionnaire du projet ».
 */
const PNPM_INSTALL = "pnpm install --frozen-lockfile";

/**
 * Installation Yarn Classic (1.x). Même exigence que pnpm : un verrou périmé
 * doit ARRÊTER la construction, jamais être réécrit en silence.
 */
const YARN_CLASSIC_INSTALL = "yarn install --frozen-lockfile";

/**
 * Installation Yarn moderne (Berry, 2+). `--immutable` y remplace
 * `--frozen-lockfile`, que Berry ne connaît pas : c'est exactement la
 * confusion qui tenait yarn dehors.
 */
const YARN_BERRY_INSTALL = "yarn install --immutable";

/** Première ligne d'un verrou Yarn Classic. */
const YARN_CLASSIC_MARQUEUR = /^#\s*yarn lockfile v1\s*$/m;

/** Bloc que Berry écrit en tête de son verrou. */
const YARN_BERRY_MARQUEUR = /^__metadata:\s*$/m;

/**
 * Génération d'un verrou yarn, lue sur SON CONTENU.
 *
 * Ni le nom du fichier ni la version déclarée ne tranchent : les deux
 * générations écrivent `yarn.lock`, et `packageManager` est souvent absent.
 * Le verrou, lui, porte sa marque. Rendre `null` quand elle manque est la
 * seule issue honnête — installer avec la mauvaise option échouerait au
 * milieu d'une construction, pas ici.
 * @param {unknown} contenu contenu du fichier yarn.lock
 * @returns {"classic"|"berry"|null} génération reconnue, ou null
 */
export function yarnGeneration(contenu) {
  if (typeof contenu !== "string" || contenu === "") return null;
  if (YARN_BERRY_MARQUEUR.test(contenu)) return "berry";
  if (YARN_CLASSIC_MARQUEUR.test(contenu)) return "classic";
  return null;
}

/**
 * Gestionnaires que railsbox sait EXÉCUTER. Liste fermée, et c'est une
 * frontière de sécurité : seul un identifiant de cette liste finit dans un
 * argument de build, donc dans une commande. La version, elle, n'y entre
 * jamais — Corepack la lit lui-même dans le `package.json` du projet.
 */
export const PACKAGE_MANAGERS = Object.freeze(["npm", "pnpm", "yarn"]);

/** Gestionnaire retenu quand rien n'impose autre chose. */
export const DEFAULT_PACKAGE_MANAGER = "npm";

/**
 * Forme du champ `packageManager` (convention Corepack) : `nom@X.Y.Z`, avec
 * une pré-version et une empreinte facultatives. Volontairement STRICTE — la
 * valeur vient d'un `package.json` tiers, et tout ce qui n'est pas exactement
 * cette forme est rejeté plutôt qu'assaini.
 */
const PACKAGE_MANAGER_FIELD =
  /^([a-z][a-z0-9-]{0,19})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\+[0-9A-Za-z._-]{4,128})?$/;

/**
 * Lit le champ `packageManager` d'un package.json.
 *
 * NE REND QUE DES DONNÉES VALIDÉES, et surtout jamais la chaîne d'origine : une
 * valeur hostile (`pnpm@1.0.0; rm -rf /`) ne satisfait pas la forme, donc elle
 * ne ressort pas — elle ne peut pas atteindre de shell.
 * @param {unknown} value valeur brute du champ
 * @returns {{ name: string, version: string } | null} null si absent ou invalide
 */
export function parsePackageManager(value) {
  if (typeof value !== "string") return null;
  const match = PACKAGE_MANAGER_FIELD.exec(value.trim());
  if (!match) return null;
  return { name: match[1], version: match[2] };
}

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
 * Choisit le gestionnaire de paquets front, sa commande d'installation, et
 * dit ce qui a été refusé.
 *
 * TROIS RÈGLES, ET AUCUNE N'INVENTE RIEN.
 *
 * 1. Deux verrous de gestionnaires DIFFÉRENTS sont contradictoires : rien ne
 *    permet de trancher lequel décrit l'état réel des dépendances, et se
 *    tromper produit une installation qui n'est celle de personne. C'est
 *    bloquant.
 * 2. Un verrou pnpm SANS `packageManager` ne donne aucune version. Corepack ne
 *    peut alors rien provisionner, et en choisir une au hasard reviendrait à
 *    installer avec un pnpm que le dépôt n'a jamais utilisé. On avertit
 *    fortement et on retombe sur npm — le comportement d'avant.
 * 3. Un verrou yarn est exécuté SI sa génération est certaine. Classic se
 *    reconnaît seul (`# yarn lockfile v1`) et Corepack en provisionne un par
 *    défaut. Berry exige un `packageManager` déclaré, pour la même raison que
 *    pnpm : sans version, Corepack retomberait sur Yarn 1, qui refuserait ce
 *    verrou. Génération indéterminée : repli npm, jamais de devinette.
 * 4. Un gestionnaire hors liste (bun) est signalé, pas exécuté.
 * @param {{ lockfiles?: readonly string[], packageManager?: unknown, yarnLock?: unknown }} input
 * @returns {{ manager: string, install: string, findings: Finding[] }}
 */
export function planPackageManager({ lockfiles = [], packageManager, yarnLock } = {}) {
  const verrous = Array.isArray(lockfiles) ? lockfiles : [];
  /** @type {Finding[]} */
  const findings = [];

  const familles = [...new Set(verrous.map((nom) => NPM_LOCKFILES[nom]).filter(Boolean))];
  if (familles.length > 1) {
    findings.push(
      createFinding(
        SEVERITY.BLOCKING,
        "verrous-front-contradictoires",
        `Verrous front contradictoires (${familles.sort().join(", ")}) : railsbox ne peut pas ` +
          "deviner lequel décrit vos dépendances. N'en gardez qu'un.",
        { lockfiles: [...verrous] },
      ),
    );
    return { manager: DEFAULT_PACKAGE_MANAGER, install: npmInstallCommand(verrous), findings };
  }

  const declare = parsePackageManager(packageManager);
  const aVerrouPnpm = verrous.includes("pnpm-lock.yaml");

  if (declare && declare.name === "pnpm" && aVerrouPnpm) {
    return { manager: "pnpm", install: PNPM_INSTALL, findings };
  }

  if (verrous.includes("yarn.lock")) {
    const generation = yarnGeneration(yarnLock);
    if (generation === "classic") {
      return { manager: "yarn", install: YARN_CLASSIC_INSTALL, findings };
    }
    if (generation === "berry" && declare && declare.name === "yarn") {
      return { manager: "yarn", install: YARN_BERRY_INSTALL, findings };
    }
    findings.push(
      generation === "berry"
        ? createFinding(
            SEVERITY.WARNING,
            "yarn-sans-package-manager",
            'Verrou Yarn moderne (Berry) présent, mais aucun `packageManager: "yarn@X.Y.Z"` ' +
              "dans package.json : Corepack retomberait sur Yarn 1, qui refuse ce verrou. " +
              "railsbox installe donc avec npm. Déclarez-le pour installer à l'identique du dépôt.",
            { packageManagerDeclare: declare?.name ?? null },
          )
        : createFinding(
            SEVERITY.WARNING,
            "yarn-generation-indeterminee",
            "Verrou « yarn.lock » présent mais illisible : ni la marque Classic " +
              "(`# yarn lockfile v1`) ni celle de Berry (`__metadata:`) n'y figurent. " +
              "Classic et Berry n'ont pas la même option d'installation verrouillée : " +
              "railsbox n'en devine aucune et installe avec npm.",
            { lockfiles: [...verrous] },
          ),
    );
    return { manager: DEFAULT_PACKAGE_MANAGER, install: npmInstallCommand(verrous), findings };
  }

  if (aVerrouPnpm) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "pnpm-sans-package-manager",
        'Verrou pnpm présent, mais aucun `packageManager: "pnpm@X.Y.Z"` exploitable dans ' +
          "package.json : railsbox n'invente pas de version et installe avec npm. Déclarez-le " +
          "pour que vos dépendances soient installées à l'identique du dépôt.",
        { packageManagerDeclare: declare?.name ?? null },
      ),
    );
  } else if (declare && !PACKAGE_MANAGERS.includes(declare.name)) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "package-manager-non-execute",
        `Gestionnaire « ${declare.name} » déclaré : railsbox ne l'exécute pas et installe avec ` +
          "npm. Seuls npm, pnpm et yarn sont pris en charge.",
        { packageManagerDeclare: declare.name },
      ),
    );
  }

  return { manager: DEFAULT_PACKAGE_MANAGER, install: npmInstallCommand(verrous), findings };
}

/**
 * @typedef {object} AssetPlan
 * @property {string} stage une des valeurs de {@link ASSET_STAGE}
 * @property {boolean} npm l'application a un package.json
 * @property {readonly string[]} scripts scripts npm de build à déclencher
 * @property {readonly string[]} tools outils front déclarés dans package.json
 * @property {readonly string[]} binaryGems gems d'assets à binaire précompilé
 * @property {string} install commande d'installation, vide sans package.json
 * @property {string} manager gestionnaire de paquets front (`npm` ou `pnpm`)
 * @property {readonly string[]} output répertoires remontés de l'étage amd64 vers le disque
 */

/**
 * Classe le pipeline d'assets et choisit l'étage de précompilation.
 *
 * La fonction est idempotente : rejouée sur un manifeste déjà planifié (après
 * fusion d'un railsbox.yml, par exemple), elle conserve la commande
 * d'installation déjà déduite des verrous — que le manifeste ne transporte pas
 * — ainsi que les répertoires de sortie déjà retenus.
 * @param {{assets?: {npm?: boolean, scripts?: readonly string[], tools?: readonly string[], install?: string, manager?: string, packageManager?: unknown, output?: readonly string[]}, specs?: Map<string, string>, lockfiles?: readonly string[], outputDirs?: readonly string[], yarnLock?: unknown}} input contexte d'analyse
 * @returns {{plan: AssetPlan, findings: Finding[]}} plan gelé et diagnostics
 */
export function planAssets({ assets, specs, lockfiles = [], outputDirs = [], yarnLock } = {}) {
  const resolved = specs instanceof Map ? specs : new Map();
  const npm = Boolean(assets?.npm);
  const scripts = [...(assets?.scripts ?? [])];
  const tools = [...(assets?.tools ?? [])];
  // Les deux répertoires par défaut ouvrent TOUJOURS la liste : ils sont la
  // sortie de assets:precompile et de jsbundling, que rien ne doit retirer.
  const output = mergeOutputDirs(DEFAULT_OUTPUT_DIRS, outputDirs, assets?.output ?? []);
  const binaryGems = binaryAssetGems(resolved);
  const pipeline = ASSET_PIPELINE_GEMS.some((gem) => resolved.has(gem));
  const stage = chooseStage({ npm, binaryGems, pipeline });
  const gestionnaire = planPackageManager({
    lockfiles,
    yarnLock,
    packageManager: assets?.packageManager,
  });
  const install = npm ? assets?.install || gestionnaire.install : "";
  const manager = npm ? (assets?.manager ?? gestionnaire.manager) : DEFAULT_PACKAGE_MANAGER;

  /** @type {Finding[]} */
  const findings = npm ? [...gestionnaire.findings] : [];
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
  if (npm && manager === DEFAULT_PACKAGE_MANAGER && !lockfileIsNpm(lockfiles)) {
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
      manager,
      output: Object.freeze(output),
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
