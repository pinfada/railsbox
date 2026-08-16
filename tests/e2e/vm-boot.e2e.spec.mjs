// Tests de bout en bout du chemin complet : VM x86 (v86) restaurée depuis
// l'instantané, pont série, Service Worker proxy, application Rails rendue
// dans l'iframe. C'est le seul test qui prouve que la chaîne entière tient —
// notamment le montage sous /app (SCRIPT_NAME) et la réécriture des
// redirections, deux sources historiques de régressions.
//
// Le boot est coûteux (téléchargement de l'instantané + restauration) : il a
// lieu une seule fois dans un beforeAll, et les tests s'enchaînent en série
// sur la même page.
import { expect, test } from "@playwright/test";
import { vmDisksSkipReason } from "./vm-disks.mjs";

// Restauration d'un instantané de ~650 Mo puis attente de Puma : large marge
// sur la mesure observée, sans jamais masquer un blocage définitif (les
// badges en erreur interrompent l'attente immédiatement).
const BOOT_TIMEOUT_MS = 300_000;
const FRAME_TIMEOUT_MS = 120_000;
// Sous émulation, un rendu Rails complet coûte ~20 s : un clic suivi de deux
// attentes (URL puis document) doit tenir dans le même test.
const NAVIGATION_TIMEOUT_MS = 300_000;
// Un document applicatif réel (mise en page + navigation) dépasse largement
// ce seuil : en deçà, c'est une page d'erreur du proxy ou un document vide.
const MIN_DOCUMENT_LENGTH = 500;
const MISSING_ASSET_TIMEOUT_MS = 30_000;

const skipReason = vmDisksSkipReason();

/**
 * Dernières lignes du journal de boot : sans elles, un échec de démarrage se
 * résume à « délai dépassé », ce qui n'aide personne à diagnostiquer.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<string>}
 */
async function bootLogTail(page) {
  try {
    const text = await page.locator("#boot-log").innerText();
    return text.split("\n").slice(-25).join("\n");
  } catch {
    return "(journal de boot illisible)";
  }
}

/**
 * Attend que le badge HTTP passe à « ok ». S'arrête aussitôt si un badge
 * tombe en erreur : main.js marque en erreur tous les badges restés en
 * attente quand le démarrage échoue, inutile d'attendre le délai complet.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<void>}
 */
async function waitForApplicationReady(page) {
  const handle = await page.waitForFunction(
    () => {
      const dom = /** @type {any} */ (globalThis).document;
      const classesOf = (id) => {
        const badge = dom.getElementById(`badge-${id}`);
        return badge ? badge.classList : null;
      };
      if (classesOf("http") && classesOf("http").contains("ok")) return "prête";
      const broken = ["sw", "coi", "vm", "http"].find(
        (id) => classesOf(id) && classesOf(id).contains("error"),
      );
      return broken ? `échec:${broken}` : null;
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS, polling: 1_000 },
  );
  const outcome = String(await handle.jsonValue());
  if (outcome !== "prête") {
    throw new Error(
      `Le démarrage a échoué (badge ${outcome.slice("échec:".length)}).\n${await bootLogTail(page)}`,
    );
  }
}

/**
 * Objet Frame de l'iframe applicative. On garde le Frame et non un
 * FrameLocator : il survit aux navigations internes et expose l'URL courante,
 * ce dont dépend l'assertion de navigation.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<import("@playwright/test").Frame>}
 */
async function resolveAppFrame(page) {
  const element = await page.locator("#app-frame").elementHandle();
  const frame = element ? await element.contentFrame() : null;
  if (!frame) throw new Error("Document de l'iframe #app-frame inaccessible");
  return frame;
}

/**
 * HTML rendu dans l'iframe, chaîne vide si sa lecture échoue (navigation en
 * cours) : la valeur est destinée à un expect.poll, qui réessaiera.
 * @param {import("@playwright/test").Frame} frame
 * @returns {Promise<string>}
 */
async function frameContent(frame) {
  try {
    return await frame.content();
  } catch {
    return "";
  }
}

/**
 * @param {import("@playwright/test").Frame} frame
 * @returns {Promise<number>}
 */
async function documentLength(frame) {
  return (await frameContent(frame)).length;
}

