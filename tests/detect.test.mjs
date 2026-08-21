import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  detectApp,
  normalizeRubyVersion,
  parseDatabaseAdapters,
  parseDatabaseNames,
  schemaDeBase,
  readOptionalFile,
} from "../tools/detect/detect.mjs";
import { collectNativeGems, detectServices, parseLockSpecs } from "../tools/detect/gems.mjs";
import {
  DATABASE_PREPARE_VALUES,
  mergeManifest,
  parseRailsboxYml,
} from "../tools/detect/manifest.mjs";
import {
  dataWriteReasons,
  scanDataMigrations,
  stripRubyComments,
} from "../tools/detect/migrations.mjs";
import { REMEDIES, formatReport, hasBlocking } from "../tools/detect/report.mjs";

/** @typedef {import("../tools/detect/findings.mjs").Finding} Finding */

// --- Fixtures partagées ------------------------------------------------------

const createdDirs = [];

/**
 * Crée une application factice dans un dossier temporaire.
 * @param {Record<string, string>} files chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function createApp(files) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-detect-"));
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

const LOCK_MINIMAL = `GEM
  remote: https://rubygems.org/
  specs:
    rails (7.1.3.4)

PLATFORMS
  ruby

DEPENDENCIES
  rails

BUNDLED WITH
   2.5.11
`;

/**
 * Construit un Gemfile.lock avec les gems demandées.
 * @param {string[]} gems noms de gems à inscrire dans la section specs
 * @param {string} [extra] sections supplémentaires à concaténer
 * @returns {string} contenu du lock
 */
function lockWith(gems, extra = "") {
  const specs = gems.map((name) => `    ${name} (1.0.0)`).join("\n");
  return `GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.1.3.4)\n${specs}\n\nDEPENDENCIES\n  rails\n${extra}`;
}

/**
 * Cherche un diagnostic par code.
 * @param {readonly Finding[]} findings liste de diagnostics
 * @param {string} code code recherché
 * @returns {Finding|undefined} le diagnostic trouvé
 */
function findByCode(findings, code) {
  return findings.find((finding) => finding.code === code);
}

// --- Version de Ruby ---------------------------------------------------------

test("normalizeRubyVersion accepte les formes ruby-, pessimiste et patch", () => {
  // Arrange / Act / Assert : les trois écritures rencontrées en vrai
  assert.equal(normalizeRubyVersion("ruby-3.3.10"), "3.3.10");
  assert.equal(normalizeRubyVersion("~> 3.3"), "3.3");
  assert.equal(normalizeRubyVersion("3.3.10p91"), "3.3.10");
  assert.equal(normalizeRubyVersion("   3.2.2\n"), "3.2.2");
  assert.equal(normalizeRubyVersion("jruby"), null);
  assert.equal(normalizeRubyVersion(null), null);
});

test("la version de Ruby vient de .ruby-version quand il existe", async () => {
  const dir = await createApp({ ".ruby-version": "ruby-3.3.10\n", "Gemfile.lock": LOCK_MINIMAL });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.ruby, "3.3.10");
  assert.equal(manifest.rubySource, ".ruby-version");
});

test("le Gemfile sert de repli, y compris en guillemets simples et pessimiste", async () => {
  const dir = await createApp({
    Gemfile: "source 'https://rubygems.org'\nruby '~> 3.2'\ngem 'rails'\n",
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.ruby, "3.2");
  assert.equal(manifest.rubySource, "Gemfile");
});

test("la section RUBY VERSION du lock sert de dernier repli", async () => {
  const dir = await createApp({
    "Gemfile.lock": `${LOCK_MINIMAL}\nRUBY VERSION\n   ruby 3.3.10p91\n`,
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.ruby, "3.3.10");
  assert.equal(manifest.rubySource, "Gemfile.lock");
});

test(".ruby-version a la priorité sur le Gemfile et sur le lock", async () => {
  const dir = await createApp({
    ".ruby-version": "3.4.1",
    Gemfile: 'ruby "3.2.0"\ngem "rails"\n',
    "Gemfile.lock": `${LOCK_MINIMAL}\nRUBY VERSION\n   ruby 3.1.4p223\n`,
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.ruby, "3.4.1");
  assert.equal(manifest.rubySource, ".ruby-version");
});

test("l'absence totale de version Ruby est un avertissement, pas une erreur", async () => {
  const dir = await createApp({ "Gemfile.lock": LOCK_MINIMAL });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.ruby, null);
  assert.equal(findByCode(findings, "missing-ruby-version").severity, "warning");
});

// --- Présence de Rails -------------------------------------------------------

test("la version de Rails est lue dans le Gemfile.lock", async () => {
  const dir = await createApp({ "Gemfile.lock": LOCK_MINIMAL });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.rails, "7.1.3.4");
  assert.equal(findByCode(findings, "not-a-rails-app"), undefined);
});

test("Rails déclaré au seul Gemfile est accepté avec une version inconnue", async () => {
  const dir = await createApp({ Gemfile: 'gem "rails", "~> 7.1"\n' });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.rails, null);
  assert.equal(findByCode(findings, "rails-version-unknown").severity, "info");
  assert.equal(findByCode(findings, "not-a-rails-app"), undefined);
});

test("un dossier sans Rails produit un diagnostic bloquant", async () => {
  const dir = await createApp({ Gemfile: 'gem "sinatra"\n' });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "not-a-rails-app").severity, "blocking");
  assert.equal(hasBlocking(findings), true);
});

