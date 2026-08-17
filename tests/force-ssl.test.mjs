// `config.force_ssl` : détection dans production.rb, et neutralisation dans le
// guest.
//
// Ce que ces tests protègent. `config.force_ssl = true` est le défaut d'un
// `rails new` depuis Rails 7 : il est dans presque toutes les applications que
// railsbox vise, y compris les quatre variantes de démonstration du dépôt. La
// sandbox n'a aucune terminaison TLS — Rails y répondrait 301 vers https en
// boucle et n'émettrait que des cookies « secure ».
//
// Deux exigences opposées se croisent ici, et c'est tout l'enjeu :
//   - une application NON MODIFIÉE doit fonctionner → on neutralise le réglage
//     dans le guest, sans attendre que l'analyse statique l'ait vu ;
//   - le rapport ne doit pas crier au loup → la forme conditionnelle
//     (`ENV["FORCE_SSL"].present?`), très répandue et déjà correcte, ne
//     déclenche aucun diagnostic.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { detectApp } from "../tools/detect/detect.mjs";
import { mergeManifest, parseRailsboxYml } from "../tools/detect/manifest.mjs";
import { hasBlocking } from "../tools/detect/report.mjs";
import { detectSslSettings, evaluateSslExpression, isSslEnforced } from "../tools/detect/ssl.mjs";
import { buildForceSslInitializer, KEEP_VARIABLE } from "../tools/build-v86-image/force-ssl.mjs";
import { buildArgs } from "../tools/build-v86-image/manifest-to-args.mjs";

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
  const dir = await mkdtemp(join(tmpdir(), "railsbox-ssl-"));
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
    rails (8.0.0)
    sqlite3 (2.1.0)

DEPENDENCIES
  rails
`;

const GEMFILE = 'gem "rails"\ngem "sqlite3"\n';

/**
 * Enveloppe des lignes de configuration dans un production.rb plausible.
 * @param {string} body lignes de configuration
 * @returns {string} fichier complet
 */
function productionRb(body) {
  return `require "active_support/core_ext/integer/time"

Rails.application.configure do
  config.eager_load = true
