// L'ATTAQUE, jouée en entier.
//
// Ce fichier ne simule pas le détournement du proxy : il l'exécute. La
// première version de cette épreuve postait le message frauduleux DEPUIS
// l'iframe, et passait donc pour la mauvaise raison — l'iframe est écartée par
// `isShellClient` sans que rien d'autre n'ait à tenir. Ce n'est pas l'attaque.
//
// L'attaque réelle exploite `allow-same-origin` sur l'iframe applicative :
//
//  1. un XSS de l'application atteint `parent.document` ;
//  2. il y ajoute un `<script src="/app/…">` — MÊME ORIGINE, donc autorisé par
//     la CSP de la coquille (`script-src 'self'`), qui est reproduite ici mot
//     pour mot par la coquille nue ;
//  3. ce script s'exécute DANS LE REALM DE LA COQUILLE : `location.href` est
//     celui de la coquille, `event.source.url` aussi. Aucun critère portant
//     sur l'émetteur ne peut le distinguer du code légitime ;
//  4. il commande le proxy.
//
// L'étape 4 est celle qui doit échouer, et elle ne peut échouer que sur ce que
// l'attaquant NE DÉTIENT PAS : le `MessagePort` privé, créé par la coquille
// avant qu'aucun contenu applicatif n'existe et gardé dans la fermeture de son
// module.
//
// CE FICHIER N'UTILISE PAS `installerCanalCoquille` — ce helper expose
// `window.__coquille.commander`, c'est-à-dire précisément la surface que la
// capacité supprime. L'attaquant n'aurait qu'à l'appeler, et l'épreuve
// passerait pour une raison qui n'existe pas en production. Le canal est donc
// monté ici, dans une fermeture, sans rien exposer de commandable.
import { expect, test } from "@playwright/test";

import { COQUILLE_NUE } from "./coquille-nue.mjs";

const DELAI_SW_MS = 30_000;
// Fenêtre d'observation d'un port qui doit rester MUET. Ce qui rend le silence
// concluant n'est pas sa durée mais la requête témoin qui le suit : elle
// aboutit, donc le worker parlait bien à quelqu'un pendant ce temps.
const FENETRE_SILENCE_MS = 500;

/**
 * Ouvre la coquille nue, installe le worker et attend qu'il prenne le contrôle.
 * @param {import("@playwright/test").Page} page
 */
async function installerWorker(page) {
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
}

/**
 * Monte la coquille : canal privé et pont légitime, l'un et l'autre enfermés
 * dans la même fermeture. Rien de commandable n'est exposé — seules le sont
 * des OBSERVATIONS (`__vues`, `__capture`), que l'épreuve relit.
 *
 * Le pont sert `/app/*` : une page piège, et le script de l'attaque avec le
 * type MIME qui le rend exécutable. C'est ce qui rend l'injection réaliste
 * sans qu'aucune VM n'ait à booter.
 * @param {import("@playwright/test").Page} page
 */
