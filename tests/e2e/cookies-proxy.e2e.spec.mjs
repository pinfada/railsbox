// Test de bout en bout du bocal à cookies, SANS VM : le trajet complet
// Set-Cookie → bocal du Service Worker → en-tête Cookie: → guest, dans un vrai
// navigateur, avec le VRAI sw-proxy.js.
//
// Ce qu'il prouve, et que seul un navigateur peut prouver :
//  1. un `Set-Cookie` rendu par la VM ne peut PAS atteindre le magasin du
//     navigateur (`document.cookie` reste vide) — c'est la cause racine du
//     422 InvalidAuthenticityToken observé sur la démonstration publiée ;
//  2. le proxy le range malgré tout et le renvoie sur la requête suivante,
//     donc un POST protégé par CSRF aboutit ;
//  3. l'en-tête `Origin` du navigateur n'atteint jamais le guest ;
//  4. un `Max-Age=0` (déconnexion) efface bien le cookie ;
//  5. le bocal survit à la MORT du Service Worker (persistance IndexedDB) —
//     le navigateur tue le worker dès qu'il est inactif, et sans cela le
//     visiteur perdrait sa session en plein parcours.
//
// La VM est remplacée par un pont factice tenu par la page : il applique le
// VRAI buildRequestFrames (donc la vraie frontière de sanitisation) pour voir
// exactement les en-têtes qu'aurait vus Puma. Aucun artefact de public/disks/
// n'est requis : ce test tourne en CI.
import { expect, test } from "@playwright/test";

const HOST_PATH = "/e2e-cookies-hote";
const SERVICE_WORKER_TIMEOUT_MS = 30_000;
const SESSION = "_demo_session";

/**
 * Installe le Service Worker depuis une page de sa portée, puis recharge pour
 * qu'il prenne le contrôle — sans passer par main.js, donc sans booter de VM.
 * @param {import("@playwright/test").Page} page
 */
async function installerWorker(page) {
  await page.goto(HOST_PATH);
  await page.evaluate(async () => {
    const nav = /** @type {any} */ (globalThis).navigator;
    await nav.serviceWorker.register("/sw-proxy.js", { type: "module" });
    await nav.serviceWorker.ready;
  });
  await page.goto(HOST_PATH);
  await page.waitForFunction(
    () => Boolean(/** @type {any} */ (globalThis).navigator.serviceWorker.controller),
    undefined,
    { timeout: SERVICE_WORKER_TIMEOUT_MS },
  );
}

/**
 * Installe la fausse VM : un pont qui répond comme le ferait Rails derrière le
 * pont série, et qui MÉMORISE les en-têtes que le guest aurait reçus.
 *
 * Il se réinstalle tout seul quand le Service Worker redémarre et réclame un
 * port (message « bridge-port-request »), exactement comme main.js.
 * @param {import("@playwright/test").Page} page
 */
