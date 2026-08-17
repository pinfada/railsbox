// Ce qui n'entre PAS dans le disque applicatif.
//
// Deux exigences se croisent ici, et la suite est écrite pour les deux.
//
// SÛRETÉ D'ABORD : une exclusion qui casse une application coûte plus cher que
// 100 Mo de trop. Les cas « ce qui doit RESTER » sont donc aussi nombreux que
// les cas « ce qui doit partir » — vendor/cache, app/assets/builds, storage,
// db ne doivent jamais disparaître par accident.
//
// SÉCURITÉ ENSUITE : les valeurs de `exclude:` viennent d'un dépôt TIERS et
// finissent en `--exclude=` d'un tar exécuté sur le runner du mainteneur. Les
// cas hostiles sont écrits à charge, comme pour system_packages.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXCLUSIONS,
  MAX_DECLARED_EXCLUDES,
  MAX_PATH_LENGTH,
  PROTECTED_PATHS,
  assetExclusions,
  normalizeExcludePath,
  planExclusions,
  sanitizeExcludePaths,
} from "../tools/detect/exclusions.mjs";
import { ASSET_STAGE } from "../tools/detect/assets.mjs";
import { mergeManifest, parseRailsboxYml } from "../tools/detect/manifest.mjs";
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

/**
 * Chemins retenus pour une liste déclarée.
 * @param {readonly *[]} entree valeurs candidates
 * @returns {readonly string[]} chemins acceptés
 */
function retenus(entree) {
  return sanitizeExcludePaths(entree).paths;
}

/**
 * Codes de diagnostic émis pour une liste déclarée.
 * @param {readonly *[]} entree valeurs candidates
 * @returns {string[]} codes émis
 */
function codes(entree) {
  return sanitizeExcludePaths(entree).findings.map((finding) => finding.code);
}

// --- Validation : c'est une FRONTIÈRE, les valeurs viennent d'un dépôt tiers --

test("normalizeExcludePath accepte les chemins relatifs ordinaires", () => {
  // Arrange / Act / Assert : le point en tête est l'usage PRINCIPAL de la clé.
  assert.equal(normalizeExcludePath(".git"), ".git");
  assert.equal(normalizeExcludePath("vendor/bundle"), "vendor/bundle");
  assert.equal(normalizeExcludePath("  doc  "), "doc");
  assert.equal(normalizeExcludePath("db/fixtures/"), "db/fixtures");
  assert.equal(normalizeExcludePath("public/uploads/demo"), "public/uploads/demo");
});

test("normalizeExcludePath refuse tout chemin qui sort de l'arbre applicatif", () => {
  // Arrange : les formes qui donneraient prise sur l'hôte de construction.
  for (const hostile of [
    "..",
    "../etc",
    "vendor/../../etc",
    "./..",
    "/etc/passwd",
    "/",
    "~",
    "~/.ssh",
    "C:\\Windows",
    "dossier\\sous",
  ]) {
    // Act / Assert
    assert.equal(normalizeExcludePath(hostile), null, hostile);
  }
});

test("normalizeExcludePath refuse tout ce qu'un shell pourrait interpréter", () => {
  // Arrange : ces valeurs finissent dans une boucle `for chemin in ${…}` puis
  // en argument `--exclude=` d'un tar exécuté en root sur le runner.
  for (const hostile of [
    "doc; rm -rf /",
    "doc $(id)",
    "doc `id`",
    "${HOME}",
    "doc*",
    "doc?",
    'doc"',
    "doc'",
    "doc | tee",
    "doc\nlog",
    "deux mots",
  ]) {
    // Act / Assert
    assert.equal(normalizeExcludePath(hostile), null, hostile);
  }
});

test("normalizeExcludePath refuse un segment commençant par un tiret", () => {
  // Arrange : `tar --exclude=./-C` reste inoffensif, mais un chemin qui
  // commence par un tiret ailleurs dans la chaîne de construction serait lu
  // comme une OPTION. La barrière est posée une fois, à l'entrée.
  for (const hostile of ["-C", "doc/-rf", "--exclude"]) {
    // Act / Assert
    assert.equal(normalizeExcludePath(hostile), null, hostile);
  }
});

