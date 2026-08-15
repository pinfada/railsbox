#!/usr/bin/env node
// Traduit le manifeste d'une application Rails (auto-détection + railsbox.yml)
// en arguments de construction du Dockerfile paramétré.
//
//   node tools/build-v86-image/manifest-to-args.mjs <dossier-application> [--json]
//
// Sortie standard : des affectations shell `CLE='valeur'` (consommables par
// `eval`), ou le manifeste et les arguments en JSON avec --json. Le rapport
// d'analyse part sur la sortie d'erreur : il informe sans polluer les données.
// Sort en 1 si un diagnostic bloquant existe, 2 en cas d'échec de l'analyse.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectApp, readOptionalFile } from "../detect/detect.mjs";
import { createFinding, SEVERITY } from "../detect/findings.mjs";
import { parseLockSpecs } from "../detect/gems.mjs";
import { mergeManifest, parseRailsboxYml } from "../detect/manifest.mjs";
import { formatReport, hasBlocking } from "../detect/report.mjs";

/** @typedef {import("../detect/manifest.mjs").Manifest} Manifest */

const EXIT_BLOCKING = 1;
const EXIT_USAGE = 2;

/**
 * Dernier niveau de correctif connu pour chaque série de Ruby. Une version
 * partielle (« 3.2 ») ne peut pas être téléchargée telle quelle : les archives
 * de cache.ruby-lang.org sont nommées par version complète.
 */
export const RUBY_PATCH_LEVELS = Object.freeze({
  3.1: "3.1.7",
  3.2: "3.2.9",
  3.3: "3.3.12",
  3.4: "3.4.5",
});

/** Version retenue quand l'application n'en déclare aucune. */
export const DEFAULT_RUBY_VERSION = "3.3.12";

/** Version majeure de PostgreSQL de la base Debian bookworm i386. */
export const DEFAULT_PG_VERSION = "15";

/** Paquets Debian fournissant chaque bibliothèque système réclamée par une gem. */
const SYSTEM_LIB_PACKAGES = Object.freeze({
  libpq: Object.freeze(["libpq-dev"]),
  libsqlite3: Object.freeze(["libsqlite3-dev"]),
  libvips: Object.freeze(["libvips42", "libvips-dev"]),
  libxml2: Object.freeze(["libxml2-dev"]),
  libxslt: Object.freeze(["libxslt1-dev"]),
  // libsass : sassc compile sa copie embarquée, aucun paquet système utile.
  libsass: Object.freeze([]),
  // libmysqlclient : MySQL est bloqué en amont par la détection.
  libmysqlclient: Object.freeze([]),
});

/** Paquets Debian propres à chaque base de données supportée. */
const DATABASE_PACKAGES = Object.freeze({
  postgresql: Object.freeze(["postgresql", "postgresql-client", "libpq-dev"]),
  sqlite3: Object.freeze(["libsqlite3-dev"]),
});

/** Gems trahissant un pipeline d'assets à précompiler sans npm. */
const ASSET_PIPELINE_GEMS = Object.freeze([
  "propshaft",
  "sprockets-rails",
  "sprockets",
  "dartsass-rails",
  "cssbundling-rails",
  "jsbundling-rails",
  "importmap-rails",
]);

/** Commande de préparation de la base par défaut (crée, migre, charge le schéma). */
const DEFAULT_DB_PREPARE = "bundle exec rails db:prepare";

/** Commande de seed par défaut, utilisée quand `db/seeds.rb` existe. */
const DEFAULT_SEED = "bundle exec rails db:seed";

/**
 * Résout une version de Ruby en version complète téléchargeable.
 * @param {string|null|undefined} version version détectée (`3.3.12`, `3.2`, ...)
 * @returns {{version: string, resolved: boolean}} version complète et indicateur de résolution
 * @throws {Error} si la série majeure.mineure est inconnue de la table
 */
export function resolveRubyVersion(version) {
  if (typeof version !== "string" || version.trim() === "") {
    return { version: DEFAULT_RUBY_VERSION, resolved: false };
  }
  const parts = version.trim().split(".");
  if (parts.length >= 3) return { version: parts.slice(0, 3).join("."), resolved: false };
  const series = parts.slice(0, 2).join(".");
  const patched = RUBY_PATCH_LEVELS[series];
  if (!patched) {
    throw new Error(
      `Version de Ruby « ${version} » incomplète et série inconnue : ` +
        `épinglez une version complète (ruby: X.Y.Z) dans railsbox.yml.`,
    );
  }
  return { version: patched, resolved: true };
}

