// La coquille sur un téléphone, sans VM.
//
// Le chemin le plus probable d'un visiteur de démonstration est un lien
// cliqué depuis un fil social, sur un téléphone. Deux défauts mesurés en
// émulation mobile sur la sandbox publiée motivent ces gardes :
//
//  1. l'en-tête en ligne imposait une largeur minimale de 468 px, si bien que
//     tout écran plus étroit dézoomait la PAGE ENTIÈRE — texte de journal à
//     ~10 px réels, application illisible ;
//  2. le journal de boot occupait 40 % d'un écran où le visiteur vient voir
//     l'application, à qui il ne restait que ~300 px de haut.
//
// Aucun artefact de public/disks/ n'est requis : la VM ne démarre pas ici,
// seule la mise en page est observée. Ces tests tournent donc en CI.
import { devices, expect, test } from "@playwright/test";

// iPhone SE : le plus étroit encore répandu. S'il passe, les autres passent.
/** @type {[string, import("@playwright/test").BrowserContextOptions][]} */
const TELEPHONES = [
  ["iPhone SE", devices["iPhone SE"]],
  ["iPhone 13", devices["iPhone 13"]],
  ["Pixel 5", devices["Pixel 5"]],
];

/**
 * Coupe le trafic externe : la mise en page ne dépend d'aucun artefact.
 * @param {import("@playwright/test").Page} page
 */
async function blockExternalTraffic(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const isLocal = url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:");
    return isLocal ? route.continue() : route.abort();
  });
}

test.describe("Coquille sur téléphone", () => {
  for (const [nom, telephone] of TELEPHONES) {
    test(`tient dans l'écran d'un ${nom}, sans dézoom ni débordement`, async ({ browser }) => {
      const largeurAppareil = telephone.viewport?.width ?? 0;
      const context = await browser.newContext({ ...telephone });
      const page = await context.newPage();
      await blockExternalTraffic(page);
      await page.goto("/");

      const mesures = await page.evaluate(() => {
        const vue = /** @type {any} */ (globalThis);
        const rect = (selector) => {
          const element = vue.document.querySelector(selector);
          return element ? Math.round(element.getBoundingClientRect().height) : 0;
        };
        return {
          innerWidth: vue.innerWidth,
          docWidth: vue.document.documentElement.scrollWidth,
          entete: rect("header"),
          journal: rect("#boot-log"),
          application: rect("#app-frame"),
        };
      });

      // Deux gardes, et la seconde est celle qui manquait. Comparer le
      // document à `innerWidth` ne suffit pas : quand la mise en page force
      // une largeur supérieure à l'écran, le navigateur mobile ÉLARGIT le
      // viewport de mise en page et dézoome — les deux valeurs restent alors
      // égales, et le test passe sur une page devenue illisible. Une seule
      // accolade CSS perdue à une fusion a suffi à reproduire le défaut.
      expect(
        mesures.docWidth,
        `${nom} : le document déborde de l'écran, la page sera dézoomée`,
      ).toBeLessThanOrEqual(mesures.innerWidth + 1);
      expect(
        mesures.innerWidth,
        `${nom} : viewport de mise en page élargi à ${mesures.innerWidth} px pour ` +
          `un écran de ${largeurAppareil} px — la page est dézoomée, le texte illisible`,
      ).toBeLessThanOrEqual(largeurAppareil + 1);

      // L'application doit dominer l'écran, pas le journal de boot.
      expect(
        mesures.application,
        `${nom} : l'application doit avoir plus de place que le journal`,
      ).toBeGreaterThan(mesures.journal);

      // Un en-tête qui déborde en hauteur mange l'écran utile.
      expect(mesures.entete, `${nom} : en-tête démesuré`).toBeLessThan(140);

      await context.close();
    });
  }
});
