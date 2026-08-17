import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OUTPUT_DIRS,
  detectOutputDirs,
  mergeOutputDirs,
  normalizeOutputDir,
  sanitizeOutputDirs,
  shakapackerOutputDirs,
  viteOutputDirs,
} from "../tools/detect/asset-output.mjs";
import { planAssets } from "../tools/detect/assets.mjs";
import { parseRailsboxYml, mergeManifest } from "../tools/detect/manifest.mjs";
import { REMEDIES } from "../tools/detect/report.mjs";
import { buildArgs } from "../tools/build-v86-image/manifest-to-args.mjs";

/**
 * Construit une table de gems résolues.
 * @param {string[]} names noms de gems présentes dans le Gemfile.lock
 * @returns {Map<string, string>} table nom → version
 */
function specs(names) {
  return new Map(names.map((name) => [name, "1.0.0"]));
}

// --- Validation : c'est une FRONTIÈRE, les valeurs viennent d'un dépôt tiers --

test("normalizeOutputDir accepte un chemin relatif ordinaire", () => {
  // Arrange / Act / Assert
  assert.equal(normalizeOutputDir("public/dist"), "public/dist");
  assert.equal(normalizeOutputDir("  public/vite  "), "public/vite");
  assert.equal(normalizeOutputDir("public/packs/"), "public/packs");
  assert.equal(normalizeOutputDir("app/javascript/build"), "app/javascript/build");
});

test("normalizeOutputDir refuse tout chemin qui sort de l'arbre applicatif", () => {
  // Arrange : les deux formes qui donnent accès à l'hôte de construction.
  for (const hostile of [
    "../etc",
    "public/../../etc",
    "..",
    "./..",
    "/etc/passwd",
    "/",
    "~/.ssh",
    "~",
  ]) {
    // Act / Assert
    assert.equal(normalizeOutputDir(hostile), null, hostile);
  }
});

test("normalizeOutputDir refuse tout ce qu'un shell pourrait interpréter", () => {
  // Arrange : ces valeurs finissent dans une boucle `for dir in ${…}` de
  // l'étage amd64, puis dans un chemin de copie.
  for (const hostile of [
    "public/dist; rm -rf /",
    "public/$(id)",
    "public/`id`",
    "public/${HOME}",
    "public/*",
    "public dist",
    "public\tdist",
    "public/dist\nautre",
    "public|dist",
    "public/dist&",
    "public/dis't",
    'public/"dist"',
    "public\\dist",
    "C:\\dist",
    "public/dist#a",
  ]) {
    // Act / Assert
    assert.equal(normalizeOutputDir(hostile), null, hostile);
  }
});

test("normalizeOutputDir refuse le vide, le non-texte et les chemins démesurés", () => {
  // Arrange / Act / Assert
  assert.equal(normalizeOutputDir(""), null);
  assert.equal(normalizeOutputDir("   "), null);
  assert.equal(normalizeOutputDir(/** @type {*} */ (null)), null);
  assert.equal(normalizeOutputDir(/** @type {*} */ (42)), null);
  assert.equal(normalizeOutputDir(/** @type {*} */ (["public/dist"])), null);
  assert.equal(normalizeOutputDir("a".repeat(129)), null, "trop long");
  assert.equal(normalizeOutputDir("a/b/c/d/e/f/g"), null, "trop de segments");
});

test("sanitizeOutputDirs sépare les chemins retenus des refusés, sans doublon", () => {
  // Arrange / Act
  const { dirs, rejected } = sanitizeOutputDirs([
    "public/dist",
    "public/dist",
    "../evil",
    "public/vite",
  ]);

  // Assert
  assert.deepEqual(dirs, ["public/dist", "public/vite"]);
  assert.deepEqual(rejected, ["../evil"]);
});

// --- Fusion ------------------------------------------------------------------

test("mergeOutputDirs écarte les doublons et les chemins déjà couverts", () => {
  // Arrange / Act
  const merged = mergeOutputDirs(
    ["public/assets", "app/assets/builds"],
    ["public/vite", "public/vite/assets", "public/assets"],
    ["public/dist"],
  );

  // Assert
  assert.deepEqual(merged, ["public/assets", "app/assets/builds", "public/vite", "public/dist"]);
});

