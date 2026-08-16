// Bocal à cookies du proxy : le magasin que le navigateur refuse de tenir.
//
// LE DÉFAUT QU'IL CORRIGE. Un Service Worker ne peut pas faire poser un cookie
// par le navigateur : `Set-Cookie` est un en-tête de réponse INTERDIT, filtré
// silencieusement par le constructeur `Response`, et une réponse synthétisée
// n'alimente jamais le magasin de cookies. Le cookie de session de Rails — qui
// porte la graine du jeton CSRF — n'atteignait donc jamais le client, aucun
// en-tête `Cookie:` ne repartait vers la VM, et TOUT POST se soldait par un
// 422 « ActionController::InvalidAuthenticityToken ». Mesuré sur la
// démonstration publiée : `document.cookie` vide côté hôte comme côté iframe.
//
// LE REMÈDE. Le proxy tient le magasin lui-même : les `Set-Cookie` des
// réponses de la VM sont retirés de la réponse rendue au document et rangés
// ici ; chaque requête relayée repart avec l'en-tête `Cookie:` que ce magasin
// sérialise. Le trajet complet reste à l'intérieur du Service Worker.
//
// EFFET DE BORD HEUREUX. Les cookies HttpOnly le sont VRAIMENT : ils vivent
// dans le Service Worker, hors de portée de tout script — un XSS dans
// l'application émulée ne peut pas les lire, et `document.cookie` reste vide.
//
// PÉRIMÈTRE VOLONTAIREMENT RÉDUIT (ADR 0004 : un visiteur = sa VM = ses
// cookies, aucun partage possible par construction) :
//  - `Domain` est conservé pour le diagnostic mais PAS apparié : il n'y a
//    qu'un seul hôte de part et d'autre du pont, et refuser un cookie sur un
//    domaine mal deviné par l'application casserait sa session sans rien
//    protéger ;
//  - `Secure` et `SameSite` sont conservés, pas appliqués : le « transport »
//    est un MessagePort interne à l'onglet, pas un réseau, et la seule origine
//    capable d'atteindre ce proxy est celle de la coquille elle-même ;
//  - `Path`, `Expires`, `Max-Age` et `HttpOnly`, eux, sont pleinement
//    honorés : ce sont ceux dont dépend le comportement de l'application
//    (déconnexion = `Max-Age=0`, cookies de scope, expiration de session).
//
// Logique PURE : aucune E/S, aucune horloge implicite (`now` est injecté).
// Le câblage — IndexedDB, MessagePort — reste dans sw-proxy.js.

// Garde-fous : une application qui déraille ne doit pas faire enfler le
// magasin indéfiniment ni produire un en-tête que le guest refusera.
const MAX_COOKIES = 200;
const MAX_COOKIE_VALUE_LENGTH = 4096;
// Caractères interdits dans un nom ou une valeur de cookie : CR, LF et NUL
// (injection en-tête), plus « ; » qui forgerait un second cookie. Comparaison
// par code de caractère : aucune séquence échappée dans une expression
// régulière, donc aucune ambiguïté de lecture.
const CODES_INTERDITS = new Set([0, 10, 13, 59]);

/**
 * @param {string} texte
 * @returns {boolean}
 */
function contientInterdit(texte) {
  for (let index = 0; index < texte.length; index += 1) {
    if (CODES_INTERDITS.has(texte.charCodeAt(index))) return true;
  }
  return false;
}

/**
 * Chemin par défaut d'un cookie sans attribut `Path` (RFC 6265 §5.1.4) :
 * le répertoire de la requête, jamais le fichier lui-même.
 * @param {string} requestPath chemin de la requête, sans chaîne de recherche
 * @returns {string}
 */
export function defaultPath(requestPath) {
  const path = typeof requestPath === "string" ? requestPath : "";
  if (!path.startsWith("/")) return "/";
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === 0 ? "/" : path.slice(0, lastSlash);
}

/**
 * Appariement de chemin (RFC 6265 §5.1.4) : un cookie de `/app` part avec
 * `/app` et `/app/posts`, jamais avec `/application`.
 * @param {string} cookiePath
 * @param {string} requestPath
 * @returns {boolean}
 */
export function pathMatches(cookiePath, requestPath) {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath[cookiePath.length] === "/";
}

