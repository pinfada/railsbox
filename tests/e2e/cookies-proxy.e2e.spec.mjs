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
//  4. les cookies que l'application pose ELLE-MÊME en JavaScript rejoignent
//     l'en-tête `Cookie:` — sur les trois moteurs, sans skip — sans jamais
//     supplanter ceux du bocal, et sans que le proxy interroge autre chose que
//     le document coquille ;
//  5. un `Max-Age=0` (déconnexion) efface bien le cookie ;
//  6. le bocal survit à la MORT du Service Worker (persistance IndexedDB) —
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
      // Même relais que main.js : un Service Worker n'a pas de DOM, donc pas de
      // `document.cookie`. Sans cette réponse, les cookies que l'application
      // pose en JavaScript n'atteignent jamais le serveur.
      if (evenement.data?.type === "cookies-document-request") {
        fenetre.__cookiesDemandes = (fenetre.__cookiesDemandes ?? 0) + 1;
        fenetre.navigator.serviceWorker.controller.postMessage({
          type: "cookies-document",
          id: evenement.data.id,
          cookie: fenetre.document.cookie,
        });
      }
    });
    // Avec `addEventListener` seul, la file de messages du worker vers la page
    // reste désactivée par la spécification : sans ceci, rien n'arrive.
    fenetre.navigator.serviceWorker.startMessages?.();
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

/**
 * Nombre de fois que le Service Worker a demandé ses cookies à la coquille.
 * Sans ce compteur, une épreuve de fusion pourrait passer à vide.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<number>}
 */
function demandesCoquille(page) {
  return page.evaluate(() => /** @type {any} */ (globalThis).__cookiesDemandes ?? 0);
}

