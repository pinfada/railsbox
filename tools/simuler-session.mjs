// Simulation d'un BORD authentifiant devant le serveur de développement.
//
// POURQUOI. Le risque n°1 de la distribution privée est l'expiration d'une
// session pendant que v86 lit son disque : le chargeur de v86 ne sait rien
// faire d'un 4xx, la lecture gèle en silence, et le diagnostic affiché accuse
// à tort l'application du client. Prouver que ce chemin se traite proprement
// exige un bord qui refuse VRAIMENT — donc un bord simulable en local, dont
// on maîtrise l'instant du refus.
//
// CE QUE CE MODULE EST, ET N'EST PAS. C'est une maquette de bord, pas un
// mécanisme d'authentification : la « session » est un horodatage d'échéance
// écrit en clair dans un cookie, que n'importe qui peut forger. Elle ne
// protège rien et ne prétend rien protéger — elle produit un 401 à l'instant
// voulu, sous la forme exacte du contrat, et c'est tout ce qu'on lui demande.
//
// LE CONTRAT DU BORD, qui découle directement de libv86.js:10-11 :
//
//   C1. JAMAIS de 3xx sur une requête d'artefact. Une redirection suivie rend
//       un 200 porteur d'une page HTML de connexion : indiscernable d'un
//       succès pour v86, et mise en cache SOUS L'URL DU MORCEAU DE DISQUE.
//       La sandbox reste alors cassée après reconnexion.
//   C2. 401, et rien d'autre, pour « session expirée ». Pas 403 (révocation :
//       irrécupérable), pas 5xx (v86 réessaierait indéfiniment en silence).
//   C3. `X-Railsbox-Auth: expired` obligatoire : le Service Worker tranche
//       sans lire le corps.
//   C4. Corps court, `application/json`, jamais `text/html`.
//   C5. `Cache-Control: no-store` sur tout 401.
//   C6. `Vary: Cookie` sur les artefacts privés. Sans effet sur le cache
//       applicatif du worker (il interroge avec `ignoreVary`), mais requis
//       pour le cache HTTP du navigateur.
//
// Logique pure, testée sans serveur : serve.mjs ne garde que le câblage HTTP.

/** Nom du cookie de session de la simulation. */
export const COOKIE_SESSION = "railsbox_session";

/** En-tête qui fait foi côté worker (C3). */
export const EN_TETE_AUTH = "X-Railsbox-Auth";

/** Valeur de cet en-tête sur un refus récupérable (C3). */
export const AUTH_EXPIREE = "expired";

/** Endpoints de la simulation. */
export const CHEMIN_ETAT = "/auth/etat";
export const CHEMIN_RENOUVELER = "/auth/renouveler";

/** Préfixe des artefacts privés : la zone que le bord protège. */
export const PREFIXE_ARTEFACTS = "/disks/";

/** Durée de session par défaut : assez longue pour ne gêner personne. */
export const TTL_DEFAUT_MS = 600_000;

/**
 * Configuration lue dans l'environnement. `active` FAUX doit laisser
 * serve.mjs strictement identique à ce qu'il était : c'est la condition pour
 * que cette simulation n'ait aucun effet sur le chemin public gratuit.
 *
 * Deux durées distinctes, et c'est délibéré : `ttlMs` gouverne le cookie posé
 * à la PREMIÈRE visite, `ttlRenouvellementMs` celui que réémet
 * `/auth/renouveler`. Un test de bout en bout peut ainsi naître avec une
 * session déjà expirée (`ttlMs=0`) et se rétablir durablement, sans dépendre
 * d'un `sleep` — donc sans intermittence.
 * @param {Record<string, string | undefined>} env
 * @returns {{ active: boolean, ttlMs: number, ttlRenouvellementMs: number }}
 */
export function lireSimulation(env) {
  const active = env.RAILSBOX_SIMULER_AUTH === "1";
  const ttlMs = duree(env.RAILSBOX_AUTH_TTL_MS, TTL_DEFAUT_MS);
  return {
    active,
    ttlMs,
    ttlRenouvellementMs: duree(env.RAILSBOX_AUTH_TTL_RENOUVELLEMENT_MS, ttlMs),
  };
}

/**
 * @param {string | undefined} valeur
 * @param {number} defaut
 * @returns {number}
 */
function duree(valeur, defaut) {
  if (valeur === undefined || valeur === "") return defaut;
  const nombre = Number(valeur);
  return Number.isFinite(nombre) && nombre >= 0 ? nombre : defaut;
}

/**
 * Valeur d'un cookie dans un en-tête `Cookie:`, ou null.
 * @param {string | undefined} entete
 * @param {string} nom
 * @returns {string | null}
 */
