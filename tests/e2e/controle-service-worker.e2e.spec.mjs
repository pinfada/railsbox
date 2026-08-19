// Ce que voit un visiteur quand le Service Worker ne prend pas (encore) les
// commandes de la page.
//
// Mesuré sur une sandbox publiée le 18/08/2026 : l'écran d'accueil annonçait
// « Le démarrage a échoué » sous quatre badges rouges, et le journal « ERREUR
// FATALE ». La sandbox, elle, fonctionnait : un rechargement à la main la
// faisait démarrer normalement. Sur une offre payante, ce premier écran coûte
// le prospect — et le mot « fatale » était faux.
//
// La condition est reproduite en privant la page de `controller` : c'est
// exactement l'état d'une page dont le worker s'active encore. Aucun artefact
// de public/disks/ n'est requis, ces tests tournent en CI.
import { expect, test } from "@playwright/test";

import { GARDE_CONTROLE } from "../../public/shared/prerequis-demarrage.js";

const BADGE_IDS = ["badge-sw", "badge-coi", "badge-vm", "badge-http"];

/**
 * Installe un Service Worker qui s'enregistre, s'active, et ne revendique
 * jamais la page. Le compteur de rechargements n'est posé que s'il est vide :
 * la coquille doit pouvoir l'incrémenter et le retrouver après navigation.
 * @param {import("@playwright/test").Page} page
 * @param {{ garde: string, tentatives: number }} contexte
 */
function simulerWorkerSansControle(page, contexte) {
  return page.addInitScript(({ garde, tentatives }) => {
    const registration = { active: { state: "activated" } };
    const worker = {
      controller: null,
      ready: Promise.resolve(registration),
      register: () => Promise.resolve(registration),
      addEventListener() {},
      removeEventListener() {},
      startMessages() {},
    };
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      configurable: true,
      get: () => worker,
    });
    if (sessionStorage.getItem(garde) === null) {
      sessionStorage.setItem(garde, String(tentatives));
    }
  }, contexte);
}

test.describe("Contrôle du Service Worker manquant", () => {
  test("après le rechargement automatique, propose un rechargement au lieu d'une panne", async ({
    page,
  }) => {
    await simulerWorkerSansControle(page, { garde: GARDE_CONTROLE, tentatives: 1 });
    await page.goto("/");

    const diagnostic = page.locator("#diagnostic");
    await expect(diagnostic, "un panneau doit expliquer la situation").toBeVisible();
    await expect(diagnostic, "le ton doit être informatif, pas celui d'une panne").toHaveClass(
      /\binfo\b/,
    );

    const texte = await diagnostic.innerText();
    expect(texte, "aucune erreur fatale : l'état est récupérable").not.toMatch(/fatal/i);
    expect(texte, "le démarrage n'a pas échoué, il attend une navigation").not.toMatch(/a échoué/i);
    expect(texte, "le panneau doit expliquer, pas étiqueter").toMatch(/Service Worker/);

    await expect(
      page.locator("#diagnostic-action"),
      "le remède connu doit être à un clic",
    ).toHaveText(/recharger/i);

    const journal = await page.locator("#boot-log").innerText();
    expect(journal, "le journal ne doit pas parler d'erreur fatale").not.toContain("ERREUR FATALE");
  });

  test("ne passe aucun badge au rouge tant que le rechargement peut suffire", async ({ page }) => {
    await simulerWorkerSansControle(page, { garde: GARDE_CONTROLE, tentatives: 1 });
    await page.goto("/");
    await expect(page.locator("#diagnostic")).toBeVisible();

    for (const id of BADGE_IDS) {
      await expect(
        page.locator(`#${id}`),
        `le badge #${id} ne doit pas accuser une panne inexistante`,
      ).not.toHaveClass(/\berror\b/);
    }
  });

  test("le clic recharge, consomme la dernière tentative, et le message devient terminal", async ({
    page,
  }) => {
    await simulerWorkerSansControle(page, { garde: GARDE_CONTROLE, tentatives: 1 });
    await page.goto("/");
    await page.locator("#diagnostic-action").click();

    // Deuxième rechargement consommé : recharger n'est plus le remède, et le
    // panneau doit cesser de le proposer pour dire ce qui reste à essayer.
    // Le clic déclenche une navigation : seules des attentes qui la traversent
    // sont fiables ici, jamais une lecture ponctuelle du texte.
    const diagnostic = page.locator("#diagnostic");
    await expect(diagnostic, "le message doit nommer la navigation privée").toContainText(
      /privée/i,
    );
    await expect(diagnostic, "le message doit nommer les extensions de blocage").toContainText(
      /extension/i,
    );
    await expect(diagnostic, "le ton n'est plus informatif : c'est une impasse").not.toHaveClass(
      /\binfo\b/,
    );
    await expect(
      page.locator("#diagnostic-action"),
      "plus de bouton de rechargement : il ne servirait à rien",
    ).toHaveCount(0);

    const lien = page.locator("#diagnostic-lien");
    await expect(lien, "un lien vers les prérequis doit rester offert").toHaveCount(1);
    await expect(lien).toHaveAttribute("href", /^https:\/\//);
    expect(
      await page.evaluate((garde) => sessionStorage.getItem(garde), GARDE_CONTROLE),
      "les deux rechargements doivent être comptés",
    ).toBe("2");
  });
});