async function installerPontFactice(page) {
  await page.evaluate(async () => {
    const fenetre = /** @type {any} */ (globalThis);
    // Import résolu par le NAVIGATEUR : cette fonction est sérialisée puis
    // exécutée dans la page. L'URL est construite dynamiquement pour que le
    // vérificateur de types de Node ne tente pas de la résoudre depuis tests/.
    const { base64ToBytes, buildRequestFrames } = await import(
      `${fenetre.location.origin}/shared/serial-codec.js`
    );
    fenetre.__requetes = [];

    // Ce que le guest verrait vraiment : on rejoue la construction des trames,
    // seule source de vérité sur les en-têtes qui franchissent la frontière.
    const enTetesGuest = (descriptor) => {
      const { head } = buildRequestFrames(String(descriptor.id), {
        ...descriptor,
        bodyBytes: null,
      });
      const json = new TextDecoder().decode(base64ToBytes(head.trim().split(" ")[3]));
      return JSON.parse(json).headers;
    };

    const corps = (texte) => new TextEncoder().encode(texte).buffer;
    // Le nom du cookie de session est répété ici : la fonction est sérialisée
    // pour le navigateur, aucune constante du test Node n'y est visible.
    const session = "_demo_session";

    const repondre = (descriptor) => {
      const entetes = enTetesGuest(descriptor);
      const cookie = (entetes.find(([nom]) => nom === "cookie") ?? [])[1] ?? "";
      fenetre.__requetes.push({
        method: descriptor.method,
        path: descriptor.path,
        entetes,
        brutes: descriptor.headers,
        cookie,
      });
      const typeHtml = ["content-type", "text/html; charset=utf-8"];

      if (descriptor.path === "/app/posts/new") {
        // Rails pose sa session (HttpOnly) ; l'auto-connexion pose son marqueur.
        return {
          status: 200,
          statusText: "OK",
          headers: [
            typeHtml,
            ["set-cookie", `${session}=graine-csrf; path=/; HttpOnly; SameSite=Lax`],
            ["set-cookie", "railsbox_auto_login=1; Path=/; SameSite=Lax"],
          ],
          body: corps(
            '<meta name="csrf-token" content="jeton-de-test">' +
              '<form action="/app/posts" method="post">' +
              '<input type="hidden" name="authenticity_token" value="jeton-de-test">' +
              '<input name="post[title]"><button>Create Post</button></form>',
          ),
        };
      }
      if (descriptor.path === "/app/deconnexion") {
        return {
          status: 200,
          statusText: "OK",
          headers: [typeHtml, ["set-cookie", `${session}=; path=/; max-age=0`]],
          body: corps("au revoir"),
        };
      }
      if (descriptor.method === "POST" && descriptor.path === "/app/posts") {
        // LE test : le jeton du formulaire doit correspondre à la GRAINE portée
        // par le cookie de session — c'est tout le mécanisme CSRF de Rails.
        // Sans cookie, la graine manque et Rails répond 422 : le défaut exact
        // de la démonstration publiée.
        const recu = new TextDecoder().decode(descriptor.corpsRecu ?? new Uint8Array(0));
        if (!cookie.includes(`${session}=graine-csrf`) || !recu.includes("authenticity_token=")) {
          return {
            status: 422,
            statusText: "Unprocessable Content",
            headers: [typeHtml],
            body: corps("ActionController::InvalidAuthenticityToken"),
          };
        }
        return {
          status: 302,
          statusText: "Found",
          headers: [["location", "/app/posts/1"]],
          body: null,
        };
      }
      if (descriptor.path === "/app/posts/1") {
        return { status: 200, statusText: "OK", headers: [typeHtml], body: corps("Billet créé") };
      }
      return { status: 200, statusText: "OK", headers: [typeHtml], body: corps("ok") };
    };

    fenetre.__poserPont = () => {
      const canal = new MessageChannel();
      canal.port1.onmessage = (evenement) => {
        const donnees = evenement.data;
        if (donnees?.type !== "http-request") return;
        // Le corps arrive à part du descripteur, comme sur le vrai pont.
        const reponse = repondre({
          ...donnees.descriptor,
          corpsRecu: donnees.body ? new Uint8Array(donnees.body) : null,
        });
        canal.port1.postMessage(
          { type: "http-response", id: donnees.descriptor.id, ...reponse },
          reponse.body ? [reponse.body] : [],
        );
      };
      fenetre.navigator.serviceWorker.controller.postMessage({ type: "bridge-port" }, [
        canal.port2,
      ]);
    };

    fenetre.navigator.serviceWorker.addEventListener("message", (evenement) => {
      if (evenement.data?.type === "bridge-port-request") fenetre.__poserPont();
    });
    fenetre.__poserPont();
  });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} chemin
 * @param {RequestInit} [options]
 */
function requete(page, chemin, options = {}) {
  return page.evaluate(
    async ({ cible, init }) => {
      const fenetre = /** @type {any} */ (globalThis);
      const reponse = await fenetre.fetch(cible, init);
      return {
        statut: reponse.status,
        localisation: reponse.headers.get("location"),
        setCookie: reponse.headers.get("set-cookie"),
        corps: await reponse.text(),
        documentCookie: fenetre.document.cookie,
      };
    },
    { cible: chemin, init: options },
  );
}

/**
 * Requêtes vues par le guest depuis le début du test.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<any[]>}
 */
function requetesGuest(page) {
  return page.evaluate(() => /** @type {any} */ (globalThis).__requetes);
}

