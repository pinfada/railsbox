// Tests de bout en bout de la page hôte, sans VM : le contrat que doit tenir
// le navigateur avant même qu'une VM démarre — Service Worker installé et aux
// commandes, isolation cross-origin effective, CSP et bac-à-sable en place.
// Aucun artefact de public/disks/ n'est requis : ces tests tournent en CI.
import { expect, test } from "@playwright/test";

const BADGE_IDS = ["badge-sw", "badge-coi", "badge-vm", "badge-http"];
const SERVICE_WORKER_TIMEOUT_MS = 30_000;

/**
 * Coupe tout le trafic hors localhost : aucune dépendance réseau externe
 * qui n'a rien à faire dans un test. La VM échoue donc volontairement ici —
 * ce que ces tests n'observent pas — pendant que le reste reste vérifiable.
 * @param {import("@playwright/test").Page} page
 */
async function blockExternalTraffic(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const isLocal = url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:");
    return isLocal ? route.continue() : route.abort();
  });
}

test.describe("Page hôte", () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalTraffic(page);
    // La page se recharge une ou deux fois au premier passage (gardes de
    // reprise, voir shared/prerequis-demarrage.js) : le temps que le Service
    // Worker prenne le contrôle, puis que la navigation qu'il intercepte porte
    // enfin COOP/COEP. Toutes les assertions ci-dessous utilisent des attentes
    // qui survivent à ces navigations, jamais des lectures ponctuelles.
    await page.goto("/");
  });

  test("expose son titre et les quatre badges de démarrage", async ({ page }) => {
    await expect(page, "le titre doit identifier le projet").toHaveTitle(/railsbox/);
    for (const id of BADGE_IDS) {
      await expect(page.locator(`#${id}`), `le badge #${id} doit être présent`).toHaveCount(1);
    }
    await expect(page.locator("#boot-log"), "le journal de boot doit être présent").toHaveCount(1);
  });

  test("active le Service Worker et le laisse prendre le contrôle", async ({ page }) => {
    // Le badge passe à « ok » uniquement après navigator.serviceWorker.ready
    // ET l'obtention du contrôle : c'est le signal le plus fiable côté page.
    await expect(
      page.locator("#badge-sw"),
      "le badge Service Worker doit passer à l'état ok",
    ).toHaveClass(/\bok\b/, { timeout: SERVICE_WORKER_TIMEOUT_MS });

    const worker = await page.evaluate(async () => {
      const browser = /** @type {any} */ (globalThis);
      const registration = await browser.navigator.serviceWorker.ready;
      return {
        state: registration.active ? registration.active.state : null,
        controlling: Boolean(browser.navigator.serviceWorker.controller),
        scriptUrl: registration.active ? registration.active.scriptURL : null,
      };
    });

    expect(worker.state, "le Service Worker doit être activé").toBe("activated");
    expect(worker.controlling, "le Service Worker doit contrôler la page").toBe(true);
    expect(worker.scriptUrl, "le proxy enregistré doit être /sw-proxy.js").toContain(
      "/sw-proxy.js",
    );
  });

  test("obtient l'isolation cross-origin exigée par SharedArrayBuffer", async ({ page }) => {
    await expect(
      page.locator("#badge-coi"),
      "le badge d'isolation doit passer à l'état ok",
    ).toHaveClass(/\bok\b/, { timeout: SERVICE_WORKER_TIMEOUT_MS });

    const isolation = await page.evaluate(() => {
      const browser = /** @type {any} */ (globalThis);
      return {
        isolated: browser.crossOriginIsolated === true,
        hasSharedArrayBuffer: typeof browser.SharedArrayBuffer === "function",
      };
    });

    expect(isolation.isolated, "crossOriginIsolated doit valoir true (COOP/COEP)").toBe(true);
    expect(isolation.hasSharedArrayBuffer, "SharedArrayBuffer doit être disponible").toBe(true);
  });

  test("annonce l'étape de démarrage en cours et le temps écoulé", async ({ page }) => {
    // Ce que garde ce test : la mesure sous bridage processeur
    // (npm run test:bridage) chiffre à 54 s l'attente d'un appareil d'entrée de
    // gamme avant de voir l'application, dont 14 s sous une rangée de badges
    // déjà tous verts. Pendant tout ce temps la coquille n'offrait qu'un
    // journal gris qui défile. L'indicateur d'étape est la réponse ; s'il
    // cessait de s'afficher, personne ne s'en apercevrait.
    //
    // La configuration de la VM est retenue en vol : la coquille reste sur
    // l'étape « démarrage de la VM », et l'indicateur s'observe sans course.
    await page.route("**/disks/v86-config.json", async (route) => {
      await new Promise((resoudre) => setTimeout(resoudre, 20_000));
      await route.abort().catch(() => {});
    });
    await page.reload();

    const etat = page.locator("#etat-demarrage");
    await expect(etat, "l'indicateur doit nommer l'étape en cours").toContainText(
      /Étape \d\/\d · .+ · \d+ s/,
      { timeout: SERVICE_WORKER_TIMEOUT_MS },
    );
    await expect(etat, "l'indicateur doit être une région de statut").toHaveAttribute(
      "role",
      "status",
    );
    // Le compteur doit AVANCER : figé, il ressemblerait à un blocage — ce qui
    // est exactement l'impression qu'il est censé dissiper.
    await expect(etat, "le compteur de secondes doit progresser").toContainText(/· [1-9]\d* s/, {
      timeout: SERVICE_WORKER_TIMEOUT_MS,
    });
  });

  test("déclare une CSP et confine l'application dans un bac-à-sable", async ({ page }) => {
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(csp, "la page hôte doit porter une balise meta CSP").not.toBeNull();
    expect(csp, "la CSP doit verrouiller les sources par défaut").toContain("default-src 'self'");
    expect(csp, "la CSP doit interdire les objets embarqués").toContain("object-src 'none'");

    const frame = page.locator("#app-frame");
    await expect(frame, "l'iframe applicative doit exister").toHaveCount(1);
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox, "l'iframe applicative doit être en bac-à-sable").not.toBeNull();
    expect(sandbox, "le bac-à-sable doit autoriser les scripts de l'application").toContain(
      "allow-scripts",
    );
    expect(
      sandbox,
      "le bac-à-sable ne doit pas autoriser la navigation de la page hôte",
    ).not.toContain("allow-top-navigation");
  });
});
