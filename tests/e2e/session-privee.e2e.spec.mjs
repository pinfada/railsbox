// Le risque n°1 de la distribution privée, joué en entier dans un vrai
// navigateur : une session qui expire PENDANT que v86 lit son disque.
//
// CE QUE CE TEST PROUVE, et que seul un navigateur peut prouver :
//   1. la lecture d'artefact est RETENUE — la promesse de `respondWith` reste
//      en suspens au lieu de rendre un 401 que v86 ne saurait pas traiter ;
//   2. la coquille est prévenue une fois (`session-expiree`) ;
//   3. après renouvellement, `session-restauree` fait REJOUER la requête ;
//   4. la réponse finalement servie est un 200 porteur des vrais octets ;
//   5. le 401 n'entre JAMAIS dans le cache d'artefacts.
//
// AUCUN ARTEFACT DE public/disks/ N'EST REQUIS, et la VM ne boote pas. Ce qui
// est éprouvé ici est le chemin Service Worker / coquille : le faire dépendre
// de 1,4 Go d'images le ferait s'ignorer en CI, or un test qui s'ignore
// ressemble trait pour trait à un test qui passe.
//
// Le test lève SON PROPRE serve.mjs, en mode bord authentifiant simulé
// (RAILSBOX_SIMULER_AUTH=1). Un port distinct est un autre ORIGINE : ni le
// Cache Storage ni le Service Worker des autres tests n'en voient rien.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { cacheNameFor } from "../../public/shared/artifact-cache.js";

const RACINE = fileURLToPath(new URL("../../", import.meta.url));
const DISKS_DIR = fileURLToPath(new URL("../../public/disks/", import.meta.url));
// Décalé du port des autres tests : deux origines, deux magasins.
const PORT = Number(process.env.RAILSBOX_PORT ?? 8091) + 6;
const BASE = `http://localhost:${PORT}`;
// Page hôte volontairement inexistante : elle sert de document DANS la portée
// du Service Worker sans déclencher main.js, donc sans tenter de booter une
// VM. Elle passe `isShellClient` (elle n'est pas sous /app), ce qui est la
// seule chose qui compte ici.
const CHEMIN_HOTE = "/e2e-session-hote";
const OCTET = 0x7e;
const MORCEAU = "/disks/e2e-session-0-4194304.ext2.zst";
const FIXTURE = `${DISKS_DIR}e2e-session-0-4194304.ext2.zst`;
const CHUNK_BYTES = 4 * 1024 * 1024;
const DELAI_SW_MS = 30_000;
const DELAI_CACHE_MS = 10_000;
// Fenêtre d'observation d'une lecture qui doit rester en suspens. Courte à
// dessein : ce qu'on veut voir est qu'elle ne se résout PAS, et un test qui
// dort ne prouve rien de plus en dormant plus longtemps.
const FENETRE_SUSPENS_MS = 700;

const CONFIG = {
  name: "e2e-session",
  baseName: "e2e-base",
  builtAt: "2026-08-18T09:00:00Z",
  disk: "disks/e2e-session.ext2.zst",
  diskSize: CHUNK_BYTES,
  diskChunkSize: CHUNK_BYTES,
};

/** @type {import("node:child_process").ChildProcess | null} */
let serveur = null;

/**
 * Lève serve.mjs en mode simulation et attend qu'il réponde.
 *
 * `RAILSBOX_AUTH_TTL_MS=0` : la session naît DÉJÀ EXPIRÉE. Le refus est donc
 * certain dès la première lecture d'artefact, sans attendre qu'une échéance
 * tombe — ce qui serait la porte ouverte à l'intermittence.
 * `RAILSBOX_AUTH_TTL_RENOUVELLEMENT_MS` généreux : une fois rétablie, la
 * session doit tenir tout le reste du test.
 */
