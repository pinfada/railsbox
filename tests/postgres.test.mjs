// Prise en charge de PostgreSQL (critère C8) : de la détection au disque
// applicatif. Le fil conducteur de ces tests est l'invariant qui rend la chose
// possible — le répertoire de données vit sur le DISQUE APPLICATIF, donc le
// cluster ne peut démarrer qu'après le montage de hdb, jamais dans l'init de la
// base dont l'instantané fige les processus.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectApp } from "../tools/detect/detect.mjs";
import { formatReport } from "../tools/detect/report.mjs";
import {
  analyzeApp,
  buildArgs,
  extraPackages,
  postgresDatabaseName,
  postgresSettings,
  PG_DATA_DIR,
} from "../tools/build-v86-image/manifest-to-args.mjs";
import { buildSplitConfig, unsupportedPackages } from "../tools/build-v86-image/split-config.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_DIR = join(PROJECT_ROOT, "tools", "build-v86-image", "base");
const DEMO_DIR = join(PROJECT_ROOT, "tools", "demo-app", "demo");
const OVERLAY_DIR = join(PROJECT_ROOT, "tools", "demo-app", "demo-pg");

const createdDirs = [];

/**
 * Crée une application factice dans un dossier temporaire.
 * @param {Record<string, string>} files chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function createApp(files) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-pg-"));
  createdDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

after(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Assemble un Gemfile.lock minimal contenant les gems demandées.
 * @param {readonly string[]} gems noms de gems résolues
 * @returns {string} contenu du verrou
 */
function lockWith(gems) {
  const specs = ["rails (8.1.3.1)", ...gems.map((gem) => `${gem} (1.0.0)`)]
    .map((line) => `    ${line}`)
    .join("\n");
  return `GEM\n  remote: https://rubygems.org/\n  specs:\n${specs}\n\nBUNDLED WITH\n   2.5.22\n`;
}

/** @typedef {import("../tools/detect/findings.mjs").Finding} Finding */

/**
 * Retrouve un diagnostic par son code.
 * @param {readonly Finding[]} findings diagnostics émis
 * @param {string} code code recherché
 * @returns {Finding|undefined} le diagnostic trouvé
 */
function findByCode(findings, code) {
  return findings.find((finding) => finding.code === code);
}

// --- Détection ---------------------------------------------------------------

test("un database.yml postgresql avec la gem pg produit un manifeste PostgreSQL", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": lockWith(["pg"]),
    "config/database.yml": "production:\n  adapter: postgresql\n  database: app_production\n",
  });

  // Act
  const { manifest, findings } = await detectApp(dir);

  // Assert
  assert.equal(manifest.database, "postgresql");
  assert.deepEqual(
    manifest.nativeGems.map((gem) => gem.name),
    ["pg"],
  );
  assert.equal(findByCode(findings, "missing-pg-gem"), undefined);
});

test("un database.yml entièrement piloté par ERB retombe sur la gem pg", async () => {
  // Arrange — forme courante des applications déployées sur un PaaS : aucun
  // adapter: littéral, tout vient de DATABASE_URL.
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": lockWith(["pg"]),
    "config/database.yml": 'production:\n  url: <%= ENV["DATABASE_URL"] %>\n',
  });

  // Act
  const { manifest, findings } = await detectApp(dir);

  // Assert
  assert.equal(manifest.database, "postgresql");
  assert.match(findByCode(findings, "missing-database-adapter").message, /postgresql/);
});

test("sans database.yml, la gem pg suffit à supposer PostgreSQL", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": lockWith(["pg"]),
  });

  // Act
  const { manifest, findings } = await detectApp(dir);

  // Assert
  assert.equal(manifest.database, "postgresql");
  assert.match(findByCode(findings, "missing-database-config").message, /postgresql/);
});

test("sans gem pg ni database.yml, sqlite3 reste le défaut", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": lockWith(["sqlite3"]),
  });

  // Act
  const { manifest } = await detectApp(dir);

  // Assert
  assert.equal(manifest.database, "sqlite3");
});

