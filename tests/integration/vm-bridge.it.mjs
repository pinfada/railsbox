// Tests d'intégration du protocole série contre une VRAIE VM v86 sous Node.
//
// Volontairement hors de la suite unitaire (« .it.mjs », pas « .test.mjs »,
// donc jamais ramassés par `npm test`) : ils exigent les artefacts locaux
// (public/disks/, non versionnés) et durent plusieurs minutes.
// Lancement : npm run test:integration — sans artefacts, la suite s'ignore ;
// RAILSBOX_IT=0 permet de la désactiver explicitement.
//
// Ce que la suite prouve — les défauts historiques du canal, mesurés dans le
// README : perte des corps > 32 Ko sans contrôle de flux, réponses tronquées,
// horloge dérivante. Chaque test correspond à une régression réelle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");

const artifactsPresent =
  existsSync(join(DISKS_DIR, "v86-config.json")) &&
  existsSync(join(DISKS_DIR, "jiyufit.ext2")) &&
  existsSync(join(DISKS_DIR, "jiyufit-state.bin"));
const enabled = process.env.RAILSBOX_IT !== "0" && artifactsPresent;

// Codes acceptables d'une application réelle : la route exacte importe peu,
// ce qui compte est qu'une réponse HTTP complète traverse le pont.
const ANY_HTTP_OK = new Set([200, 301, 302, 303, 307, 308, 401, 404, 405, 406, 422, 500]);

// Pour les POST de charge, le contenu envoyé est volontairement arbitraire :
// l'application peut répondre 415/400/422 — n'importe quel statut bien formé
// prouve que le corps a traversé le canal et que celui-ci reste vivant.
function isWellFormedStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 600;
}

test(
  "pont série de bout en bout (VM v86 réelle)",
  { skip: enabled ? false : "artefacts absents ou RAILSBOX_IT non posé", timeout: 900_000 },
  async (t) => {
    const { bootHarness } = await import("../../tools/vm-harness.mjs");
    const logs = [];
    const vm = await bootHarness({
      projectRoot: PROJECT_ROOT,
      onLog: (line) => logs.push(line),
    });
    t.after(() => vm.stop());

    await vm.waitUntilReady({
      onAttempt: (attempt, error) =>
        process.stdout.write(`[it] sonde n°${attempt}${error ? ` — ${error}` : " — OK"}\n`),
    });

    await t.test("GET /app/ traverse le pont et répond", async () => {
      const response = await vm.request({ method: "GET", path: "/app/" });
      assert.ok(
        ANY_HTTP_OK.has(response.status),
        `statut inattendu: ${response.status} ${response.statusText}`,
      );
    });

    await t.test("une réponse multi-trames arrive entière (page > 10 Ko)", async () => {
      const response = await vm.request({ method: "GET", path: "/app/" });
      // ~80 Ko de page = ~11 trames DAT : l'assembleur doit tout recoller.
      // (Une redirection 3xx a un corps court : suivre Location une fois.)
      let body = response.body;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.find(([name]) => name === "location")?.[1] ?? "/app/";
        const path = location.startsWith("http") ? new URL(location).pathname : location;
        const followed = await vm.request({ method: "GET", path });
        body = followed.body;
      }
      assert.ok(body.length > 10_000, `corps trop court: ${body.length} octets`);
    });

    await t.test("un POST de 128 Ko n'est plus perdu (contrôle de flux acquitté)", async () => {
      // Régression historique : 128 Ko d'un seul tenant tuaient le canal.
      const body = new Uint8Array(128 * 1024).fill(97); // 'a'
      const response = await vm.request(
        {
          method: "POST",
          path: "/app/",
          headers: [["content-type", "application/octet-stream"]],
        },
        body,
      );
      assert.ok(
        isWellFormedStatus(response.status),
        `le canal devait survivre au POST 128 Ko (statut ${response.status})`,
      );
    });

    await t.test("un POST de 1 Mo passe, et le canal reste vivant après", async () => {
      const body = new Uint8Array(1024 * 1024).fill(98); // 'b'
      const response = await vm.request(
        {
          method: "POST",
          path: "/app/",
          headers: [["content-type", "application/octet-stream"]],
        },
        body,
      );
      assert.ok(isWellFormedStatus(response.status), `statut POST 1 Mo: ${response.status}`);

      const after = await vm.request({ method: "GET", path: "/app/" });
      assert.ok(
        ANY_HTTP_OK.has(after.status),
        "le canal doit rester utilisable après un gros POST",
      );
    });

    await t.test("la synchronisation d'horloge ne perturbe pas le canal", async () => {
      vm.syncClock();
      const response = await vm.request({ method: "GET", path: "/app/" });
      assert.ok(ANY_HTTP_OK.has(response.status));
    });

    await t.test("une trame ENV est acquittée par le démon", async () => {
      // L'injection seule (sans RST : le redémarrage coûte plusieurs minutes,
      // il est couvert par RAILSBOX_IT_FULL=1 ci-dessous).
      await vm.sendEnvironment({ RAILSBOX_IT_PROBE: "1" });
    });

    if (process.env.RAILSBOX_IT_FULL === "1") {
      await t.test("RST relance l'application, qui répond à nouveau", async () => {
        await vm.restartApplication();
        await vm.waitUntilReady();
        const response = await vm.request({ method: "GET", path: "/app/" });
        assert.ok(ANY_HTTP_OK.has(response.status));
      });
    }
  },
);