${body}
end
`;
}

/**
 * Cherche un diagnostic par code.
 * @param {readonly Finding[]} findings diagnostics
 * @param {string} code code recherché
 * @returns {Finding|undefined} diagnostic trouvé
 */
function findByCode(findings, code) {
  return findings.find((finding) => finding.code === code);
}

// --- Évaluation des expressions ---------------------------------------------

test("evaluateSslExpression tranche les littéraux", () => {
  assert.deepEqual(evaluateSslExpression("true"), { state: "actif", env: null });
  assert.deepEqual(evaluateSslExpression("false"), { state: "inactif", env: null });
});

test("evaluateSslExpression évalue la forme ENV variable ABSENTE", () => {
  // C'est le seul critère qui compte : ce que fait l'application quand
  // railsbox ne pose pas la variable.
  assert.deepEqual(evaluateSslExpression('ENV.fetch("RAILS_FORCE_SSL", "true") == "true"'), {
    state: "conditionnel-actif",
    env: "RAILS_FORCE_SSL",
  });
  assert.deepEqual(evaluateSslExpression('ENV.fetch("RAILS_FORCE_SSL", "false") == "true"'), {
    state: "conditionnel-inactif",
    env: "RAILS_FORCE_SSL",
  });
  assert.deepEqual(evaluateSslExpression('ENV["FORCE_SSL"] == "true"'), {
    state: "conditionnel-inactif",
    env: "FORCE_SSL",
  });
  assert.deepEqual(evaluateSslExpression('ENV["FORCE_SSL"].present?'), {
    state: "conditionnel-inactif",
    env: "FORCE_SSL",
  });
  assert.deepEqual(evaluateSslExpression('ENV.fetch("FORCE_SSL", "on").present?'), {
    state: "conditionnel-actif",
    env: "FORCE_SSL",
  });
});

test("evaluateSslExpression s'avoue ignorante plutôt que d'inventer", () => {
  assert.deepEqual(evaluateSslExpression("Settings.ssl_enabled?"), { state: "inconnu", env: null });
});

// --- Lecture du fichier -----------------------------------------------------

test("detectSslSettings ignore les lignes commentées", () => {
  // Le production.rb de `rails new` commente `config.assume_ssl` : le prendre
  // pour un réglage actif ferait mentir le rapport.
  const settings = detectSslSettings(
    productionRb("  # config.assume_ssl = true\n  config.force_ssl = true"),
  );

  assert.equal(settings.assume_ssl, null);
  assert.equal(settings.force_ssl.state, "actif");
});

test("detectSslSettings retient la DERNIÈRE affectation, comme Ruby", () => {
  const settings = detectSslSettings(
    productionRb("  config.force_ssl = true\n  config.force_ssl = false"),
  );

  assert.equal(settings.force_ssl.state, "inactif");
  assert.equal(isSslEnforced(settings.force_ssl), false);
});

// --- Diagnostic -------------------------------------------------------------

test("force_ssl littéral est signalé en INFO, avec la ligne", async () => {
  // INFO et non avertissement : railsbox le neutralise. Un avertissement sur
  // un réglage que le produit gère déjà rendrait tout le rapport suspect —
  // et les quatre variantes de démonstration le porteraient toutes.
  const dir = await createApp({
    Gemfile: GEMFILE,
    "Gemfile.lock": LOCK,
    "config/environments/production.rb": productionRb("  config.force_ssl = true"),
  });

  const { findings, manifest } = await detectApp(dir);

  const finding = findByCode(findings, "force-ssl-enabled");
  assert.equal(finding.severity, "info");
  assert.equal(finding.details.line, 5);
  assert.match(finding.message, /neutralise/);
  assert.equal(manifest.ssl.enforced, true);
  assert.equal(hasBlocking(findings), false);
});

test("la forme ENV active par défaut est signalée, et nomme la variable", async () => {
  const dir = await createApp({
    Gemfile: GEMFILE,
    "Gemfile.lock": LOCK,
    "config/environments/production.rb": productionRb(
      '  config.force_ssl = ENV.fetch("RAILS_FORCE_SSL", "true") == "true"',
    ),
  });

  const { findings } = await detectApp(dir);

  const finding = findByCode(findings, "force-ssl-enabled");
  assert.equal(finding.details.env, "RAILS_FORCE_SSL");
  assert.match(finding.message, /RAILS_FORCE_SSL/);
});

test("la forme ENV inactive par défaut n'est PAS signalée", async () => {
  // Faux positif à ne jamais produire : cette application a déjà le bon
  // comportement sans que railsbox ait à intervenir.
  const dir = await createApp({
    Gemfile: GEMFILE,
    "Gemfile.lock": LOCK,
    "config/environments/production.rb": productionRb(
      '  config.force_ssl = ENV["FORCE_SSL"].present?',
    ),
  });

  const { findings, manifest } = await detectApp(dir);

  assert.equal(findByCode(findings, "force-ssl-enabled"), undefined);
  assert.equal(manifest.ssl.enforced, false);
});

test("assume_ssl seul ne déclenche aucun diagnostic", async () => {
  // assume_ssl fait croire à Rails qu'il est derrière un terminateur TLS —
  // exactement ce que le proxy annonce déjà. Rien à signaler.
  const dir = await createApp({
    Gemfile: GEMFILE,
    "Gemfile.lock": LOCK,
    "config/environments/production.rb": productionRb("  config.assume_ssl = true"),
  });

  const { findings, manifest } = await detectApp(dir);

  assert.equal(findByCode(findings, "force-ssl-enabled"), undefined);
  assert.equal(manifest.ssl.assumeSsl, "actif");
});

test("sans config/environments/production.rb, rien n'est inventé", async () => {
  const dir = await createApp({ Gemfile: GEMFILE, "Gemfile.lock": LOCK });

  const { findings, manifest } = await detectApp(dir);

  assert.equal(findByCode(findings, "force-ssl-enabled"), undefined);
  assert.equal(manifest.ssl.forceSsl, null);
});

// --- Désarmement de la parade ------------------------------------------------

test("désarmer la neutralisation devient un AVERTISSEMENT", async () => {
  const dir = await createApp({
    Gemfile: GEMFILE,
    "Gemfile.lock": LOCK,
    "config/environments/production.rb": productionRb("  config.force_ssl = true"),
  });
  const detected = await detectApp(dir);

  const merged = mergeManifest(
    detected.manifest,
    parseRailsboxYml(`env:\n  ${KEEP_VARIABLE}: "1"\n`).manifest,
  );

  const finding = findByCode(merged.findings, "force-ssl-kept");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /301/);
});

test("la variable de désarmement sur une application SANS force_ssl ne dit rien", async () => {
  const dir = await createApp({ Gemfile: GEMFILE, "Gemfile.lock": LOCK });
  const detected = await detectApp(dir);

  const merged = mergeManifest(
    detected.manifest,
    parseRailsboxYml(`env:\n  ${KEEP_VARIABLE}: "1"\n`).manifest,
  );

  assert.equal(findByCode(merged.findings, "force-ssl-kept"), undefined);
});

// --- Initialiseur déposé dans le guest --------------------------------------

test("l'initialiseur est gardé par RAILSBOX_SANDBOX et désarmable", () => {
  const source = buildForceSslInitializer();

  assert.match(source, /ENV\["RAILSBOX_SANDBOX"\] == "1"/);
  assert.match(source, new RegExp(`ENV\\["${KEEP_VARIABLE}"\\] != "1"`));
  assert.match(source, /Rails\.application\.config\.force_ssl = false/);
});

test("l'initialiseur n'est pas émis quand la neutralisation est désactivée", () => {
  assert.equal(buildForceSslInitializer({ enabled: false }), "");
});

test("buildArgs n'émet plus l'initialiseur si railsbox.yml désarme la parade", () => {
  // Arrange
  const commun = { specs: new Map(), hasSeeds: false, appName: "demo" };

  // Act
  const avec = buildArgs({ manifest: { database: "sqlite3" }, ...commun });
  const sans = buildArgs({
    manifest: { database: "sqlite3", env: { [KEEP_VARIABLE]: "1" } },
    ...commun,
  });

  // Assert
  assert.match(avec.FORCE_SSL_INITIALIZER, /force_ssl = false/);
  assert.equal(sans.FORCE_SSL_INITIALIZER, "");
});