test("normalizeExcludePath borne longueur, profondeur et type", () => {
  // Arrange / Act / Assert
  assert.equal(normalizeExcludePath("a".repeat(MAX_PATH_LENGTH + 1)), null);
  assert.equal(normalizeExcludePath("a/b/c/d/e/f/g"), null);
  assert.equal(normalizeExcludePath(42), null);
  assert.equal(normalizeExcludePath(null), null);
  assert.equal(normalizeExcludePath(""), null);
  assert.equal(normalizeExcludePath("   "), null);
});

test("une valeur refusée devient un diagnostic nommé, jamais un silence", () => {
  // Arrange / Act
  const { paths, findings } = sanitizeExcludePaths(["doc", "../etc", "log"]);

  // Assert : la liste utile survit, l'entrée fautive est citée.
  assert.deepEqual([...paths], ["doc", "log"]);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["invalid-exclude-path"],
  );
  assert.match(findings[0].message, /\.\.\/etc/);
});

test("les doublons sont écrasés sans bruit", () => {
  // Arrange / Act / Assert : deux écritures du même chemin ne sont pas une
  // erreur de l'utilisateur, seulement une redite.
  assert.deepEqual([...retenus(["doc", "doc/", "  doc  "])], ["doc"]);
});

// --- Garde-fou : une exclusion ne doit pas décapiter l'application ----------

test("les chemins qui portent l'application elle-même sont refusés", () => {
  // Arrange : sans eux, l'échec surviendrait au bundle check, à la
  // précompilation ou au premier boot — très loin de la ligne fautive.
  for (const protege of PROTECTED_PATHS) {
    // Act
    const resultat = sanitizeExcludePaths([protege]);

    // Assert
    assert.deepEqual([...resultat.paths], [], protege);
    assert.deepEqual(
      resultat.findings.map((finding) => finding.code),
      ["protected-exclude-path"],
      protege,
    );
  }
});

test("un SOUS-chemin d'un répertoire protégé reste permis", () => {
  // Arrange / Act / Assert : c'est toute la distinction utile — `vendor` est
  // vital (vendor/cache, vendor/javascript), `vendor/bundle` ne l'est pas.
  assert.deepEqual(
    [...retenus(["vendor/bundle", "public/uploads", "db/fixtures", "lib/legacy"])],
    ["vendor/bundle", "public/uploads", "db/fixtures", "lib/legacy"],
  );
});

test("une liste absurde est tronquée en le disant", () => {
  // Arrange
  const enorme = Array.from({ length: MAX_DECLARED_EXCLUDES + 3 }, (_, i) => `doc${i}`);

  // Act
  const resultat = sanitizeExcludePaths(enorme);

  // Assert
  assert.equal(resultat.paths.length, MAX_DECLARED_EXCLUDES);
  assert.ok(codes(enorme).includes("too-many-excludes"));
});

// --- La liste par défaut : chaque entrée doit être défendable ---------------

test("la liste par défaut couvre les postes lourds d'un dépôt réel", () => {
  // Arrange / Act
  const chemins = DEFAULT_EXCLUSIONS.map((entry) => entry.path);

  // Assert : mesurés sur l'application témoin — .git 54 Mo, vendor/bundle
  // 143 Mo, à quoi s'ajoutent node_modules et les caches sur d'autres dépôts.
  for (const attendu of [".git", "vendor/bundle", "node_modules", "tmp", "log", "coverage"]) {
    assert.ok(chemins.includes(attendu), attendu);
  }
});

