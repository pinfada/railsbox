// Logique pure du Service Worker proxy (sw-proxy.js) : tout ce qui se teste
// sans environnement Service Worker vit ici — réécriture des redirections,
// en-têtes d'isolation, pages d'erreur. Le SW ne garde que le câblage
// événementiel (fetch/message/ports), intestable en dehors du navigateur.

// Frontière du proxy quand la coquille est servie À LA RACINE d'une origine.
// Ce n'est plus toujours le cas : depuis l'ADR 0004, chaque démonstration est
// publiée sur un Pages de projet, donc sous « /<depot>/ ». Les fonctions
// ci-dessous acceptent donc un chemin de base, dont « / » reste le défaut.
export const APP_PREFIX = "/app";

/**
 * Normalise un chemin de base en une forme sans barre oblique finale : « / »
 * devient «  » (chaîne vide), « /depot/ » devient « /depot ». Concaténer
 * ensuite « /app » donne la frontière du proxy dans les deux cas.
 * @param {string} basePath
 * @returns {string}
 */
export function normalizeBasePath(basePath) {
  const trimmed = String(basePath ?? "/").replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Frontière du proxy pour un chemin de base donné.
 * @param {string} [basePath]
 * @returns {string}
 */
export function appPrefix(basePath = "/") {
  return `${normalizeBasePath(basePath)}/app`;
}

// Racine des assets extraits de l'image disque (tools/extract-assets.sh).
// Servis en statique : ils ne traversent jamais le pont série.
export const STATIC_ASSETS_ROOT = "/disks/assets/";

/**
 * Traduit un chemin d'asset applicatif (/app/assets/…) vers son équivalent
 * statique extrait de l'image, ou null si le chemin n'est pas un asset
 * fingerprinté servable statiquement. C'est le levier de performance n°1 :
 * ~90 % du trafic série d'un chargement de page est constitué d'assets
 * immuables que la VM n'a aucune raison de servir elle-même.
 * @param {string} pathname
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {string | null}
 */
export function staticAssetPath(pathname, basePath = "/") {
  const base = normalizeBasePath(basePath);
  const prefix = `${base}/app/assets/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest === "" || rest.includes("..")) return null;
  return `${base}${STATIC_ASSETS_ROOT}${rest}`;
}

// Fichiers statiques que Rails référence EN DUR à la racine, sans préfixe
// (/favicon.ico, /site.webmanifest…) : ils échappaient au proxy et
// produisaient des 404 silencieux. Extraits de l'image vers /disks/appstatic/
// par tools/extract-assets.sh, ils sont servis statiquement — qu'ils soient
// demandés nus ou préfixés /app.
export const ROOT_STATIC_ROOT = "/disks/appstatic/";
const ROOT_STATIC_FILES = new Set([
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "site.webmanifest",
  "manifest.json",
  "browserconfig.xml",
  "robots.txt",
]);

/**
 * @param {string} pathname
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {string | null}
 */
export function rootStaticPath(pathname, basePath = "/") {
  const base = normalizeBasePath(basePath);
  const prefix = `${base}/app`;
  const bare = pathname.startsWith(`${prefix}/`)
    ? pathname.slice(prefix.length + 1)
    : pathname.slice(base.length).replace(/^\//, "");
  return ROOT_STATIC_FILES.has(bare) ? `${base}${ROOT_STATIC_ROOT}${bare}` : null;
}

// Codes pour lesquels le constructeur Response interdit un corps.
export const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

/**
 * Corps à passer au constructeur Response : null pour les statuts sans corps.
 * (Type volontairement lib-agnostique : ce module est aussi vérifié sous la
 * config Node, où BodyInit n'existe pas.)
 * @param {number} status
 * @param {ArrayBuffer | string | null | undefined} body
 */
export function responseBodyFor(status, body) {
  return BODYLESS_STATUS.has(status) ? null : (body ?? null);
}

/**
 * Sécurisation des redirections : la cible doit rester un chemin relatif
 * sous /app, donc réintercepté par le proxy. Deux cas à ramener :
 *  - chemin absolu sans préfixe (« /users/sign_in ») ;
 *  - URL absolue « https://localhost:8080/… » que Rails génère à cause du
 *    X-Forwarded-Proto ; la suivre telle quelle ferait tenter au navigateur
 *    une connexion TLS vers un port qui n'écoute qu'en clair.
 * Les redirections externes sont laissées intactes.
 * @param {string} location
 * @param {{ origin: string, host: string }} self - origine/hôte de la page
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {string}
 */
export function rewriteLocation(location, self, basePath = "/") {
  let target;
  try {
    target = new URL(location, self.origin);
  } catch {
    return location; // en-tête inexploitable : laissé intact
  }
  const isSelf =
    target.host === self.host || target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (!isSelf) return location; // redirection externe : ne pas y toucher
  const prefix = appPrefix(basePath);
  const path =
    target.pathname.startsWith(`${prefix}/`) || target.pathname === prefix
      ? target.pathname
      : `${prefix}${target.pathname}`;
  return `${path}${target.search}${target.hash}`;
}

// CSP des documents applicatifs proxifiés : l'iframe est same-origin (il le
// faut — cookies + interception SW), donc un XSS dans l'application aurait
// sinon accès au VRAI réseau du navigateur pour exfiltrer. connect-src 'self'
// coupe fetch/XHR/beacon vers des tiers ; form-action 'self' bloque l'envoi
// de formulaires vers l'extérieur ; script-src reste souple ('unsafe-inline' :
// importmap et les inline-scripts Rails en dépendent) ; img-src large (fonds
// de carte type OSM) — canal résiduel assumé, documenté dans SECURITY.md.
const APP_DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

/**
 * Prépare les en-têtes d'une réponse proxifiée : réécrit Location, pose les
 * en-têtes exigés par l'isolation cross-origin (sous COEP:require-corp, un
 * document imbriqué doit lui-même les porter, et ses sous-ressources un CORP
 * explicite) et applique la CSP applicative aux documents HTML qui n'en
 * apportent pas déjà une (celle de l'application prime si elle existe).
 * @param {Array<[string, string]> | undefined} rawHeaders
 * @param {{ origin: string, host: string }} self
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {Headers}
 */
export function prepareProxyHeaders(rawHeaders, self, basePath = "/") {
  const headers = new Headers(rawHeaders ?? []);
  const location = headers.get("location");
  if (location) {
    headers.set("location", rewriteLocation(location, self, basePath));
  }
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  const isHtml = (headers.get("content-type") ?? "").includes("text/html");
  if (isHtml && !headers.has("content-security-policy")) {
    headers.set("Content-Security-Policy", APP_DOCUMENT_CSP);
  }
  return headers;
}

/**
 * Le message peut contenir du contenu dérivé des réponses de la VM (donc de
 * l'application, donc potentiellement d'un tiers) : il doit être échappé
 * avant toute interpolation dans du HTML.
 * @param {unknown} text
 */
export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

/**
 * Page d'erreur autonome du proxy (statut coercé, message échappé).
 * @param {number} status
 * @param {string} message
 */
export function errorPage(status, message) {
  return `<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui;background:#101418;color:#dce3ea;padding:2rem">
<h1 style="color:#ff6b6b">${Number(status)}</h1><p>${escapeHtml(message)}</p></body>`;
}
