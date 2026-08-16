import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_STAGE,
  binaryAssetGems,
  npmInstallCommand,
  planAssets,
} from "../tools/detect/assets.mjs";
import { REMEDIES } from "../tools/detect/report.mjs";

/**
 * Construit une table de gems résolues.
 * @param {string[]} names noms de gems présentes dans le Gemfile.lock
 * @returns {Map<string, string>} table nom → version
 */
function specs(names) {
  return new Map(names.map((name) => [name, "1.0.0"]));
}

// --- Gems à exécutable précompilé --------------------------------------------

test("binaryAssetGems relève les gems dont aucun binaire i386 n'existe", () => {
  // Arrange / Act / Assert
  assert.deepEqual(binaryAssetGems(specs(["propshaft"])), []);
  assert.deepEqual(binaryAssetGems(specs(["tailwindcss-rails", "tailwindcss-ruby"])), [
    "tailwindcss-rails",
    "tailwindcss-ruby",
  ]);
  assert.deepEqual(binaryAssetGems(specs(["dartsass-rails", "tailwindcss-rails"])), [
    "dartsass-rails",
    "tailwindcss-rails",
  ]);
});

test("binaryAssetGems tolère une entrée qui n'est pas une table de gems", () => {
  // Arrange / Act / Assert
  assert.deepEqual(binaryAssetGems(/** @type {*} */ (null)), []);
});

// --- Choix de l'étage de précompilation --------------------------------------

test("une application importmap/propshaft précompile dans le guest i386", () => {
  // Arrange / Act
  const { plan } = planAssets({ assets: { npm: false }, specs: specs(["propshaft"]) });

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.GUEST);
  assert.equal(plan.install, "");
  assert.deepEqual([...plan.binaryGems], []);
});

test("tailwindcss-rails bascule la précompilation sur l'étage amd64", () => {
  // Arrange : Tailwind par la gem, donc AUCUN package.json — c'est le cas que
  // la construction refusait jusqu'ici.
  const { plan, findings } = planAssets({
    assets: { npm: false },
    specs: specs(["propshaft", "tailwindcss-rails", "tailwindcss-ruby"]),
  });

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.HOST);
  assert.deepEqual([...plan.binaryGems], ["tailwindcss-rails", "tailwindcss-ruby"]);
  // Pas de package.json : rien à installer côté npm.
  assert.equal(plan.install, "");
  const info = findings.find((finding) => finding.code === "assets-amd64-stage");
  assert.equal(info.severity, "info");
  assert.match(info.message, /tailwindcss-rails/);
});

test("dartsass-rails bascule lui aussi sur l'étage amd64", () => {
  // Arrange / Act
  const { plan } = planAssets({
    assets: { npm: false },
    specs: specs(["sprockets-rails", "dartsass-rails", "dartsass-ruby"]),
  });

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.HOST);
});

test("une chaîne npm impose l'étage amd64, même sans gem à binaire", () => {
  // Arrange / Act
  const { plan } = planAssets({
    assets: { npm: true, scripts: ["build:css", "build:js"], tools: ["esbuild"] },
    specs: specs(["propshaft", "jsbundling-rails", "cssbundling-rails"]),
    lockfiles: ["package-lock.json"],
  });

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.HOST);
  assert.deepEqual([...plan.scripts], ["build:css", "build:js"]);
  assert.equal(plan.install, "npm ci --no-audit --no-fund");
});

test("sans pipeline d'assets, il n'y a rien à précompiler", () => {
  // Arrange / Act
  const { plan, findings } = planAssets({ assets: { npm: false }, specs: specs(["rails"]) });

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.NONE);
  assert.deepEqual(findings, []);
});

test("planAssets sans argument rend un plan vide plutôt qu'une exception", () => {
  // Arrange / Act
  const { plan } = planAssets();

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.NONE);
  assert.equal(plan.npm, false);
  assert.equal(Object.isFrozen(plan), true);
});

// --- Installation des dépendances front --------------------------------------

test("npmInstallCommand exige un verrou npm pour une installation reproductible", () => {
  // Arrange / Act / Assert
  assert.match(npmInstallCommand(["package-lock.json"]), /^npm ci /);
  assert.match(npmInstallCommand(["npm-shrinkwrap.json"]), /^npm ci /);
  assert.match(npmInstallCommand(["yarn.lock"]), /^npm install /);
  assert.match(npmInstallCommand([]), /^npm install /);
});

test("un verrou yarn ou pnpm est signalé, pas exécuté", () => {
  // Arrange / Act
  const { plan, findings } = planAssets({
    assets: { npm: true },
    specs: specs(["jsbundling-rails"]),
    lockfiles: ["pnpm-lock.yaml"],
  });

  // Assert
  const avertissement = findings.find((finding) => finding.code === "npm-lockfile-absent");
  assert.equal(avertissement.severity, "warning");
  assert.match(avertissement.message, /pnpm-lock\.yaml/);
  assert.match(plan.install, /^npm install /);
  // Un diagnostic actionnable doit porter son remède, comme tous les autres.
  assert.ok(REMEDIES["npm-lockfile-absent"]);
});

test("l'absence totale de verrou front est un avertissement, pas un refus", () => {
  // Arrange / Act
  const { plan, findings } = planAssets({
    assets: { npm: true },
    specs: specs(["jsbundling-rails"]),
    lockfiles: [],
  });

  // Assert
  assert.equal(plan.stage, ASSET_STAGE.HOST);
  assert.match(
    findings.find((f) => f.code === "npm-lockfile-absent").message,
    /package-lock\.json/,
  );
});

// --- Idempotence -------------------------------------------------------------

test("rejouer planAssets sur un plan existant conserve la commande d'installation", () => {
  // Arrange : c'est le cas réel — manifest-to-args rejoue le plan après fusion
  // du railsbox.yml, sans avoir relu les verrous du dépôt.
  const premier = planAssets({
    assets: { npm: true },
    specs: specs(["jsbundling-rails"]),
    lockfiles: ["package-lock.json"],
  }).plan;

  // Act
  const second = planAssets({ assets: premier, specs: specs(["jsbundling-rails"]) }).plan;

  // Assert
  assert.equal(second.install, premier.install);
  assert.equal(second.stage, premier.stage);
});