async function monterCoquille(page) {
  await page.evaluate(() => {
    const vue = /** @type {any} */ (globalThis);
    // Capturé avant tout : c'est ce qui empêche un `postMessage` remplacé de
    // récupérer le port en `this` au premier envoi qui suit l'injection.
    const poster = MessagePort.prototype.postMessage;

    vue.__vues = [];
    // Ce que l'attaquant aura réussi à capter, s'il capte quoi que ce soit.
    vue.__capture = { descripteurs: [], ports: [], canal: [], tours: [] };

    // Le script INJECTÉ, servi par le faux Rails sous /app/ avec un type MIME
    // exécutable. Il s'exécute dans la coquille : c'est tout l'objet du test.
    const SCRIPT_ATTAQUE = `
      (() => {
        const rapport = { origine: location.href, commandes: [] };
        // Piège 1 : capturer le port du pont au prochain envoi de la coquille.
        const original = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (donnees, transfert) {
          window.__capture.ports.push(this);
          return original.call(this, donnees, transfert);
        };
        // Piège 2 : poser notre propre pont et recevoir les descripteurs.
        const canal = new MessageChannel();
        canal.port1.onmessage = (evenement) => {
          window.__capture.descripteurs.push(evenement.data?.type ?? "sans-type");
        };
        canal.port1.start();
        const controleur = navigator.serviceWorker.controller;
        controleur.postMessage({ type: "bridge-port" }, [canal.port2]);
        rapport.commandes.push("bridge-port");
        // Les trois autres commandes, par le même chemin.
        controleur.postMessage({ type: "artifact-config", config: { name: "pirate" } });
        rapport.commandes.push("artifact-config");
        controleur.postMessage({ type: "cookies-document", id: 1, cookie: "vole=1" });
        rapport.commandes.push("cookies-document");
        controleur.postMessage({ type: "session-restauree" });
        rapport.commandes.push("session-restauree");
        // Piège 3 : se faire passer pour la coquille et obtenir SON canal.
        const usurpation = new MessageChannel();
        usurpation.port1.onmessage = (evenement) => {
          window.__capture.canal.push(evenement.data?.type ?? "sans-type");
        };
        usurpation.port1.start();
        controleur.postMessage({ type: "coquille-canal" }, [usurpation.port2]);
        rapport.commandes.push("coquille-canal");
        // Piège 4 : réclamer un TOUR de rétablissement, et y répondre.
        // C'est la manœuvre que le nonce doit rendre inutile — l'intrus
        // s'inscrit forcément après la coquille, donc il répond après elle.
        navigator.serviceWorker.addEventListener("message", (evenement) => {
          if (evenement.data?.type !== "coquille-canal-request") return;
          window.__capture.tours.push(evenement.data.nonce);
          const vole = new MessageChannel();
          vole.port1.onmessage = (recu) => {
            window.__capture.canal.push(recu.data?.type ?? "sans-type");
          };
          vole.port1.start();
          controleur.postMessage(
            { type: "coquille-canal", nonce: evenement.data.nonce },
            [vole.port2],
          );
        });
        navigator.serviceWorker.startMessages?.();
        controleur.postMessage({ type: "coquille-canal-demande" });
        rapport.commandes.push("coquille-canal-demande");
        window.__attaque = rapport;
      })();
    `;

    const encoder = (texte) => new TextEncoder().encode(texte).buffer;
    /** @param {{ path: string }} descripteur */
    const repondre = (descripteur) => {
      vue.__vues.push(descripteur.path);
      if (descripteur.path === "/app/attaque.js") {
        return {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/javascript; charset=utf-8"]],
          body: encoder(SCRIPT_ATTAQUE),
        };
      }
      return {
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/html; charset=utf-8"]],
        body: encoder("pont-legitime"),
      };
    };

    /** @type {any} */
    let canal = null;
    const commander = (donnees, transfert = []) =>
      Reflect.apply(poster, canal, [donnees, transfert]);

    const poserPont = () => {
      const paire = new MessageChannel();
      paire.port1.onmessage = (evenement) => {
        const donnees = evenement.data;
        if (donnees?.type !== "http-request") return;
        const reponse = repondre(donnees.descriptor);
        Reflect.apply(poster, paire.port1, [
          { type: "http-response", id: donnees.descriptor.id, ...reponse },
          reponse.body ? [reponse.body] : [],
        ]);
      };
      paire.port1.start();
      commander({ type: "bridge-port" }, [paire.port2]);
    };

    vue.__pret = false;
    const repondreAuTour = (nonce) => {
      const paire = new MessageChannel();
      paire.port1.onmessage = (evenement) => {
        if (evenement.data?.type === "coquille-canal-ok") {
          vue.__pret = true;
          poserPont();
          return;
        }
        if (evenement.data?.type === "bridge-port-request") poserPont();
      };
      paire.port1.start();
      canal = paire.port1;
      vue.navigator.serviceWorker.controller.postMessage({ type: "coquille-canal", nonce }, [
        paire.port2,
      ]);
    };

    // Inscrit AVANT la demande, comme main.js : c'est l'ordre d'inscription
    // qui fait gagner la coquille face à un script injecté plus tard.
    vue.navigator.serviceWorker.addEventListener("message", (evenement) => {
      if (evenement.data?.type === "coquille-canal-request") repondreAuTour(evenement.data.nonce);
    });
    vue.navigator.serviceWorker.startMessages?.();
    vue.navigator.serviceWorker.controller.postMessage({ type: "coquille-canal-demande" });
  });
  await page.waitForFunction(() => /** @type {any} */ (globalThis).__pret, undefined, {
    timeout: 10_000,
  });
}

