// Instrumentation réseau de la recette en ligne : capture de tout le trafic
// d'un onglet, et classement des en-têtes de requête selon qu'ils déclenchent
// ou non un préflight CORS.

/**
 * @typedef {{
 *   url: string,
 *   methode: string,
 *   type: string,
 *   cadrePrincipal: boolean,
 *   viaServiceWorker: boolean,
 *   requete: import("@playwright/test").Request,
 *   statut: number | null,
 * }} Trace
 */

/**
 * En-têtes « CORS-safelisted » (spec Fetch, § CORS-safelisted request-header).
 * Leur présence ne déclenche jamais de préflight — `Range` inclus, tant qu'il
 * s'agit d'un intervalle d'octets simple.
 */
const EN_TETES_SAFELISTES = new Set([
  "accept",
  "accept-language",
  "content-language",
  "content-type",
  "range",
]);

/**
 * En-têtes que seul l'agent utilisateur pose. Le code d'une page ne PEUT pas
 * les écrire (« forbidden header names » de la spec Fetch) ou ils sont ajoutés
 * sous la couche fetch (révalidation de cache HTTP) : dans les deux cas ils ne
 * déclenchent aucun préflight, et leur présence n'est donc pas un défaut.
 */
const EN_TETES_AGENT = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "dnt",
  "host",
  "keep-alive",
  "origin",
  "priority",
  "purpose",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "upgrade-insecure-requests",
  "user-agent",
  // Révalidation de cache : posés par le cache HTTP, pas par la page.
  "if-modified-since",
  "if-none-match",
  "if-range",
]);

/** Préfixes d'en-têtes réservés à l'agent utilisateur (`Sec-`, pseudo-HTTP/2). */
const PREFIXES_AGENT = ["sec-", ":"];

/**
 * En-têtes d'une requête qui provoqueraient un préflight s'ils étaient posés
 * par du code applicatif.
 * @param {Record<string, string>} entetes
 * @returns {string[]}
 */
export function enTetesNonSafelistes(entetes) {
  return Object.keys(entetes)
    .map((nom) => nom.toLowerCase())
    .filter(
      (nom) =>
        !EN_TETES_SAFELISTES.has(nom) &&
        !EN_TETES_AGENT.has(nom) &&
        !PREFIXES_AGENT.some((prefixe) => nom.startsWith(prefixe)),
    )
    .sort();
}

/**
 * Vrai pour une vraie requête réseau. Les URL `blob:` et `data:` — v86
 * instancie ses workers ainsi — ne sortent jamais de l'onglet et n'ont donc ni
 * origine ni en-têtes à vérifier.
 * @param {string} url
 * @returns {boolean}
 */
export function estRequeteReseau(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Branche les écouteurs réseau sur une page. À appeler AVANT toute navigation :
 * les requêtes émises entre-temps seraient perdues.
 * @param {import("@playwright/test").Page} page
 * @returns {{ traces: Trace[], echecs: string[] }}
 */
export function observerReseau(page) {
  /** @type {Trace[]} */
  const traces = [];
  /** @type {string[]} */
  const echecs = [];
  const parRequete = new Map();

  page.on("request", (requete) => {
    /** @type {Trace} */
    const trace = {
      url: requete.url(),
      methode: requete.method(),
      type: requete.resourceType(),
      cadrePrincipal: estCadrePrincipal(page, requete),
      viaServiceWorker: estEmisParServiceWorker(requete),
      requete,
      statut: null,
    };
    parRequete.set(requete, trace);
    traces.push(trace);
  });

  page.on("response", (reponse) => {
    const trace = parRequete.get(reponse.request());
    if (trace) trace.statut = reponse.status();
  });

  page.on("requestfailed", (requete) => {
    echecs.push(`${requete.method()} ${requete.url()} — ${requete.failure()?.errorText ?? "?"}`);
  });

  return { traces, echecs };
}

/**
 * Requête émise par le document principal (la coquille) et non par l'iframe
 * applicative. Une requête de Service Worker n'a pas de cadre : Playwright y
 * lève, d'où la garde.
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Request} requete
 * @returns {boolean}
 */
function estCadrePrincipal(page, requete) {
  try {
    return requete.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

/**
 * @param {import("@playwright/test").Request} requete
 * @returns {boolean}
 */
function estEmisParServiceWorker(requete) {
  try {
    return requete.serviceWorker() !== null;
  } catch {
    return false;
  }
}