// --- Auto-détection ----------------------------------------------------------

test("vite_rails fait exporter public/vite sans que rien ne soit déclaré", () => {
  // Arrange / Act
  const { dirs, findings } = detectOutputDirs({ specs: specs(["vite_rails", "vite_ruby"]) });

  // Assert
  assert.deepEqual(dirs, ["public/vite"]);
  const info = findings.find((finding) => finding.code === "assets-output-detected");
  assert.equal(info.severity, "info");
  assert.match(info.message, /public\/vite/);
});

test("Shakapacker et Webpacker font exporter public/packs", () => {
  // Arrange / Act / Assert
  assert.deepEqual(detectOutputDirs({ specs: specs(["shakapacker"]) }).dirs, ["public/packs"]);
  assert.deepEqual(detectOutputDirs({ specs: specs(["webpacker"]) }).dirs, ["public/packs"]);
});

test("config/vite.json a le dernier mot sur le répertoire de sortie", () => {
  // Arrange : un dépôt qui déplace sa sortie ; le défaut de la gem ne suffit pas.
  const viteJson = JSON.stringify({
    all: { publicOutputDir: "bundles", sourceCodeDir: "app/frontend" },
    production: { publicOutputDir: "bundles" },
  });

  // Act
  const { dirs } = detectOutputDirs({ specs: specs(["vite_rails"]), viteJson });

  // Assert : la sortie configurée ET le défaut, faute de savoir laquelle sert.
  assert.ok(dirs.includes("public/bundles"), dirs.join(", "));
});

test("viteOutputDirs tolère un config/vite.json illisible", () => {
  // Arrange / Act / Assert
  assert.deepEqual(viteOutputDirs("{ pas du json"), []);
  assert.deepEqual(viteOutputDirs(null), []);
  assert.deepEqual(viteOutputDirs("[]"), []);
});

test("shakapackerOutputDirs relève toutes les sorties déclarées, ancres comprises", () => {
  // Arrange : la forme réelle du fichier, que le sous-ensemble YAML ne lit pas.
  const yml = [
    "default: &default",
    "  public_root_path: public",
    "  public_output_path: packs",
    "",
    "production:",
    "  <<: *default",
    "  public_output_path: packs-prod",
  ].join("\n");

  // Act
  const dirs = shakapackerOutputDirs(yml);

  // Assert
  assert.deepEqual(dirs, ["public/packs", "public/packs-prod"]);
});

test("une sortie hostile lue dans une configuration tierce est refusée, pas assainie", () => {
  // Arrange
  const viteJson = JSON.stringify({ publicOutputDir: "../../etc", publicDir: "public" });

  // Act
  const { dirs, findings } = detectOutputDirs({ specs: specs(["vite_rails"]), viteJson });

  // Assert
  assert.equal(dirs.includes("public/../../etc"), false);
  assert.ok(findings.some((finding) => finding.code === "invalid-asset-output"));
  assert.ok(REMEDIES["invalid-asset-output"]);
});

// --- Plan d'assets -----------------------------------------------------------

test("le plan porte toujours les deux répertoires structurels en tête", () => {
  // Arrange / Act
  const { plan } = planAssets({ assets: { npm: true }, specs: specs(["propshaft"]) });

  // Assert
  assert.deepEqual([...plan.output], [...DEFAULT_OUTPUT_DIRS]);
  assert.equal(Object.isFrozen(plan.output), true);
});

test("les répertoires détectés s'ajoutent aux deux répertoires structurels", () => {
  // Arrange / Act
  const { plan } = planAssets({
    assets: { npm: true },
    specs: specs(["vite_rails"]),
    outputDirs: ["public/vite"],
  });

  // Assert
  assert.deepEqual([...plan.output], ["public/assets", "app/assets/builds", "public/vite"]);
});

test("rejouer le plan conserve les répertoires de sortie déjà retenus", () => {
  // Arrange : manifest-to-args rejoue planAssets après fusion du railsbox.yml,
  // sans avoir relu config/vite.json.
  const premier = planAssets({
    assets: { npm: true },
    specs: specs(["vite_rails"]),
    outputDirs: ["public/vite"],
  }).plan;

  // Act
  const second = planAssets({ assets: premier, specs: specs(["vite_rails"]) }).plan;

  // Assert
  assert.deepEqual([...second.output], [...premier.output]);
});

