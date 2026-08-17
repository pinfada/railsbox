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
import { ASSET_STAGE, binaryAssetGems, planAssets } from "../detect/assets.mjs";
import { detectApp, readOptionalFile } from "../detect/detect.mjs";
import { createFinding, SEVERITY } from "../detect/findings.mjs";
import { parseLockSpecs } from "../detect/gems.mjs";
import { mergeManifest, parseRailsboxYml } from "../detect/manifest.mjs";
import { KEEP_FORCE_SSL_VALUE, KEEP_FORCE_SSL_VARIABLE } from "../detect/ssl.mjs";
import { buildAutoLoginInitializer } from "./auto-login.mjs";
import { buildForceSslInitializer } from "./force-ssl.mjs";
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

/**
 * Emplacement du fichier sqlite3 servi dans la VM, RELATIF à la racine de
 * l'application.
 *
 * Relatif et non absolu : l'arbre est sous /app aussi bien à la construction
 * (WORKDIR de app.Dockerfile) qu'à l'exécution (start-app.sh monte hdb sur
 * /app puis `cd /app`), mais un chemin relatif reste correct même si cette
 * convention change. Rails le résout à partir de Rails.root.
 */
export const SQLITE_DATABASE_PATH = "storage/production.sqlite3";

/**
 * URL de connexion posée quand la base retenue est sqlite3.
 *
 * Sans elle, la clé `database: sqlite3` était un vœu pieux : le build tourne
 * en RAILS_ENV=production et l'application lisait le bloc `production:` de son
 * propre config/database.yml — souvent PostgreSQL-only sur une application
 * déployée. DATABASE_URL, elle, a la priorité sur database.yml : l'override
 * devient réel.
 */
export const SQLITE_DATABASE_URL = `sqlite3:${SQLITE_DATABASE_PATH}`;

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

// La classification du pipeline d'assets (et donc l'étage de précompilation)
// vit dans tools/detect/assets.mjs : elle sert au rapport d'analyse comme aux
// arguments de construction, et ne doit exister qu'une fois.
export { binaryAssetGems };

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
 *
 * `precompile` ne vaut plus que pour la précompilation DANS le guest i386 :
 * quand l'étage amd64 s'en charge, le disque applicatif ne fait que recevoir
 * `public/assets` — il ne relance rien.
 * @param {Manifest} manifest manifeste fusionné
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @returns {{npm: boolean, scripts: string[], stage: string, install: string, binaryGems: string[], precompile: boolean, output: string[]}} plan d'assets
 */
export function assetsPlan(manifest, specs) {
  const { plan } = planAssets({ assets: manifest.assets, specs });
  return {
    npm: plan.npm,
    scripts: [...plan.scripts],
    stage: plan.stage,
    install: plan.install,
    binaryGems: [...plan.binaryGems],
    precompile: plan.stage === ASSET_STAGE.GUEST,
    output: [...plan.output],
  };
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
  // Le mainteneur peut vouloir observer le comportement d'origine : la
  // neutralisation de force_ssl se désarme par une variable du bloc `env:`.
  const keepForceSsl = manifest.env?.[KEEP_FORCE_SSL_VARIABLE] === KEEP_FORCE_SSL_VALUE;
  return {
    APP_NAME: appName,
    RUBY_VERSION: ruby.version,
    // Ruby réellement fourni par la base : ne sert à AUCUN étage de
    // construction, seulement au journal — c'est la valeur que le rapport
    // oppose à la contrainte du Gemfile, et la voir dans le plan évite de
    // croire que RUBY_VERSION la pilote.
    BASE_RUBY_VERSION: manifest.baseRuby ?? "",
    DATABASE: manifest.database ?? "sqlite3",
    // Override réel de config/database.yml pour une sandbox sqlite3. Vide dès
    // que PostgreSQL est retenu : PG_DATABASE_URL prend alors le relais.
    SQLITE_DATABASE_URL: withPostgres ? "" : SQLITE_DATABASE_URL,
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
    // Précompilation dans le guest i386 : seulement quand aucun outil n'exige
    // l'étage amd64 (importmap/propshaft pur).
    ASSET_PRECOMPILE: assets.precompile ? "1" : "0",
    // Étage de précompilation retenu (« aucun », « i386 » ou « amd64 ») : le
    // script de construction s'en sert pour déclencher — ou non — le build
    // amd64, et HOST_ASSETS sélectionne l'étage côté Dockerfile.
    ASSETS_STAGE: assets.stage,
    HOST_ASSETS: assets.stage === ASSET_STAGE.HOST ? "1" : "0",
    NPM_INSTALL_COMMAND: assets.install,
    // Répertoires que l'étage amd64 remonte vers le disque applicatif. Les
    // deux premiers sont structurels ; les suivants viennent de la détection
    // (vite_rails, Shakapacker) ou de `assets.output` du railsbox.yml, et sont
    // validés à l'analyse : chemin relatif, sans « .. », sans métacaractère.
    ASSET_OUTPUT_DIRS: assets.output.join(" "),
    // Outils d'assets à binaire précompilé : aucun n'existe pour i386, ils
    // tournent donc sur l'étage amd64. Conservé pour le journal de build.
    BINARY_ASSET_GEMS: assets.binaryGems.join(" "),
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
    // Neutralisation de config.force_ssl dans le guest. Émise sans condition
    // sur ce que la détection a lu : le réglage peut venir de application.rb,
    // d'un concern ou d'une gem, et le critère du projet est qu'une
    // application NON MODIFIÉE fonctionne.
    FORCE_SSL_INITIALIZER: buildForceSslInitializer({ enabled: !keepForceSsl }),
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
 * @param {{base?: string}} [options] base visée (fixe le Ruby du guest)
 * @returns {Promise<{manifest: Manifest, findings: readonly any[], args: Record<string, string>, report: string}>} analyse complète
 */
export async function analyzeApp(appDir, appName, options = {}) {
  const detected = await detectApp(appDir, { base: options.base });
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
  const baseIndex = args.indexOf("--base");
  const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
  const positional = args.filter(
    (value, index) => !value.startsWith("--") && (baseIndex === -1 || index !== baseIndex + 1),
  );
  const appDir = positional[0];
  const appName = positional[1];
  if (!appDir) {
    process.stderr.write(
      "Usage : node tools/build-v86-image/manifest-to-args.mjs <dossier-application> " +
        "[nom] [--base <version>] [--json]\n",
    );
    return EXIT_USAGE;
  }
  const analysis = await analyzeApp(appDir, appName, { base });
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