async function leverServeur() {
  serveur = spawn(process.execPath, ["serve.mjs"], {
    cwd: RACINE,
    env: {
      ...process.env,
      PORT: String(PORT),
      RAILSBOX_SIMULER_AUTH: "1",
      RAILSBOX_AUTH_TTL_MS: "0",
      RAILSBOX_AUTH_TTL_RENOUVELLEMENT_MS: "600000",
    },
    stdio: "ignore",
  });
  const limite = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`${BASE}/e2e-sonde`);
      return;
    } catch (erreur) {
      if (Date.now() > limite) {
        throw new Error(`serve.mjs simulé injoignable sur ${BASE}`, { cause: erreur });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * Installe le Service Worker depuis une page de la portée, puis recharge pour
 * qu'il prenne le contrôle — sans passer par main.js.
 * @param {import("@playwright/test").Page} page
 */
async function installerWorker(page) {
  await page.goto(`${BASE}${CHEMIN_HOTE}`);
  await page.evaluate(async () => {
    const nav = /** @type {any} */ (globalThis).navigator;
    await nav.serviceWorker.register("/sw-proxy.js", { type: "module" });
    await nav.serviceWorker.ready;
  });
  await page.goto(`${BASE}${CHEMIN_HOTE}`);
  await page.waitForFunction(
    () => Boolean(/** @type {any} */ (globalThis).navigator.serviceWorker.controller),
    undefined,
    { timeout: DELAI_SW_MS },
  );
}

/**
 * Rejoue ce que fait main.js à l'ouverture : écouter le worker, puis lui
 * déclarer la configuration des artefacts.
 * @param {import("@playwright/test").Page} page
 */
async function preparerCoquille(page) {
  await page.evaluate((config) => {
    const vue = /** @type {any} */ (globalThis);
    vue.__messages = [];
    vue.__lecture = null;
    const nav = vue.navigator;
    nav.serviceWorker.addEventListener("message", (evenement) => {
      vue.__messages.push(evenement.data?.type);
    });
    // Sans cet appel, la file de messages du worker vers la page peut n'être
    // jamais délivrée : `addEventListener` seul ne l'ouvre pas.
    nav.serviceWorker.startMessages?.();
    nav.serviceWorker.controller.postMessage({ type: "artifact-config", config });
  }, CONFIG);
  await page.waitForFunction(
    async (attendu) => (await /** @type {any} */ (globalThis).caches.keys()).includes(attendu),
    cacheNameFor(CONFIG),
    { timeout: DELAI_CACHE_MS },
  );
}

/**
 * Contenu du cache d'artefacts pour une URL : statut, ou null si absent.
 * @param {import("@playwright/test").Page} page
 * @param {string} url
 */
function statutEnCache(page, url) {
  return page.evaluate(
    async ({ nom, cible }) => {
      const cache = await /** @type {any} */ (globalThis).caches.open(nom);
      const entree = await cache.match(cible);
      return entree ? entree.status : null;
    },
    { nom: cacheNameFor(CONFIG), cible: url },
  );
}

test.describe("Session expirée en plein boot", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    await mkdir(DISKS_DIR, { recursive: true });
    await writeFile(FIXTURE, Buffer.alloc(1024, OCTET));
    await leverServeur();
    page = await browser.newPage();
    await installerWorker(page);
    await preparerCoquille(page);
  });

  test.afterAll(async () => {
    await page?.close();
    await rm(FIXTURE, { force: true });
    serveur?.kill();
  });

  test("suspend, prévient, rejoue — et ne met jamais le refus en cache", async () => {
    // --- 1. La lecture part, et ne revient pas -----------------------------
    // Elle n'est pas attendue ici : c'est tout le sujet. `respondWith` tient
    // une promesse en suspens, ce que v86 lit comme une lecture lente — la
    // seule chose qu'il sache traiter, faute de savoir traiter un 4xx.
    await page.evaluate((cible) => {
      const vue = /** @type {any} */ (globalThis);
      vue.__lecture = { fini: false, statut: null, premier: null };
      vue
        .fetch(cible)
        .then(async (reponse) => {
          const octets = new Uint8Array(await reponse.arrayBuffer());
          vue.__lecture = {
            fini: true,
            statut: reponse.status,
            premier: octets.length > 0 ? octets[0] : null,
          };
        })
        .catch((erreur) => {
          vue.__lecture = { fini: true, statut: -1, premier: null, erreur: String(erreur) };
        });
    }, MORCEAU);

    // --- 2. La coquille est prévenue, une seule fois -----------------------
    await page.waitForFunction(
      () => /** @type {any} */ (globalThis).__messages.includes("session-expiree"),
      undefined,
      { timeout: DELAI_CACHE_MS },
    );

    await page.waitForTimeout(FENETRE_SUSPENS_MS);
    expect(
      await page.evaluate(() => /** @type {any} */ (globalThis).__lecture.fini),
      "la lecture doit rester RETENUE : rendre le 401 gèlerait v86 en silence",
    ).toBe(false);
    expect(
      await page.evaluate(() =>
        /** @type {any} */ (globalThis).__messages.filter((t) => t === "session-expiree"),
      ),
      "une seule notification par épisode, quelle que soit la rafale",
    ).toHaveLength(1);

    // --- 3. Le refus n'est pas entré dans le cache -------------------------
    expect(
      await statutEnCache(page, MORCEAU),
      "un 401 n'a rien à faire dans un cache d'immuables",
    ).toBeNull();

    // --- 4. Le visiteur se reconnecte --------------------------------------
    const renouvellement = await page.evaluate(async () => {
      const reponse = await /** @type {any} */ (globalThis).fetch("/auth/renouveler", {
        method: "POST",
      });
      return reponse.status;
    });
    expect(renouvellement).toBe(200);

    // La sonde que main.js interroge pendant que la VM est en pause.
    expect(
      await page.evaluate(async () => {
        const reponse = await /** @type {any} */ (globalThis).fetch("/auth/etat", {
          cache: "no-store",
        });
        return reponse.status;
      }),
      "la sonde d'état doit voir la session rétablie",
    ).toBe(200);

    // --- 5. La coquille libère la lecture retenue --------------------------
    await page.evaluate(() => {
      /** @type {any} */ (globalThis).navigator.serviceWorker.controller.postMessage({
        type: "session-restauree",
      });
    });

    await page.waitForFunction(() => /** @type {any} */ (globalThis).__lecture.fini, undefined, {
      timeout: DELAI_CACHE_MS,
    });
    const lecture = await page.evaluate(() => /** @type {any} */ (globalThis).__lecture);
    expect(lecture.statut, "la lecture rejouée aboutit en 200").toBe(200);
    expect(lecture.premier, "et porte les VRAIS octets du morceau").toBe(OCTET);

    // --- 6. Le cache ne contient que la réponse valide ---------------------
    await page.waitForFunction(
      async ({ nom, cible }) => {
        const cache = await /** @type {any} */ (globalThis).caches.open(nom);
        return Boolean(await cache.match(cible));
      },
      { nom: cacheNameFor(CONFIG), cible: MORCEAU },
      { timeout: DELAI_CACHE_MS },
    );
    expect(
      await statutEnCache(page, MORCEAU),
      "le cache ne doit porter que le 200, jamais le refus",
    ).toBe(200);
  });

  test("le bord ne redirige JAMAIS un artefact refusé", async () => {
    // Contrat C1. Une 3xx suivie rendrait un 200 porteur de HTML : v86 le
    // prendrait pour des octets de disque, et le cache l'écrirait sous l'URL
    // du morceau. C'est le défaut que toute cette manœuvre existe pour éviter.
    const reponse = await fetch(`${BASE}${MORCEAU}`, { redirect: "manual" });
    expect(reponse.status, "401 et rien d'autre").toBe(401);
    expect(reponse.redirected).toBe(false);
    expect(reponse.headers.get("x-railsbox-auth")).toBe("expired");
    expect(reponse.headers.get("cache-control")).toBe("no-store");
    expect(reponse.headers.get("content-type")).toMatch(/application\/json/);
    expect(reponse.headers.get("vary")).toBe("Cookie");
  });

  test("la coquille et ses scripts restent servis, session expirée", async () => {
    // Sans cela, le visiteur serait devant une page blanche — donc sans le
    // moyen de se reconnecter, l'interface vivant DANS le document coquille.
    for (const chemin of ["/sw-proxy.js", "/main.js", "/shared/session-privee.js"]) {
      const reponse = await fetch(`${BASE}${chemin}`);
      expect(reponse.status, `${chemin} doit rester servi`).toBe(200);
    }
  });
});
