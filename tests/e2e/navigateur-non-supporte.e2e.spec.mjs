// Ce que voit un visiteur dont le navigateur ne peut pas faire tourner la
// sandbox. La question n'est pas rhétorique : les webviews intégrées aux
// applications (réseaux sociaux, messageries) bloquent les Service Workers, et
// c'est par là qu'arrive une bonne part des liens partagés.
//
// Sans ce garde, l'échec se résumait à quatre badges rouges et une ligne grise
// « ERREUR FATALE: navigator.serviceWorker is undefined » perdue au milieu du
// journal de boot, à côté d'un cadre applicatif vide et muet.
//
// Aucun artefact de public/disks/ n'est requis : ce test tourne en CI.
import { expect, test } from "@playwright/test";

const BADGE_IDS = ["badge-sw", "badge-coi", "badge-vm", "badge-http"];

/**
 * Prive la page de Service Worker AVANT tout script de la coquille — c'est
 * exactement ce que voit du code tournant dans une webview qui le refuse.
 * @param {import("@playwright/test").Page} page
 */
function retirerServiceWorker(page) {
  return page.addInitScript(() => {
    Object.defineProperty(globalThis.navigator, "serviceWorker", { get: () => undefined });
  });
}

test.describe("Navigateur non pris en charge", () => {
  test.beforeEach(async ({ page }) => {
    await retirerServiceWorker(page);
    await page.goto("/");
  });

  test("affiche un diagnostic à la place de l'application, pas un cadre vide", async ({ page }) => {
    const diagnostic = page.locator("#diagnostic");
    await expect(diagnostic, "le diagnostic doit être visible").toBeVisible();
    await expect(
      page.locator("#app-frame"),
      "le cadre applicatif ne doit pas rester affiché et vide",
    ).toBeHidden();
  });

  test("nomme la capacité manquante et ce qu'elle empêche", async ({ page }) => {
    const texte = await page.locator("#diagnostic").innerText();
    expect(texte, "le diagnostic doit nommer le Service Worker").toContain("Service Worker");
    expect(texte, "le diagnostic doit citer le cas des webviews").toMatch(/webview/i);
    expect(
      texte.length,
      "le diagnostic doit expliquer la conséquence, pas seulement étiqueter",
    ).toBeGreaterThan(120);
  });

  test("passe les quatre badges en erreur, aucun ne reste en attente", async ({ page }) => {
    // Un badge laissé « pending » se lit comme « ça charge encore » : c'est
    // le chargement infini qu'on refuse.
    for (const id of BADGE_IDS) {
      await expect(page.locator(`#${id}`), `le badge #${id} doit passer en erreur`).toHaveClass(
        /\berror\b/,
      );
    }
  });
});
