// Le tiroir d'environnement comme DIALOGUE, au clavier et pour un lecteur
// d'écran.
//
// Ce que ces tests protègent. Le panneau se superpose à l'application et lui
// prend le focus : c'est une boîte de dialogue modale, qu'il le déclare ou non.
// Tant qu'il ne le déclarait pas, quatre défauts coexistaient — relevés en
// direct sur le DOM, panneau ouvert : ni `role="dialog"` ni `aria-modal`, donc
// un lecteur d'écran annonçait un contenu ordinaire ; aucun `aria-expanded` sur
// le déclencheur, donc rien ne disait que le panneau était ouvert ; la touche
// Échap ne fermait pas ; et le focus s'échappait au Tab vers une application
// qu'on ne voit plus, sans moyen de revenir.
//
// Pourquoi ici plutôt qu'en test unitaire. Le dépôt n'embarque pas de DOM
// synthétique, et c'est heureux : les deux comportements qui comptent le plus
// ici — le déplacement NATIF du focus par Tab, et l'effet de `inert` sur ce
// parcours — ne sont pas simulables. Un événement `keydown` fabriqué prouve
// qu'un gestionnaire a été appelé, jamais que le navigateur a bougé le focus.
// Playwright presse de vraies touches.
//
// Aucun artefact de public/disks/ n'est requis : le tiroir est instancié
// directement depuis ses modules, la VM ne démarre pas. Ces tests tournent donc
// en CI, et en quelques secondes.
import { expect, test } from "@playwright/test";

/** Ligne de journal qui déclare une variable manquante BLOQUANTE. */
const LIGNE_FATALE = '{"severity":"FATAL","message":"STRIPE_SECRET_KEY is missing"}';

/**
 * Coupe tout ce qui n'est pas la coquille : ni artefact de VM (650 Mo
 * d'instantané rendraient ces tests inutilisables), ni trafic externe.
 * @param {import("@playwright/test").Page} page page à brider
 */
async function servirLaCoquilleSeule(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const local = url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:");
    if (!local || url.includes("/disks/")) return route.abort();
    return route.continue();
  });
}

/**
 * Instancie un tiroir isolé et rend son déclencheur focalisable depuis la page.
 *
 * On ne passe pas par le démarrage de la coquille : il exige la VM, et le
 * contrat de dialogue ne dépend pas d'elle. Le déclencheur est posé en tête de
 * `body` pour que le premier Tab de la page l'atteigne.
 * @param {import("@playwright/test").Page} page page cible
 */
async function monterLeTiroir(page) {
  await page.evaluate(async () => {
    const vue = /** @type {any} */ (globalThis);
    // Spécificateurs passés par variable, et ce n'est pas une coquetterie : ce
    // sont des URL servies par serve.mjs, résolues par le navigateur au moment
    // de l'exécution. Écrites en littéral, tsc les prendrait pour des chemins
    // de fichiers et échouerait à les trouver — sur du code qui, lui, ne
    // s'exécute jamais dans Node.
    const moduleDetecteur = "/shared/env-detector.js";
    const moduleTiroir = "/env-drawer.js";
    const { createEnvironmentRegistry } = await import(moduleDetecteur);
    const { createEnvironmentDrawer } = await import(moduleTiroir);
    const registry = createEnvironmentRegistry();
    const tiroir = createEnvironmentDrawer({ registry, onApply: async () => {} });
    vue.document.body.prepend(tiroir.element);
    vue.__tiroir = tiroir;
  });
}

/**
 * Prépare une page avec un tiroir monté et vide.
 * @param {import("@playwright/test").Page} page page cible
 */
async function préparer(page) {
  await servirLaCoquilleSeule(page);
  await page.goto("/");
  await monterLeTiroir(page);
}