test("aucune exclusion par défaut ne touche à ce qui fait tourner l'application", () => {
  // Arrange / Act
  const chemins = DEFAULT_EXCLUSIONS.map((entry) => entry.path);

  // Assert : les répertoires qu'une exclusion trop large emporterait, et dont
  // l'absence ne se verrait qu'au boot — chez le visiteur, pas au build.
  for (const vital of [
    "app",
    "app/assets",
    "app/assets/builds",
    "bin",
    "config",
    "db",
    "lib",
    "public",
    "storage",
    "vendor",
    "vendor/cache",
    "vendor/javascript",
    "vendor/assets",
    ".bundle",
  ]) {
    assert.ok(!chemins.includes(vital), vital);
  }
  // Et aucune ne peut être un chemin protégé : ce serait une contradiction.
  for (const chemin of chemins) assert.ok(!PROTECTED_PATHS.includes(chemin), chemin);
});

test("chaque exclusion par défaut porte sa justification", () => {
  // Arrange / Act / Assert : la liste est lue par des mainteneurs, pas
  // seulement par tar — une entrée sans motif est une entrée indéfendable.
  for (const entry of DEFAULT_EXCLUSIONS) {
    assert.equal(entry.source, "defaut", entry.path);
    assert.ok(entry.reason.length > 40, entry.path);
    assert.equal(normalizeExcludePath(entry.path), entry.path, entry.path);
  }
});

// --- Assets : n'écarter QUE ce que la construction régénère -----------------

test("sans pipeline d'assets, aucun répertoire de sortie n'est écarté", () => {
  // Arrange : les assets versionnés sont alors les SEULS que la sandbox
  // servira — les exclure laisserait la démonstration sans feuille de style.
  const dirs = ["public/assets", "app/assets/builds"];

  // Act / Assert
  assert.deepEqual(assetExclusions({ stage: ASSET_STAGE.NONE, outputDirs: dirs }), []);
  assert.deepEqual(assetExclusions({ outputDirs: dirs }), []);
});

test("public/assets est écarté dès que la construction le réémet", () => {
  // Arrange / Act
  for (const stage of [ASSET_STAGE.HOST, ASSET_STAGE.GUEST]) {
    const entries = assetExclusions({
      stage,
      outputDirs: ["public/assets", "app/assets/builds", "public/vite"],
    });

    // Assert : sous `public/` un répertoire de sortie est un ARTEFACT…
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["public/assets", "public/vite"],
      stage,
    );
    for (const entry of entries) assert.equal(entry.source, "assets", stage);
  }
});

test("app/assets/builds n'est JAMAIS écarté : c'est une source, pas un artefact", () => {
  // Arrange : le répertoire est un chemin de recherche du pipeline. Une
  // application peut parfaitement y versionner un CSS que rien ne reconstruit
  // (ni gem cssbundling, ni script npm) : l'exclure la laisserait sans style.
  for (const stage of [ASSET_STAGE.NONE, ASSET_STAGE.GUEST, ASSET_STAGE.HOST]) {
    // Act
    const chemins = assetExclusions({
      stage,
      outputDirs: ["app/assets/builds", "app/javascript/build"],
    }).map((entry) => entry.path);

    // Assert
    assert.deepEqual(chemins, [], stage);
  }
});

// --- Plan complet -----------------------------------------------------------

test("planExclusions ajoute le déclaré aux défauts, sans doublon", () => {
  // Arrange / Act
  const { paths } = planExclusions({
    declared: ["doc", ".git"],
    assetStage: ASSET_STAGE.HOST,
    assetOutputDirs: ["public/assets", "app/assets/builds"],
  });

  // Assert : `.git` figure déjà par défaut, il ne doit pas être répété.
  assert.equal(paths.filter((chemin) => chemin === ".git").length, 1);
  assert.ok(paths.includes("public/assets"));
  assert.ok(paths.includes("doc"));
  assert.equal(new Set(paths).size, paths.length);
});

test("planExclusions sans rien de déclaré rend exactement les défauts", () => {
  // Arrange / Act
  const { paths } = planExclusions({ assetStage: ASSET_STAGE.NONE });

  // Assert
  assert.deepEqual(
    [...paths],
    DEFAULT_EXCLUSIONS.map((entry) => entry.path),
  );
});

// --- Clé railsbox.yml -------------------------------------------------------

