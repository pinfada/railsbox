// Panel de détection : les QUATRE variantes de l'application de démonstration
// passées à tools/detect, et leurs manifestes FIGÉS.
//
// Pourquoi ce test existe. Les variantes ne sont pas des démonstrations
// décoratives : chacune couvre un chemin de construction distinct, et c'est
// l'auto-détection qui décide lequel sera emprunté.
//
//   demo           sqlite3      · assets précompilés dans le guest i386
//   demo-pg        postgresql   · idem, mais cluster PostgreSQL embarqué
//   demo-tailwind  sqlite3      · assets amd64, gem à variante « ruby »
//   demo-dartsass  sqlite3      · assets amd64, gem SANS aucun binaire i386
//
// Une régression de classement (un « amd64 » qui redevient « i386ivre », une
// gem native oubliée) ne se voit pas dans les tests unitaires par fonction :
// elle se voit ici, sur les applications réelles, et ELLE se paie une heure
// plus tard par un build i386 qui cherche un binaire tailwindcss inexistant.
//
// Les surcouches sont matérialisées comme le font preparer-demo-pg.sh et
// preparer-demo-tailwind.sh : contenu de demo/, puis contenu de la surcouche
// par-dessus. Reproduire la fusion ici plutôt qu'invoquer les scripts garde le
// test exécutable partout où Node tourne, y compris sans bash.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectApp } from "../tools/detect/detect.mjs";
import { SEVERITY } from "../tools/detect/findings.mjs";
import { hasBlocking } from "../tools/detect/report.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_APP_DIR = join(PROJECT_ROOT, "tools", "demo-app");

/** @type {string[]} */
const createdDirs = [];

after(async () => {
  for (const dir of createdDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Matérialise une variante : demo/ puis, le cas échéant, la surcouche.
 * @param {string|null} overlay nom du dossier de surcouche, `null` pour demo seule
 * @returns {Promise<string>} racine de l'application matérialisée
 */
async function materialiser(overlay) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-panel-"));
  createdDirs.push(dir);
  await cp(join(DEMO_APP_DIR, "demo"), dir, { recursive: true });
  if (overlay) await cp(join(DEMO_APP_DIR, overlay), dir, { recursive: true });
  return dir;
}

/**
 * Réduit un manifeste à ce que le panel fige : tout le reste (versions de gems
 * transitoires) bougerait à chaque mise à jour du Gemfile.lock sans rien dire
 * du chemin de construction emprunté.
 * @param {import("../tools/detect/manifest.mjs").Manifest} manifest manifeste détecté
 * @returns {object} vue comparable
 */
function resume(manifest) {
  return {
    ruby: manifest.ruby,
    rubySource: manifest.rubySource,
    database: manifest.database,
    stage: manifest.assets.stage,
    npm: manifest.assets.npm,
    binaryGems: [...manifest.assets.binaryGems],
    scripts: [...manifest.assets.scripts],
    nativeGems: manifest.nativeGems.map((gem) => gem.name),
    services: { ...manifest.services },
  };
}

/**
 * Manifestes attendus, un par variante. Ce tableau EST le contrat : le modifier
 * doit être un acte délibéré, pas la conséquence silencieuse d'un correctif.
 */
const PANEL = Object.freeze([
  {
    nom: "demo",
    overlay: null,
    attendu: {
      ruby: "3.3.12",
      rubySource: ".ruby-version",
      database: "sqlite3",
      // Propshaft et importmap seuls : aucun binaire, le guest i386 précompile.
      stage: "i386",
      npm: false,
      binaryGems: [],
      scripts: [],
      nativeGems: ["nokogiri", "sqlite3"],
      services: { redis: false, sidekiq: false },
    },
  },
  {
    nom: "demo-pg",
    overlay: "demo-pg",
    attendu: {
      ruby: "3.3.12",
      rubySource: ".ruby-version",
      // Vient du config/database.yml de la surcouche, pas de la gem seule.
      database: "postgresql",
      stage: "i386",
      npm: false,
      binaryGems: [],
      scripts: [],
      // sqlite3 a disparu du Gemfile de la surcouche : pg le remplace.
      nativeGems: ["nokogiri", "pg"],
      services: { redis: false, sidekiq: false },
    },
  },
  {
    nom: "demo-tailwind",
    overlay: "demo-tailwind",
    attendu: {
      ruby: "3.3.12",
      rubySource: ".ruby-version",
      database: "sqlite3",
      // LE point de la variante : tailwindcss-ruby n'a aucun binaire i386.
      stage: "amd64",
      // Et il l'obtient SANS chaîne npm : Tailwind v4 est un exécutable
      // autonome, l'étage amd64 n'installera donc même pas node.
      npm: false,
      binaryGems: ["tailwindcss-rails", "tailwindcss-ruby"],
      scripts: [],
      nativeGems: ["nokogiri", "sqlite3"],
      services: { redis: false, sidekiq: false },
    },
  },
  {
    nom: "demo-dartsass",
    overlay: "demo-dartsass",
    attendu: {
      ruby: "3.3.12",
      rubySource: ".ruby-version",
      database: "sqlite3",
      // Même étage que Tailwind, cas plus strict : dartsass-rails tire
      // sass-embedded, dont AUCUNE variante i386 n'existe — là où
      // tailwindcss-ruby offre encore une variante « ruby ».
      stage: "amd64",
      npm: false,
      binaryGems: ["dartsass-rails"],
      scripts: [],
      nativeGems: ["nokogiri", "sqlite3"],
      services: { redis: false, sidekiq: false },
    },
  },
]);

for (const { nom, overlay, attendu } of PANEL) {
  test(`panel — le manifeste de « ${nom} » est celui attendu`, async () => {
    // Arrange
    const appDir = await materialiser(overlay);

    // Act
    const { manifest, findings } = await detectApp(appDir);

    // Assert
    assert.deepEqual(resume(manifest), attendu);
    assert.equal(
      manifest.rails,
      "8.1.3.1",
      "les quatre variantes suivent la même version de Rails",
    );
    assert.equal(hasBlocking(findings), false, "aucune variante ne doit être refusée");
    assert.deepEqual(
      findings.filter((finding) => finding.severity === SEVERITY.WARNING).map((f) => f.code),
      [],
      "aucun avertissement : les surcouches sont censées être complètes",
    );
  });
}

test("panel — les quatre variantes couvrent quatre chemins distincts", async () => {
  // Arrange / Act : base de données, étage d'assets, et outil d'assets — les
  // deux variantes amd64 partagent l'étage mais pas la gem qui l'impose, et
  // c'est bien cette gem qui décide de ce que le guest saurait exécuter.
  const chemins = PANEL.map(
    ({ attendu }) => `${attendu.database}/${attendu.stage}/${attendu.binaryGems[0] ?? "aucun"}`,
  );

  // Assert : sans cela, deux variantes pourraient converger au fil des
  // correctifs et l'on croirait tester quatre chemins pour n'en tester que
  // trois.
  assert.equal(new Set(chemins).size, PANEL.length, `chemins : ${chemins}`);
});
