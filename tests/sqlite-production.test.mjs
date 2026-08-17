// Le pilote sqlite3 dans le bundle de la VM, et l'override réel de
// config/database.yml.
//
// Deux défauts jumeaux que ces tests ferment.
//
//   1. Le disque applicatif est construit en RAILS_ENV=production et
//      DATABASE_URL n'était posée que pour PostgreSQL. Une application dont le
//      bloc `production:` de database.yml est PostgreSQL-only lisait donc son
//      propre fichier, et la clé `database: sqlite3` de railsbox.yml ne
//      changeait rien du tout.
//   2. Le bundle est installé avec `BUNDLE_WITHOUT="development:test"`. Une gem
//      `sqlite3` rangée dans `group :development` — le cas de la première
//      application tierce intégrée — n'existe pas dans la VM, alors que le
//      Gemfile.lock la mentionne.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { detectApp } from "../tools/detect/detect.mjs";
import { isInProductionBundle, parseGemfileGroups } from "../tools/detect/gems.mjs";
import { mergeManifest, parseRailsboxYml } from "../tools/detect/manifest.mjs";
import { hasBlocking } from "../tools/detect/report.mjs";
import { buildArgs, SQLITE_DATABASE_URL } from "../tools/build-v86-image/manifest-to-args.mjs";

/** @typedef {import("../tools/detect/findings.mjs").Finding} Finding */

const createdDirs = [];

after(async () => {
  for (const dir of createdDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Crée une application factice dans un dossier temporaire.
 * @param {Record<string, string>} files chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function createApp(files) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-sqlite-"));
  createdDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

const LOCK = `GEM
  remote: https://rubygems.org/
  specs:
    rails (7.1.3.4)
    pg (1.5.6)
    sqlite3 (1.7.3)

DEPENDENCIES
  rails
`;

/** database.yml de l'application tierce : PostgreSQL en production, sqlite3 en dev. */
const DATABASE_YML = `default: &default
  adapter: postgresql

development:
  adapter: sqlite3
  database: db/development.sqlite3

production:
  <<: *default
  url: <%= ENV['DATABASE_URL'] %>
`;

/** Gemfile de l'application tierce : pg partout, sqlite3 en développement seul. */
const GEMFILE_TIERS = `source "https://rubygems.org"
gem "rails"
gem "pg", "~> 1.5"

group :development do
  gem "sqlite3", "~> 1.4"
end
`;

/**
 * Cherche un diagnostic par code.
 * @param {readonly Finding[]} findings diagnostics
 * @param {string} code code recherché
 * @returns {Finding|undefined} diagnostic trouvé
 */
function findByCode(findings, code) {
  return findings.find((finding) => finding.code === code);
}

// --- Lecture des groupes Bundler --------------------------------------------

test("parseGemfileGroups classe les gems par groupe", () => {
  const groups = parseGemfileGroups(GEMFILE_TIERS);

  assert.deepEqual(groups.get("rails"), []);
  assert.deepEqual(groups.get("pg"), []);
  assert.deepEqual(groups.get("sqlite3"), ["development"]);
});

test("parseGemfileGroups ne se laisse pas décaler par un bloc imbriqué", () => {
  // Le `end` de `platforms … do` fermait le `group … do` englobant, et toutes
  // les gems suivantes changeaient silencieusement de groupe.
  const groups = parseGemfileGroups(`group :development do
  platforms :ruby do
    gem "byebug"
  end
  gem "sqlite3"
end
gem "puma"
`);

  assert.deepEqual(groups.get("byebug"), ["development"]);
  assert.deepEqual(groups.get("sqlite3"), ["development"]);
  assert.deepEqual(groups.get("puma"), [], "puma est hors de tout groupe");
});

test("parseGemfileGroups lit l'option group: en ligne", () => {
  const groups = parseGemfileGroups(`gem "sqlite3", group: :development
gem "rspec", groups: [:development, :test]
`);

  assert.deepEqual(groups.get("sqlite3"), ["development"]);
  assert.deepEqual(groups.get("rspec"), ["development", "test"]);
});

test("isInProductionBundle applique la règle de Bundler, pas une approximation", () => {
  const groups = parseGemfileGroups(`gem "rails"
gem "a", group: :development
gem "b", groups: [:development, :test]
gem "c", groups: [:development, :production]
`);

  assert.equal(isInProductionBundle(groups, "rails"), true);
  assert.equal(isInProductionBundle(groups, "a"), false);
  assert.equal(isInProductionBundle(groups, "b"), false);
  // Un seul groupe non exclu suffit à faire installer la gem.
  assert.equal(isInProductionBundle(groups, "c"), true);
  assert.equal(isInProductionBundle(groups, "absente"), false);
});

// --- Diagnostic -------------------------------------------------------------

test("une gem sqlite3 en développement seul est signalée en INFO tant que PG est retenu", async () => {
  // Rien n'est cassé : l'application tourne sur PostgreSQL. Mais le repli
  // sqlite3 est impossible, et mieux vaut le lire ici qu'après une
  // construction refusée.
  const dir = await createApp({
    Gemfile: GEMFILE_TIERS,
    "Gemfile.lock": LOCK,
    "config/database.yml": DATABASE_YML,
  });

  const { findings, manifest } = await detectApp(dir);

  assert.equal(manifest.database, "postgresql");
  const finding = findByCode(findings, "sqlite3-fallback-unavailable");
  assert.equal(finding.severity, "info");
  assert.deepEqual(finding.details.groups, ["development"]);
  assert.equal(hasBlocking(findings), false);
});

test("« database: sqlite3 » sur cette même application est REFUSÉ", async () => {
  // Le cœur du défaut : la clé paraissait acceptée, et l'application échouait
  // dans la VM sur un LoadError qu'aucun rapport n'annonçait.
  const dir = await createApp({
    Gemfile: GEMFILE_TIERS,
    "Gemfile.lock": LOCK,
    "config/database.yml": DATABASE_YML,
  });
  const detected = await detectApp(dir);

  const merged = mergeManifest(detected.manifest, parseRailsboxYml("database: sqlite3\n").manifest);

  const finding = findByCode(merged.findings, "sqlite3-gem-missing-in-production");
  assert.equal(finding.severity, "blocking");
  assert.match(finding.message, /development/);
  assert.match(finding.message, /BUNDLE_WITHOUT/);
  assert.equal(hasBlocking(merged.findings), true);
});

test("une gem sqlite3 hors groupe ne déclenche rien", async () => {
  const dir = await createApp({
    Gemfile: 'gem "rails"\ngem "sqlite3", ">= 2.1"\n',
    "Gemfile.lock": LOCK,
    "config/database.yml": "production:\n  adapter: sqlite3\n",
  });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "sqlite3-gem-missing-in-production"), undefined);
  assert.equal(findByCode(findings, "sqlite3-fallback-unavailable"), undefined);
  assert.equal(findByCode(findings, "missing-sqlite3-gem"), undefined);
});

test("une gem absente du Gemfile avertit sans refuser", async () => {
  // sqlite3 peut n'avoir été retenu que par défaut, faute de database.yml :
  // refuser sur une supposition rejetterait des applications qui marchent.
  const dir = await createApp({
    Gemfile: 'gem "rails"\n',
    "Gemfile.lock": "GEM\n  specs:\n    rails (7.1.3.4)\n\nDEPENDENCIES\n  rails\n",
  });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "missing-sqlite3-gem").severity, "warning");
  assert.equal(hasBlocking(findings), false);
});