test.describe("Bocal à cookies du proxy", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await installerWorker(page);
    await installerPontFactice(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("range le Set-Cookie de la VM sans jamais le rendre au navigateur", async () => {
    const reponse = await requete(page, "/app/posts/new");

    expect(reponse.statut, "la page du formulaire doit être servie").toBe(200);
    expect(reponse.corps, "elle doit porter le jeton CSRF de Rails").toContain("csrf-token");
    // Le cœur du diagnostic : un Service Worker NE PEUT PAS faire poser de
    // cookie. Ces deux vérifications figent la contrainte, pas un choix.
    expect(reponse.setCookie, "Set-Cookie ne franchit pas le constructeur Response").toBeNull();
    expect(reponse.documentCookie, "le magasin du navigateur reste vide").toBe("");
  });

  test("renvoie le cookie de session à la requête suivante", async () => {
    const reponse = await requete(page, "/app/posts/1");
    expect(reponse.statut).toBe(200);

    const derniere = (await requetesGuest(page)).at(-1);
    expect(derniere.cookie, "le guest doit recevoir la session ET le marqueur").toBe(
      `${SESSION}=graine-csrf; railsbox_auto_login=1`,
    );
  });

  test("fait aboutir le POST protégé par CSRF (le défaut corrigé)", async () => {
    // Répétition FIDÈLE du scénario de la recette en ligne
    // (tests/live/sandbox-publiee.live.spec.mjs) : on relit le jeton dans le
    // formulaire servi, on soumet, on suit la redirection. Ce qui marche ici
    // marche là-bas, aux réponses de la VM près.
    const resultat = await page.evaluate(async () => {
      const fenetre = /** @type {any} */ (globalThis);
      const formulaire = await fenetre.fetch("/app/posts/new");
      const html = await formulaire.text();
      const doc = new fenetre.DOMParser().parseFromString(html, "text/html");
      const jeton = doc.querySelector('input[name="authenticity_token"]')?.value ?? null;

      const creation = await fenetre.fetch("/app/posts", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new fenetre.URLSearchParams({
          authenticity_token: jeton ?? "",
          "post[title]": "Bonjour",
          commit: "Create Post",
        }).toString(),
      });
      return {
        jetonTrouve: jeton !== null,
        statut: creation.status,
        redirige: creation.redirected,
        urlFinale: creation.url,
        corps: await creation.text(),
      };
    });

    expect(resultat.jetonTrouve, "le formulaire doit porter un jeton CSRF").toBe(true);
    expect(resultat.corps, "aucun refus CSRF ne doit apparaître").not.toContain(
      "InvalidAuthenticityToken",
    );
    expect(resultat.redirige, "la création doit répondre par une redirection").toBe(true);
    expect(resultat.urlFinale, "la redirection doit mener au billet créé").toMatch(
      /\/app\/posts\/\d+$/,
    );
    expect(resultat.statut, "la page du billet doit être servie").toBe(200);
    expect(resultat.corps, "on doit atterrir sur le billet créé").toContain("Billet créé");

    const vues = await requetesGuest(page);
    const post = vues.find((entree) => entree.method === "POST");
    expect(post.cookie, "le POST doit porter la session, sinon 422").toContain(
      `${SESSION}=graine-csrf`,
    );
  });

  test("ne transmet ni Cookie ni Origin du navigateur au guest", async () => {
    // Rails compare Origin à request.base_url (forgery_protection_origin_check) :
    // le guest ne peut pas connaître l'origine publique de façon fiable, et
    // l'écart produirait un 422 opaque sur une application non modifiée.
    const post = (await requetesGuest(page)).find((entree) => entree.method === "POST");
    expect(post, "le POST doit avoir atteint le guest").toBeTruthy();

    // Mesuré ici : le Service Worker ne voit lui-même AUCUN en-tête Cookie —
    // le navigateur l'ajoute après l'interception. C'est la seconde moitié du
    // diagnostic : même s'il en existait un, le worker ne pourrait pas le lire.
    const brutes = post.brutes.map(([nom]) => nom);
    expect(brutes, "le navigateur n'expose aucun Cookie au worker").not.toContain("cookie");

    const noms = post.entetes.map(([nom]) => nom);
    expect(noms, "aucun Origin ne doit franchir la frontière").not.toContain("origin");
    expect(noms, "le cookie du bocal, lui, doit bien être là").toContain("cookie");
  });

  test("efface le cookie sur Max-Age=0 (déconnexion)", async () => {
    await requete(page, "/app/deconnexion");
    await requete(page, "/app/posts/1");

    const derniere = (await requetesGuest(page)).at(-1);
    expect(derniere.cookie, "la session effacée ne doit plus repartir").toBe(
      "railsbox_auto_login=1",
    );
  });

  test("survit à la mort du Service Worker (persistance IndexedDB)", async () => {
    // Le navigateur tue le worker dès qu'il est inactif ; le bocal en mémoire
    // disparaît avec lui. Sans persistance, le visiteur perdrait sa session au
    // milieu de son parcours — le défaut reviendrait par la fenêtre.
    await requete(page, "/app/posts/new"); // repose une session fraîche

    const client = await page.context().newCDPSession(page);
    await client.send("ServiceWorker.enable");
    await client.send("ServiceWorker.stopAllWorkers");
    await client.detach();

    // Le worker redémarre à la requête suivante : il redemande un port à la
    // page (le pont factice répond seul) et recharge son bocal depuis IndexedDB.
    const reponse = await requete(page, "/app/posts/1");
    expect(reponse.statut, "le proxy doit répondre après redémarrage").toBe(200);

    const derniere = (await requetesGuest(page)).at(-1);
    expect(derniere.cookie, "la session doit avoir survécu au redémarrage").toContain(
      `${SESSION}=graine-csrf`,
    );
  });
});