/**
 * Date d'expiration absolue d'un cookie, en millisecondes epoch.
 * `Max-Age` prime sur `Expires` (RFC 6265 §5.2.2). `null` = cookie de session,
 * qui vit tant que le magasin vit.
 * @param {{ maxAge?: string, expires?: string }} attributs
 * @param {number} now
 * @returns {number | null}
 */
function expiryFrom({ maxAge, expires }, now) {
  if (maxAge !== undefined) {
    const seconds = Number.parseInt(maxAge, 10);
    if (!Number.isFinite(seconds)) return null;
    // Max-Age négatif ou nul : suppression immédiate — c'est ainsi que Rails
    // efface un cookie de session à la déconnexion.
    return now + seconds * 1000;
  }
  if (expires !== undefined) {
    const parsed = Date.parse(expires);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Analyse UNE valeur d'en-tête `Set-Cookie`.
 * @param {string} raw
 * @param {{ requestPath?: string, now?: number }} [contexte]
 * @returns {{
 *   name: string, value: string, path: string, domain: string | null,
 *   secure: boolean, httpOnly: boolean, sameSite: string | null,
 *   expiresAt: number | null,
 * } | null} null si la valeur est inexploitable
 */
export function parseSetCookie(raw, { requestPath = "/", now = Date.now() } = {}) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parts = raw.split(";");
  const pair = parts[0];
  const separator = pair.indexOf("=");
  if (separator <= 0) return null; // « ; HttpOnly » seul, ou nom vide
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name === "" || contientInterdit(name) || contientInterdit(value)) {
    return null;
  }
  if (name.length + value.length > MAX_COOKIE_VALUE_LENGTH) return null;

  const attributs = {};
  let path = null;
  let domain = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = null;
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    const attribute = (equals < 0 ? part : part.slice(0, equals)).trim().toLowerCase();
    const attributeValue = equals < 0 ? "" : part.slice(equals + 1).trim();
    switch (attribute) {
      case "path":
        path = attributeValue.startsWith("/") ? attributeValue : null;
        break;
      case "domain":
        domain = attributeValue === "" ? null : attributeValue.replace(/^\./, "").toLowerCase();
        break;
      case "expires":
        attributs.expires = attributeValue;
        break;
      case "max-age":
        attributs.maxAge = attributeValue;
        break;
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite":
        sameSite = attributeValue.toLowerCase() || null;
        break;
      default:
        break; // attribut inconnu : ignoré, comme le fait un navigateur
    }
  }

  return {
    name,
    value,
    path: path ?? defaultPath(requestPath),
    domain,
    secure,
    httpOnly,
    sameSite,
    expiresAt: expiryFrom(attributs, now),
  };
}

/**
 * Sépare les `Set-Cookie` du reste des en-têtes d'une réponse. Le proxy range
 * les premiers dans le magasin et ne rend QUE les seconds au document : un
 * `Set-Cookie` rendu serait de toute façon filtré par le constructeur
 * `Response`, et le retirer explicitement rend le contrat lisible.
 * @param {Array<[string, string]> | undefined | null} headers
 * @returns {{ setCookies: string[], headers: Array<[string, string]> }}
 */
export function extractSetCookie(headers) {
  const setCookies = [];
  const reste = [];
  for (const [name, value] of headers ?? []) {
    if (String(name).toLowerCase() === "set-cookie") {
      setCookies.push(String(value));
    } else {
      reste.push([name, value]);
    }
  }
  return { setCookies, headers: reste };
}

/**
 * Sérialise une liste de cookies en valeur d'en-tête `Cookie:`.
 * @param {Array<{ name: string, value: string }>} cookies
 * @returns {string}
 */
