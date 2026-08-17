// Contrainte de Ruby du Gemfile confrontée au Ruby de l'image de base.
//
// Ce que ces tests protègent. Un Gemfile qui épingle `ruby "3.3.10"` face à une
// base qui fournit 3.3.12 produisait un `Bundler::RubyVersionMismatch` au
// milieu du `bundle install` de app.Dockerfile — plusieurs minutes après le
// début de la construction, avec un journal Docker pour seule explication. La
// détection connaissait pourtant les deux valeurs.
//
// La moitié des cas ci-dessous vérifient l'INVERSE : les formes qui doivent
// passer. Refuser une application qui marche serait pire que le défaut
// d'origine, et `~> 3.3.10`, `~> 3.3` ou un `.ruby-version` seul en font
// partie.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { baseRubyVersion, parseBaseVersion, resolveBase } from "../tools/detect/bases.mjs";
import { detectApp } from "../tools/detect/detect.mjs";
import { mergeManifest, parseRailsboxYml } from "../tools/detect/manifest.mjs";
import { hasBlocking, REMEDIES } from "../tools/detect/report.mjs";
import {
  parseRubyDirective,
  resolveRubyRequirement,
  satisfiesRubyRequirement,
} from "../tools/detect/ruby-requirement.mjs";

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
  const dir = await mkdtemp(join(tmpdir(), "railsbox-ruby-"));
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
    sqlite3 (1.7.3)

DEPENDENCIES
  rails
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

// --- Table des bases --------------------------------------------------------

test("parseBaseVersion lit les trois écritures de référence qui circulent", () => {
  // Arrange / Act / Assert : entrée du workflow, image GHCR, nom local.
  assert.equal(parseBaseVersion("3.3-r2"), "3.3-r2");
  assert.equal(parseBaseVersion("ghcr.io/pinfada/railsbox-base:3.3-r2"), "3.3-r2");
  assert.equal(parseBaseVersion("railsbox-base-3.3"), "3.3");
  assert.equal(parseBaseVersion(null), null);
  assert.equal(parseBaseVersion("   "), null);
});

test("baseRubyVersion ne répond que pour une base publiée", () => {
  assert.equal(baseRubyVersion("3.3-r2"), "3.3.12");
  assert.equal(baseRubyVersion("4.0-r9"), null);
});

test("resolveBase ne suppose RIEN quand la base n'est pas précisée", () => {
  // build-app-disk.sh ne connaît sa base par défaut qu'APRÈS cette analyse :
  // supposer 3.3-r2 refuserait à tort une application d'une autre série.
  assert.deepEqual(resolveBase(undefined), { version: null, ruby: null });
  assert.deepEqual(resolveBase("3.3-r2"), { version: "3.3-r2", ruby: "3.3.12" });
});

test("detectApp, lui, vise la base par défaut du workflow", async () => {
  const dir = await createApp({ Gemfile: 'gem "rails"\n', "Gemfile.lock": LOCK });

  const { manifest } = await detectApp(dir);

  assert.deepEqual(
    { base: manifest.base, baseRuby: manifest.baseRuby },
    {
      base: "3.3-r2",
      baseRuby: "3.3.12",
    },
  );
});

test("detectApp avec une base VIDE s'abstient au lieu de supposer", async () => {
  const dir = await createApp({ Gemfile: 'ruby "3.2.9"\ngem "rails"\n', "Gemfile.lock": LOCK });

  const { findings } = await detectApp(dir, { base: "" });

  assert.equal(findByCode(findings, "ruby-version-incompatible"), undefined);
  assert.match(findByCode(findings, "base-ruby-unknown").message, /non précisée/);
});

// --- Lecture de la directive ------------------------------------------------

test("parseRubyDirective reconnaît les formes littérales et l'intervalle", () => {
  assert.deepEqual(parseRubyDirective('ruby "3.3.10"\n').requirements, ["3.3.10"]);
  assert.deepEqual(parseRubyDirective("ruby '~> 3.3.10'\n").requirements, ["~> 3.3.10"]);
  assert.deepEqual(parseRubyDirective('ruby ">= 3.1", "< 3.5"\n').requirements, [
    ">= 3.1",
    "< 3.5",
  ]);
});

