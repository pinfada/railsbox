// Auto-détection d'une application Rails : produit le manifeste de build que
// railsbox utilisera pour préparer l'image. Tout est tolérant à l'absence de
// fichier — un projet incomplet doit donner un rapport, jamais une exception.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectOutputDirs } from "./asset-output.mjs";
import { NPM_LOCKFILES, planAssets } from "./assets.mjs";
import { DEFAULT_BASE, resolveBase } from "./bases.mjs";
import { absolutePathFindings, scanAbsolutePaths } from "./chemins-absolus-js.mjs";
import { etatFichierSeeds } from "./donnees-demo.mjs";
import { SEVERITY, createFinding } from "./findings.mjs";
import { collectNativeGems, detectServices, parseBundlerVersion, parseLockSpecs } from "./gems.mjs";
import { deepFreeze } from "./manifest.mjs";
import { dataMigrationFindings, scanDataMigrations } from "./migrations.mjs";
import { externalServiceFindings } from "./services-externes.mjs";
import { sqliteDriverFindings, sqliteDriverState } from "./sqlite.mjs";
import {
  normalizeRubyVersion,
  parseRubyDirective,
  resolveRubyRequirement,
  satisfiesRubyRequirement,
} from "./ruby-requirement.mjs";
import { detectSslSettings, isSslEnforced } from "./ssl.mjs";
import { detectMecanismeAuth } from "./authentification.mjs";

// Réexporté ici : la fonction vit avec l'analyse des contraintes (l'inverse
// créerait un cycle d'imports), mais son point d'entrée public reste detect.
export { normalizeRubyVersion };

/** @typedef {import("./findings.mjs").Finding} Finding */
/** @typedef {import("./manifest.mjs").Manifest} Manifest */

/** Adaptateurs `database.yml` que les images de base savent servir. */
const SUPPORTED_ADAPTERS = Object.freeze(["postgresql", "sqlite3"]);

/** Adaptateurs reconnus mais non supportés : ils doivent bloquer le build. */
const UNSUPPORTED_ADAPTERS = Object.freeze(["mysql2", "trilogy"]);

/** Scripts npm que railsbox sait déclencher pour construire les assets. */
const KNOWN_BUILD_SCRIPTS = Object.freeze(["build", "build:css", "build:js"]);

/** Outils de build front reconnus (déterminent les binaires à embarquer). */
const KNOWN_ASSET_TOOLS = Object.freeze(["esbuild", "tailwindcss", "sass"]);

/** Codes d'erreur système à traiter comme « fichier absent ». */
const ABSENT_CODES = Object.freeze(["ENOENT", "ENOTDIR", "EISDIR"]);

const LOCK_RUBY = /^RUBY VERSION\s+ruby\s+(\S+)/m;
const ERB_TAG = /<%[\s\S]*?%>/g;
// `\s` engloberait les sauts de ligne et ferait déborder ces motifs sur la
// ligne suivante (une balise ERB retirée laisse une valeur vide) : on reste
// donc explicitement sur les blancs horizontaux.
const GEMFILE_RUBY = /^[ \t]*ruby[ \t]+["']([^"']+)["']/m;
const GEMFILE_RAILS = /^[ \t]*gem[ \t]+["']rails["']/m;
const ADAPTER_LINE = /^[ \t]*adapter:[ \t]*(.+)$/gm;

/**
 * Lit un fichier texte en tolérant son absence.
 * @param {string} filePath chemin absolu ou relatif du fichier
 * @returns {Promise<string|null>} contenu, ou `null` si le fichier n'existe pas
 * @throws {Error} pour toute erreur de lecture autre qu'une absence (droits, E/S)
 */
export async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    // Une absence est un diagnostic ; une erreur de droits ou d'E/S est un bug
    // d'environnement qui doit remonter au lieu d'être silencieusement avalé.
    if (error && ABSENT_CODES.includes(error.code)) return null;
    throw error;
  }
}

/**
 * Teste l'existence d'un chemin en tolérant son absence.
 * @param {string} filePath chemin à tester
 * @returns {Promise<boolean>} vrai si le chemin existe
 * @throws {Error} pour toute erreur autre qu'une absence (droits, E/S)
 */