test("la clé exclude: est lue et validée", () => {
  // Arrange / Act
  const { manifest, findings } = parseRailsboxYml("exclude: [doc, db/fixtures]\n");

  // Assert
  assert.deepEqual([...manifest.excludePaths], ["doc", "db/fixtures"]);
  assert.deepEqual([...findings], []);
});

test("une entrée hostile de exclude: est refusée à la lecture du fichier", () => {
  // Arrange / Act
  const { manifest, findings } = parseRailsboxYml("exclude: [doc, ../../etc, app]\n");

  // Assert : la validation a lieu au plus près du fichier tiers, et les deux
  // motifs de refus sont distingués.
  assert.deepEqual([...manifest.excludePaths], ["doc"]);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["invalid-exclude-path", "protected-exclude-path"],
  );
});

test("exclude: mal formé est signalé sans interrompre l'analyse", () => {
  // Arrange / Act
  const { manifest, findings } = parseRailsboxYml("exclude:\nruby: 3.3.12\n");

  // Assert
  assert.equal(manifest.ruby, "3.3.12");
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["invalid-manifest-value"],
  );
});

test("exclude: s'AJOUTE à la détection au lieu de la remplacer", () => {
  // Arrange
  const detected = { excludePaths: ["doc"] };
  const declared = { excludePaths: ["db/fixtures", "doc"] };

  // Act
  const { manifest } = mergeManifest(detected, declared);

  // Assert
  assert.deepEqual([...manifest.excludePaths], ["doc", "db/fixtures"]);
});

test("chaque diagnostic d'exclusion a son remède", () => {
  // Arrange / Act / Assert : un code sans remède laisse le mainteneur avec un
  // constat et rien pour agir.
  for (const code of ["invalid-exclude-path", "protected-exclude-path", "too-many-excludes"]) {
    assert.ok(REMEDIES[code], code);
  }
});

// --- Argument de construction ----------------------------------------------

test("APP_EXCLUDES porte les défauts et le déclaré", () => {
  // Arrange
  const manifest = {
    database: "sqlite3",
    excludePaths: ["doc"],
    assets: { npm: true, scripts: ["build:css"] },
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: specs(["rails", "propshaft"]),
    hasSeeds: false,
    appName: "demo",
  });
  const chemins = args.APP_EXCLUDES.split(" ");

  // Assert : étage amd64 (package.json) → public/assets est régénéré.
  assert.ok(chemins.includes(".git"));
  assert.ok(chemins.includes("vendor/bundle"));
  assert.ok(chemins.includes("doc"));
  assert.ok(chemins.includes("public/assets"));
  assert.ok(!chemins.includes("app/assets/builds"));
});

test("APP_EXCLUDES épargne public/assets quand aucun pipeline ne le régénère", () => {
  // Arrange : ni package.json, ni gem de pipeline → étage « aucun ».
  const manifest = { database: "sqlite3" };

  // Act
  const args = buildArgs({
    manifest,
    specs: specs(["rails"]),
    hasSeeds: false,
    appName: "demo",
  });
  const chemins = args.APP_EXCLUDES.split(" ");

  // Assert : les assets versionnés du dépôt sont alors les seuls existants.
  assert.equal(args.ASSETS_STAGE, ASSET_STAGE.NONE);
  assert.ok(!chemins.includes("public/assets"));
  assert.ok(chemins.includes(".git"));
});

test("APP_EXCLUDES ne contient que des chemins que tar peut recevoir sans risque", () => {
  // Arrange : garde-fou de bout en bout — quelle que soit l'entrée du dépôt
  // tiers, ce qui sort de buildArgs part dans un `--exclude=./<chemin>`.
  const manifest = {
    database: "sqlite3",
    excludePaths: ["doc"],
    assets: { npm: true, output: ["public/vite"] },
  };

  // Act
  const args = buildArgs({
    manifest,
    specs: specs(["rails"]),
    hasSeeds: false,
    appName: "demo",
  });

  // Assert
  for (const chemin of args.APP_EXCLUDES.split(" ")) {
    assert.equal(normalizeExcludePath(chemin), chemin, chemin);
  }
});