/**
 * Joue l'attaque de bout en bout et rend ce qu'elle a obtenu.
 * @param {import("@playwright/test").Page} page
 * @param {number} fenetre
 */
function jouerAttaque(page, fenetre) {
  return page.evaluate(async (attente) => {
    const vue = /** @type {any} */ (globalThis);

    // 1. Le XSS applicatif : une page servie sous /app/, dans l'iframe.
    const cadre = vue.document.createElement("iframe");
    cadre.src = "/app/piege";
    vue.document.body.append(cadre);
    await new Promise((resoudre) => cadre.addEventListener("load", resoudre));
    const interne = cadre.contentWindow;

    // 2. Depuis l'iframe, injecter un script SAME-ORIGIN dans le DOM du parent.
    //    Script INLINE dans le document applicatif — la CSP que le proxy y
    //    injecte porte `'unsafe-inline'` mais pas `'unsafe-eval'`, donc `eval`
    //    serait refusé. Ce script atteint `parent.document` parce que l'iframe
    //    porte `allow-same-origin` : c'est le cœur du problème.
    const amorce = interne.document.createElement("script");
    amorce.textContent = `
      (() => {
        const parentDoc = parent.document;
        const balise = parentDoc.createElement("script");
        balise.src = "/app/attaque.js";
        balise.addEventListener("load", () => { parent.__injection = "charge"; });
        balise.addEventListener("error", () => { parent.__injection = "refuse"; });
        parentDoc.head.append(balise);
      })();
    `;
    interne.document.body.append(amorce);

    // 3. Laisser au worker le temps de livrer, s'il devait livrer.
    await new Promise((resoudre) => setTimeout(resoudre, Number(attente)));

    // 4. Requête témoin : le pont légitime doit servir, et lui seul.
    const reponse = await vue.fetch("/app/temoin");
    const corpsTemoin = await reponse.text();

    return {
      injecte: vue.__injection ?? "aucune",
      attaque: vue.__attaque ?? null,
      capture: {
        descripteurs: vue.__capture.descripteurs,
        ports: vue.__capture.ports.length,
        canal: vue.__capture.canal,
        tours: vue.__capture.tours,
      },
      statutTemoin: reponse.status,
      corpsTemoin,
      vues: vue.__vues,
    };
  }, fenetre);
}

test.describe("Frontière coquille / application", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;
  /** @type {any} */
  let resultat;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await installerWorker(page);
    await monterCoquille(page);
    resultat = await jouerAttaque(page, FENETRE_SILENCE_MS);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("l'injection RÉUSSIT : le script applicatif s'exécute dans la coquille", () => {
    // Si cette épreuve tombe, toutes les suivantes deviennent creuses : elles
    // constateraient l'échec d'une attaque qui n'a pas eu lieu. Elle affirme
    // donc explicitement ce que la CSP de la coquille autorise.
    expect(resultat.injecte, "le script applicatif est chargé et exécuté").toBe("charge");
    expect(resultat.attaque, "le script a bien tourné dans le document parent").not.toBeNull();
    expect(resultat.attaque.origine, "il s'exécute à l'URL DE LA COQUILLE").toContain(
      "coquille=nue",
    );
    expect(
      resultat.attaque.commandes,
      "il a tenté les quatre commandes, puis l'usurpation",
    ).toEqual([
      "bridge-port",
      "artifact-config",
      "cookies-document",
      "session-restauree",
      "coquille-canal",
      "coquille-canal-demande",
    ]);
  });

  test("le pont ne lui est jamais livré : aucun descripteur, aucun cookie", () => {
    expect(
      resultat.capture.descripteurs,
      "le port frauduleux n'a rien reçu — c'est là que passeraient les cookies HttpOnly",
    ).toEqual([]);
  });

  test("le port privé ne fuit pas par un postMessage remplacé", () => {
    // Le second piège : remplacer `MessagePort.prototype.postMessage` pour que
    // le prochain envoi de la coquille livre le port en `this`. `Reflect.apply`
    // sur la référence capturée au démarrage rend le piège inopérant.
    expect(resultat.capture.ports, "aucun port n'est passé par la fonction remplacée").toBe(0);
  });

  test("le pont légitime sert toujours : l'attaque ne l'a pas remplacé", () => {
    expect(resultat.statutTemoin).toBe(200);
    expect(resultat.corpsTemoin, "la réponse vient bien du pont de la coquille").toContain(
      "pont-legitime",
    );
    expect(resultat.vues, "la requête témoin a été vue par le pont légitime").toContain(
      "/app/temoin",
    );
  });

  test("il ne peut pas non plus USURPER le canal de la coquille", () => {
    // Dernière porte publique : proposer son propre canal. Une proposition
    // SPONTANÉE n'est plus jamais adoptée — il faut le nonce d'un tour que le
    // worker seul ouvre.
    expect(resultat.capture.canal, "le canal usurpé ne reçoit rien").toEqual([]);
  });

  test("il n'obtient même pas de TOUR de rétablissement", () => {
    // Le worker n'ouvre un tour que s'il n'a pas de canal utilisable. Tant que
    // la coquille qui commande est vivante — et l'intrus s'exécute DEDANS —
    // aucun nonce n'est émis. La manœuvre « réveiller le worker et parler le
    // premier » n'a plus de prise.
    expect(resultat.capture.tours, "aucun nonce n'a été émis").toEqual([]);
  });

  test("la configuration d'artefacts n'a pas été détournée", async () => {
    // `artifact-config` nomme le cache d'artefacts : l'accepter d'un intrus
    // reviendrait à lui laisser désigner ce que la VM lira.
    const caches = await page.evaluate(() => /** @type {any} */ (globalThis).caches.keys());
    expect(
      caches.some((nom) => String(nom).includes("pirate")),
      "aucun cache ne porte l'identité déclarée par l'attaquant",
    ).toBe(false);
  });
});