test("une gem au nom proche (rails-html-sanitizer) ne vaut pas Rails", async () => {
  const dir = await createApp({
    "Gemfile.lock": lockWith([]).replace("rails (7.1.3.4)", "rails-html-sanitizer (1.6.0)"),
  });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "not-a-rails-app").severity, "blocking");
});

test("le dossier analysé doit être un chemin exploitable", async () => {
  await assert.rejects(() => detectApp(""), TypeError);
  await assert.rejects(() => detectApp(null), TypeError);
});

test("readOptionalFile remonte une erreur de lecture qui n'est pas une absence", async () => {
  // Un chemin qui n'est pas une chaîne provoque une erreur d'argument : ce n'est
  // pas une absence de fichier, elle doit sortir au lieu d'être confondue avec elle.
  await assert.rejects(() => readOptionalFile(/** @type {*} */ (42)));
  assert.equal(await readOptionalFile(join(tmpdir(), "railsbox-absent-xyz", "Gemfile")), null);
});

test("un dossier inexistant est analysé sans planter", async () => {
  const { manifest, findings } = await detectApp(join(tmpdir(), "railsbox-absent-xyz"));

  assert.equal(manifest.ruby, null);
  assert.equal(hasBlocking(findings), true);
});

// --- Base de données ---------------------------------------------------------

test("parseDatabaseAdapters ignore les balises ERB", () => {
  const yml = `default: &default\n  adapter: <%= ENV.fetch("ADAPTER", "postgresql") %>\n  adapter: postgresql\n`;

  assert.deepEqual(parseDatabaseAdapters(yml), ["postgresql"]);
});

test("database.yml truffé d'ERB donne quand même postgresql", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": `default: &default\n  adapter: postgresql\n  url: <%= ENV["DATABASE_URL"] %>\n\nproduction:\n  <<: *default\n`,
  });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.database, "postgresql");
  assert.equal(hasBlocking(findings), false);
});

// --- Bases MULTIPLES ---------------------------------------------------------

const YML_BASES_MULTIPLES = [
  "default: &default",
  "  adapter: postgresql",
  "  pool: 5",
  "",
  "test:",
  "  <<: *default",
  "",
  "production:",
  "  primary: &primary_production",
  "    <<: *default",
  "  cache:",
  "    <<: *primary_production",
  "  cable:",
  "    <<: *primary_production",
  "",
].join("\n");

test("une connexion unique ne nomme AUCUNE base", () => {
  // Le piège à éviter : prendre `adapter`, `pool`, `url` pour des noms de
  // bases et réclamer un db/adapter_schema.rb.
  assert.deepEqual(parseDatabaseNames(YML_BASES_MULTIPLES, "test"), []);
  assert.deepEqual(parseDatabaseNames("production:\n  adapter: postgresql\n  pool: 5\n"), []);
  assert.deepEqual(parseDatabaseNames("production:\n  <<: *default\n"), []);
  assert.deepEqual(parseDatabaseNames(null), []);
  assert.deepEqual(parseDatabaseNames("development:\n  <<: *default\n"), []);
});

test("un dictionnaire de bases nommées les nomme toutes, ancre comprise", () => {
  assert.deepEqual(parseDatabaseNames(YML_BASES_MULTIPLES), ["primary", "cache", "cable"]);
  assert.deepEqual(parseDatabaseNames(YML_BASES_MULTIPLES, "development"), []);
});

test("une base marquée schema_dump: false n'attend aucun fichier", () => {
  // Rails ne dumpe pas ces bases : en réclamer le schéma ferait basculer la
  // préparation sur les migrations pour rien.
  const yml = [
    "production:",
    "  primary:",
    "    <<: *default",
    "  cache:",
    "    <<: *default",
    "    schema_dump: false",
    "",
  ].join("\n");

  assert.deepEqual(parseDatabaseNames(yml), ["primary"]);
});

test("le schéma d'une base suit son nom, et le format du schéma primaire", () => {
  assert.equal(schemaDeBase("primary", "db/schema.rb"), "db/schema.rb");
  assert.equal(schemaDeBase("cache", "db/schema.rb"), "db/cache_schema.rb");
  assert.equal(schemaDeBase("primary", "db/structure.sql"), "db/structure.sql");
  assert.equal(schemaDeBase("cable", "db/structure.sql"), "db/cable_structure.sql");
});

test("un schéma secondaire absent est RELEVÉ NOMMÉMENT", async () => {
  // La panne d'origine, en salle blanche : `db:schema:load` s'arrêtait sur
  // « /app/db/cache_schema.rb doesn't exist yet » — un message de Rails qui ne
  // nomme pas railsbox et laisse croire à un défaut de l'application.
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": YML_BASES_MULTIPLES,
    "db/schema.rb": "ActiveRecord::Schema[8.0].define(version: 1) do\nend\n",
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.schemaFile, "db/schema.rb");
  assert.deepEqual(manifest.schemasManquants, ["db/cache_schema.rb", "db/cable_schema.rb"]);
});

test("des schémas secondaires tous présents ne relèvent rien", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": YML_BASES_MULTIPLES,
    "db/schema.rb": "ActiveRecord::Schema[8.0].define(version: 1) do\nend\n",
    "db/cache_schema.rb": "ActiveRecord::Schema[8.0].define(version: 1) do\nend\n",
    "db/cable_schema.rb": "ActiveRecord::Schema[8.0].define(version: 1) do\nend\n",
  });

  const { manifest } = await detectApp(dir);

  assert.deepEqual(manifest.schemasManquants, []);
});