test.describe("Bocal à cookies du proxy", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;
  // Contexte explicite : le test de la frontière d'origine ouvre une SECONDE
  // page, sur 127.0.0.1, qui doit partager l'enregistrement du Service Worker
  // — donc le même contexte de navigateur.
  /** @type {import("@playwright/test").BrowserContext} */
  let contexte;

  test.beforeAll(async ({ browser }) => {
    contexte = await browser.newContext();
    page = await contexte.newPage();
    await installerWorker(page);
    await installerPontFactice(page);
  });

  test.afterAll(async () => {
    await contexte?.close();
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

  // --- MEDIUM-6 : les cookies que l'application pose en JavaScript ----------
  //
  // Ces trois épreuves tournent sur les TROIS moteurs, sans skip. C'est le
  // point : la première implémentation s'appuyait sur le Cookie Store API,
  // absent de WebKit et tardif dans Firefox, et le test correspondant
  // s'ignorait là où le manque était — deux visiteurs sur trois perdaient la
  // fusion sans qu'aucune suite ne rougisse. Le relais passe désormais par le
  // document coquille, qui existe partout.
  //
  // Placées AVANT l'épreuve inter-origine à dessein : elle échoue sur Firefox
  // et WebKit (aucun des deux n'expose `Origin` ni `Sec-Fetch-Site` sur une
  // navigation interceptée — défaut réel, hors du périmètre de celles-ci), et
  // le mode « serial » abandonne tout ce qui suit un échec.

  test("fusionne les cookies posés en JavaScript par la coquille", async () => {
    // L'iframe est same-origin : `document.cookie = "timezone=…"` crée un VRAI
    // cookie du navigateur, dont aucun `Set-Cookie` n'a informé le bocal et que
    // le proxy retirait de la requête. Motif courant d'une application Rails
    // non modifiée (fuseau, locale, consentement, js-cookie).
    await page.evaluate((session) => {
      const document = /** @type {any} */ (globalThis).document;
      document.cookie = "timezone=Europe/Paris; path=/";
      // Tentative d'usurpation : le bocal tient déjà ce nom (et c'est un
      // HttpOnly). Il ne doit être ni doublé, ni remplacé.
      document.cookie = `${session}=usurpe; path=/`;
    }, SESSION);
    await requete(page, "/app/posts/1");

    const derniere = (await requetesGuest(page)).at(-1);
    expect(derniere.cookie, "le cookie posé en JS doit atteindre le serveur").toContain(
      "timezone=Europe/Paris",
    );
    expect(derniere.cookie, "le bocal reste autoritaire sur les noms qu'il tient").toBe(
      `${SESSION}=graine-csrf; railsbox_auto_login=1; timezone=Europe/Paris`,
    );
    expect(await demandesCoquille(page), "la coquille a bien été interrogée").toBeGreaterThan(0);
  });

  test("voit les cookies posés depuis l'iframe applicative, et pas ceux de chemin /app", async () => {
    // Vérification, et non supposition : la coquille et l'iframe sont
    // same-origin, mais `document.cookie` reste apparié PAR CHEMIN. Un cookie
    // que l'application pose sans `Path` explicite prend « /app » pour chemin
    // et reste invisible de la coquille — donc hors de portée du relais. C'est
    // la limite exacte du dispositif, mesurée plutôt que devinée (et la même
    // que celle du Cookie Store API, dont la portée est celle du worker).
    const vus = await page.evaluate(async () => {
      const fenetre = /** @type {any} */ (globalThis);
      const cadre = fenetre.document.createElement("iframe");
      cadre.src = "/app/xss-simule";
      fenetre.document.body.append(cadre);
      await new Promise((resoudre) => cadre.addEventListener("load", resoudre));
      cadre.contentDocument.cookie = "consentement=accepte; path=/";
      cadre.contentDocument.cookie = "sans_chemin=1";
      const mesure = {
        iframe: cadre.contentDocument.cookie,
        coquille: fenetre.document.cookie,
      };
      cadre.remove();
      return mesure;
    });

    expect(vus.iframe, "l'application voit ce qu'elle vient de poser").toContain(
      "consentement=accepte",
    );
    expect(vus.coquille, "et la coquille le voit aussi : même origine").toContain(
      "consentement=accepte",
    );
    expect(vus.iframe, "y compris le cookie sans chemin explicite").toContain("sans_chemin=1");
    expect(vus.coquille, "que la coquille, elle, ne voit pas : il vaut pour /app").not.toContain(
      "sans_chemin",
    );

    await requete(page, "/app/posts/1");
    const derniere = (await requetesGuest(page)).at(-1);
    expect(derniere.cookie, "le cookie de l'application repart vers le serveur").toContain(
      "consentement=accepte",
    );
    expect(derniere.cookie, "celui de chemin /app reste hors de portée, sciemment").not.toContain(
      "sans_chemin",
    );
  });

  test("n'interroge jamais un client servi sous /app (isShellClient)", async () => {
    // Le sens de la demande est inversé par rapport à `bridge-port`, mais le
    // filtre est le même : interroger l'iframe applicative laisserait un XSS
    // dicter au proxy des cookies que le navigateur ne lui montre pas.
    const mesure = await page.evaluate(async () => {
      const fenetre = /** @type {any} */ (globalThis);
      fenetre.__demandesIframe = null;
      const cadre = fenetre.document.createElement("iframe");
      cadre.src = "/app/xss-simule";
      fenetre.document.body.append(cadre);
      await new Promise((resoudre) => cadre.addEventListener("load", resoudre));
      const script = cadre.contentDocument.createElement("script");
      script.textContent = `
        let vues = 0;
        navigator.serviceWorker.onmessage = (evenement) => {
          if (evenement.data?.type === "cookies-document-request") vues += 1;
        };
        parent.__demandesIframe = () => vues;
      `;
      cadre.contentDocument.body.append(script);

      const avant = fenetre.__cookiesDemandes ?? 0;
      await fenetre.fetch("/app/posts/1");
      await new Promise((resoudre) => fenetre.setTimeout(resoudre, 300));
      const mesuree = { iframe: fenetre.__demandesIframe(), coquille: fenetre.__cookiesDemandes };
      cadre.remove();
      return { ...mesuree, avant };
    });

    expect(mesure.iframe, "un client applicatif n'est jamais interrogé").toBe(0);
    expect(mesure.coquille, "alors que la coquille, elle, l'est").toBeGreaterThan(mesure.avant);

    // Ménage : les épreuves suivantes comparent l'en-tête `Cookie:` à l'octet
    // près, et un cookie de document survit à tout le reste.
    await page.evaluate((session) => {
      const document = /** @type {any} */ (globalThis).document;
      for (const nom of ["timezone", "consentement", session]) {
        document.cookie = `${nom}=; path=/; max-age=0`;
      }
    }, SESSION);
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
        urlFinale: creation.url,
        corps: await creation.text(),
      };
    });

    expect(resultat.jetonTrouve, "le formulaire doit porter un jeton CSRF").toBe(true);
    expect(resultat.corps, "aucun refus CSRF ne doit apparaître").not.toContain(
      "InvalidAuthenticityToken",
    );
    // La redirection se constate par où l'on ATTERRIT, pas par le drapeau
    // `redirected` : WebKit ne le lève pas quand la 302 est synthétisée par un
    // Service Worker (mesuré sur les trois moteurs — Chromium et Firefox le
    // lèvent, WebKit suit pourtant bien la redirection). L'URL finale et le
    // corps prouvent la même chose, sur les trois.
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

  test("refuse un POST de formulaire venu d'une AUTRE origine (HIGH-1)", async () => {
    // Le défaut : on croyait qu'un Service Worker n'intercepte que les
    // requêtes de ses propres clients. C'est faux — une requête de NAVIGATION
    // est routée par *Match Service Worker Registration* sur l'URL de la
    // requête, sans considération de l'initiateur. Le proxy y attachait donc
    // la session du bocal (qui n'applique pas SameSite), et le jeton
    // d'authenticité ne couvre pas les routes en skip_forgery_protection.
    //
    // Reproduction FIDÈLE, pas simulée : 127.0.0.1 et localhost sont deux
    // origines distinctes servies par le même serveur de test. La page tierce
    // poste un vrai formulaire vers l'origine de la sandbox ; c'est bien une
    // navigation inter-origine que le navigateur route jusqu'à notre worker.
    const avant = (await requetesGuest(page)).length;
    const port = new URL(page.url()).port;
    const tiers = await contexte.newPage();
    try {
      await tiers.goto(`http://127.0.0.1:${port}${HOST_PATH}`);
      await tiers.evaluate((cible) => {
        const fenetre = /** @type {any} */ (globalThis);
        const formulaire = fenetre.document.createElement("form");
        formulaire.method = "POST";
        formulaire.action = cible;
        const champ = fenetre.document.createElement("input");
        champ.name = "post[title]";
        champ.value = "forge";
        formulaire.append(champ);
        fenetre.document.body.append(formulaire);
        formulaire.submit();
      }, `http://localhost:${port}/app/posts`);
      await tiers.waitForURL(/\/app\/posts$/);

      const corps = (await tiers.textContent("body")) ?? "";
      expect(corps, "la requête inter-origine doit être refusée en 403").toContain("403");
      expect(corps).toContain("refusée");
      expect(await requetesGuest(page), "et RIEN ne doit atteindre la VM").toHaveLength(avant);
    } finally {
      await tiers.close();
    }
  });

  test("refuse un bridge-port qui ne vient pas du document coquille (HIGH-2)", async () => {
    // « Les cookies HttpOnly sont hors de portée de tout script » était faux :
    // chaque descripteur qui part sur le pont porte `cookie:` EN CLAIR, et le
    // pont était accepté de n'importe quel client. Un XSS dans l'application
    // (iframe same-origin, donc client du worker) n'avait qu'à poser son
    // propre port. On rejoue ici ce détournement depuis un document servi SOUS
    // /app/ — la surface exacte d'un tel XSS.
    const capture = await page.evaluate(async () => {
      const fenetre = /** @type {any} */ (globalThis);
      fenetre.__captureXss = null;
      const cadre = fenetre.document.createElement("iframe");
      cadre.src = "/app/xss-simule";
      fenetre.document.body.append(cadre);
      await new Promise((resoudre) => cadre.addEventListener("load", resoudre));

      // Script INLINE injecté dans le document applicatif : il s'exécute avec
      // l'iframe pour client, ce qui est tout l'objet du test. (`eval` serait
      // refusé par la CSP applicative, `unsafe-eval` n'y figurant pas.)
      const script = cadre.contentDocument.createElement("script");
      script.textContent = `
        const canal = new MessageChannel();
        canal.port1.onmessage = () => { parent.__captureXss = "descripteur intercepté"; };
        navigator.serviceWorker.controller.postMessage({ type: "bridge-port" }, [canal.port2]);
        fetch("/app/posts/1");
      `;
      cadre.contentDocument.body.append(script);
      await new Promise((resoudre) => fenetre.setTimeout(resoudre, 1500));
      cadre.remove();
      return fenetre.__captureXss ?? "aucun message";
    });
    expect(capture, "le port d'un client applicatif ne doit rien recevoir").toBe("aucun message");

    // Et le pont légitime, lui, sert toujours : la requête lancée par l'iframe
    // a bien été relayée par le port de la page hôte.
    const derniere = (await requetesGuest(page)).at(-1);
    expect(derniere.path, "la VM répond toujours par le pont de la coquille").toBe("/app/posts/1");
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