// --- railsbox.yml ------------------------------------------------------------

test("assets.output est lu depuis railsbox.yml", () => {
  // Arrange / Act
  const { manifest, findings } = parseRailsboxYml(
    ["assets:", '  scripts: ["build:react"]', '  output: ["public/dist"]'].join("\n"),
  );

  // Assert
  assert.deepEqual(manifest.assets.output, ["public/dist"]);
  assert.deepEqual(manifest.assets.scripts, ["build:react"]);
  assert.deepEqual(findings, []);
});

test("assets.output accepte un scalaire comme liste d'un élément", () => {
  // Arrange / Act
  const { manifest } = parseRailsboxYml("assets:\n  output: public/dist\n");

  // Assert
  assert.deepEqual(manifest.assets.output, ["public/dist"]);
});

test("une entrée hostile d'assets.output est refusée avec un diagnostic", () => {
  // Arrange / Act
  const { manifest, findings } = parseRailsboxYml(
    'assets:\n  output: ["public/dist", "../../etc", "/etc/passwd"]\n',
  );

  // Assert : les entrées saines passent, les autres sont nommées.
  assert.deepEqual(manifest.assets.output, ["public/dist"]);
  const refus = findings.filter((finding) => finding.code === "invalid-asset-output");
  assert.equal(refus.length, 2);
  assert.equal(refus[0].severity, "warning");
  assert.match(refus[0].message, /\.\.\/\.\.\/etc/);
});

test("un assets.output entièrement hostile ne laisse aucune valeur au manifeste", () => {
  // Arrange / Act
  const { manifest, findings } = parseRailsboxYml('assets:\n  output: ["$(id)", "../.."]\n');

  // Assert
  assert.equal(manifest.assets, undefined);
  assert.equal(findings.filter((finding) => finding.code === "invalid-asset-output").length, 2);
});

test("assets.output complète la détection au lieu de la remplacer", () => {
  // Arrange : la détection a déjà trouvé public/vite ; le mainteneur ajoute
  // public/dist. Perdre public/vite rendrait la sandbox muette en silence —
  // exactement la panne qu'on ferme.
  const detected = { assets: { npm: true, output: ["public/vite"] } };
  const declared = { assets: { output: ["public/dist"] } };

  // Act
  const { manifest } = mergeManifest(detected, declared);

  // Assert
  assert.deepEqual([...manifest.assets.output], ["public/vite", "public/dist"]);
});

test("un railsbox.yml sans assets.output laisse la détection intacte", () => {
  // Arrange / Act
  const { manifest } = mergeManifest(
    { assets: { npm: true, output: ["public/vite"], scripts: ["build"] } },
    { assets: { scripts: ["build:css"] } },
  );

  // Assert
  assert.deepEqual([...manifest.assets.output], ["public/vite"]);
  assert.deepEqual([...manifest.assets.scripts], ["build:css"]);
});

// --- Contrat avec la construction --------------------------------------------

test("ASSET_OUTPUT_DIRS transporte la liste séparée par des espaces", () => {
  // Arrange : c'est la forme que consomme la boucle `for dir in ${…}` de
  // l'étage amd64 — d'où l'interdiction absolue des espaces dans une valeur.
  const manifest = {
    ruby: "3.3.12",
    database: "sqlite3",
    assets: { npm: true, scripts: ["build:react"], output: ["public/dist"] },
    services: {},
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: specs(["propshaft", "jsbundling-rails"]),
    hasSeeds: false,
    appName: "demo",
  });

  // Assert
  assert.equal(args.ASSET_OUTPUT_DIRS, "public/assets app/assets/builds public/dist");
  assert.equal(args.ASSETS_STAGE, "amd64");
});

test("une clé inconnue du bloc assets reste signalée", () => {
  // Arrange / Act
  const { findings } = parseRailsboxYml("assets:\n  sortie: public/dist\n");

  // Assert
  assert.equal(findings[0].code, "unknown-manifest-key");
  assert.match(findings[0].message, /assets\.sortie/);
});