test("en format SQL, ce sont les structure.sql secondaires qui sont attendus", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": YML_BASES_MULTIPLES,
    "db/structure.sql": "CREATE TABLE things (id bigserial primary key);\n",
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.schemaFile, "db/structure.sql");
  assert.deepEqual(manifest.schemasManquants, ["db/cache_structure.sql", "db/cable_structure.sql"]);
});

test("sans schéma primaire, rien n'est relevé : le repli existe déjà", async () => {
  // Cumuler les deux diagnostics dirait deux fois la même chose, et
  // `prepare-sans-schema` couvre déjà ce cas.
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": YML_BASES_MULTIPLES,
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.schemaFile, null);
  assert.deepEqual(manifest.schemasManquants, []);
});

test("mysql2 dans database.yml bloque l'analyse avec le bon message", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": "development:\n  adapter: mysql2\n",
  });

  const { findings } = await detectApp(dir);
  const blocking = findByCode(findings, "unsupported-database");

  assert.equal(blocking.severity, "blocking");
  assert.match(blocking.message, /MySQL pas encore supporté par les images de base/);
});

test("l'adaptateur trilogy est bloqué comme mysql2", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": "development:\n  adapter: trilogy\n",
  });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "unsupported-database").details.adapter, "trilogy");
});

test("la gem mysql2 seule bloque aussi, sans doublon de diagnostic", async () => {
  const dir = await createApp({
    "Gemfile.lock": lockWith(["mysql2"]),
    "config/database.yml": "development:\n  adapter: mysql2\n",
  });

  const { findings } = await detectApp(dir);
  const blocking = findings.filter((finding) => finding.code === "unsupported-database");

  assert.equal(blocking.length, 1);
});

test("database.yml absent suppose sqlite3 avec un avertissement", async () => {
  const dir = await createApp({ "Gemfile.lock": LOCK_MINIMAL });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.database, "sqlite3");
  assert.equal(findByCode(findings, "missing-database-config").severity, "warning");
});

test("un database.yml sans adapter retombe sur sqlite3", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": "development:\n  database: db/dev.sqlite3\n",
  });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.database, "sqlite3");
  assert.equal(findByCode(findings, "missing-database-adapter").severity, "warning");
});

test("deux adaptateurs supportés retiennent le premier et le signalent", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "config/database.yml": "development:\n  adapter: sqlite3\nproduction:\n  adapter: postgresql\n",
  });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.database, "sqlite3");
  assert.equal(findByCode(findings, "database-adapter-ambiguous").severity, "info");
});

test("la gem mysql2 bloque même sans database.yml", async () => {
  const dir = await createApp({ "Gemfile.lock": lockWith(["mysql2"]) });

  const { findings } = await detectApp(dir);
  const blocking = findByCode(findings, "unsupported-database");

  assert.equal(blocking.severity, "blocking");
  assert.match(blocking.message, /Gem « mysql2 »/);
});

// --- Assets ------------------------------------------------------------------

test("package.json révèle les scripts de build et les outils front", async () => {
  const dir = await createApp({
    "Gemfile.lock": LOCK_MINIMAL,
    "package.json": JSON.stringify({
      scripts: { "build:css": "tailwindcss -i x -o y", "build:js": "esbuild app.js", test: "jest" },
      dependencies: { esbuild: "^0.20.0" },
      devDependencies: { tailwindcss: "^3.4.0", chokidar: "^3.6.0" },
    }),
  });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.assets.npm, true);
  assert.deepEqual([...manifest.assets.scripts], ["build:css", "build:js"]);
  assert.deepEqual([...manifest.assets.tools], ["esbuild", "tailwindcss"]);
});

test("sans package.json le pipeline est importmap/sprockets", async () => {
  const dir = await createApp({ "Gemfile.lock": LOCK_MINIMAL });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.assets.npm, false);
  assert.deepEqual([...manifest.assets.scripts], []);
  assert.equal(findByCode(findings, "no-npm-assets").severity, "info");
});

test("une application Tailwind est classée « précompilation amd64 », pas refusée", async () => {
  const dir = await createApp({
    "Gemfile.lock": lockWith(["propshaft", "tailwindcss-rails", "tailwindcss-ruby"]),
  });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.assets.stage, "amd64");
  assert.deepEqual([...manifest.assets.binaryGems], ["tailwindcss-rails", "tailwindcss-ruby"]);
  assert.equal(findByCode(findings, "assets-amd64-stage").severity, "info");
  assert.equal(hasBlocking(findings), false);
});

test("un package-lock.json donne une installation reproductible", async () => {
  const dir = await createApp({
    "Gemfile.lock": lockWith(["jsbundling-rails"]),
    "package.json": JSON.stringify({ scripts: { build: "esbuild app.js" } }),
    "package-lock.json": "{}",
  });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.assets.stage, "amd64");
  assert.match(manifest.assets.install, /^npm ci /);
  assert.equal(findByCode(findings, "npm-lockfile-absent"), undefined);
});

