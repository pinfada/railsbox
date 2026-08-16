// Recette de la sandbox PUBLIÉE — la seule vérification qui ait jamais trouvé
// les défauts de publication.
//
// Ce que cette suite garde, dans l'ordre où l'histoire les a fait apparaître :
//  1. la coquille ne référence QUE des chemins relatifs (un Pages de projet
//     sert sous /<depot>/ : `/main.js` y sort du site — défaut réel, invisible
//     en local, quatre fois de suite) ;
//  2. tout le chargement aboutit (aucun 404) ;
//  3. aucune origine externe n'est contactée (contrainte « GitHub seul ») ;
//  4. la VM boote vraiment et l'application répond ;
//  5. une page du scaffold traverse le proxy et rend du HTML Rails ;
//  6. aucune requête d'artefact ne porte d'en-tête non safelisté, et aucun
//     préflight OPTIONS n'est émis (point de vigilance de l'ADR 0001 : GitHub
//     Pages répond 405 à OPTIONS, une requête préflightée échouerait).
//
// Elle dépend du réseau et d'un déploiement : elle ne tourne donc PAS dans
// `npm test` ni dans la CI standard. Voir playwright.live.config.mjs.
import { expect, test } from "@playwright/test";

import { enTetesNonSafelistes, estRequeteReseau, observerReseau } from "./observateur-reseau.mjs";
import { urlSandbox } from "./url-sandbox.mjs";

const URL_SANDBOX = urlSandbox();
const ORIGINE_SANDBOX = new URL(URL_SANDBOX).origin;
/** Chemin de publication du site, « / » à la racine, « /depot/ » sur un Pages de projet. */
const CHEMIN_SITE = new URL(URL_SANDBOX).pathname;
const PREFIXE_APPLICATIF = `${URL_SANDBOX}app/`;

// Boot en ligne mesuré entre 25 et 80 s ; la marge absorbe un Pages lent ou un
// boot à froid, sans jamais masquer un blocage (un badge en erreur coupe court).
const BOOT_TIMEOUT_MS = 240_000;
// Une requête servie par la VM traverse le pont série : compter en dizaines de
// secondes, pas en centaines de millisecondes.
const REQUETE_VM_TIMEOUT_MS = 120_000;
const TAILLE_MINIMALE_DOCUMENT = 500;

/**
 * @typedef {import("./observateur-reseau.mjs").Trace} Trace
 */

