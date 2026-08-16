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
import { buildAutoLoginInitializer } from "./auto-login.mjs";
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

/**
 * Répertoire de données du cluster PostgreSQL — SUR LE DISQUE APPLICATIF.
 *
 * C'est le choix structurant de la prise en charge de PostgreSQL (ADR 0002) :
 * le datadir voyage avec l'application, donc l'état déjà migré et seedé au
 * build est capturé dans l'ext2 applicatif, exactement comme le fichier
 * sqlite3. Corollaire : le cluster ne peut démarrer qu'APRÈS le montage de hdb,
 * jamais dans l'init de la base — dont l'instantané fige les processus.
 */
export const PG_DATA_DIR = "/app/var/pg";

/** Port du cluster dans la VM : loopback interne, jamais exposé au navigateur. */
export const PG_PORT = "5432";

/** Rôle du cluster de démonstration. */
export const PG_ROLE = "postgres";

/**
 * Mot de passe du rôle de démonstration. Ce n'est PAS un secret : la VM n'a
 * aucun réseau sortant, le cluster n'écoute que sur le loopback émulé et chaque
 * visiteur a sa propre copie jetable (voir SECURITY.md). Il n'existe que pour
 * satisfaire les `config/database.yml` qui exigent un mot de passe.
 */
export const PG_PASSWORD = "postgres";

/**
 * Dérive un nom de base PostgreSQL valide du nom court de la sandbox.
 * Les identifiants non cités n'acceptent que lettres, chiffres et souligné, et
 * ne commencent pas par un chiffre : « mon-app » deviendrait sinon une syntaxe
 * invalide dans la moitié des outils qui manipulent ce nom.
 * @param {string} appName nom court de la sandbox
 * @returns {string} nom de base, suffixé par l'environnement Rails servi
 */
export function postgresDatabaseName(appName) {
  const cleaned = String(appName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = cleaned === "" || /^\d/.test(cleaned) ? `app_${cleaned}` : cleaned;
  return `${stem.replace(/_+$/, "")}_production`;
}

/**
 * Décrit le cluster PostgreSQL d'une sandbox : emplacement, nom de base et URL
 * de connexion. Centralisé ici pour que le disque applicatif, l'init du guest
 * et la documentation ne divergent jamais.
 * @param {string} appName nom court de la sandbox
 * @returns {{dataDir: string, database: string, port: string, role: string, url: string}}
 */
export function postgresSettings(appName) {
  const database = postgresDatabaseName(appName);
  return {
    dataDir: PG_DATA_DIR,
    database,
    port: PG_PORT,
    role: PG_ROLE,
    // sslmode=disable : le cluster est local à la VM, une poignée de main TLS
    // ne protégerait rien et coûterait cher sous émulation.
    url: `postgresql://${PG_ROLE}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${database}?sslmode=disable`,
  };
}

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

/**
 * Gems dont la précompilation d'assets passe par un EXÉCUTABLE précompilé,
 * publié par plateforme — et jamais pour i386.
 *
 * Vérifié le 2026-08-16 sur rubygems : `tailwindcss-ruby`, dont dépend
 * tailwindcss-rails, ne publie que aarch64-linux, arm64-darwin, x86_64-linux,
 * x86_64-darwin et mingw ; `dartsass-ruby` télécharge de même un binaire
 * x86_64. Dans la base i386, `rails assets:precompile` échoue donc sur un
 * « executable not found » ou un ELF illisible, très loin de la cause.
 *
 * Ce n'est pas une impasse de fond : ces outils produisent du CSS et du JS
 * ordinaires, indépendants de l'architecture. Les faire tourner sur l'hôte
 * amd64 puis copier `public/assets` dans le disque i386 lèverait la limite —
 * c'est le chantier à ouvrir pour couvrir les applications Tailwind.
 */
const BINARY_ASSET_GEMS = Object.freeze(["tailwindcss-rails", "dartsass-rails"]);

/**
 * Gems à outillage binaire présentes dans le verrou.
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @returns {string[]} noms détectés, triés
 */
export function binaryAssetGems(specs) {
  return BINARY_ASSET_GEMS.filter((gem) => specs.has(gem)).sort();
}

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
  const withPostgres = manifest.database === "postgresql";
  const postgres = postgresSettings(appName);
  return {
    APP_NAME: appName,
    RUBY_VERSION: ruby.version,
    DATABASE: manifest.database ?? "sqlite3",
    WITH_POSTGRES: withPostgres ? "1" : "0",
    // Version majeure de PostgreSQL fournie par la base Debian bookworm i386.
    // Centralisée ici pour que build.sh et le Dockerfile ne divergent pas.
    PG_VERSION: DEFAULT_PG_VERSION,
    // Cluster de la sandbox — vide pour une application sqlite3, afin qu'un
    // disque applicatif ne porte jamais de réglage PostgreSQL inutile.
    PG_DATA_DIR: withPostgres ? postgres.dataDir : "",
    PG_DATABASE: withPostgres ? postgres.database : "",
    PG_DATABASE_URL: withPostgres ? postgres.url : "",
    WITH_REDIS: manifest.services?.redis ? "1" : "0",
    NPM_ASSETS: assets.npm ? "1" : "0",
    ASSET_SCRIPTS: assets.scripts.join(" "),
    ASSET_PRECOMPILE: assets.precompile ? "1" : "0",
    // Outils d'assets à binaire précompilé : aucun n'existe pour i386.
    BINARY_ASSET_GEMS: binaryAssetGems(specs).join(" "),
    EXTRA_PACKAGES: extraPackages(manifest).join(" "),
    DB_PREPARE_COMMAND: DEFAULT_DB_PREPARE,
    SEED_COMMAND: seedCommand,
    // Non fiable (railsbox.yml tiers) : ajouté verbatim, jamais évalué.
    APP_ENV_MANIFEST: formatEnvFragment(manifest.env),
    // Initialiseur d'auto-connexion, vide si le manifeste n'en demande pas.
    // Même discipline : déposé tel quel dans l'arbre applicatif, exécuté par
    // le seul guest, jamais évalué à la construction.
    AUTO_LOGIN_INITIALIZER: buildAutoLoginInitializer({
      autoLogin: manifest.seed?.autoLogin ?? null,
      autoLoginCode: manifest.seed?.autoLoginCode ?? null,
    }),
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