export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && ABSENT_CODES.includes(error.code)) return false;
    throw error;
  }
}

/**
 * Relève les verrous de dépendances front présents à la racine.
 * @param {string} appDir racine de l'application
 * @returns {Promise<string[]>} noms des verrous trouvés, dans l'ordre de la table
 */
async function detectNpmLockfiles(appDir) {
  const names = Object.keys(NPM_LOCKFILES);
  const present = await Promise.all(names.map((name) => pathExists(join(appDir, name))));
  return names.filter((_, index) => present[index]);
}

/**
 * Lit toutes les migrations de `db/migrate`, en tolérant l'absence du dossier.
 * @param {string} appDir racine de l'application
 * @returns {Promise<{name: string, text: string}[]>} migrations, triées par nom
 * @throws {Error} pour toute erreur autre qu'une absence (droits, E/S)
 */
async function readMigrations(appDir) {
  const dir = join(appDir, "db", "migrate");
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error && ABSENT_CODES.includes(error.code)) return [];
    throw error;
  }
  const names = entries.filter((name) => name.endsWith(".rb")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      // Un fichier disparu entre le readdir et la lecture n'est pas un incident
      // : l'analyse doit rendre un rapport, jamais une exception.
      text: (await readOptionalFile(join(dir, name))) ?? "",
    })),
  );
}

/**
 * Sources où vit l'authentification, concaténées.
 *
 * On ne lit PAS tout `app/` : la question tient dans trois endroits
 * conventionnels, et une lecture exhaustive coûterait cher sur une grosse
 * application pour un gain nul. Un mécanisme caché ailleurs sortira en
 * « inconnu », ce qui produit un avertissement — le bon comportement quand on
 * ne sait pas.
 * @param {string} appDir racine de l'application
 * @returns {Promise<string>} sources concaténées, vide si rien n'est lisible
 */
async function readAuthSources(appDir) {
  const fixes = [
    join(appDir, "app", "controllers", "application_controller.rb"),
    join(appDir, "app", "controllers", "sessions_controller.rb"),
  ];
  const concerns = join(appDir, "app", "controllers", "concerns");
  /** @type {string[]} */
  let entries = [];
  try {
    entries = (await readdir(concerns)).filter((name) => name.endsWith(".rb"));
  } catch (error) {
    if (!error || !ABSENT_CODES.includes(error.code)) throw error;
  }
  const chemins = [...fixes, ...entries.map((name) => join(concerns, name))];
  const textes = await Promise.all(chemins.map((chemin) => readOptionalFile(chemin)));
  return textes.filter(Boolean).join("\n");
}

/**
 * Noms des modèles de l'application, en minuscules et sans extension.
 * @param {string} appDir racine de l'application
 * @returns {Promise<readonly string[]>} noms de modèles, vide si le dossier manque
 */
async function readModelNames(appDir) {
  try {
    const entries = await readdir(join(appDir, "app", "models"));
    return Object.freeze(
      entries.filter((name) => name.endsWith(".rb")).map((name) => name.slice(0, -3).toLowerCase()),
    );
  } catch (error) {
    if (error && ABSENT_CODES.includes(error.code)) return Object.freeze([]);
    throw error;
  }
}

/** Répertoires où vit le JavaScript écrit par l'application. */
const JS_ROOTS = Object.freeze([
  ["app", "javascript"],
  ["app", "assets", "javascripts"],
]);

/** Extensions traitées comme du JavaScript applicatif. */
const JS_EXTENSIONS = Object.freeze([".js", ".mjs", ".jsx"]);

/**
 * Répertoires JAMAIS parcourus : ils portent des dépendances tierces, dont les
 * chemins absolus ne regardent pas l'auteur de l'application — et un seul
 * `node_modules` égaré suffirait à faire durer l'analyse des minutes.
 */
const JS_SKIPPED_DIRS = Object.freeze(["node_modules", "vendor", ".git"]);

/** Bornes du parcours : un dépôt mal rangé ne doit pas faire exploser l'analyse. */
const JS_MAX_DEPTH = 6;
const JS_MAX_FILES = 400;

