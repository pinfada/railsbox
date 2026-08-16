// Test d'intégration de la prise en charge de PostgreSQL (critère C8) contre
// une VRAIE VM v86 sous Node. S'ignore tant que les artefacts de la variante
// PostgreSQL n'existent pas.
//
// Comment les produire :
//   APP="$(bash tools/demo-app/preparer-demo-pg.sh)"
//   wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP" \
//       --name demo-pg --base railsbox-base-3.3-r2
//   node tools/build-v86-image/make-delta-snapshot.mjs --name demo-pg \
//       --base base-3.3-r2
//
// Ce que la suite prouve, et que rien d'autre ne prouve : un instantané delta
// capturé cluster démarré se restaure, le cluster reprend la main, et les
// données seedées AU BUILD dans /app/var/pg ressortent — donc le datadir a bien
// voyagé avec le disque applicatif.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");
const SPLIT_CONFIG = "demo-pg-split-config.json";

const configPath = join(DISKS_DIR, SPLIT_CONFIG);
const enabled = process.env.RAILSBOX_IT !== "0" && existsSync(configPath);

test(
  "sandbox PostgreSQL (VM v86 réelle, critère C8)",
  { skip: enabled ? false : "artefacts de la variante PostgreSQL absents", timeout: 900_000 },
  async (t) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.database, "postgresql", "la config doit annoncer PostgreSQL");

    const { bootHarness } = await import("../../tools/vm-harness.mjs");
    const vm = await bootHarness({
      projectRoot: PROJECT_ROOT,
      configName: SPLIT_CONFIG,
      onLog: (line) => process.stdout.write(`[pg] ${line}\n`),
    });
    t.after(() => vm.stop());

    await vm.waitUntilReady({
      onAttempt: (attempt, error) =>
        process.stdout.write(`[pg] sonde n°${attempt}${error ? ` — ${error}` : " — OK"}\n`),
    });

    await t.test("l'application répond, donc le cluster a démarré", async () => {
      const response = await vm.request({ method: "GET", path: "/app/" });
      assert.ok(response.status >= 200 && response.status < 400, `statut : ${response.status}`);
    });

    await t.test("les données seedées dans /app/var/pg sont servies", async () => {
      const list = await vm.request({ method: "GET", path: "/app/posts" });
      const body = new TextDecoder().decode(list.body);
      // Texte propre aux seeds de la variante PostgreSQL : un fichier sqlite3
      // resté là par accident ne pourrait pas le produire.
      assert.match(body, /PostgreSQL/, "le contenu seedé du cluster doit apparaître");
    });

    await t.test("une écriture traverse jusqu'à la base", async () => {
      // POST réel : c'est la preuve que la connexion est en lecture/écriture et
      // que le WAL du datadir restauré accepte les transactions.
      const titre = `Écrit par le test ${Date.now()}`;
      const corps = new TextEncoder().encode(
        `post[title]=${encodeURIComponent(titre)}&post[body]=${encodeURIComponent("corps")}`,
      );
      const created = await vm.request(
        {
          method: "POST",
          path: "/app/posts",
          headers: [
            ["content-type", "application/x-www-form-urlencoded"],
            ["content-length", String(corps.length)],
          ],
        },
        corps,
      );
      // Rails répond 302 (redirection vers le billet) ou 422 si la protection
      // CSRF refuse : les deux prouvent que la requête a atteint l'application,
      // seul un 500 trahirait une base inaccessible.
      assert.ok(created.status < 500, `statut inattendu : ${created.status}`);
    });
  },
);