// CE QUE LE FILTRE D'URL NE POUVAIT PAS FAIRE, mesuré plutôt qu'affirmé.
//
// Les épreuves ci-dessus constatent que l'attaque échoue. Elles ne disent pas
// POURQUOI le filtre d'URL ne suffisait pas. Celle-ci le tranche, sur le code
// de production, sans rien y affaiblir : un client coquille qui n'a PAS établi
// de canal — l'état exact d'un worker qui vient de redémarrer — se voit tout de
// même émettre un nonce, à l'URL de la coquille, sans que rien ne distingue le
// code légitime d'un script injecté au même endroit.
//
// Et elle vérifie l'autre moitié : la proposition SPONTANÉE, elle, est refusée
// même dans cet état. C'est ce qui a changé.
test.describe("Ce que l'URL de l'émetteur ne dit pas", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await installerWorker(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("une proposition spontanée est refusée, worker sans canal compris", async () => {
    const recu = await page.evaluate(async () => {
      const vue = /** @type {any} */ (globalThis);
      const canal = new MessageChannel();
      /** @type {string[]} */
      const messages = [];
      canal.port1.onmessage = (evenement) => messages.push(evenement.data?.type);
      canal.port1.start();
      // Aucun nonce : c'est exactement ce que le worker adoptait autrefois.
      vue.navigator.serviceWorker.controller.postMessage({ type: "coquille-canal" }, [canal.port2]);
      await new Promise((resoudre) => setTimeout(resoudre, 500));
      return messages;
    });
    expect(recu, "rien n'est adopté sans nonce").toEqual([]);
  });

  test("le nonce, lui, part bien à l'URL de la coquille", async () => {
    // La mesure qui explique tout le reste : le worker ne peut pas viser mieux
    // qu'un CLIENT, et le script injecté vit dans le même client que nous. Ce
    // qui les départage est l'ordre d'inscription des écouteurs, pas l'adresse.
    const nonce = await page.evaluate(async () => {
      const vue = /** @type {any} */ (globalThis);
      /** @type {string[]} */
      const nonces = [];
      vue.navigator.serviceWorker.addEventListener("message", (evenement) => {
        if (evenement.data?.type === "coquille-canal-request") nonces.push(evenement.data.nonce);
      });
      vue.navigator.serviceWorker.startMessages?.();
      vue.navigator.serviceWorker.controller.postMessage({ type: "coquille-canal-demande" });
      await new Promise((resoudre) => setTimeout(resoudre, 500));
      return nonces;
    });
    expect(nonce.length, "un tour a bien été ouvert vers ce client").toBeGreaterThan(0);
    expect(typeof nonce[0], "et il porte un nonce").toBe("string");
  });
});
