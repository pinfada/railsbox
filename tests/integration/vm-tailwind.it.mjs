// Test d'intégration de la voie « assets précompilés sur étage amd64 »
// (critère C8) contre une VRAIE VM v86 sous Node. S'ignore tant que les
// artefacts de la variante Tailwind n'existent pas.
//
// Comment les produire :
//   APP="$(bash tools/demo-app/preparer-demo-tailwind.sh)"
//   wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP" \
//       --name demo-tailwind --base ghcr.io/pinfada/railsbox-base:3.3-r2
//   node tools/build-v86-image/make-delta-snapshot.mjs --name demo-tailwind \
//       --base base-3.3-r2
//
// Ce que la suite prouve, et que rien d'autre ne prouve : le binaire
// tailwindcss — qui n'existe pour aucune architecture i386 — a tourné sur
// l'hôte de construction, son CSS a été digéré par Propshaft, embarqué dans le
// disque applicatif, et la VM i386 le sert. Le contrôle ne porte pas sur la
// présence d'un fichier mais sur son CONTENU : un utilitaire à valeur
// arbitraire (tracking-[0.35em]) et une variable de thème personnalisée
// (--color-railsbox) n'apparaissent dans la feuille que si le balayage des
// vues a réellement eu lieu pendant CETTE construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");
const SPLIT_CONFIG = "demo-tailwind-split-config.json";

/** Feuille de style produite par tailwindcss, digérée par Propshaft. */
const TAILWIND_HREF = /href="([^"]*\/tailwind-[^"]+\.css)"/;

const configPath = join(DISKS_DIR, SPLIT_CONFIG);
const enabled = process.env.RAILSBOX_IT !== "0" && existsSync(configPath);

test(
  "sandbox Tailwind (VM v86 réelle, critère C8)",
  { skip: enabled ? false : "artefacts de la variante Tailwind absents", timeout: 900_000 },
  async (t) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.database, "sqlite3", "la variante Tailwind reste sur sqlite3");

    const { bootHarness } = await import("../../tools/vm-harness.mjs");
    const vm = await bootHarness({
      projectRoot: PROJECT_ROOT,
      configName: SPLIT_CONFIG,
      onLog: (line) => process.stdout.write(`[tailwind] ${line}\n`),
    });
    t.after(() => vm.stop());

    await vm.waitUntilReady({
      onAttempt: (attempt, error) =>
        process.stdout.write(`[tailwind] sonde n°${attempt}${error ? ` — ${error}` : " — OK"}\n`),
    });

    /** @type {string} */
    let page = "";

    await t.test("la page du scaffold est servie et porte les classes Tailwind", async () => {
      const response = await vm.request({ method: "GET", path: "/app/posts" });
      assert.ok(response.status >= 200 && response.status < 400, `statut : ${response.status}`);
      page = new TextDecoder().decode(response.body);
      // Texte propre aux seeds de la variante : un artefact d'une construction
      // précédente resté dans public/disks ne pourrait pas le produire.
      assert.match(page, /Bienvenue dans railsbox \(Tailwind\)/);
      assert.match(page, /tracking-\[0\.35em\]/, "la vue doit porter l'utilitaire arbitraire");
    });

    await t.test("la feuille Tailwind digérée est référencée par le layout", () => {
      const match = TAILWIND_HREF.exec(page);
      assert.ok(match, "aucun <link> vers tailwind-<empreinte>.css dans la page servie");
      // Empreinte Propshaft : sans elle, le fichier n'est pas passé par la
      // précompilation, il a été copié tel quel.
      assert.match(match[1], /tailwind-[0-9a-f]{8,}\.css$/, `href inattendu : ${match[1]}`);
    });

    await t.test("le CSS servi est bien la sortie du binaire tailwindcss", async () => {
      const href = /** @type {RegExpExecArray} */ (TAILWIND_HREF.exec(page))[1];
      const sheet = await vm.request({ method: "GET", path: href });
      assert.equal(sheet.status, 200, `statut de la feuille : ${sheet.status}`);
      const css = new TextDecoder().decode(sheet.body);

      // Une feuille Tailwind v4 réelle pèse plusieurs dizaines de kilo-octets ;
      // un fichier vide ou un 404 déguisé se verrait ici.
      assert.ok(css.length > 5_000, `feuille trop courte (${css.length} o)`);
      // Valeur arbitraire : AUCUNE feuille Tailwind pré-construite ne peut la
      // contenir. Sa présence prouve le balayage des vues à la construction.
      assert.match(css, /\.35em/, "l'utilitaire tracking-[0.35em] n'a pas été compilé");
      // Variable issue du bloc @theme du point d'entrée de la surcouche.
      assert.match(css, /--color-railsbox/, "le thème personnalisé n'a pas été compilé");
      // Preflight de Tailwind : signe que c'est bien la feuille complète.
      assert.match(css, /box-sizing/, "le preflight Tailwind est absent");
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
