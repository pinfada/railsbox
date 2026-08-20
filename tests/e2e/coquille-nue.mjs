// Adresse de LA COQUILLE, servie sans son chargeur — et le canal privé par
// lequel elle commande le proxy.
//
// Ces épreuves ont besoin d'un document qui commande le proxy (pont série,
// identité des artefacts, cookies, lectures retenues) mais pas d'un boot de
// machine virtuelle, qui prendrait des dizaines de secondes pour rien. Elles
// se servaient d'une page hôte INEXISTANTE (`/e2e-…-hote`) : un 404 dans la
// portée du Service Worker, qui passait l'ancien `isShellClient` parce qu'il
// acceptait « tout ce qui n'est pas sous /app ».
//
// Ce raccourci est mort avec le filtre, et c'est le but : une page quelconque
// de l'origine n'est plus une coquille. Le remplaçant est plus fidèle — c'est
// la vraie adresse de la coquille, avec sa vraie CSP — et la neutralisation du
// chargeur vient du SERVEUR DE DEV, pas d'une interception Playwright : dès que
// le worker contrôle la page, c'est lui qui va chercher `main.js`, et seul
// Chromium laisse Playwright intercepter les requêtes d'un Service Worker. Voir
// `estCoquilleNue` dans tools/serve-logic.mjs.
export const COQUILLE_NUE = "/?coquille=nue";

/**
 * Installe le CANAL PRIVÉ dans la page, en rejouant le protocole de main.js :
 * inscrire l'écouteur AVANT tout, demander un tour, répondre au nonce, attendre
 * l'accusé de réception.
 *
 * ATTENTION — CE QUE CETTE EXPOSITION COÛTE. `window.__coquille.commander` est
 * exactement la surface que la capacité existe pour supprimer : un script
 * injecté dans la coquille n'aurait qu'à l'appeler. C'est acceptable dans les
 * épreuves qui n'éprouvent PAS l'injection ; ce ne l'est pas dans celle qui
 * l'éprouve, et tests/e2e/frontiere-coquille.e2e.spec.mjs monte donc son propre
 * canal, sans rien exposer de commandable. Ne pas utiliser ce helper là-bas.
 * @param {import("@playwright/test").Page} page
 * @param {{ attendre?: boolean }} [options] `attendre: false` pour une coquille
 *   qui doit rester SANS canal (un second onglet, refusé tant que le premier
 *   tient) — l'épreuve décide alors elle-même quand il devient disponible.
 */
export async function installerCanalCoquille(page, { attendre = true } = {}) {
  await page.evaluate(() => {
    const vue = /** @type {any} */ (globalThis);
    if (vue.__coquille) return; // déjà installé sur cette page
    // Lus par `globalThis` : ce corps est sérialisé pour le NAVIGATEUR, où
    // `ServiceWorker` existe — il n'existe pas dans le Node qui lit ce fichier.
    const poster = vue.MessagePort.prototype.postMessage;
    const posterAuWorker = vue.ServiceWorker.prototype.postMessage;
    /** @type {any} */
    let canal = null;
    let confirme = false;
    /** @type {any[]} */
    const enAttente = [];
    /** @type {Array<(donnees: any, ports: readonly MessagePort[]) => void>} */
    const abonnes = [];
    /** @type {Array<() => void>} */
    const attentes = [];

    const repondreAuTour = (nonce) => {
      const paire = new MessageChannel();
      paire.port1.onmessage = (evenement) => {
        const donnees = evenement.data;
        if (donnees?.type === "coquille-canal-ok") {
          confirme = true;
          for (const message of enAttente.splice(0)) {
            Reflect.apply(poster, canal, [message, []]);
          }
          for (const resoudre of attentes.splice(0)) resoudre();
          return;
        }
        vue.__coquille.messages.push(donnees?.type);
        for (const abonne of abonnes) abonne(donnees, evenement.ports);
      };
      paire.port1.start();
      canal = paire.port1;
      confirme = false;
      Reflect.apply(posterAuWorker, vue.navigator.serviceWorker.controller, [
        { type: "coquille-canal", nonce },
        [paire.port2],
      ]);
    };

    const demanderTour = () => {
      Reflect.apply(posterAuWorker, vue.navigator.serviceWorker.controller, [
        { type: "coquille-canal-demande" },
      ]);
    };

    vue.__coquille = {
      messages: [],
      estPret: () => confirme,
      /** @param {number} delai */
      attendrePret(delai = 5000) {
        if (confirme) return Promise.resolve(true);
        return new Promise((resoudre) => {
          attentes.push(() => resoudre(true));
          setTimeout(() => resoudre(confirme), delai);
        });
      },
      /**
       * @param {Record<string, unknown>} donnees
       * @param {any[]} [transfer] objets transférés (ports du pont)
       */
      commander(donnees, transfer = []) {
        if (canal && confirme) {
          Reflect.apply(poster, canal, [donnees, transfer]);
          return true;
        }
        if (transfer.length === 0) enAttente.push(donnees);
        demanderTour();
        return false;
      },
      /** @param {(donnees: any, ports: readonly MessagePort[]) => void} fn */
      surMessage(fn) {
        abonnes.push(fn);
      },
      demanderTour,
    };

    // Inscrit AVANT toute demande : c'est l'ordre qui fait gagner la coquille
    // face à un script injecté, les écouteurs étant appelés dans leur ordre
    // d'inscription.
    vue.navigator.serviceWorker.addEventListener("message", (evenement) => {
      if (evenement.data?.type === "coquille-canal-request") repondreAuTour(evenement.data.nonce);
    });
    vue.navigator.serviceWorker.startMessages?.();
    demanderTour();
  });

  if (!attendre) return;
  await page.waitForFunction(
    () => /** @type {any} */ (globalThis).__coquille.estPret(),
    undefined,
    {
      timeout: 10_000,
    },
  );
}