/**
 * Lit le JavaScript de l'application, en tolérant l'absence des dossiers.
 * @param {string} appDir racine de l'application
 * @returns {Promise<{name: string, text: string}[]>} sources, chemins relatifs à la racine
 * @throws {Error} pour toute erreur autre qu'une absence (droits, E/S)
 */
async function readJavaScriptFiles(appDir) {
  /** @type {{name: string, text: string}[]} */
  const files = [];
  /**
   * @param {string} dir répertoire à parcourir
   * @param {string} relative même répertoire, vu depuis la racine de l'application
   * @param {number} depth profondeur courante, 0 à la racine du parcours
   * @returns {Promise<void>}
   */
  async function walk(dir, relative, depth) {
    if (depth > JS_MAX_DEPTH || files.length >= JS_MAX_FILES) return;
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && ABSENT_CODES.includes(error.code)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= JS_MAX_FILES) return;
      const chemin = join(dir, entry.name);
      const affiche = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (JS_SKIPPED_DIRS.includes(entry.name)) continue;
        await walk(chemin, affiche, depth + 1);
        continue;
      }
      if (!JS_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      // Un fichier disparu entre le readdir et la lecture n'est pas un incident.
      files.push({ name: affiche, text: (await readOptionalFile(chemin)) ?? "" });
    }
  }
  for (const parts of JS_ROOTS) await walk(join(appDir, ...parts), parts.join("/"), 0);
  return files;
}

/**
 * Extrait les adaptateurs déclarés dans un `config/database.yml`.
 * Les balises ERB sont retirées d'abord : elles rendent le fichier non-YAML.
 * @param {string} text contenu du fichier
 * @returns {string[]} adaptateurs rencontrés, sans doublon, dans l'ordre du fichier
 */
export function parseDatabaseAdapters(text) {
  if (typeof text !== "string") return [];
  const withoutErb = text.replace(ERB_TAG, "");
  const adapters = [];
  for (const match of withoutErb.matchAll(ADAPTER_LINE)) {
    const value = match[1]
      .split("#")[0]
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value && !adapters.includes(value)) adapters.push(value);
  }
  return adapters;
}

/**
 * Détermine la version de Ruby et sa provenance, par ordre de priorité.
 * @param {{rubyVersionFile: string|null, gemfile: string|null, lock: string|null}} sources
 * @returns {{version: string|null, source: string|null, findings: Finding[]}} résultat
 */
function detectRuby(sources) {
  const candidates = [
    [".ruby-version", normalizeRubyVersion(sources.rubyVersionFile)],
    ["Gemfile", normalizeRubyVersion(matchGroup(GEMFILE_RUBY, sources.gemfile))],
    ["Gemfile.lock", normalizeRubyVersion(matchGroup(LOCK_RUBY, sources.lock))],
  ];
  for (const [source, version] of candidates) {
    if (version) return { version, source, findings: [] };
  }
  const finding = createFinding(
    SEVERITY.WARNING,
    "missing-ruby-version",
    "Aucune version de Ruby détectée (.ruby-version, Gemfile ni Gemfile.lock).",
  );
  return { version: null, source: null, findings: [finding] };
}

/**
 * Confronte la contrainte de Ruby du Gemfile au Ruby fourni par la base.
 *
 * C'est LE refus amont que ce module doit produire : la détection connaît les
 * deux valeurs, et sans cette confrontation le désaccord n'éclatait qu'au
 * `bundle install` de app.Dockerfile, plusieurs minutes après le début de la
 * construction, sous la forme d'un `Bundler::RubyVersionMismatch`.
 * @param {{gemfile: string|null, rubyVersionFile: string|null, base: {version: string|null, ruby: string|null}}} sources
 * @returns {{requirement: {requirements: readonly string[], source: string}|null, findings: Finding[]}}
 */
