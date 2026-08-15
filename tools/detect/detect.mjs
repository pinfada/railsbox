// Auto-détection d'une application Rails : produit le manifeste de build que
// railsbox utilisera pour préparer l'image. Tout est tolérant à l'absence de
// fichier — un projet incomplet doit donner un rapport, jamais une exception.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SEVERITY, createFinding } from "./findings.mjs";
import { collectNativeGems, detectServices, parseBundlerVersion, parseLockSpecs } from "./gems.mjs";
import { deepFreeze } from "./manifest.mjs";

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

// `3.3.10p91`, `ruby-3.3.10`, `~> 3.3` : on ne garde que les composants numériques.
const RUBY_VERSION = /^(?:ruby-)?v?(\d+(?:\.\d+){0,2})/;
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
 * Normalise une version de Ruby quelle que soit sa forme d'écriture.
 * @param {string|null} raw valeur brute (`ruby-3.3.10`, `~> 3.3`, `3.3.10p91`...)
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
 * Choisit la base de données à provisionner à partir de `config/database.yml`.
 * @param {string|null} databaseYml contenu du fichier, `null` s'il est absent
 * @returns {{database: string, findings: Finding[]}} adaptateur retenu et diagnostics
 */
function detectDatabase(databaseYml) {
  if (databaseYml === null) {
    return {
      database: "sqlite3",
      findings: [
        createFinding(
          SEVERITY.WARNING,
          "missing-database-config",
          "config/database.yml est absent : sqlite3 est supposé par défaut.",
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
        "Aucune clé adapter: exploitable dans config/database.yml : sqlite3 est supposé.",
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
  return { database: supported[0] ?? "sqlite3", findings };
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
 * @returns {Promise<{manifest: Manifest, findings: readonly Finding[]}>} manifeste gelé et diagnostics
 * @throws {TypeError} si `appDir` n'est pas un chemin exploitable
 */
export async function detectApp(appDir) {
  if (typeof appDir !== "string" || appDir.trim() === "") {
    throw new TypeError("detectApp attend le chemin du dossier de l'application");
  }
  const [rubyVersionFile, gemfile, lock, databaseYml, packageJson] = await Promise.all([
    readOptionalFile(join(appDir, ".ruby-version")),
    readOptionalFile(join(appDir, "Gemfile")),
    readOptionalFile(join(appDir, "Gemfile.lock")),
    readOptionalFile(join(appDir, "config", "database.yml")),
    readOptionalFile(join(appDir, "package.json")),
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
  const rails = detectRails(gemfile, specs);
  findings.push(...rails.findings);
  const database = detectDatabase(databaseYml);
  findings.push(...database.findings);
  const assets = detectAssets(packageJson);
  findings.push(...assets.findings);
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
    rails: rails.version,
    database: database.database,
    bundler,
    assets: assets.assets,
    nativeGems: native.nativeGems,
    services: detectServices(specs),
  });
  return { manifest, findings: Object.freeze(findings) };
}
