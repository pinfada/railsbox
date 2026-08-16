// Test de bout en bout du cache d'artefacts (critère C3), sans VM.
//
// Ce qu'il prouve, et que seul un vrai navigateur peut prouver : un morceau
// déjà téléchargé n'est PLUS DEMANDÉ AU RÉSEAU au chargement suivant. La
// mesure est faite de la façon la moins ambiguë possible — le fichier est
// SUPPRIMÉ DU SERVEUR entre les deux lectures. Une seconde lecture qui réussit
// quand même n'a pu venir que de Cache Storage ; un témoin de même forme, mais
// absent de la configuration, doit lui échouer.
//
// Aucun artefact de public/disks/ n'est requis : le test pose ses propres
// leurres et les retire ensuite. Il tourne donc en CI.
import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { cacheNameFor } from "../../public/shared/artifact-cache.js";

const DISKS_DIR = fileURLToPath(new URL("../../public/disks/", import.meta.url));
// Un « dépôt d'artefacts » same-origin HORS de /disks/ : la topologie de la
// démonstration de référence, où railsbox-assets est un autre Pages du même
// hôte github.io. Un prédicat de zone fondé sur l'origine l'a déjà manquée.
const HORS_ZONE_DIR = fileURLToPath(new URL("../../public/e2e-autre-depot/", import.meta.url));
const CHUNK_BYTES = 4 * 1024 * 1024;
// Page hôte volontairement inexistante : elle sert de document dans la portée
// du Service Worker sans déclencher main.js, donc sans tenter de booter une
// VM. Le test n'observe que le cache, rien d'autre.
const HOST_PATH = "/e2e-cache-hote";
const SERVICE_WORKER_TIMEOUT_MS = 30_000;
const CACHE_TIMEOUT_MS = 10_000;

// Un « disque » découpé, déclaré dans la configuration…
const DISK = "disks/e2e-cache.ext2.zst";
const PART = "disks/e2e-cache-0-4194304.ext2.zst";
// …et un leurre de forme identique, jamais déclaré : il doit rester au réseau.
const TEMOIN = "disks/e2e-temoin-0-4194304.ext2.zst";

const FIXTURES = [
  { path: `${DISKS_DIR}e2e-cache-0-4194304.ext2.zst`, byte: 0x42 },
  { path: `${DISKS_DIR}e2e-temoin-0-4194304.ext2.zst`, byte: 0x17 },
  { path: `${HORS_ZONE_DIR}e2e-hors-zone-0-4194304.ext2.zst`, byte: 0x99 },
];

/** @param {string} builtAt */
function fixtureConfig(builtAt) {
  return {
    name: "e2e-cache",
    baseName: "e2e-base",
    builtAt,
    disk: DISK,
    diskSize: CHUNK_BYTES,
    diskChunkSize: CHUNK_BYTES,
    kernel: "disks/e2e-base-vmlinuz",
    initrd: "disks/e2e-base-initrd",
  };
}

/**
 * Installe le Service Worker depuis une page de la portée, puis recharge pour
 * qu'il prenne le contrôle — sans passer par main.js.
 * @param {import("@playwright/test").Page} page
 */
async function installWorker(page) {
  await page.goto(HOST_PATH);
  await page.evaluate(async () => {
    const nav = /** @type {any} */ (globalThis).navigator;
    await nav.serviceWorker.register("/sw-proxy.js", { type: "module" });
    await nav.serviceWorker.ready;
  });
  await page.goto(HOST_PATH);
  await page.waitForFunction(
    () => Boolean(/** @type {any} */ (globalThis).navigator.serviceWorker.controller),
    undefined,
    { timeout: SERVICE_WORKER_TIMEOUT_MS },
  );
}

/**
 * Déclare la configuration au Service Worker, comme le fait main.js, et
 * attend que le cache correspondant soit réellement ouvert.
 * @param {import("@playwright/test").Page} page
 * @param {Record<string, any>} config
 */
async function declareConfig(page, config) {
  await page.evaluate((value) => {
    const nav = /** @type {any} */ (globalThis).navigator;
    nav.serviceWorker.controller.postMessage({ type: "artifact-config", config: value });
  }, config);
  await page.waitForFunction(
    async (expected) => {
      const names = await /** @type {any} */ (globalThis).caches.keys();
      return names.includes(expected);
    },
    cacheNameFor(config),
    { timeout: CACHE_TIMEOUT_MS },
  );
}

/**
 * Lit une URL depuis la page : statut et premier octet du corps.
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 * @returns {Promise<{ status: number, first: number | null }>}
 */
function readFromPage(page, path) {
  return page.evaluate(async (target) => {
    const view = /** @type {any} */ (globalThis);
    const response = await view.fetch(target);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, first: bytes.length > 0 ? bytes[0] : null };
  }, path);
}

/**
 * Noms des caches d'artefacts présents dans l'origine.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<string[]>}
 */