test("sans Gemfile.lock, l'absence n'est pas une preuve", async () => {
  const dir = await createApp({ Gemfile: 'gem "rails"\n' });

  const { findings } = await detectApp(dir);

  assert.equal(findByCode(findings, "missing-sqlite3-gem"), undefined);
});

// --- L'override devient réel -------------------------------------------------

test("une sandbox sqlite3 reçoit une DATABASE_URL, donc un override réel", () => {
  // Sans elle, l'application lisait le bloc `production:` de son propre
  // database.yml — souvent PostgreSQL-only — et ignorait le fichier sqlite3
  // que la construction venait pourtant de créer et de peupler.
  const args = buildArgs({
    manifest: { database: "sqlite3" },
    specs: new Map(),
    hasSeeds: false,
    appName: "demo",
  });

  assert.equal(args.SQLITE_DATABASE_URL, SQLITE_DATABASE_URL);
  assert.match(args.SQLITE_DATABASE_URL, /^sqlite3:/);
  assert.doesNotMatch(args.SQLITE_DATABASE_URL, /^sqlite3:\//, "un chemin RELATIF à Rails.root");
});

test("une sandbox PostgreSQL n'en reçoit aucune : PG_DATABASE_URL fait foi", () => {
  const args = buildArgs({
    manifest: { database: "postgresql" },
    specs: new Map(),
    hasSeeds: false,
    appName: "demo",
  });

  assert.equal(args.SQLITE_DATABASE_URL, "");
  assert.match(args.PG_DATABASE_URL, /^postgresql:/);
});