function checkRubyRequirement({ gemfile, rubyVersionFile, base }) {
  const directive = parseRubyDirective(gemfile);
  // `ruby file: ".ruby-version"` est la seule forme où le fichier engage
  // Bundler ; seul est relu celui que la directive désigne.
  const referenced =
    directive?.kind === "file" && directive.path === ".ruby-version" ? rubyVersionFile : null;
  const requirement = resolveRubyRequirement(directive, referenced);
  if (!requirement) return { requirement: null, findings: [] };
  const verdict = satisfiesRubyRequirement(base.ruby, requirement.requirements);
  if (verdict !== false) return { requirement, findings: [] };
  const declared = requirement.requirements.join(", ");
  return {
    requirement,
    findings: [
      createFinding(
        SEVERITY.BLOCKING,
        "ruby-version-incompatible",
        `Le Gemfile exige Ruby « ${declared} » (source : ${requirement.source}) ; ` +
          `la base ${base.version} fournit ${base.ruby}.`,
        { required: declared, provided: base.ruby, base: base.version },
      ),
    ],
  };
}

/**
 * Relève `config.force_ssl` dans l'environnement de production.
 * @param {string|null} productionRb contenu de config/environments/production.rb
 * @returns {{ssl: object, findings: Finding[]}} réglages relevés et diagnostics
 */
function detectSsl(productionRb) {
  const settings = detectSslSettings(productionRb);
  const forced = isSslEnforced(settings.force_ssl);
  const ssl = Object.freeze({
    forceSsl: settings.force_ssl?.state ?? null,
    forceSslEnv: settings.force_ssl?.env ?? null,
    assumeSsl: settings.assume_ssl?.state ?? null,
    enforced: forced,
  });
  if (!forced) return { ssl, findings: [] };
  const par =
    settings.force_ssl.state === "conditionnel-actif"
      ? ` (via ${settings.force_ssl.env}, active par défaut)`
      : "";
  return {
    ssl,
    findings: [
      createFinding(
        SEVERITY.INFO,
        "force-ssl-enabled",
        `config/environments/production.rb ligne ${settings.force_ssl.line} active ` +
          `config.force_ssl${par} ; la sandbox sert l'application en clair derrière le pont ` +
          "série — railsbox le neutralise dans le guest.",
        { line: settings.force_ssl.line, env: settings.force_ssl.env ?? undefined },
      ),
    ],
  };
}

/**
 * Applique une expression régulière à un contenu éventuellement absent.
 * @param {RegExp} pattern expression à un groupe capturant
 * @param {string|null} text contenu à analyser
 * @returns {string|null} premier groupe capturé, ou `null`
 */