test("un verrou yarn est signalé et l'installation retombe sur npm install", async () => {
  const dir = await createApp({
    "Gemfile.lock": lockWith(["cssbundling-rails"]),
    "package.json": JSON.stringify({ scripts: { "build:css": "sass x y" } }),
    "yarn.lock": "# yarn lockfile v1\n",
  });

  const { manifest, findings } = await detectApp(dir);

  assert.match(manifest.assets.install, /^npm install /);
  assert.equal(findByCode(findings, "npm-lockfile-absent").severity, "warning");
});

test("un package.json illisible est un avertissement, pas un plantage", async () => {
  const dir = await createApp({ "Gemfile.lock": LOCK_MINIMAL, "package.json": "{ oops" });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.assets.npm, true);
  assert.equal(findByCode(findings, "invalid-package-json").severity, "warning");
});

// --- Gems natives et services ------------------------------------------------

test("parseLockSpecs ne retient que les gems résolues, pas leurs dépendances", () => {
  const lock =
    "GEM\n  specs:\n    rails (7.1.3)\n      actionpack (= 7.1.3)\n\nDEPENDENCIES\n  rails\n";

  const specs = parseLockSpecs(lock);

  assert.equal(specs.get("rails"), "7.1.3");
  assert.equal(specs.has("actionpack"), false);
});

test("les gems natives connues portent leurs bibliothèques système", () => {
  const specs = parseLockSpecs(lockWith(["nokogiri", "pg", "ruby-vips", "sassc", "bcrypt"]));

  const { nativeGems } = collectNativeGems(specs);
  const byName = new Map(nativeGems.map((gem) => [gem.name, gem.systemLibs]));

  assert.deepEqual([...byName.get("nokogiri")], ["libxml2", "libxslt"]);
  assert.deepEqual([...byName.get("pg")], ["libpq"]);
  assert.deepEqual([...byName.get("ruby-vips")], ["libvips"]);
  assert.deepEqual([...byName.get("sassc")], ["libsass"]);
  assert.deepEqual([...byName.get("bcrypt")], []);
});

test("la pile de traitement d'images d'image_processing est reconnue", async () => {
  // Arrange : ce que résout `gem "image_processing"` — la gem elle-même est en
  // Ruby pur, mais elle tire les DEUX processeurs de variantes de Rails. C'est
  // exactement le lock de pinfada/tchopmygrinds, premier intégrateur tiers.
  const dir = await createApp({
    "Gemfile.lock": lockWith(["image_processing", "mini_magick", "ruby-vips", "ffi"]),
  });

  // Act
  const { manifest, findings } = await detectApp(dir);
  const byName = new Map(manifest.nativeGems.map((gem) => [gem.name, gem.systemLibs]));

  // Assert : ruby-vips ne compile rien (liaison FFI) et mini_magick appelle un
  // exécutable — les deux dépendances système sont pourtant réelles, et doivent
  // être vues AVANT la construction, pas au premier redimensionnement.
  assert.deepEqual([...byName.get("ruby-vips")], ["libvips"]);
  assert.deepEqual([...byName.get("mini_magick")], ["imagemagick"]);
  assert.deepEqual([...byName.get("ffi")], ["libffi"]);
  // Rien de bloquant : la base 3.3-r3 fournit libvips et ImageMagick.
  assert.equal(hasBlocking(findings), false);
});

test("les gems à bibliothèque écartée de la base sont tout de même nommées", () => {
  // rmagick et ruby-filemagic n'ont pas leur place dans la base (80 Mo et 8 Mo
  // pour des gems marginales). Les taire produirait un échec de compilation
  // sans cause lisible ; les nommer produit un refus qui dit quoi faire.
  const specs = parseLockSpecs(lockWith(["rmagick", "ruby-filemagic", "rbnacl", "curb"]));

  const { nativeGems } = collectNativeGems(specs);
  const byName = new Map(nativeGems.map((gem) => [gem.name, gem.systemLibs]));

  assert.deepEqual([...byName.get("rmagick")], ["libmagickwand"]);
  assert.deepEqual([...byName.get("ruby-filemagic")], ["libmagic"]);
  assert.deepEqual([...byName.get("rbnacl")], ["libsodium"]);
  assert.deepEqual([...byName.get("curb")], ["libcurl"]);
});

test("grpc déclenche l'avertissement de compilation très longue", async () => {
  const dir = await createApp({ "Gemfile.lock": lockWith(["grpc"]) });

  const { manifest, findings } = await detectApp(dir);
  const heavy = findByCode(findings, "heavy-native-gem");

  assert.equal(heavy.severity, "warning");
  assert.match(heavy.message, /très longue/);
  assert.ok(manifest.nativeGems.some((gem) => gem.name === "grpc"));
});

test("sidekiq implique redis même sans la gem redis", () => {
  const services = detectServices(parseLockSpecs(lockWith(["sidekiq"])));

  assert.deepEqual({ ...services }, { redis: true, sidekiq: true });
});

test("la gem redis seule n'implique pas sidekiq", async () => {
  const dir = await createApp({ "Gemfile.lock": lockWith(["redis"]) });

  const { manifest } = await detectApp(dir);

  assert.equal(manifest.services.redis, true);
  assert.equal(manifest.services.sidekiq, false);
});

test("la version de Bundler est relevée à titre informatif", async () => {
  const dir = await createApp({ "Gemfile.lock": LOCK_MINIMAL });

  const { manifest, findings } = await detectApp(dir);

  assert.equal(manifest.bundler, "2.5.11");
  assert.equal(findByCode(findings, "bundler-version").severity, "info");
});