export function valeurCookie(entete, nom) {
  for (const morceau of String(entete ?? "").split(";")) {
    const separateur = morceau.indexOf("=");
    if (separateur === -1) continue;
    if (morceau.slice(0, separateur).trim() !== nom) continue;
    return morceau.slice(separateur + 1).trim();
  }
  return null;
}

/**
 * La session portée par cette valeur de cookie est-elle encore valide ?
 * Un cookie absent, illisible ou échu vaut « expirée ».
 * @param {string | null} valeur
 * @param {number} maintenant horodatage en millisecondes
 * @returns {boolean}
 */
export function sessionActive(valeur, maintenant) {
  const echeance = Number(valeur);
  return valeur !== null && valeur !== "" && Number.isFinite(echeance) && echeance > maintenant;
}

/**
 * En-tête `Set-Cookie` d'une session neuve.
 *
 * HOST-ONLY, sans `Domain` : sous une topologie « un sous-domaine par
 * sandbox », un cookie de domaine parent serait envoyé à TOUTES les sandboxes
 * de tous les clients (c.3 de la note d'architecture). `HttpOnly` pour que la
 * coquille ne puisse pas le relayer par mégarde au pont série via le rapport
 * `cookies-document`. Pas de `Secure` : la simulation tourne en clair sur
 * localhost, et l'y poser ferait perdre le cookie en silence sur certains
 * moteurs — ce qui transformerait le test en énigme.
 * @param {number} maintenant
 * @param {number} ttlMs
 * @returns {string}
 */
export function cookieSession(maintenant, ttlMs) {
  return `${COOKIE_SESSION}=${maintenant + ttlMs}; Path=/; SameSite=Lax; HttpOnly`;
}

/**
 * Ce chemin désigne-t-il un artefact privé, donc une ressource que le bord
 * protège ?
 * @param {string} urlPath
 * @returns {boolean}
 */
export function estRequeteArtefact(urlPath) {
  return String(urlPath).split("?")[0].startsWith(PREFIXE_ARTEFACTS);
}

/**
 * Réponse de refus, forme unique et non négociable (C2 à C5). Elle sert aussi
 * bien sur un artefact que sur `/auth/etat` : le worker et la coquille lisent
 * exactement le même signal.
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function refusDeSession() {
  return {
    status: 401,
    headers: {
      // C3 : le worker tranche sans lire le corps.
      [EN_TETE_AUTH]: AUTH_EXPIREE,
      // C4 : jamais text/html — un corps HTML rendu à v86 serait pris pour
      // des octets de disque si un jour un 200 le portait.
      "Content-Type": "application/json; charset=utf-8",
      // C5 : un refus n'a rien à faire dans un cache, HTTP ou applicatif.
      "Cache-Control": "no-store",
      Vary: "Cookie",
    },
    body: JSON.stringify({ erreur: "session_expiree" }),
  };
}

/**
 * Réponse de `/auth/etat` quand la session est valide. La coquille n'en lit
 * que le statut : le corps est là pour le diagnostic humain.
 * @param {string | null} valeur valeur du cookie
 * @param {number} maintenant
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function etatDeSession(valeur, maintenant) {
  if (!sessionActive(valeur, maintenant)) return refusDeSession();
  return {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Cookie",
    },
    body: JSON.stringify({ etat: "active", expireDansMs: Number(valeur) - maintenant }),
  };
}

/**
 * Ce que le bord doit faire d'une requête, sous simulation active.
 *
 * Trois verdicts, et un seul point de décision pour que serve.mjs n'en
 * invente aucun :
 *  - `refus`      : artefact privé sans session — le 401 du contrat.
 *  - `poser`      : première visite (aucun cookie) — on émet la session.
 *    Une session EXPIRÉE n'est jamais réémise d'office : ce serait supprimer
 *    le phénomène qu'on cherche à observer.
 *  - `laisser`    : servir normalement, sans toucher aux en-têtes.
 * @param {{ urlPath: string, cookie: string | undefined, maintenant: number, ttlMs: number }} requete
 * @returns {{ verdict: "refus" | "poser" | "laisser", setCookie?: string }}
 */
export function decisionBord({ urlPath, cookie, maintenant, ttlMs }) {
  const valeur = valeurCookie(cookie, COOKIE_SESSION);
  if (estRequeteArtefact(urlPath)) {
    return sessionActive(valeur, maintenant) ? { verdict: "laisser" } : { verdict: "refus" };
  }
  if (valeur === null) {
    return { verdict: "poser", setCookie: cookieSession(maintenant, ttlMs) };
  }
  return { verdict: "laisser" };
}
