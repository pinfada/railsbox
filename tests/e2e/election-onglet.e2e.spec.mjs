// Deux onglets, une seule VM. Le défaut se mesurait dans un vrai navigateur :
// chaque onglet bootait sa propre émulation x86 (processeur payé double), et le
// Service Worker, qui ne retient qu'un pont, envoyait les requêtes de tout le
// monde dans la VM du dernier onglet annoncé — un billet créé dans l'un
// apparaissait dans l'autre.
//
// Deux pages du MÊME contexte : c'est ce qui leur donne la même origine, donc
// le même espace de verrous Web Locks. Aucun artefact de public/disks/ n'est
// requis : le boot de la VM échoue volontairement ici, après avoir été
// ANNONCÉ — et c'est cette annonce qui distingue un onglet qui démarre une VM
// d'un onglet qui n'en démarre pas. Ces tests tournent en CI.
import { expect, test } from "@playwright/test";

const DELAI_SERVICE_WORKER_MS = 30_000;
const ANNONCE_BOOT = "Boot de la VM";

/**
 * Coupe tout le trafic hors localhost : aucune dépendance réseau externe.
 * @param {import("@playwright/test").Page} page
 */
async function couperTraficExterne(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const local = url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:");
    return local ? route.continue() : route.abort();
  });
}

/**
 * Ouvre la coquille dans un nouvel onglet du contexte courant.
 * @param {import("@playwright/test").BrowserContext} context
 */
async function ouvrirCoquille(context) {
  const page = await context.newPage();
  await couperTraficExterne(page);
  await page.goto("/");
  return page;
}

/**
 * Attend qu'un onglet ait pris la main : il enregistre le Service Worker, puis
 * annonce le boot de sa VM.
 * @param {import("@playwright/test").Page} page
 */
async function attendreRolePrincipal(page) {
  await expect(
    page.locator("#badge-sw"),
    "l'onglet actif enregistre le Service Worker",
  ).toHaveClass(/\bok\b/, { timeout: DELAI_SERVICE_WORKER_MS });
  await expect(page.locator("#boot-log"), "l'onglet actif annonce le boot de sa VM").toContainText(
    ANNONCE_BOOT,
    { timeout: DELAI_SERVICE_WORKER_MS },
  );
}

test.describe("Une seule sandbox active par navigateur", () => {
  test("le second onglet ne boote aucune VM et propose de reprendre la main", async ({
    context,
  }) => {
    const premier = await ouvrirCoquille(context);
    await attendreRolePrincipal(premier);

    const second = await ouvrirCoquille(context);

    const diagnostic = second.locator("#diagnostic");
    await expect(diagnostic, "le second onglet doit expliquer sa situation").toBeVisible();
    await expect(diagnostic).toContainText("déjà ouverte dans un autre onglet");
    await expect(
      second.locator("#diagnostic button"),
      "le visiteur doit pouvoir reprendre la main explicitement",
    ).toBeVisible();
    await expect(
      second.locator("#app-frame"),
      "aucun cadre applicatif vide dans un onglet secondaire",
    ).toBeHidden();

    // Le gain tient tout entier ici : pas de seconde émulation x86.
    await expect(
      second.locator("#boot-log"),
      "le second onglet ne doit pas démarrer de VM",
    ).not.toContainText(ANNONCE_BOOT);
    for (const id of ["badge-sw", "badge-coi", "badge-vm", "badge-http"]) {
      await expect(
        second.locator(`#${id}`),
        `le badge #${id} ne doit pas se lire comme un chargement en cours`,
      ).not.toHaveClass(/\bpending\b/);
    }

    // Le premier onglet, lui, n'a rien perdu.
    await expect(premier.locator("#diagnostic")).not.toContainText("déjà ouverte");
  });

  test("le bouton de reprise transfère la sandbox, l'autre onglet la libère", async ({
    context,
  }) => {
    const premier = await ouvrirCoquille(context);
    await attendreRolePrincipal(premier);
    const second = await ouvrirCoquille(context);
    await expect(second.locator("#diagnostic")).toBeVisible();

    await second.locator("#diagnostic button").click();

    await expect(
      second.locator("#diagnostic"),
      "le panneau doit céder la place une fois la main reprise",
    ).toBeHidden();
    await attendreRolePrincipal(second);

    await expect(
      premier.locator("#diagnostic"),
      "l'onglet évincé doit se présenter comme secondaire après avoir libéré sa VM",
    ).toContainText("déjà ouverte dans un autre onglet", { timeout: DELAI_SERVICE_WORKER_MS });
  });
});