test("l'absence de Gemfile.lock est signalée explicitement", async () => {
  const dir = await createApp({ Gemfile: 'gem "rails"\n' });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "missing-gemfile-lock").severity, "warning");
});

// --- railsbox.yml ------------------------------------------------------------

test("parseRailsboxYml lit les scalaires, les blocs imbriqués et les commentaires", () => {
  const yml = `# manifeste railsbox\nruby: "3.3.10"   # version imposée\ndatabase: postgresql\nseed:\n  command: bin/rails db:seed\n  auto_login: admin@example.com\nenv:\n  STRIPE_SECRET_KEY: "sk_test_123"\n  RAILS_ENV: production\n`;

  const { manifest, findings } = parseRailsboxYml(yml);

  assert.equal(manifest.ruby, "3.3.10");
  assert.equal(manifest.database, "postgresql");
  assert.equal(manifest.seed.command, "bin/rails db:seed");
  assert.equal(manifest.seed.autoLogin, "admin@example.com");
  assert.deepEqual(
    { ...manifest.env },
    { STRIPE_SECRET_KEY: "sk_test_123", RAILS_ENV: "production" },
  );
  assert.deepEqual([...findings], []);
});

test("parseRailsboxYml supporte les tableaux en style flow", () => {
  const yml = 'assets:\n  scripts: [build:css, "build:js"]\n';

  const { manifest, findings } = parseRailsboxYml(yml);

  assert.deepEqual([...manifest.assets.scripts], ["build:css", "build:js"]);
  assert.deepEqual([...findings], []);
});

test("une clé inconnue est un avertissement et n'interrompt pas l'analyse", () => {
  const yml = "ruby: 3.3.10\nmagie: true\nseed:\n  inconnue: x\ndatabase: sqlite3\n";

  const { manifest, findings } = parseRailsboxYml(yml);
  const unknown = findings.filter((finding) => finding.code === "unknown-manifest-key");

  assert.equal(manifest.ruby, "3.3.10");
  assert.equal(manifest.database, "sqlite3");
  assert.deepEqual(
    unknown.map((finding) => finding.details.key),
    ["magie", "seed.inconnue"],
  );
});

test("le contenu d'un bloc inconnu est ignoré sans avalanche de diagnostics", () => {
  const yml = "inconnu:\n  a: 1\n  b: 2\nruby: 3.3.10\n";

  const { manifest, findings } = parseRailsboxYml(yml);

  assert.equal(manifest.ruby, "3.3.10");
  assert.equal(findings.length, 1);
});

test("un nom de variable d'environnement invalide est signalé, pas fatal", () => {
  const yml = "env:\n  1INVALIDE: x\n  bad-name: y\n  VALIDE: ok\n";

  const { manifest, findings } = parseRailsboxYml(yml);
  const invalid = findings.filter((finding) => finding.code === "invalid-env-name");

  assert.deepEqual({ ...manifest.env }, { VALIDE: "ok" });
  assert.deepEqual(
    invalid.map((finding) => finding.details.key),
    ["1INVALIDE", "bad-name"],
  );
});

test("une ligne malformée porte son numéro de ligne", () => {
  const yml = "ruby: 3.3.10\nceci n'est pas du yaml\n";

  const { findings } = parseRailsboxYml(yml);
  const malformed = findByCode(findings, "malformed-manifest-line");

  assert.equal(malformed.details.line, 2);
  assert.match(malformed.message, /ligne 2/);
});

test("une indentation inattendue est signalée sans casser le reste", () => {
  const yml = "   ruby: 3.3.10\ndatabase: sqlite3\n";

  const { manifest, findings } = parseRailsboxYml(yml);

  assert.equal(manifest.ruby, undefined);
  assert.equal(manifest.database, "sqlite3");
  assert.equal(findByCode(findings, "malformed-manifest-line").details.line, 1);
});

test("une valeur hors schéma produit invalid-manifest-value", () => {
  const yml = "database: oracle\nruby: true\n";

  const { manifest, findings } = parseRailsboxYml(yml);
  const invalid = findings.filter((finding) => finding.code === "invalid-manifest-value");

  assert.deepEqual({ ...manifest }, {});
  assert.deepEqual(
    invalid.map((finding) => finding.details.key),
    ["database", "ruby"],
  );
});

test("un bloc déclaré avec une valeur scalaire est rejeté, contenu compris", () => {
  const yml = "seed: bin/rails db:seed\n  command: x\ndatabase: sqlite3\n";

  const { manifest, findings } = parseRailsboxYml(yml);

  assert.equal(manifest.seed, undefined);
  assert.equal(manifest.database, "sqlite3");
  assert.equal(findByCode(findings, "invalid-manifest-value").details.key, "seed");
  assert.equal(findings.length, 1);
});

test("une ligne indentée sans bloc parent est malformée", () => {
  const yml = "  command: bin/seed\n";

  const { findings } = parseRailsboxYml(yml);

  assert.match(findByCode(findings, "malformed-manifest-line").message, /sans bloc parent/);
});

test("un tableau là où un texte est attendu reste un avertissement", () => {
  const yml = "seed:\n  command: [a, b]\nenv:\n  API: [x]\n";

  const { manifest, findings } = parseRailsboxYml(yml);
  const invalid = findings.filter((finding) => finding.code === "invalid-manifest-value");

  assert.equal(manifest.seed, undefined);
  assert.equal(manifest.env, undefined);
  assert.deepEqual(
    invalid.map((finding) => finding.details.key),
    ["seed.command", "env.API"],
  );
});