function matchGroup(pattern, text) {
  if (typeof text !== "string") return null;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

/**
 * Vérifie que le dossier contient bien une application Rails.
 * @param {string|null} gemfile contenu du Gemfile
 * @param {Map<string, string>} specs gems résolues
 * @returns {{version: string|null, findings: Finding[]}} version de Rails et diagnostics
 */
function detectRails(gemfile, specs) {
  const locked = specs.get("rails");
  if (locked) return { version: locked, findings: [] };
  if (typeof gemfile === "string" && GEMFILE_RAILS.test(gemfile)) {
    return {
      version: null,
      findings: [
        createFinding(
          SEVERITY.INFO,
          "rails-version-unknown",
          "Rails est déclaré dans le Gemfile mais absent du Gemfile.lock : version inconnue.",
        ),
      ],
    };
  }
  return {
    version: null,
    findings: [
      createFinding(
        SEVERITY.BLOCKING,
        "not-a-rails-app",
        "Aucune trace de Rails : ni gem « rails » dans le Gemfile.lock, ni dans le Gemfile.",
      ),
    ],
  };
}

/**
 * Base supposée quand `config/database.yml` ne dit rien d'exploitable.
 *
 * Le Gemfile.lock tranche mieux qu'un défaut aveugle : un `database.yml`
 * entièrement piloté par ERB (`url: <%= ENV["DATABASE_URL"] %>`, forme
 * courante des applications déployées sur un PaaS) n'expose aucun `adapter:`,
 * mais la gem `pg` ne se trouve dans le verrou que si l'application parle bien
 * à PostgreSQL. Supposer sqlite3 dans ce cas produisait une image sans cluster
 * et une application qui refuse de démarrer — très loin de la cause.
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @returns {string} adaptateur supposé
 */
function fallbackDatabase(specs) {
  return specs.has("pg") ? "postgresql" : "sqlite3";
}

/**
 * Choisit la base de données à provisionner à partir de `config/database.yml`,
 * le Gemfile.lock servant d'arbitre quand le fichier ne déclare rien.
 * @param {string|null} databaseYml contenu du fichier, `null` s'il est absent
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @returns {{database: string, findings: Finding[]}} adaptateur retenu et diagnostics
 */
function detectDatabase(databaseYml, specs) {
  if (databaseYml === null) {
    const database = fallbackDatabase(specs);
    return {
      database,
      findings: [
        createFinding(
          SEVERITY.WARNING,
          "missing-database-config",
          `config/database.yml est absent : ${database} est supposé par défaut.`,
        ),
      ],
    };
  }
  const adapters = parseDatabaseAdapters(databaseYml);
  const blocked = adapters.filter((adapter) => UNSUPPORTED_ADAPTERS.includes(adapter));
  const supported = adapters.filter((adapter) => SUPPORTED_ADAPTERS.includes(adapter));
  /** @type {Finding[]} */
  const findings = [];
  for (const adapter of blocked) {
    findings.push(
      createFinding(
        SEVERITY.BLOCKING,
        "unsupported-database",
        `Adaptateur « ${adapter} » : MySQL pas encore supporté par les images de base.`,
        { adapter },
      ),
    );
  }
  if (supported.length === 0 && blocked.length === 0) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "missing-database-adapter",
        `Aucune clé adapter: exploitable dans config/database.yml : ${fallbackDatabase(specs)} est supposé.`,
      ),
    );
  }
  if (supported.length > 1) {
    findings.push(
      createFinding(
        SEVERITY.INFO,
        "database-adapter-ambiguous",
        `Plusieurs adaptateurs supportés (${supported.join(", ")}) : « ${supported[0]} » retenu.`,
      ),
    );
  }
  const database = supported[0] ?? fallbackDatabase(specs);
  // La gem pg est le seul moyen pour Rails de parler à PostgreSQL : sans elle
  // le cluster démarrerait dans la VM pour rien, et l'application échouerait au
  // premier accès à la base. Averti ici plutôt que découvert dans les journaux
  // de boot, dix minutes après le début de la construction.
  if (database === "postgresql" && !specs.has("pg")) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "missing-pg-gem",
        "PostgreSQL est demandé mais la gem « pg » est absente du Gemfile.lock.",
      ),
    );
  }
  return { database, findings };
}

/**
 * Décrit le pipeline d'assets à partir du `package.json`.
 * @param {string|null} packageJson contenu du fichier, `null` s'il est absent
 * @returns {{assets: Manifest["assets"], findings: Finding[]}} description et diagnostics
 */