test.describe("Sandbox publiée", () => {
  test.describe.configure({ mode: "serial" });

  /** @type {import("@playwright/test").Page} */
  let page;
  /** @type {Trace[]} */
  let traces;
  /** @type {string[]} */
  let echecs;
  /** @type {Record<string, any>} */
  let configVm;
  /** @type {string[]} */
  let racinesArtefacts;
  /** @type {string} */
  let htmlCoquille;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(BOOT_TIMEOUT_MS + 60_000);
    console.log(`[live] sandbox vérifiée : ${URL_SANDBOX}`);
    // Contexte neuf : aucun cache, aucun Service Worker survivant d'un essai
    // précédent — on veut la première visite d'un visiteur réel.
    page = await browser.newPage();
    ({ traces, echecs } = observerReseau(page));

    const debutChargement = Date.now();
    await page.goto(URL_SANDBOX, { waitUntil: "domcontentloaded" });
    console.log(`[live] coquille chargée en ${secondes(debutChargement)} s`);

    htmlCoquille = await (await page.request.get(URL_SANDBOX)).text();
    configVm = await (
      await page.request.get(new URL("disks/v86-config.json", URL_SANDBOX).href)
    )
      .json()
      .catch(() => ({}));
    racinesArtefacts = deduireRacinesArtefacts(configVm);
    console.log(`[live] racines d'artefacts : ${racinesArtefacts.join(" ")}`);

    const debutBoot = Date.now();
    await attendreApplication(page);
    console.log(`[live] application disponible (badge HTTP) en ${secondes(debutBoot)} s`);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("ne référence ses ressources qu'en chemins relatifs", async () => {
    // Garde statique : la coquille telle qu'elle est publiée. Une seule
    // référence partant de la racine du domaine, et la sandbox ne charge plus
    // rien sur un Pages de projet.
    const absolues = [...htmlCoquille.matchAll(/(?:src|href)\s*=\s*"\/(?!\/)[^"]*/g)].map(
      (trouve) => trouve[0],
    );
    expect(absolues, "index.html ne doit contenir aucune référence absolue").toEqual([]);

    // Garde dynamique : ce que le navigateur a réellement demandé. Sont hors
    // périmètre l'iframe applicative (son trafic dépend de l'application), les
    // requêtes du Service Worker et /favicon.ico, que le navigateur réclame de
    // lui-même à la racine du domaine.
    const horsDuSite = requetesCoquille(traces)
      .filter((trace) => new URL(trace.url).origin === ORIGINE_SANDBOX)
      .filter((trace) => !estArtefact(trace.url, racinesArtefacts))
      .filter((trace) => new URL(trace.url).pathname !== "/favicon.ico")
      .filter((trace) => !new URL(trace.url).pathname.startsWith(CHEMIN_SITE))
      .map((trace) => `${trace.methode} ${trace.url}`);
    expect(horsDuSite, `toute requête doit rester sous ${CHEMIN_SITE}`).toEqual([]);
  });

  test("charge tout ce dont elle a besoin, sans 404 ni requête en échec", () => {
    expect(echecs, "aucune requête ne doit échouer au niveau réseau").toEqual([]);

    // Le trafic INTERNE à l'application est hors périmètre : ses 404 éventuels
    // regardent l'application, pas la publication de la sandbox.
    const enErreur = traces
      .filter((trace) => estRequeteReseau(trace.url))
      .filter((trace) => !trace.url.startsWith(PREFIXE_APPLICATIF))
      .filter((trace) => trace.statut !== null && trace.statut >= 400)
      .map((trace) => `${trace.statut} ${trace.methode} ${trace.url}`);
    expect(
      enErreur,
      "le chargement de la coquille et des artefacts doit être exempt d'erreurs",
    ).toEqual([]);
  });

  test("ne contacte aucune origine externe", () => {
    const autorisees = new Set([
      ORIGINE_SANDBOX,
      ...racinesArtefacts.map((racine) => new URL(racine).origin),
    ]);
    const externes = [
      ...new Set(
        traces
          .filter((trace) => estRequeteReseau(trace.url))
          .map((trace) => new URL(trace.url).origin)
          .filter((origine) => !autorisees.has(origine)),
      ),
    ];
    expect(externes, `origines autorisées : ${[...autorisees].join(" ")}`).toEqual([]);
  });

  test("boote la VM et monte l'application dans l'iframe", async () => {
    for (const badge of ["sw", "coi", "vm", "http"]) {
      await expect(
        page.locator(`#badge-${badge}`),
        `le badge ${badge} doit être au vert`,
      ).toHaveClass(/\bok\b/);
    }
    await expect(
      page.locator("#app-frame"),
      "l'iframe doit pointer sur le proxy applicatif du site",
    ).toHaveAttribute("src", `${CHEMIN_SITE}app/`, { timeout: REQUETE_VM_TIMEOUT_MS });
  });

  test("sert une page du scaffold Posts à travers le proxy", async () => {
    test.setTimeout(REQUETE_VM_TIMEOUT_MS * 2);
    const debut = Date.now();
    // Chemin RELATIF à la page : c'est exactement ce que fait l'application
    // depuis l'iframe, et cela traverse le Service Worker puis le pont série.
    const reponse = await page.evaluate(async () => {
      const navigateur = /** @type {any} */ (globalThis);
      const brute = await navigateur.fetch("app/posts");
      return { statut: brute.status, corps: await brute.text() };
    });
    console.log(
      `[live] GET app/posts → ${reponse.statut} (${reponse.corps.length} o) en ${secondes(debut)} s`,
    );

    expect(reponse.statut, "le scaffold doit répondre 200 à travers le proxy").toBe(200);
    expect(
      reponse.corps.length,
      "la réponse doit être un vrai document, pas une page d'erreur du proxy",
    ).toBeGreaterThan(TAILLE_MINIMALE_DOCUMENT);
    expect(reponse.corps, "le document doit être celui du scaffold Posts").toContain(
      "<h1>Posts</h1>",
    );
    expect(
      reponse.corps,
      "le document doit venir de Rails (jeton CSRF rendu par la couche vue)",
    ).toContain('name="csrf-token"');
  });

  test("n'ajoute aucun en-tête non safelisté sur les requêtes d'artefacts", async () => {
    // Point de vigilance de l'ADR 0001. Un seul en-tête hors liste — celui que
    // v86 pose sur son chemin Range, par exemple — et le navigateur préflighte ;
    // GitHub Pages répond 405 au préflight, la sandbox ne boote plus.
    const artefacts = traces.filter((trace) => estArtefact(trace.url, racinesArtefacts));
    expect(artefacts.length, "le boot doit avoir téléchargé des artefacts").toBeGreaterThan(0);

    const fautifs = [];
    for (const trace of artefacts) {
      const entetes = await trace.requete.allHeaders();
      const hors = enTetesNonSafelistes(entetes);
      if (hors.length > 0) fautifs.push(`${trace.url} → ${hors.join(", ")}`);
    }
    expect(
      fautifs,
      "les requêtes d'artefacts doivent rester des « requêtes simples » CORS",
    ).toEqual([]);
    console.log(`[live] ${artefacts.length} requêtes d'artefacts, toutes en en-têtes safelistés`);
  });

  test("n'émet aucun préflight vers les origines d'artefacts", () => {
    // Chromium n'expose pas toujours ses préflights à l'instrumentation : cette
    // vérification est donc doublée par l'absence de requête en échec (un
    // préflight refusé se solde par un net::ERR_FAILED) et par l'inspection des
    // en-têtes ci-dessus.
    const preflights = traces
      .filter((trace) => trace.methode === "OPTIONS")
      .map((trace) => trace.url);
    expect(preflights, "aucune requête OPTIONS ne doit partir").toEqual([]);
  });

  test("est hébergée sur un service qui sert CORS et Range", async ({ request }) => {
    // Les deux seules exigences que l'ADR 0001 pose à l'hébergeur. Les perdre
    // casserait toutes les sandboxes d'un coup.
    const artefact = new URL(configVm.disk, URL_SANDBOX).href;
    const tete = await request.fetch(artefact, { method: "HEAD" });
    expect(tete.headers()["access-control-allow-origin"], `CORS attendu sur ${artefact}`).toBe("*");
    expect(tete.headers()["accept-ranges"], `Range attendu sur ${artefact}`).toBe("bytes");

    // Observation, non assertion : si l'hébergeur se mettait à répondre au
    // préflight, c'est l'ADR 0001 qu'il faudrait relire, pas le code.
    const preflight = await request.fetch(artefact, { method: "OPTIONS" });
    console.log(`[live] OPTIONS ${artefact} → ${preflight.status()}`);
  });
});