test("un script d'assets scalaire vaut une liste d'un élément", () => {
  const { manifest } = parseRailsboxYml("assets:\n  scripts: build\n");

  assert.deepEqual([...manifest.assets.scripts], ["build"]);
});

test("parseRailsboxYml refuse une entrée qui n'est pas du texte", () => {
  assert.throws(() => parseRailsboxYml(null), TypeError);
});

// --- Fusion ------------------------------------------------------------------

test("mergeManifest laisse le déclaré l'emporter et trace les remplacements", () => {
  const detected = Object.freeze({ ruby: "3.2.0", rubySource: "Gemfile", database: "sqlite3" });
  const declared = Object.freeze({ ruby: "3.3.10", database: "postgresql" });

  const { manifest, findings } = mergeManifest(detected, declared);

  assert.equal(manifest.ruby, "3.3.10");
  assert.equal(manifest.rubySource, "railsbox.yml");
  assert.equal(manifest.database, "postgresql");
  assert.deepEqual(
    findings.map((finding) => finding.details.key),
    ["ruby", "database"],
  );
  assert.ok(findings.every((finding) => finding.severity === "info"));
  assert.match(findings[0].message, /« ruby »/);
});

test("mergeManifest conserve le détecté quand rien n'est déclaré", () => {
  const detected = Object.freeze({ ruby: "3.3.10", database: "sqlite3" });

  const { manifest, findings } = mergeManifest(detected, {});

  assert.equal(manifest.ruby, "3.3.10");
  assert.deepEqual([...findings], []);
});

test("mergeManifest ajoute seed, env et scripts sans les signaler comme remplacements", () => {
  const detected = Object.freeze({
    assets: Object.freeze({ npm: true, scripts: Object.freeze([]) }),
  });
  const declared = {
    seed: { command: "bin/seed" },
    env: { API: "x" },
    assets: { scripts: ["build"] },
  };

  const { manifest, findings } = mergeManifest(detected, declared);

  assert.equal(manifest.seed.command, "bin/seed");
  assert.equal(manifest.env.API, "x");
  assert.deepEqual([...manifest.assets.scripts], ["build"]);
  assert.equal(manifest.assets.npm, true);
  assert.deepEqual([...findings], []);
});

test("mergeManifest rend le manifeste fusionné immuable en profondeur", () => {
  const { manifest } = mergeManifest(
    { assets: { scripts: [] } },
    { seed: { command: "bin/seed" } },
  );

  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.seed), true);
  assert.throws(() => {
    manifest.ruby = "3.0.0";
  }, TypeError);
});

test("mergeManifest refuse des arguments qui ne sont pas des objets", () => {
  // Les casts documentent l'intention : on éprouve la validation d'entrée.
  assert.throws(() => mergeManifest(null, {}), TypeError);
  assert.throws(() => mergeManifest({}, /** @type {*} */ ("ruby: 3.3.10")), TypeError);
});

// --- Rapport -----------------------------------------------------------------

test("formatReport résume la détection en français", async () => {
  const dir = await createApp({
    ".ruby-version": "3.3.10",
    "Gemfile.lock": lockWith(["pg", "sidekiq"], "\nBUNDLED WITH\n   2.5.11\n"),
    "config/database.yml": "development:\n  adapter: postgresql\n",
    "package.json": JSON.stringify({ scripts: { build: "node build.mjs" } }),
  });

  const report = formatReport(await detectApp(dir));

  assert.match(report, /Ruby {14}: 3\.3\.10 \(source : \.ruby-version\)/);
  assert.match(report, /Base de données {3}: postgresql/);
  assert.match(report, /Gems natives {6}: pg \(libpq\)/);
  assert.match(report, /Services {10}: redis, sidekiq/);
  assert.match(report, /Assets {12}: npm — scripts : build/);
});

test("formatReport groupe les diagnostics par sévérité et propose un remède", async () => {
  const dir = await createApp({
    Gemfile: 'gem "sinatra"\n',
    "config/database.yml": "development:\n  adapter: mysql2\n",
  });

  const report = formatReport(await detectApp(dir));

  assert.match(report, /--- Bloquant \(2\) ---/);
  assert.match(report, /--- Avertissement \(2\) ---/);
  assert.match(
    report,
    /Remède : Utilisez PostgreSQL ou SQLite, ou déclarez database: dans railsbox\.yml/,
  );
  assert.ok(
    report.indexOf("Bloquant") < report.indexOf("Avertissement"),
    "bloquant affiché en premier",
  );
});

test("tout diagnostic bloquant ou d'avertissement émis dispose d'un remède", async () => {
  const dir = await createApp({
    Gemfile: 'gem "sinatra"\n',
    "package.json": "{ oops",
    "config/database.yml": "development:\n  adapter: mysql2\n",
  });

  const detected = await detectApp(dir);
  const declared = parseRailsboxYml(
    "magie: oui\nceci n'est pas du yaml\nenv:\n  1BAD: x\ndatabase: oracle\n",
  );
  const findings = [...detected.findings, ...declared.findings];
  const actionable = findings.filter((finding) => finding.severity !== "info");

  assert.ok(actionable.length >= 6, `attendu plusieurs diagnostics, obtenu ${actionable.length}`);
  for (const finding of actionable) {
    assert.ok(REMEDIES[finding.code], `code sans remède : ${finding.code}`);
  }
});