export function serializeCookies(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * Magasin de cookies d'un visiteur. Clé d'unicité : nom + chemin (le domaine
 * n'entre pas en compte, cf. en-tête de fichier).
 *
 * @param {{ now?: () => number }} [options] `now` injectable pour les tests
 */
export function createCookieJar({ now = () => Date.now() } = {}) {
  /** @type {Map<string, any>} */
  const cookies = new Map();
  // Rang de création : départage deux cookies de même longueur de chemin dans
  // l'en-tête `Cookie:` (RFC 6265 §5.4.2), y compris posés dans la même
  // milliseconde — ce qui arrive à chaque réponse de Rails.
  let sequence = 0;

  /** @param {{ name: string, path: string }} cookie */
  const keyOf = (cookie) => `${cookie.name} ${cookie.path}`;

  /** Retire les cookies expirés ; renvoie true si le magasin a changé. */
  function prune() {
    const instant = now();
    let changed = false;
    for (const [key, cookie] of cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= instant) {
        cookies.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Range un cookie déjà analysé. Un cookie expiré SUPPRIME son homonyme :
   * c'est le mécanisme d'effacement du web (`Max-Age=0`).
   * @param {any} cookie
   * @returns {boolean} true si le magasin a changé
   */
  function store(cookie) {
    const key = keyOf(cookie);
    if (cookie.expiresAt !== null && cookie.expiresAt <= now()) {
      return cookies.delete(key);
    }
    const previous = cookies.get(key);
    if (
      previous &&
      previous.value === cookie.value &&
      previous.expiresAt === cookie.expiresAt &&
      previous.httpOnly === cookie.httpOnly
    ) {
      return false; // réémission à l'identique : rien à persister
    }
    // Un cookie réécrit conserve son rang de création (RFC 6265 §5.3 étape 11).
    cookies.set(key, { ...cookie, sequence: previous ? previous.sequence : sequence++ });
    if (cookies.size > MAX_COOKIES) {
      // Éviction du plus ancien : un magasin sans borne finirait par produire
      // un en-tête que le guest refuserait, ce qui casserait TOUTES les
      // requêtes plutôt qu'une seule.
      const oldest = [...cookies.entries()].sort((a, b) => a[1].sequence - b[1].sequence)[0];
      cookies.delete(oldest[0]);
    }
    return true;
  }

  return {
    /**
     * Range les `Set-Cookie` d'une réponse de la VM.
     * @param {string[]} setCookies valeurs brutes
     * @param {string} requestPath chemin de la requête (sans recherche)
     * @returns {boolean} true si le magasin a changé (donc s'il faut persister)
     */
    ingest(setCookies, requestPath) {
      let changed = false;
      for (const raw of setCookies ?? []) {
        const cookie = parseSetCookie(raw, { requestPath, now: now() });
        if (cookie === null) continue;
        changed = store(cookie) || changed;
      }
      return changed;
    },

    /**
     * En-tête `Cookie:` à injecter dans une requête, ou null s'il n'y a rien à
     * envoyer. Ordre RFC 6265 §5.4.2 : chemin le plus spécifique d'abord, puis
     * ordre de création.
     * @param {string} requestPath chemin de la requête (sans recherche)
     * @returns {string | null}
     */
    headerFor(requestPath) {
      prune();
      const applicables = [...cookies.values()]
        .filter((cookie) => pathMatches(cookie.path, requestPath))
        .sort((a, b) => b.path.length - a.path.length || a.sequence - b.sequence);
      return applicables.length === 0 ? null : serializeCookies(applicables);
    },

    /**
     * État sérialisable (structured clone) pour la persistance, expirés purgés.
     * @returns {any[]}
     */
    snapshot() {
      prune();
      return [...cookies.values()].map((cookie) => ({ ...cookie }));
    },

    /**
     * Recharge un état persisté. Remplace le contenu courant : appelé une
     * seule fois, au réveil du Service Worker.
     * @param {any[]} saved
     */
    load(saved) {
      cookies.clear();
      sequence = 0;
      for (const cookie of saved ?? []) {
        if (!cookie || typeof cookie.name !== "string" || typeof cookie.path !== "string") continue;
        // Le rang de création est conservé s'il a été persisté : c'est lui qui
        // fixe l'ordre de l'en-tête `Cookie:`, et un magasin rechargé doit
        // produire exactement le même que le magasin d'origine.
        const rang = Number.isFinite(cookie.sequence) ? cookie.sequence : sequence;
        sequence = Math.max(sequence, rang + 1);
        cookies.set(keyOf(cookie), { ...cookie, sequence: rang });
      }
      prune();
    },

    clear() {
      cookies.clear();
    },

    get size() {
      return cookies.size;
    },
  };
}