test("parseRubyDirective ignore une directive commentée", () => {
  // Un exemple laissé en commentaire ne doit pas devenir la contrainte réelle.
  assert.equal(parseRubyDirective('# ruby "3.4.0"\ngem "rails"\n'), null);
});

test("parseRubyDirective ne confond pas la directive avec une gem homonyme", () => {
  assert.equal(parseRubyDirective('gem "ruby-vips"\ngem "rails"\n'), null);
});

test("parseRubyDirective reconnaît la lecture d'un fichier", () => {
  const parFile = parseRubyDirective('ruby file: ".ruby-version"\n');
  assert.deepEqual(
    { kind: parFile.kind, path: parFile.path },
    { kind: "file", path: ".ruby-version" },
  );
  const parRead = parseRubyDirective('ruby File.read(".ruby-version").strip\n');
  assert.equal(parRead.kind, "file");
});

test("resolveRubyRequirement transforme le fichier en égalité stricte", () => {
  // Bundler lit le fichier et en fait un `= 3.3.10` : `ruby file:` n'est pas
  // plus permissif que l'écriture littérale, seulement moins visible.
  const directive = parseRubyDirective('ruby file: ".ruby-version"\n');

  const resolved = resolveRubyRequirement(directive, "ruby-3.3.10\n");

  assert.deepEqual([...resolved.requirements], ["3.3.10"]);
});

// --- Sémantique de Gem::Requirement -----------------------------------------

test("satisfiesRubyRequirement applique la sémantique de Gem::Requirement", () => {
  assert.equal(satisfiesRubyRequirement("3.3.12", ["3.3.10"]), false);
  assert.equal(satisfiesRubyRequirement("3.3.12", ["= 3.3.12"]), true);
  assert.equal(satisfiesRubyRequirement("3.3.12", ["~> 3.3.10"]), true);
  assert.equal(satisfiesRubyRequirement("3.3.12", ["~> 3.3"]), true);
  assert.equal(satisfiesRubyRequirement("3.3.12", ["~> 3.4"]), false);
  assert.equal(satisfiesRubyRequirement("3.3.12", [">= 3.1", "< 3.5"]), true);
  assert.equal(satisfiesRubyRequirement("3.3.12", [">= 3.1", "< 3.3"]), false);
  assert.equal(satisfiesRubyRequirement("3.3.12", ["!= 3.3.12"]), false);
});

test("satisfiesRubyRequirement s'abstient plutôt que de refuser à tort", () => {
  // Rien de vérifiable : une base inconnue, ou une contrainte illisible.
  assert.equal(satisfiesRubyRequirement(null, ["3.3.10"]), null);
  assert.equal(satisfiesRubyRequirement("3.3.12", []), null);
  assert.equal(satisfiesRubyRequirement("3.3.12", ["jruby"]), null);
});

// --- Intégration : la détection refuse AVANT la construction ----------------

test("une égalité stricte incompatible est refusée, avec les deux versions nommées", async () => {
  // Arrange : exactement le Gemfile du premier intégrateur tiers.
  const dir = await createApp({ Gemfile: 'ruby "3.3.10"\ngem "rails"\n', "Gemfile.lock": LOCK });

  // Act
  const { findings } = await detectApp(dir, { base: "3.3-r2" });

  // Assert : le message nomme la contrainte ET ce que la base fournit.
  const finding = findByCode(findings, "ruby-version-incompatible");
  assert.equal(finding.severity, "blocking");
  assert.match(finding.message, /3\.3\.10/);
  assert.match(finding.message, /3\.3\.12/);
  assert.deepEqual(finding.details, {
    required: "3.3.10",
    provided: "3.3.12",
    base: "3.3-r2",
  });
  assert.equal(hasBlocking(findings), true);
  assert.match(REMEDIES["ruby-version-incompatible"], /~> 3\.3\.10/);
});

test('`ruby file: ".ruby-version"` est refusé par le même chemin', async () => {
  const dir = await createApp({
    Gemfile: 'ruby file: ".ruby-version"\ngem "rails"\n',
    ".ruby-version": "3.3.10\n",
    "Gemfile.lock": LOCK,
  });

  const { findings } = await detectApp(dir, { base: "3.3-r2" });

  assert.equal(findByCode(findings, "ruby-version-incompatible").severity, "blocking");
});

