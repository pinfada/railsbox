// Test d'intégration de la voie « assets précompilés sur étage amd64 »
// (critère C8) contre une VRAIE VM v86 sous Node. S'ignore tant que les
// artefacts de la variante dart-sass n'existent pas.
//
// Comment les produire :
//   APP="$(bash tools/demo-app/preparer-demo-dartsass.sh)"
//   wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP" \
//       --name demo-dartsass --base ghcr.io/pinfada/railsbox-base:3.3-r2
//   node tools/build-v86-image/make-delta-snapshot.mjs --name demo-dartsass \
//       --base base-3.3-r2
//
// Ce que la suite prouve, et que la variante Tailwind ne prouve pas tout à
// fait : dartsass-rails tire sass-embedded, dont AUCUNE variante i386
// n'existe — là où tailwindcss-ruby offre encore une variante « ruby ». Le
// compilateur Dart Sass a donc tourné sur l'hôte amd64, sa sortie a été
// digérée par Propshaft, embarquée dans le disque i386, et la VM la sert.
// Le contrôle ne porte pas sur la présence d'un fichier mais sur son
// CONTENU : la feuille doit porter une couleur CALCULÉE par Sass
// (color.adjust) et l'aplatissement d'une imbrication — deux sorties qu'une
// simple copie de fichier ne saurait produire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");
const SPLIT_CONFIG = "demo-dartsass-split-config.json";

/** Feuille produite par le compilateur Dart Sass, digérée par Propshaft. */
const DARTSASS_HREF = /href="([^"]*\/dartsass-[^"]+\.css)"/;

const configPath = join(DISKS_DIR, SPLIT_CONFIG);
const enabled = process.env.RAILSBOX_IT !== "0" && existsSync(configPath);

test(
  "sandbox dart-sass (VM v86 réelle, critère C8)",
  { skip: enabled ? false : "artefacts de la variante dart-sass absents", timeout: 900_000 },
  async (t) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.database, "sqlite3", "la variante dart-sass reste sur sqlite3");

    const { bootHarness } = await import("../../tools/vm-harness.mjs");
    const vm = await bootHarness({
      projectRoot: PROJECT_ROOT,
      configName: SPLIT_CONFIG,
      onLog: (line) => process.stdout.write(`[dartsass] ${line}\n`),
    });
    t.after(() => vm.stop());

    await vm.waitUntilReady({
      onAttempt: (attempt, error) =>
        process.stdout.write(`[dartsass] sonde n°${attempt}${error ? ` — ${error}` : " — OK"}\n`),
    });

    /** @type {string} */
    let page = "";

    await t.test("la page du scaffold est servie et porte la classe de preuve", async () => {
      const response = await vm.request({ method: "GET", path: "/app/posts" });
      assert.ok(response.status >= 200 && response.status < 400, `statut : ${response.status}`);
      page = new TextDecoder().decode(response.body);
      // Texte propre aux seeds de la variante : un artefact d'une construction
      // précédente resté dans public/disks ne pourrait pas le produire.
      assert.match(page, /Bienvenue dans railsbox \(dart-sass\)/);
      assert.match(page, /railsbox-preuve-dartsass/, "la vue doit porter la classe de preuve");
    });

    await t.test("la feuille compilée est référencée par le layout", () => {
      const match = DARTSASS_HREF.exec(page);
      assert.ok(match, "aucun <link> vers dartsass-<empreinte>.css dans la page servie");
      // Empreinte Propshaft : sans elle, le fichier n'est pas passé par la
      // précompilation, il a été copié tel quel.
      assert.match(match[1], /dartsass-[0-9a-f]{8,}\.css$/, `href inattendu : ${match[1]}`);
    });

    await t.test("le CSS servi est bien la sortie du compilateur Dart Sass", async () => {
      const href = /** @type {RegExpExecArray} */ (DARTSASS_HREF.exec(page))[1];
      const sheet = await vm.request({ method: "GET", path: href });
      assert.equal(sheet.status, 200, `statut de la feuille : ${sheet.status}`);
      const css = new TextDecoder().decode(sheet.body);

      assert.ok(css.length > 200, `feuille trop courte (${css.length} o)`);
      // Couleur CALCULÉE par color.adjust() : le SCSS source ne contient que
      // « color.adjust($railsbox-accent, $lightness: -12%) ». Retrouver le
      // résultat prouve qu'un compilateur Sass est passé.
      assert.match(
        css,
        /\.railsbox-preuve-dartsass\s*\{[^}]*rgb\(/,
        "la couleur calculée par Sass est absente : rien n'a été compilé",
      );
      // Aplatissement d'imbrication : « body { h1 { … } } » devient « body h1 ».
      assert.match(css, /body h1/, "l'imbrication Sass n'a pas été aplatie");
      // Le SCSS source ne doit PAS avoir fui tel quel dans la feuille servie.
      assert.doesNotMatch(css, /\$railsbox-accent|@use/, "du SCSS non compilé est servi");
    });

    await t.test("la feuille Propshaft classique reste servie à côté", async () => {
      // `stylesheet_link_tag :app` désigne app/assets/stylesheets/application.css :
      // c'est bien « application-<empreinte>.css » qui est servi, pas « app-… ».
      const match = /href="([^"]*\/application-[0-9a-f]{8,}\.css)"/.exec(page);
      assert.ok(match, "aucun <link> vers application-<empreinte>.css — le chemin :app a disparu");
      const sheet = await vm.request({ method: "GET", path: match[1] });
      assert.equal(sheet.status, 200, `statut de la feuille :app : ${sheet.status}`);
    });
  },
);