test.describe("Tiroir d'environnement — contrat de dialogue", () => {
  test("le déclencheur annonce l'état du panneau", async ({ page }) => {
    await préparer(page);
    const declencheur = page.locator(".env-declencheur");

    await expect(declencheur).toHaveAttribute("aria-expanded", "false");
    const controle = await declencheur.getAttribute("aria-controls");
    expect(controle, "aria-controls doit viser le panneau").toBeTruthy();

    await declencheur.click();
    await expect(declencheur).toHaveAttribute("aria-expanded", "true");
  });

  test("le panneau ouvert est un dialogue modal, nommé par son titre visible", async ({ page }) => {
    await préparer(page);
    await page.locator(".env-declencheur").click();

    const panneau = page.locator(".env-panneau");
    await expect(panneau).toHaveAttribute("role", "dialog");
    await expect(panneau).toHaveAttribute("aria-modal", "true");

    // Le nom accessible doit être le titre VISIBLE : un aria-label recopié à
    // côté diverge tôt ou tard du texte que l'utilisateur voyant lit.
    const nom = await page.evaluate(() => {
      const vue = /** @type {any} */ (globalThis);
      const p = vue.document.querySelector(".env-panneau");
      const id = p?.getAttribute("aria-labelledby");
      return id ? (vue.document.getElementById(id)?.textContent ?? "").trim() : null;
    });
    expect(nom).toBe("Inspecteur d'environnement");
  });

  test("Échap ferme, et rend le focus au déclencheur", async ({ page }) => {
    // Le retour de focus est ce qui manque le plus souvent, et ce qui se voit
    // le plus vite au clavier : sans lui, fermer le panneau renvoie l'utilisateur
    // au début de la page.
    await préparer(page);
    const declencheur = page.locator(".env-declencheur");
    await declencheur.click();
    await expect(page.locator(".env-panneau")).toHaveAttribute("aria-modal", "true");

    await page.keyboard.press("Escape");

    await expect(declencheur).toHaveAttribute("aria-expanded", "false");
    const focusRendu = await page.evaluate(() => {
      const vue = /** @type {any} */ (globalThis);
      return vue.document.activeElement?.classList.contains("env-declencheur") ?? false;
    });
    expect(focusRendu, "le focus doit revenir sur le déclencheur").toBe(true);
  });

  test("le focus ne quitte pas le panneau ouvert, en Tab comme en Maj+Tab", async ({ page }) => {
    await préparer(page);
    await page.locator(".env-declencheur").click();

    const dedans = async () =>
      page.evaluate(() => {
        const vue = /** @type {any} */ (globalThis);
        const p = vue.document.querySelector(".env-panneau");
        return !!(p && vue.document.activeElement && p.contains(vue.document.activeElement));
      });

    expect(await dedans(), "le focus entre dans le panneau à l'ouverture").toBe(true);

    // Vraies frappes : c'est le navigateur qui déplace le focus, pas nous.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      expect(await dedans(), `Tab n°${i + 1} a laissé fuir le focus`).toBe(true);
    }
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await dedans(), `Maj+Tab n°${i + 1} a laissé fuir le focus`).toBe(true);
    }
  });

  test("panneau fermé, le clavier ne traverse pas ses champs", async ({ page }) => {
    // Défaut préexistant, invisible à l'œil : les champs d'un panneau replié
    // restaient dans l'ordre de tabulation. Le visiteur tabulait dans un
    // formulaire qu'il ne voyait pas.
    await préparer(page);
    await page.locator(".env-declencheur").focus();

    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      const dansLePanneau = await page.evaluate(() => {
        const vue = /** @type {any} */ (globalThis);
        const p = vue.document.querySelector(".env-panneau");
        return !!(p && vue.document.activeElement && p.contains(vue.document.activeElement));
      });
      expect(dansLePanneau, `Tab n°${i + 1} est entré dans un panneau fermé`).toBe(false);
    }
  });

  test("sans variable manquante, les deux actions sont coupées et disent pourquoi", async ({
    page,
  }) => {
    // Offrir « Générer » et « Appliquer » sur un panneau vide, c'est promettre
    // un effet qui ne viendra pas. La raison doit être LUE, pas seulement
    // survolée : un `title` n'existe pas au clavier.
    await préparer(page);
    await page.locator(".env-declencheur").click();

    const actions = page.locator(".env-action");
    await expect(actions).toHaveCount(2);
    for (const action of await actions.all()) {
      await expect(action).toBeDisabled();
    }

    const raison = await page.evaluate(() => {
      const vue = /** @type {any} */ (globalThis);
      const bouton = vue.document.querySelector(".env-action");
      const id = bouton?.getAttribute("aria-describedby");
      return id ? (vue.document.getElementById(id)?.textContent ?? "").trim() : null;
    });
    expect(raison, "une action coupée doit exposer sa raison").toBeTruthy();
    expect((raison ?? "").length).toBeGreaterThan(10);
  });

  test("une variable bloquante rouvre les actions", async ({ page }) => {
    // Le pendant du test précédent : la coupure doit être un ÉTAT, pas un
    // verrou définitif. Sans cette garde, désactiver les boutons « pour être
    // tranquille » passerait la suite au vert.
    await préparer(page);
    await page.evaluate((ligne) => {
      const vue = /** @type {any} */ (globalThis);
      vue.__tiroir.ingest(ligne);
    }, LIGNE_FATALE);

    await expect(page.locator(".env-panneau")).toHaveAttribute("aria-modal", "true");
    // Une variable bloquante et vide : il y a de quoi générer.
    await expect(page.locator(".env-action").first()).toBeEnabled();
  });
});