test.describe("VM v86 : application Rails servie via le pont série", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(skipReason !== null, skipReason ?? "");

  /** @type {import("@playwright/test").Page} */
  let page;
  /** @type {import("@playwright/test").Frame} */
  let appFrame;

  test.beforeAll(async ({ browser }) => {
    if (skipReason !== null) return;
    test.setTimeout(BOOT_TIMEOUT_MS + FRAME_TIMEOUT_MS);
    page = await browser.newPage();
    const startedAt = Date.now();
    // La page se recharge une fois pour laisser le Service Worker prendre le
    // contrôle ; waitForApplicationReady survit à cette navigation.
    await page.goto("/");
    await waitForApplicationReady(page);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[e2e] VM prête (badge HTTP ok) en ${seconds} s`);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("charge l'application dans l'iframe via le proxy /app/", async () => {
    await expect(
      page.locator("#app-frame"),
      "l'iframe doit pointer sur le proxy applicatif",
    ).toHaveAttribute("src", "/app/", { timeout: FRAME_TIMEOUT_MS });

    appFrame = await resolveAppFrame(page);
    await expect
      .poll(() => documentLength(appFrame), {
        message: "l'iframe doit rendre un vrai document servi par la VM",
        timeout: FRAME_TIMEOUT_MS,
      })
      .toBeGreaterThan(MIN_DOCUMENT_LENGTH);

    const url = appFrame.url();
    expect(url, "l'iframe doit rester sous le préfixe /app").toContain("/app/");
  });

  test("navigue vers un autre écran de l'application", async () => {
    test.setTimeout(NAVIGATION_TIMEOUT_MS);
    const startPath = new URL(appFrame.url()).pathname;
    const startContent = await frameContent(appFrame);

    // Premier lien interne visible menant ailleurs. Trois exclusions :
    //  - liens à méthode (déconnexion en DELETE via Turbo) : ils détruiraient
    //    la session sans rien prouver sur le rendu ;
    //  - liens repliés dans un menu fermé (navigation mobile) : non cliquables,
    //    ils feraient échouer le test sur l'interface et non sur le pont ;
    //  - liens vers l'écran courant : ils ne prouveraient aucune navigation.
    // Le candidat est marqué dans le DOM pour obtenir un sélecteur sans
    // ambiguïté (plusieurs liens partagent souvent la même destination).
    const target = await appFrame.evaluate(() => {
      const view = /** @type {any} */ (globalThis);
      const dom = view.document;
      const links = Array.from(dom.querySelectorAll('a[href^="/app/"]'));
      const candidate = links.find(
        (link) =>
          !link.hasAttribute("data-turbo-method") &&
          !link.hasAttribute("data-method") &&
          new URL(link.href).pathname !== dom.location.pathname &&
          link.getClientRects().length > 0 &&
          view.getComputedStyle(link).visibility !== "hidden",
      );
      if (!candidate) return null;
      candidate.setAttribute("data-cible-e2e", "1");
      return candidate.getAttribute("href");
    });

    expect(
      target,
      "l'application doit exposer au moins un lien interne visible vers /app/…",
    ).not.toBeNull();

    await appFrame.locator('a[data-cible-e2e="1"]').click();

    await expect
      .poll(() => new URL(appFrame.url()).pathname, {
        message: "le clic doit faire naviguer l'iframe (SCRIPT_NAME et redirections)",
        timeout: FRAME_TIMEOUT_MS,
      })
      .not.toBe(startPath);

    // Turbo remplace le corps APRÈS avoir poussé la nouvelle URL : se contenter
    // d'une taille de document validerait encore la page de départ. On exige
    // donc un contenu à la fois différent et complet.
    await expect
      .poll(
        async () => {
          const content = await frameContent(appFrame);
          return content !== startContent && content.length > MIN_DOCUMENT_LENGTH;
        },
        {
          message: "l'écran atteint doit être un nouveau document complet, pas une page d'erreur",
          timeout: FRAME_TIMEOUT_MS,
        },
      )
      .toBe(true);
  });

  test("sert les assets fingerprintés depuis les fichiers extraits", async () => {
    const assetPath = await appFrame.evaluate(() => {
      const dom = /** @type {any} */ (globalThis).document;
      const nodes = Array.from(dom.querySelectorAll('link[rel="stylesheet"][href], script[src]'));
      const references = nodes.map(
        (node) => node.getAttribute("href") ?? node.getAttribute("src") ?? "",
      );
      return references.find((reference) => reference.startsWith("/app/assets/")) ?? null;
    });

    expect(
      assetPath,
      "l'application doit référencer au moins un asset /app/assets/…",
    ).not.toBeNull();

    const asset = await page.evaluate(async (path) => {
      const browser = /** @type {any} */ (globalThis);
      const response = await browser.fetch(path);
      const bytes = await response.arrayBuffer();
      return { status: response.status, byteLength: bytes.byteLength };
    }, assetPath);

    expect(asset.status, `l'asset ${assetPath} doit être servi en 200`).toBe(200);
    expect(asset.byteLength, `l'asset ${assetPath} ne doit pas être vide`).toBeGreaterThan(0);
  });

  test("répond sans blocage pour un asset inexistant", async () => {
    // Le repli vers la VM traverse le pont série : laisser au test de quoi
    // observer l'abandon interne (30 s) plutôt que d'expirer avant lui.
    test.setTimeout(MISSING_ASSET_TIMEOUT_MS * 4);
    const outcome = await page.evaluate(async (timeoutMs) => {
      const browser = /** @type {any} */ (globalThis);
      const controller = new browser.AbortController();
      const timer = browser.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await browser.fetch("/app/assets/definitely-missing-xyz.css", {
          signal: controller.signal,
        });
        await response.arrayBuffer();
        return { status: response.status, failure: null };
      } catch (error) {
        return { status: 0, failure: String(error) };
      } finally {
        browser.clearTimeout(timer);
      }
    }, MISSING_ASSET_TIMEOUT_MS);

    expect(
      outcome.failure,
      "un asset absent doit produire une réponse, jamais un blocage",
    ).toBeNull();
    // Repli VM (404 de Rails) ou page d'erreur du proxy : peu importe, tant
    // que la réponse est bien formée et arrive dans le délai imparti.
    expect(outcome.status, "le statut doit être un statut HTTP exploitable").toBeGreaterThanOrEqual(
      200,
    );
  });
});