/**
 * Requêtes émises par la coquille elle-même : ni l'iframe applicative, ni le
 * Service Worker, ni les URL internes à l'onglet (blob:).
 * @param {Trace[]} traces
 * @returns {Trace[]}
 */
function requetesCoquille(traces) {
  return traces.filter(
    (trace) => estRequeteReseau(trace.url) && trace.cadrePrincipal && !trace.viaServiceWorker,
  );
}

/**
 * Répertoires depuis lesquels les artefacts de la VM sont téléchargés. Les
 * morceaux (`base-3.3-4194304-8388608.ext2.zst`) portent des noms dérivés par
 * v86 : on raisonne donc par répertoire, pas par URL exacte.
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
function deduireRacinesArtefacts(config) {
  const references = [config.kernel, config.initrd, config.disk, config.appDisk, config.state];
  const racines = references
    .filter((reference) => typeof reference === "string" && reference.length > 0)
    .map((reference) => new URL(reference, URL_SANDBOX).href)
    .map((url) => url.slice(0, url.lastIndexOf("/") + 1));
  return [...new Set(racines)];
}

/**
 * @param {string} url
 * @param {string[]} racines
 * @returns {boolean}
 */
function estArtefact(url, racines) {
  return racines.some((racine) => url.startsWith(racine));
}

/**
 * Attend que la coquille signale l'application disponible. S'arrête aussitôt
 * qu'un badge tombe en erreur : la coquille marque en erreur tout badge resté
 * en attente quand le démarrage échoue, inutile d'attendre le délai complet.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<void>}
 */
async function attendreApplication(page) {
  const verdict = await page.waitForFunction(
    () => {
      const document = /** @type {any} */ (globalThis).document;
      const classes = (id) => document.getElementById(`badge-${id}`)?.classList ?? null;
      if (classes("http")?.contains("ok")) return "prête";
      const casse = ["sw", "coi", "vm", "http"].find((id) => classes(id)?.contains("error"));
      return casse ? `échec:${casse}` : null;
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS, polling: 1_000 },
  );
  const resultat = String(await verdict.jsonValue());
  if (resultat !== "prête") {
    throw new Error(
      `Le démarrage a échoué (badge ${resultat.slice("échec:".length)}).\n${await journalDeBoot(page)}`,
    );
  }
}

/**
 * Dernières lignes du journal de boot : sans elles, un échec en ligne se résume
 * à « délai dépassé », ce qui n'aide personne.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<string>}
 */
async function journalDeBoot(page) {
  try {
    const texte = await page.locator("#boot-log").innerText();
    return texte.split("\n").slice(-30).join("\n");
  } catch {
    return "(journal de boot illisible)";
  }
}

/**
 * @param {number} depuis horodatage de départ
 * @returns {string}
 */
function secondes(depuis) {
  return ((Date.now() - depuis) / 1000).toFixed(1);
}