/**
 * Liste les paquets Debian à installer en plus de la base commune.
 * @param {Manifest} manifest manifeste fusionné
 * @returns {string[]} noms de paquets, triés et sans doublon
 */
export function extraPackages(manifest) {
  const packages = new Set(DATABASE_PACKAGES[manifest.database] ?? []);
  for (const gem of manifest.nativeGems ?? []) {
    for (const lib of gem.systemLibs ?? []) {
      for (const name of SYSTEM_LIB_PACKAGES[lib] ?? []) packages.add(name);
    }
  }
  if (manifest.services?.redis) packages.add("redis-server");
  return [...packages].sort();
}

/**
 * Décrit le pipeline d'assets à exécuter pendant la construction.
 * @param {Manifest} manifest manifeste fusionné
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @returns {{npm: boolean, scripts: string[], precompile: boolean}} plan d'assets
 */
export function assetsPlan(manifest, specs) {
  const npm = Boolean(manifest.assets?.npm);
  const scripts = [...(manifest.assets?.scripts ?? [])];
  const precompile = ASSET_PIPELINE_GEMS.some((gem) => specs.has(gem));
  return { npm, scripts, precompile };
}

/**
 * Sérialise les variables d'environnement déclarées en fragment shell.
 *
 * SÉCURITÉ : ce fragment provient de railsbox.yml, donc de code TIERS et non
 * fiable. Chaque valeur est mise entre apostrophes (apostrophes internes
 * échappées) et le fragment est destiné à être ajouté VERBATIM au fichier
 * d'environnement — jamais évalué. Une valeur telle que `$(commande)` reste
 * ainsi une chaîne littérale et n'est pas exécutée au build (cf. Dockerfile :
 * APP_ENV_MANIFEST est concaténé sans `eval`, contrairement au --env-file de
 * confiance qui, lui, peut contenir des `$(openssl rand …)` à figer).
 * @param {Record<string, string>|undefined} env variables issues de railsbox.yml
 * @returns {string} lignes `export NOM='valeur'`, vide si aucune variable
 */
export function formatEnvFragment(env) {
  if (!env) return "";
  const names = Object.keys(env).sort();
  if (names.length === 0) return "";
  return `${names.map((name) => `export ${name}=${shellQuote(env[name])}`).join("\n")}\n`;
}

/**
 * Construit la table des arguments de construction Docker.
 * @param {{manifest: Manifest, specs: Map<string, string>, hasSeeds: boolean, appName: string}} input contexte d'analyse
 * @returns {Record<string, string>} arguments prêts à passer en `--build-arg`
 * @throws {Error} si la version de Ruby ne peut pas être résolue
 */
export function buildArgs({ manifest, specs, hasSeeds, appName }) {
  const ruby = resolveRubyVersion(manifest.ruby);
  const assets = assetsPlan(manifest, specs);
  const seedCommand = manifest.seed?.command ?? (hasSeeds ? DEFAULT_SEED : "");
  return {
    APP_NAME: appName,
    RUBY_VERSION: ruby.version,
    DATABASE: manifest.database ?? "sqlite3",
    WITH_POSTGRES: manifest.database === "postgresql" ? "1" : "0",
    // Version majeure de PostgreSQL fournie par la base Debian bookworm i386.
    // Centralisée ici pour que build.sh et le Dockerfile ne divergent pas.
    PG_VERSION: DEFAULT_PG_VERSION,
    WITH_REDIS: manifest.services?.redis ? "1" : "0",
    NPM_ASSETS: assets.npm ? "1" : "0",
    ASSET_SCRIPTS: assets.scripts.join(" "),
    ASSET_PRECOMPILE: assets.precompile ? "1" : "0",
    EXTRA_PACKAGES: extraPackages(manifest).join(" "),
    DB_PREPARE_COMMAND: DEFAULT_DB_PREPARE,
    SEED_COMMAND: seedCommand,
    // Non fiable (railsbox.yml tiers) : ajouté verbatim, jamais évalué.
    APP_ENV_MANIFEST: formatEnvFragment(manifest.env),
  };
}