function artifactCacheNames(page) {
  return page.evaluate(async () => {
    const names = await /** @type {any} */ (globalThis).caches.keys();
    return names.filter((name) => name.startsWith("railsbox-artefacts-"));
  });
}

test.describe("Cache des artefacts immuables", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    await mkdir(DISKS_DIR, { recursive: true });
    await mkdir(HORS_ZONE_DIR, { recursive: true });
    for (const fixture of FIXTURES) {
      await writeFile(fixture.path, Buffer.alloc(1024, fixture.byte));
    }
    page = await browser.newPage();
    await installWorker(page);
  });

  test.afterAll(async () => {
    await page?.close();
    for (const fixture of FIXTURES) await rm(fixture.path, { force: true });
    await rm(HORS_ZONE_DIR, { recursive: true, force: true });
  });

  test("resert un morceau depuis Cache Storage alors qu'il a disparu du serveur", async () => {
    const config = fixtureConfig("2026-08-16T09:00:00Z");
    await declareConfig(page, config);

    const premiere = await readFromPage(page, PART);
    expect(premiere.status, "le premier passage doit venir du réseau en 200").toBe(200);
    expect(premiere.first, "le corps doit être celui du leurre").toBe(0x42);

    // L'écriture est faite en arrière-plan (waitUntil) : on attend qu'elle
    // soit visible plutôt que de supposer un délai.
    await page.waitForFunction(
      async ({ name, url }) => {
        const cache = await /** @type {any} */ (globalThis).caches.open(name);
        return Boolean(await cache.match(url));
      },
      { name: cacheNameFor(config), url: PART },
      { timeout: CACHE_TIMEOUT_MS },
    );

    // Le serveur n'a plus rien à offrir : ce qui répondra viendra du cache.
    await rm(`${DISKS_DIR}e2e-cache-0-4194304.ext2.zst`, { force: true });
    await rm(`${DISKS_DIR}e2e-temoin-0-4194304.ext2.zst`, { force: true });

    await page.goto(HOST_PATH); // rechargement complet, comme un visiteur qui revient
    await declareConfig(page, config);

    const seconde = await readFromPage(page, PART);
    expect(seconde.status, "le rechargement ne doit RIEN retélécharger").toBe(200);
    expect(seconde.first, "le contenu resservi doit être identique").toBe(0x42);
  });

  test("laisse au réseau ce qui n'est pas déclaré dans la configuration", async () => {
    // Même forme de nom, même dossier, mais absent de la configuration : le
    // pré-filtre le laisse passer, la vérification qui fait foi le refuse.
    const temoin = await readFromPage(page, TEMOIN);
    expect(temoin.status, "un artefact non déclaré ne doit jamais être mis en cache").toBe(404);
  });

  test("abandonne le cache précédent quand la construction change", async () => {
    // Même URL de disque, construction différente : c'est exactement le cas
    // d'une reconstruction de sandbox, et le piège que le nom de cache évite.
    const reconstruit = fixtureConfig("2026-08-17T09:00:00Z");
    await declareConfig(page, reconstruit);

    expect(
      await artifactCacheNames(page),
      "un seul cache d'artefacts doit subsister après bascule",
    ).toEqual([cacheNameFor(reconstruit)]);

    const apres = await readFromPage(page, PART);
    expect(apres.status, "les morceaux de la construction précédente sont abandonnés").toBe(404);
  });

  test("met en cache un artefact same-origin hors de /disks/", async () => {
    // La topologie de la démonstration de référence : le dépôt d'artefacts est
    // un AUTRE Pages du même hôte github.io — same-origin, mais hors du site
    // et de son dossier /disks/. Le cache la manquait en production alors que
    // tous les tests locaux étaient verts : ce test fige la leçon.
    const config = {
      name: "e2e-hors-zone",
      baseName: "e2e-base",
      builtAt: "2026-08-16T12:00:00Z",
      disk: "e2e-autre-depot/e2e-hors-zone.ext2.zst",
      diskSize: CHUNK_BYTES,
      diskChunkSize: CHUNK_BYTES,
    };
    await declareConfig(page, config);

    const PART_HORS_ZONE = "e2e-autre-depot/e2e-hors-zone-0-4194304.ext2.zst";
    const premiere = await readFromPage(page, PART_HORS_ZONE);
    expect(premiere.status, "le premier passage doit venir du réseau en 200").toBe(200);
    expect(premiere.first).toBe(0x99);

    await page.waitForFunction(
      async ({ name, url }) => {
        const cache = await /** @type {any} */ (globalThis).caches.open(name);
        return Boolean(await cache.match(url));
      },
      { name: cacheNameFor(config), url: PART_HORS_ZONE },
      { timeout: CACHE_TIMEOUT_MS },
    );

    await rm(`${HORS_ZONE_DIR}e2e-hors-zone-0-4194304.ext2.zst`, { force: true });
    const seconde = await readFromPage(page, PART_HORS_ZONE);
    expect(seconde.status, "le morceau hors zone doit être resservi depuis le cache").toBe(200);
    expect(seconde.first).toBe(0x99);
  });
});
