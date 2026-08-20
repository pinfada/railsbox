// LE PASSAGE DE RELAIS ENTRE ONGLETS.
//
// La règle « un seul canal à la fois » a un revers : un second onglet est
// refusé tant que le premier tient. Si le premier disparaît — fermé, rechargé,
// ou simplement muet parce qu'il ne pilote plus la VM — le proxy resterait
// muet avec lui, sans réessai ni accusé de réception.
//
// Trois choses sont éprouvées ici :
//  1. le second onglet est bien refusé tant que le premier vit — c'est la
//     capacité qui tient, pas un hasard ;
//  2. le premier disparu, le second REPREND la main, et le sait : le worker lui
//     répond `coquille-canal-ok` ;
//  3. un script injecté dans ce second onglet ne gagne pas la reprise, alors
//     qu'il voit exactement le même nonce — il s'inscrit forcément après la
//     coquille, et les écouteurs sont appelés dans leur ordre d'inscription.
//
// CE QUE CE FICHIER NE PROUVE PAS. Il rejoue le côté page à la main
// (`installerCanalCoquille`) : il éprouve donc le PROTOCOLE DU WORKER, pas
// `main.js`, pas l'élection Web Locks, pas le rechargement réel de l'onglet qui
// rend la sandbox. Sa valeur est d'être rapide et de tourner sur les trois
// moteurs. Le passage de rôle avec la vraie coquille — et les pièges posés sur
// les intrinsèques du canal — vit dans `relais-onglets-reel.e2e.spec.mjs`, qui
// boote deux VM et s'ignore là où les artefacts manquent.
import { expect, test } from "@playwright/test";

import { COQUILLE_NUE, installerCanalCoquille } from "./coquille-nue.mjs";

const DELAI_SW_MS = 30_000;

/**
 * Ouvre un onglet sur la coquille nue et attend que le worker le contrôle.
 * @param {import("@playwright/test").BrowserContext} contexte
 */
async function ouvrirOnglet(contexte) {
  const page = await contexte.newPage();
  await page.goto(COQUILLE_NUE);
  await page.evaluate(async () => {
    const nav = /** @type {any} */ (globalThis).navigator;
    await nav.serviceWorker.register("/sw-proxy.js", { type: "module" });
    await nav.serviceWorker.ready;
  });
  await page.goto(COQUILLE_NUE);
  await page.waitForFunction(
    () => Boolean(/** @type {any} */ (globalThis).navigator.serviceWorker.controller),
    undefined,
    { timeout: DELAI_SW_MS },
  );
  return page;
}

/**
 * Pose dans la page un INTRUS : un écouteur de tours inscrit APRÈS celui de la
 * coquille, qui tente de répondre au nonce à sa place. C'est ce que ferait un
 * script injecté depuis l'application.
 * @param {import("@playwright/test").Page} page
 */
function poserIntrus(page) {
  return page.evaluate(() => {
    const vue = /** @type {any} */ (globalThis);
    vue.__intrus = { nonces: [], recu: [] };
    vue.navigator.serviceWorker.addEventListener("message", (evenement) => {
      if (evenement.data?.type !== "coquille-canal-request") return;
      vue.__intrus.nonces.push(evenement.data.nonce);
      const vole = new MessageChannel();
      vole.port1.onmessage = (recu) => vue.__intrus.recu.push(recu.data?.type ?? "sans-type");
      vole.port1.start();
      vue.navigator.serviceWorker.controller.postMessage(
        { type: "coquille-canal", nonce: evenement.data.nonce },
        [vole.port2],
      );
    });
  });
}

test.describe("Relais du canal entre onglets", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").BrowserContext} */
  let contexte;
  /** @type {import("@playwright/test").Page} */
  let premier;
  /** @type {import("@playwright/test").Page} */
  let second;

  test.beforeAll(async ({ browser }) => {
    // Un seul contexte : deux onglets du même visiteur, donc un seul worker.
    contexte = await browser.newContext();
    premier = await ouvrirOnglet(contexte);
    await installerCanalCoquille(premier);
    second = await ouvrirOnglet(contexte);
    // Refusé à ce stade : on n'attend donc pas la confirmation.
    await installerCanalCoquille(second, { attendre: false });
    await poserIntrus(second);
  });

  test.afterAll(async () => {
    await contexte?.close();
  });

  test("le second onglet est refusé tant que le premier tient le canal", async () => {
    const pret = await second.evaluate(() =>
      /** @type {any} */ (globalThis).__coquille.attendrePret(1000),
    );
    expect(pret, "aucun second canal tant que le porteur vit").toBe(false);
    const nonces = await second.evaluate(() => /** @type {any} */ (globalThis).__intrus.nonces);
    expect(nonces, "aucun tour n'est même ouvert").toEqual([]);
  });

  test("le premier fermé, le second reprend la main et le SAIT", async () => {
    await premier.close();
    // Rien ne prévient le worker qu'un client est parti, et le navigateur ne
    // le retire pas de `clients` à la seconde où l'onglet se ferme — mesuré
    // plus lent sur WebKit. Le second onglet redemande donc, comme le fait
    // `commander()` en production à chaque commande qui trouve le canal
    // absent : c'est le réessai qui manquait, et une demande unique le
    // masquait derrière une réussite de Chromium.
    const pret = await second.evaluate(async () => {
      const vue = /** @type {any} */ (globalThis);
      for (let essai = 0; essai < 20; essai += 1) {
        vue.__coquille.demanderTour();
        if (await vue.__coquille.attendrePret(500)) return true;
      }
      return false;
    });
    expect(pret, "le canal est repris, et l'accusé de réception le confirme").toBe(true);
  });

  test("l'intrus du second onglet ne gagne pas la reprise", async () => {
    // Il a vu LE MÊME nonce que la coquille — ils vivent dans le même client,
    // et le worker ne sait pas viser plus fin. Ce qui les départage est
    // l'ordre : la coquille s'est inscrite la première, elle a répondu la
    // première, et le nonce était consommé quand l'intrus a répondu.
    const intrus = await second.evaluate(() => /** @type {any} */ (globalThis).__intrus);
    expect(intrus.nonces.length, "l'intrus a bien vu le nonce passer").toBeGreaterThan(0);
    expect(intrus.recu, "et son canal n'a rien reçu").toEqual([]);
  });

  test("le second onglet commande réellement le proxy", async () => {
    // La reprise ne vaut que si elle sert : on pose un pont et on lit une page
    // applicative à travers lui.
    const corps = await second.evaluate(async () => {
      const vue = /** @type {any} */ (globalThis);
      vue.__coquille.surMessage((donnees) => {
        if (donnees?.type === "bridge-port-request") poserPont();
      });
      function poserPont() {
        const paire = new MessageChannel();
        paire.port1.onmessage = (evenement) => {
          const recu = evenement.data;
          if (recu?.type !== "http-request") return;
          const corpsReponse = new TextEncoder().encode("relais-second-onglet").buffer;
          paire.port1.postMessage(
            {
              type: "http-response",
              id: recu.descriptor.id,
              status: 200,
              statusText: "OK",
              headers: [["content-type", "text/html; charset=utf-8"]],
              body: corpsReponse,
            },
            [corpsReponse],
          );
        };
        paire.port1.start();
        vue.__coquille.commander({ type: "bridge-port" }, [paire.port2]);
      }
      poserPont();
      const reponse = await vue.fetch("/app/relais");
      return reponse.text();
    });
    expect(corps, "la lecture passe par le pont du second onglet").toContain(
      "relais-second-onglet",
    );
  });
});