function detectAssets(packageJson) {
  if (packageJson === null) {
    return {
      assets: Object.freeze({ npm: false, scripts: Object.freeze([]), tools: Object.freeze([]) }),
      findings: [
        createFinding(
          SEVERITY.INFO,
          "no-npm-assets",
          "Pas de package.json : pipeline importmap/sprockets supposé, aucun build npm.",
        ),
      ],
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(packageJson);
  } catch (error) {
    return {
      assets: Object.freeze({ npm: true, scripts: Object.freeze([]), tools: Object.freeze([]) }),
      findings: [
        createFinding(
          SEVERITY.WARNING,
          "invalid-package-json",
          `package.json illisible (${error.message}) : scripts d'assets non détectés.`,
        ),
      ],
    };
  }
  const scripts = KNOWN_BUILD_SCRIPTS.filter((name) => Boolean(parsed?.scripts?.[name]));
  const declared = { ...(parsed?.dependencies ?? {}), ...(parsed?.devDependencies ?? {}) };
  const tools = KNOWN_ASSET_TOOLS.filter((name) => name in declared);
  return {
    assets: Object.freeze({
      npm: true,
      scripts: Object.freeze(scripts),
      tools: Object.freeze(tools),
    }),
    findings: [],
  };
}

/**
 * Inspecte une application Rails et en déduit le manifeste de build.
 * @param {string} appDir racine de l'application à analyser
 * @param {{base?: string}} [options] version (ou référence d'image) de la base visée
 * @returns {Promise<{manifest: Manifest, findings: readonly Finding[]}>} manifeste gelé et diagnostics
 * @throws {TypeError} si `appDir` n'est pas un chemin exploitable
 */
export async function detectApp(appDir, options = {}) {
  if (typeof appDir !== "string" || appDir.trim() === "") {
    throw new TypeError("detectApp attend le chemin du dossier de l'application");
  }
  const base = resolveBase(options.base ?? DEFAULT_BASE);
  const [
    rubyVersionFile,
    gemfile,
    lock,
    databaseYml,
    packageJson,
    productionRb,
    lockfiles,
    viteJson,
    shakapackerYml,
    webpackerYml,
    migrations,
    javascriptFiles,
    seedsRb,
    sourcesAuth,
    nomsModeles,
  ] = await Promise.all([
    readOptionalFile(join(appDir, ".ruby-version")),
    readOptionalFile(join(appDir, "Gemfile")),
    readOptionalFile(join(appDir, "Gemfile.lock")),
    readOptionalFile(join(appDir, "config", "database.yml")),
    readOptionalFile(join(appDir, "package.json")),
    readOptionalFile(join(appDir, "config", "environments", "production.rb")),
    detectNpmLockfiles(appDir),
    // Configurations des empaqueteurs qui écrivent HORS des deux répertoires
    // exportés par défaut : lues pour que l'auto-détection couvre le cas
    // courant sans que le mainteneur ait rien à écrire.
    readOptionalFile(join(appDir, "config", "vite.json")),
    readOptionalFile(join(appDir, "config", "shakapacker.yml")),
    readOptionalFile(join(appDir, "config", "webpacker.yml")),
    // Les migrations elles-mêmes : railsbox doit savoir si certaines AMORCENT
    // des données, car `db:prepare` sur une base vierge charge db/schema.rb et
    // n'en joue aucune (voir migrations.mjs).
    readMigrations(appDir),
    // Le JavaScript de l'application : railsbox doit savoir si des appels
    // réseau visent la racine du DOMAINE, ce qu'aucun test GET ne révèle —
    // la page s'affiche, et c'est le premier clic qui casse (chemins-absolus-js).
    readJavaScriptFiles(appDir),
    // Le jeu de démonstration : lu ici, jugé après la fusion de railsbox.yml —
    // une commande de seed déclarée l'emporte sur ce fichier (donnees-demo.mjs).
    readOptionalFile(join(appDir, "db", "seeds.rb")),
    // Le mécanisme d'authentification : railsbox promet « le visiteur arrive
    // connecté », et cette promesse n'a de sens que s'il sait OÙ l'application
    // ira chercher la session. Quand il ne le sait pas, il doit le dire.
    readAuthSources(appDir),
    readModelNames(appDir),
  ]);

  /** @type {Finding[]} */
  const findings = [];
  const specs = parseLockSpecs(lock);
  if (lock === null) {
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "missing-gemfile-lock",
        "Gemfile.lock absent : les gems natives et les services ne peuvent pas être détectés.",
      ),
    );
  }

  const ruby = detectRuby({ rubyVersionFile, gemfile, lock });
  findings.push(...ruby.findings);
  // La contrainte du Gemfile est confrontée au Ruby de la BASE, pas à celle
  // que la détection retient : `manifest.ruby` ne pilote que la série (donc la
  // base choisie) et l'image de l'étage amd64 — le Ruby du guest, lui, est
  // compilé dans la base et rien ne peut l'y changer.
  const requirement = checkRubyRequirement({ gemfile, rubyVersionFile, base });
  findings.push(...requirement.findings);
  if (base.ruby === null) {
    const quelle = base.version
      ? `Base « ${base.version} » inconnue de railsbox`
      : "Base non précisée";
    findings.push(
      createFinding(
        SEVERITY.INFO,
        "base-ruby-unknown",
        `${quelle} : la compatibilité de la contrainte Ruby du Gemfile n'a pas pu être vérifiée.`,
        { base: base.version },
      ),
    );
  }
  const rails = detectRails(gemfile, specs);
  findings.push(...rails.findings);
  const database = detectDatabase(databaseYml, specs);
  findings.push(...database.findings);
  // L'état du pilote sqlite3 entre dans le manifeste : la base FINALEMENT
  // retenue peut changer à la fusion de railsbox.yml (« database: sqlite3 »),
  // et le verdict doit alors être réévalué avec les mêmes données.
  const adapters = parseDatabaseAdapters(databaseYml ?? "");
  const sqlite = sqliteDriverState(gemfile, specs, lock !== null);
  findings.push(...sqliteDriverFindings({ state: sqlite, database: database.database, adapters }));
  findings.push(...externalServiceFindings(specs.keys()));
  findings.push(...absolutePathFindings(scanAbsolutePaths(javascriptFiles)));
  const dataMigrations = scanDataMigrations(migrations);
  findings.push(...dataMigrationFindings(dataMigrations));
  const ssl = detectSsl(productionRb);
  findings.push(...ssl.findings);
  const assets = detectAssets(packageJson);
  findings.push(...assets.findings);
  // L'étage de précompilation se décide ici et nulle part ailleurs : il dépend
  // à la fois du package.json (chaîne npm) et du Gemfile.lock (gems à binaire).
  const outputs = detectOutputDirs({ specs, viteJson, shakapackerYml, webpackerYml });
  findings.push(...outputs.findings);
  const assetPlan = planAssets({
    assets: assets.assets,
    specs,
    lockfiles,
    outputDirs: outputs.dirs,
  });
  findings.push(...assetPlan.findings);
  const native = collectNativeGems(specs);
  findings.push(...native.findings);
  // mysql2 dans le lock est aussi bloquant, mais inutile de le signaler deux
  // fois quand database.yml a déjà déclenché le même code.
  const alreadyBlocked = findings.some((finding) => finding.code === "unsupported-database");
  if (specs.has("mysql2") && !alreadyBlocked) {
    findings.push(
      createFinding(
        SEVERITY.BLOCKING,
        "unsupported-database",
        "Gem « mysql2 » présente : MySQL pas encore supporté par les images de base.",
        { adapter: "mysql2" },
      ),
    );
  }

  const bundler = parseBundlerVersion(lock);
  if (bundler) {
    findings.push(
      createFinding(
        SEVERITY.INFO,
        "bundler-version",
        `Gemfile.lock produit par Bundler ${bundler}.`,
      ),
    );
  }

  const manifest = deepFreeze({
    ruby: ruby.version,
    rubySource: ruby.source,
    // Le Ruby que le guest exécutera VRAIMENT, et d'où il vient. Sans ces deux
    // champs, le rapport laissait croire que `ruby:` choisissait l'interpréteur.
    base: base.version,
    baseRuby: base.ruby,
    rubyRequirement: requirement.requirement
      ? {
          requirements: requirement.requirement.requirements,
          source: requirement.requirement.source,
        }
      : null,
    rails: rails.version,
    database: database.database,
    databaseAdapters: Object.freeze(adapters),
    // Noms des migrations qui écrivent des lignes : ce sont eux qui décident,
    // en mode « auto », de préparer la base en jouant les migrations.
    dataMigrations: Object.freeze(dataMigrations.map((entry) => entry.file)),
    // État du db/seeds.rb (absent, vide, utile). Aucun diagnostic ici : le
    // verdict dépend aussi de `seed.command`, qui n'arrive qu'à la fusion.
    seedsFile: etatFichierSeeds(seedsRb),
    sqliteDriver: sqlite,
    // Mécanisme d'authentification reconnu. Aucun diagnostic ici : il ne devient
    // un problème que si `auto_login` est déclaré, et cette clé n'arrive qu'à la
    // fusion de railsbox.yml.
    authMecanisme: detectMecanismeAuth({
      gems: [...specs.keys()],
      sources: sourcesAuth,
      modeles: nomsModeles,
    }),
    ssl: ssl.ssl,
    bundler,
    assets: assetPlan.plan,
    nativeGems: native.nativeGems,
    services: detectServices(specs),
  });
  return { manifest, findings: Object.freeze(findings) };
}