test("une contrainte pessimiste compatible n'est PAS refusée", async () => {
  const dir = await createApp({ Gemfile: 'ruby "~> 3.3.10"\ngem "rails"\n', "Gemfile.lock": LOCK });

  const { findings, manifest } = await detectApp(dir, { base: "3.3-r2" });

  assert.equal(findByCode(findings, "ruby-version-incompatible"), undefined);
  assert.equal(hasBlocking(findings), false);
  assert.deepEqual([...manifest.rubyRequirement.requirements], ["~> 3.3.10"]);
});

test("un .ruby-version SEUL n'engage pas Bundler et ne refuse rien", async () => {
  // Le faux positif le plus tentant : le fichier dit 3.3.10, la base fournit
  // 3.3.12 — mais rbenv n'est pas Bundler, et rien n'échouera au build.
  const dir = await createApp({
    ".ruby-version": "3.3.10\n",
    Gemfile: 'gem "rails"\n',
    "Gemfile.lock": LOCK,
  });

  const { findings, manifest } = await detectApp(dir, { base: "3.3-r2" });

  assert.equal(findByCode(findings, "ruby-version-incompatible"), undefined);
  assert.equal(manifest.rubyRequirement, null);
  assert.equal(manifest.ruby, "3.3.10", "la série reste celle du fichier");
  assert.equal(manifest.baseRuby, "3.3.12", "mais le guest exécutera celui de la base");
});

test("un Gemfile.lock qui fige RUBY VERSION ne refuse rien non plus", async () => {
  // Bundler réécrit cette section, il ne la fait pas respecter.
  const dir = await createApp({
    Gemfile: 'gem "rails"\n',
    "Gemfile.lock": `${LOCK}\nRUBY VERSION\n   ruby 3.3.10p183\n`,
  });

  const { findings } = await detectApp(dir, { base: "3.3-r2" });

  assert.equal(findByCode(findings, "ruby-version-incompatible"), undefined);
});

test("une base inconnue s'abstient au lieu de refuser", async () => {
  const dir = await createApp({ Gemfile: 'ruby "3.3.10"\ngem "rails"\n', "Gemfile.lock": LOCK });

  const { findings } = await detectApp(dir, { base: "9.9-r1" });

  assert.equal(findByCode(findings, "ruby-version-incompatible"), undefined);
  assert.equal(findByCode(findings, "base-ruby-unknown").severity, "info");
});

// --- La clé `ruby:` ne choisit que la série ---------------------------------

test("railsbox.yml « ruby: » de la même série est expliqué, pas refusé", async () => {
  const dir = await createApp({ Gemfile: 'ruby "~> 3.3"\ngem "rails"\n', "Gemfile.lock": LOCK });
  const detected = await detectApp(dir, { base: "3.3-r2" });

  const merged = mergeManifest(detected.manifest, parseRailsboxYml("ruby: 3.3.10\n").manifest);

  const finding = findByCode(merged.findings, "ruby-key-series-only");
  assert.equal(finding.severity, "info");
  assert.match(finding.message, /3\.3\.12/, "le Ruby réellement exécuté est nommé");
});

test("railsbox.yml « ruby: » d'une AUTRE série est un avertissement", async () => {
  // La clé ne change pas l'interpréteur du guest : demander 3.2 sur une base
  // 3.3 est une attente que rien ne satisfera.
  const dir = await createApp({ Gemfile: 'gem "rails"\n', "Gemfile.lock": LOCK });
  const detected = await detectApp(dir, { base: "3.3-r2" });

  const merged = mergeManifest(detected.manifest, parseRailsboxYml("ruby: 3.2.9\n").manifest);

  assert.equal(findByCode(merged.findings, "ruby-key-series-mismatch").severity, "warning");
});

test("railsbox.yml « ruby: » égal au Ruby de la base ne dit rien", async () => {
  const dir = await createApp({ Gemfile: 'gem "rails"\n', "Gemfile.lock": LOCK });
  const detected = await detectApp(dir, { base: "3.3-r2" });

  const merged = mergeManifest(detected.manifest, parseRailsboxYml("ruby: 3.3.12\n").manifest);

  assert.equal(findByCode(merged.findings, "ruby-key-series-only"), undefined);
  assert.equal(findByCode(merged.findings, "ruby-key-series-mismatch"), undefined);
});