test("formatReport signale l'absence de diagnostic", () => {
  const report = formatReport({ manifest: { ruby: "3.3.10" }, findings: [] });

  assert.match(report, /Aucun diagnostic/);
});

test("formatReport affiche seed et variables d'environnement quand ils existent", () => {
  const manifest = { seed: { command: "bin/seed", autoLogin: "a@b.c" }, env: { API: "x" } };

  const report = formatReport({ manifest, findings: [] });

  assert.match(report, /Commande de seed {2}: bin\/seed/);
  assert.match(report, /Auto-login {8}: a@b\.c/);
  assert.match(report, /Variables d'env {3}: API/);
});

test("formatReport exige un résultat de détection bien formé", () => {
  assert.throws(() => formatReport(null), TypeError);
  assert.throws(() => formatReport(/** @type {*} */ ({ findings: [] })), TypeError);
});

test("hasBlocking distingue les diagnostics bloquants des autres", () => {
  assert.equal(hasBlocking([{ severity: "warning" }, { severity: "blocking" }]), true);
  assert.equal(hasBlocking([{ severity: "warning" }, { severity: "info" }]), false);
  assert.equal(hasBlocking([]), false);
  assert.equal(hasBlocking(undefined), false);
});

// ── Scalaires en bloc littéraux (`clé: |`) ────────────────────────────────
// Nécessaires à seed.auto_login_code, qui porte du Ruby multiligne. Le
// contenu doit être pris VERBATIM : un « # » y est du code, pas un
// commentaire YAML.

test("parseRailsboxYml lit un scalaire en bloc multiligne", () => {
  const { manifest, findings } = parseRailsboxYml(
    [
      "seed:",
      '  command: "bin/rails db:seed"',
      "  auto_login_code: |",
      '    compte = Account.find_by(email: "demo@example.com")',
      "    env['rack.session'][:account_id] = compte.id",
      "database: sqlite3",
    ].join("\n"),
  );
  assert.equal(
    manifest.seed.autoLoginCode,
    'compte = Account.find_by(email: "demo@example.com")\n' +
      "env['rack.session'][:account_id] = compte.id",
  );
  // La clé qui suit le bloc est bien reprise : le curseur ne l'a pas avalée.
  assert.equal(manifest.database, "sqlite3");
  assert.deepEqual(
    findings.filter((f) => f.code === "malformed-line"),
    [],
  );
});

test("un dièse dans un scalaire en bloc est du contenu, pas un commentaire", () => {
  const { manifest } = parseRailsboxYml(
    ["seed:", "  auto_login_code: |", "    # commentaire Ruby", '    puts "#{1 + 1}"'].join("\n"),
  );
  assert.equal(manifest.seed.autoLoginCode, '# commentaire Ruby\nputs "#{1 + 1}"');
});

test("le retrait commun d'un scalaire en bloc est ôté sans écraser l'imbrication", () => {
  const { manifest } = parseRailsboxYml(
    ["seed:", "  auto_login_code: |", "    if vrai", "      agir", "    end"].join("\n"),
  );
  assert.equal(manifest.seed.autoLoginCode, "if vrai\n  agir\nend");
});

test("les lignes vides finales ne sont pas absorbées par le bloc", () => {
  const { manifest } = parseRailsboxYml(
    ["seed:", "  auto_login_code: |", "    agir", "", "", "ruby: 3.3.12"].join("\n"),
  );
  assert.equal(manifest.seed.autoLoginCode, "agir");
  assert.equal(manifest.ruby, "3.3.12");
});

test("auto_login reste un scalaire simple", () => {
  const { manifest } = parseRailsboxYml(
    ["seed:", '  command: "bin/rails db:seed"', '  auto_login: "admin@example.com"'].join("\n"),
  );
  assert.equal(manifest.seed.autoLogin, "admin@example.com");
  assert.equal(manifest.seed.autoLoginCode, undefined);
});

// --- Migrations porteuses de données -----------------------------------------

const MIGRATION_INSERT = `class CreateCurrencies < ActiveRecord::Migration[7.1]
  def change
    create_table :currencies, id: false do |t|
      t.string :code, primary_key: true, limit: 3, null: false
    end

    reversible do |dir|
      dir.up do
        execute <<~SQL
          INSERT INTO currencies (code, label) VALUES ('XAF', 'Franc CFA');
        SQL
      end
    end
  end
end
`;

/** Migration de pur DDL : rien de ce qu'elle fait ne manque à un schema.rb. */
const MIGRATION_DDL = `class AddIndexToOrders < ActiveRecord::Migration[7.1]
  def change
    add_column :orders, :updated_by, :string
    add_index :orders, :updated_by, name: "index_orders_on_updated_at"
    execute "CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status)"
    execute "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'new'"
  end
end
`;

test("une migration qui exécute un INSERT est signalée, fichier nommé", () => {
  assert.deepEqual(
    scanDataMigrations([{ name: "20260514210000_create_currencies.rb", text: MIGRATION_INSERT }]),
    [{ file: "20260514210000_create_currencies.rb", reasons: ["execute d'un INSERT SQL"] }],
  );
});

test("une migration qui crée des lignes par un modèle est signalée", () => {
  const source = `class SeedRoles < ActiveRecord::Migration[7.1]
    def up
      Role.create!(name: "admin")
      Setting.find_or_create_by(key: "devise")
    end
  end`;
  const [trouve] = scanDataMigrations([{ name: "20240101000000_seed_roles.rb", text: source }]);
  assert.equal(trouve.file, "20240101000000_seed_roles.rb");
  assert.match(trouve.reasons.join(" "), /create!/);
});

test("insert_all et upsert_all comptent aussi comme des écritures", () => {
  for (const appel of ["Country.insert_all([{ code: 'FR' }])", "Tax.upsert_all(rows)"]) {
    assert.equal(dataWriteReasons(appel).length, 1, appel);
  }
});

// --- Faux positifs : ce qui ne doit PAS être signalé --------------------------

test("une migration de pur DDL n'est pas signalée", () => {
  assert.deepEqual(
    scanDataMigrations([{ name: "20240101000000_ddl.rb", text: MIGRATION_DDL }]),
    [],
  );
});

test("create_table et create_join_table ne sont pas des écritures de données", () => {
  const source = `def change
    create_table :commerces
    create_join_table :commerces, :products
    t.timestamps
  end`;
  assert.deepEqual(dataWriteReasons(source), []);
});

test("un INSERT en commentaire ne déclenche rien", () => {
  const source = `def up
    # execute "INSERT INTO currencies VALUES ('XAF')" — retiré, voir db/seeds.rb
    add_column :currencies, :suffix, :string
  end`;
  assert.deepEqual(dataWriteReasons(source), []);
});

test("un UPDATE sans SET (identifiant, colonne updated_at) ne déclenche rien", () => {
  const source = `def change
    execute "CREATE INDEX index_updates_on_updated_at ON updates (updated_at)"
  end`;
  assert.deepEqual(dataWriteReasons(source), []);
});

test("un INSERT sans execute (chaîne de documentation) ne déclenche rien", () => {
  const source = `def change
    add_column :notes, :body, :text, comment: "rempli par INSERT INTO notes"
  end`;
  assert.deepEqual(dataWriteReasons(source), []);
});

test("un dièse dans une chaîne ne coupe pas la ligne analysée", () => {
  assert.equal(
    stripRubyComments(`execute "INSERT INTO t VALUES ('#1')" # commentaire`).trim(),
    `execute "INSERT INTO t VALUES ('#1')"`,
  );
});

test("detectApp relève la migration porteuse de données et l'annonce en avertissement", async () => {
  const dir = await createApp({
    Gemfile: 'gem "rails"\n',
    "Gemfile.lock": LOCK_MINIMAL,
    ".ruby-version": "3.3.12\n",
    "db/migrate/20260514210000_create_currencies.rb": MIGRATION_INSERT,
    "db/migrate/20240101000000_ddl.rb": MIGRATION_DDL,
  });
  const { manifest, findings } = await detectApp(dir);
  assert.deepEqual(manifest.dataMigrations, ["20260514210000_create_currencies.rb"]);
  const finding = findByCode(findings, "data-bearing-migration");
  assert.equal(finding.severity, "warning");
  // Le fichier est NOMMÉ et le mécanisme expliqué : sans les deux, le rapport
  // laisse le mainteneur devant la même validation absurde qu'avant.
  assert.match(finding.message, /db\/migrate\/20260514210000_create_currencies\.rb/);
  assert.match(finding.message, /db\/schema\.rb/);
  assert.ok(REMEDIES["data-bearing-migration"]);
});

test("une application sans db/migrate ne produit aucun diagnostic de migration", async () => {
  const dir = await createApp({
    Gemfile: 'gem "rails"\n',
    "Gemfile.lock": LOCK_MINIMAL,
    ".ruby-version": "3.3.12\n",
  });
  const { manifest, findings } = await detectApp(dir);
  assert.deepEqual(manifest.dataMigrations, []);
  assert.equal(findByCode(findings, "data-bearing-migration"), undefined);
});

// --- Clé database_prepare ----------------------------------------------------

test("database_prepare accepte schema et migrate", () => {
  for (const valeur of DATABASE_PREPARE_VALUES) {
    const { manifest, findings } = parseRailsboxYml(`database_prepare: ${valeur}\n`);
    assert.equal(manifest.databasePrepare, valeur);
    assert.deepEqual(findings, []);
  }
});

test("une valeur inconnue de database_prepare est refusée avec ses valeurs admises", () => {
  const { manifest, findings } = parseRailsboxYml("database_prepare: auto\n");
  assert.equal(manifest.databasePrepare, undefined);
  const finding = findByCode(findings, "invalid-manifest-value");
  assert.match(finding.message, /database_prepare/);
  assert.match(finding.message, /schema, migrate/);
});

test("database_prepare: migrate avertit de ce qu'il ne corrige pas", () => {
  const detected = { dataMigrations: ["20260514210000_create_currencies.rb"] };
  const { manifest, findings } = mergeManifest(detected, { databasePrepare: "migrate" });
  assert.equal(manifest.databasePrepare, "migrate");
  const finding = findByCode(findings, "database-prepare-migrate");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /db\/schema\.rb/);
  assert.ok(REMEDIES["database-prepare-migrate"]);
});

test("database_prepare: schema est le défaut et ne produit aucun avertissement", () => {
  const detected = { dataMigrations: ["20260514210000_create_currencies.rb"] };
  const { findings } = mergeManifest(detected, { databasePrepare: "schema" });
  assert.equal(findByCode(findings, "database-prepare-migrate"), undefined);
});