/**
 * Met les arguments en forme d'affectations shell consommables par `eval`.
 * @param {Record<string, string>} args arguments de construction
 * @returns {string} lignes `CLE='valeur'`
 */
export function formatAssignments(args) {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n");
}

/**
 * Protège une valeur pour une insertion littérale dans du shell POSIX.
 * @param {string} value valeur brute
 * @returns {string} valeur entre apostrophes, apostrophes internes échappées
 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Analyse une application et en déduit manifeste, diagnostics et arguments.
 * @param {string} appDir racine de l'application Rails
 * @param {string} [appName] nom court de l'image (défaut : nom du dossier)
 * @returns {Promise<{manifest: Manifest, findings: readonly any[], args: Record<string, string>, report: string}>} analyse complète
 */
export async function analyzeApp(appDir, appName) {
  const detected = await detectApp(appDir);
  const findings = [...detected.findings];
  let manifest = detected.manifest;

  const declaredText = await readOptionalFile(join(appDir, "railsbox.yml"));
  if (declaredText !== null) {
    const declared = parseRailsboxYml(declaredText);
    findings.push(...declared.findings);
    const merged = mergeManifest(manifest, declared.manifest);
    manifest = merged.manifest;
    findings.push(...merged.findings);
  }

  const [lock, seeds] = await Promise.all([
    readOptionalFile(join(appDir, "Gemfile.lock")),
    readOptionalFile(join(appDir, "db", "seeds.rb")),
  ]);
  const specs = parseLockSpecs(lock);

  // Une série de Ruby irrésoluble est un diagnostic BLOQUANT, pas une
  // exception : ainsi le rapport structuré (avec son remède) est présenté à
  // l'utilisateur comme pour MySQL ou un dossier qui n'est pas une app Rails,
  // au lieu de n'afficher qu'un message d'erreur nu.
  try {
    resolveRubyVersion(manifest.ruby);
  } catch {
    findings.push(
      createFinding(
        SEVERITY.BLOCKING,
        "unresolvable-ruby-series",
        `Version de Ruby « ${manifest.ruby} » incomplète et série inconnue.`,
        { ruby: manifest.ruby },
      ),
    );
  }

  const report = formatReport({ manifest, findings });
  if (hasBlocking(findings)) {
    return { manifest, findings, args: {}, report };
  }
  const args = buildArgs({
    manifest,
    specs,
    hasSeeds: seeds !== null && seeds.trim() !== "",
    appName: appName ?? defaultAppName(appDir),
  });
  return { manifest, findings, args, report };
}

/**
 * Déduit un nom d'image du chemin de l'application.
 * @param {string} appDir chemin, éventuellement terminé par un séparateur
 * @returns {string} nom en minuscules, caractères exotiques remplacés
 */
export function defaultAppName(appDir) {
  const segments = String(appDir)
    .split(/[\\/]+/)
    .filter(Boolean);
  const last = segments[segments.length - 1] ?? "app";
  return last.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

async function main() {
  const args = process.argv.slice(2);
  const wantsJson = args.includes("--json");
  const positional = args.filter((value) => !value.startsWith("--"));
  const appDir = positional[0];
  const appName = positional[1];
  if (!appDir) {
    process.stderr.write(
      "Usage : node tools/build-v86-image/manifest-to-args.mjs <dossier-application> [nom] [--json]\n",
    );
    return EXIT_USAGE;
  }
  const analysis = await analyzeApp(appDir, appName);
  process.stderr.write(`${analysis.report}\n`);
  if (hasBlocking(analysis.findings)) return EXIT_BLOCKING;
  process.stdout.write(
    wantsJson
      ? `${JSON.stringify({ manifest: analysis.manifest, args: analysis.args }, null, 2)}\n`
      : `${formatAssignments(analysis.args)}\n`,
  );
  return 0;
}

// Exécution directe seulement : le module est aussi importé par les tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`Échec de l'analyse : ${error.message}\n`);
      process.exitCode = EXIT_USAGE;
    },
  );
}