test("PostgreSQL sans la gem pg est signalé, sans bloquer, avec son remède", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": lockWith(["sqlite3"]),
    "config/database.yml": "production:\n  adapter: postgresql\n",
  });

  // Act
  const detected = await detectApp(dir);
  const report = formatReport(detected);

  // Assert
  assert.equal(findByCode(detected.findings, "missing-pg-gem").severity, "warning");
  assert.match(report, /gem "pg"/);
});

// --- Manifeste vers arguments de construction --------------------------------

test("postgresDatabaseName produit un identifiant PostgreSQL valide", () => {
  // Arrange / Act / Assert
  assert.equal(postgresDatabaseName("demo"), "demo_production");
  // Les tirets d'un nom de dépôt ne sont pas acceptés hors identifiant cité.
  assert.equal(postgresDatabaseName("Mon-App"), "mon_app_production");
  // Un identifiant ne commence jamais par un chiffre.
  assert.equal(postgresDatabaseName("42"), "app_42_production");
  assert.equal(postgresDatabaseName(""), "app_production");
});

test("postgresSettings place le datadir sur le disque applicatif", () => {
  // Arrange / Act
  const settings = postgresSettings("demo-pg");

  // Assert — c'est l'invariant qui rend la capture d'un état déjà migré
  // possible : le datadir voyage avec le disque de l'application.
  assert.equal(settings.dataDir, PG_DATA_DIR);
  assert.match(settings.dataDir, /^\/app\//);
  assert.equal(settings.database, "demo_pg_production");
  assert.equal(
    settings.url,
    "postgresql://postgres:postgres@127.0.0.1:5432/demo_pg_production?sslmode=disable",
  );
});

test("buildArgs décrit le cluster d'une application PostgreSQL", () => {
  // Arrange
  const manifest = {
    ruby: "3.3.12",
    database: "postgresql",
    assets: { npm: false, scripts: [] },
    nativeGems: [{ name: "pg", systemLibs: ["libpq"] }],
    services: { redis: false, sidekiq: false },
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: new Map([["propshaft", "1.1.0"]]),
    hasSeeds: true,
    appName: "demo-pg",
  });

  // Assert
  assert.equal(args.WITH_POSTGRES, "1");
  assert.equal(args.DATABASE, "postgresql");
  assert.equal(args.PG_VERSION, "15");
  assert.equal(args.PG_DATA_DIR, "/app/var/pg");
  assert.equal(args.PG_DATABASE, "demo_pg_production");
  assert.match(args.PG_DATABASE_URL, /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\//);
  assert.equal(args.EXTRA_PACKAGES, "libpq-dev postgresql postgresql-client");
});

test("buildArgs n'emporte aucun réglage PostgreSQL pour une application sqlite3", () => {
  // Arrange
  const manifest = { ruby: "3.3.12", database: "sqlite3", services: {} };

  // Act
  const args = buildArgs({ manifest, specs: new Map(), hasSeeds: false, appName: "demo" });

  // Assert
  assert.equal(args.WITH_POSTGRES, "0");
  assert.equal(args.PG_DATA_DIR, "");
  assert.equal(args.PG_DATABASE, "");
  assert.equal(args.PG_DATABASE_URL, "");
});

test("la base mutualisée fournit tous les paquets d'une application PostgreSQL", () => {
  // Arrange — c'est CE contrôle que build-app-disk.sh oppose à l'application,
  // et c'est lui qui refusait PostgreSQL avant la base 3.3-r2.
  const manifest = {
    database: "postgresql",
    nativeGems: [
      { name: "pg", systemLibs: ["libpq"] },
      { name: "nokogiri", systemLibs: ["libxml2", "libxslt"] },
    ],
    services: { redis: true },
  };

  // Act
  const missing = unsupportedPackages(extraPackages(manifest));

  // Assert
  assert.deepEqual(missing, []);
});

test("la configuration v86 annonce la base de données de la sandbox", () => {
  // Arrange / Act — make-delta-snapshot.mjs y reporte la valeur lue dans la
  // fiche écrite par build-app-disk.sh.
  const config = buildSplitConfig({
    name: "demo-pg",
    baseName: "base-3.3-r2",
    baseDiskBytes: 1,
    database: "postgresql",
  });

  // Assert
  assert.equal(config.database, "postgresql");
  // Le défaut historique reste sqlite3 pour un disque fabriqué sans fiche.
  assert.equal(
    buildSplitConfig({ name: "d", baseName: "b", baseDiskBytes: 1 }).database,
    "sqlite3",
  );
});

// --- Cohérence des scripts du guest ------------------------------------------
//
// Ces vérifications tiennent le piège n°1 de l'instantané mémoire : un service
// démarré dans l'init de la base y serait figé, puis réveillé chez tous les
// visiteurs — y compris ceux qui n'utilisent pas PostgreSQL, et avec un
// répertoire de données qui n'existe pas encore.

test("l'init de la base ne démarre JAMAIS le cluster PostgreSQL", async () => {
  // Arrange
  const init = await readFile(join(BASE_DIR, "rib", "guest-init.sh"), "utf8");

  // Act
  const lignesActives = init
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  // Assert
  assert.doesNotMatch(lignesActives, /postgres\.sh|pg_ctl|pg_ctlcluster|initdb/);
  // Redis, lui, est bien mutualisé et démarre avant la capture.
  assert.match(lignesActives, /redis-server --daemonize/);
});

test("le lanceur applicatif démarre le cluster APRÈS le montage du disque", async () => {
  // Arrange
  const start = await readFile(join(BASE_DIR, "rib", "start-app.sh"), "utf8");

  // Act
  const montage = start.indexOf("mount /dev/sdb /app");
  const cluster = start.indexOf("/opt/rib/postgres.sh start");
  const puma = start.indexOf("exec bundle exec puma");

  // Assert
  assert.ok(montage > 0, "le montage de hdb doit rester dans start-app.sh");
  assert.ok(cluster > montage, "le cluster ne démarre qu'après le montage de /app");
  assert.ok(puma > cluster, "Puma démarre après le cluster, sinon la base est absente");
  // Conditionné à la base réellement utilisée : une sandbox sqlite3 ne doit
  // pas payer le démarrage d'un cluster.
  assert.match(start, /RAILSBOX_DATABASE:-sqlite3.*=\s*postgresql/s);
});

test("le cycle de vie du cluster garde son datadir sur le disque applicatif", async () => {
  // Arrange
  const script = await readFile(join(BASE_DIR, "rib", "postgres.sh"), "utf8");

  // Act / Assert
  assert.match(script, /PGDATA="\$\{PGDATA:-\/app\/var\/pg\}"/);
  // L'arrêt « fast » écrit un checkpoint : c'est lui qui rend le datadir
  // cohérent avant le mkfs de l'ext2 applicatif.
  assert.match(script, /--mode=fast --wait stop/);
});

test("la base installe PostgreSQL mais supprime le cluster par défaut", async () => {
  // Arrange
  const dockerfile = await readFile(join(BASE_DIR, "Dockerfile"), "utf8");

  // Act / Assert
  assert.match(dockerfile, /postgresql postgresql-client libpq-dev/);
  assert.match(dockerfile, /pg_dropcluster --stop 15 main/);
  assert.match(dockerfile, /rib\/postgres\.sh/);
});

// --- Surcouche de démonstration ---------------------------------------------

test("la surcouche demo-pg produit une application PostgreSQL détectable", async () => {
  // Arrange — même assemblage que preparer-demo-pg.sh, en JavaScript pour que
  // le test tourne sur toutes les plateformes.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-demo-pg-"));
  createdDirs.push(dir);
  await cp(DEMO_DIR, dir, { recursive: true });
  await cp(OVERLAY_DIR, dir, { recursive: true });

  // Act
  const analysis = await analyzeApp(dir, "demo-pg");

  // Assert
  assert.equal(analysis.manifest.database, "postgresql");
  assert.equal(analysis.args.WITH_POSTGRES, "1");
  assert.equal(analysis.args.PG_DATABASE, "demo_pg_production");
  assert.equal(analysis.args.SEED_COMMAND, "bundle exec rails db:seed");
  assert.match(analysis.args.EXTRA_PACKAGES, /postgresql/);
  // La surcouche ne doit pas laisser traîner la gem sqlite3 : deux adaptateurs
  // dans le verrou, c'est un disque applicatif qui embarque deux bases.
  assert.equal(
    analysis.manifest.nativeGems.some((gem) => gem.name === "sqlite3"),
    false,
  );
});
