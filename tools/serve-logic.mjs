// Logique pure du serveur de dev (serve.mjs), extraite pour être testable :
// résolution sûre des chemins (anti-traversée) et interprétation des
// requêtes Range. serve.mjs ne garde que le câblage HTTP.
import { join, normalize, sep } from "node:path";

/**
 * Résout un chemin d'URL vers un chemin absolu SOUS publicDir, ou null si la
 * requête tente une traversée de répertoire. Un chemin se terminant par «/»
 * est résolu vers son index.html.
 * @param {string} urlPath
 * @param {string} publicDir - racine absolue des fichiers servis
 * @returns {string | null}
 */
export function resolveSafePath(urlPath, publicDir) {
  let cleaned;
  try {
    cleaned = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null; // percent-encoding invalide
  }
  const relative = cleaned.endsWith("/") ? `${cleaned}index.html` : cleaned;
  const absolute = normalize(join(publicDir, relative));
  if (absolute !== publicDir && !absolute.startsWith(publicDir + sep)) {
    return null; // tentative de traversée de répertoire
  }
  return absolute;
}

// --- Coquille NUE (serveur de dev seulement) -------------------------------
//
// Un document à L'ADRESSE DE LA COQUILLE, dans la portée du Service Worker,
// mais sans son chargeur : ni VM, ni pont, ni instantané.
//
// Plusieurs épreuves de bout en bout ont besoin d'un client qui COMMANDE le
// proxy — déclarer les artefacts, tenir le pont, libérer les lectures — sans
// démarrer une machine virtuelle dont elles n'observent rien. Elles se
// servaient d'une page inexistante quelconque, ce que `isShellClient`
// acceptait alors ; ce n'est plus vrai, et c'était le défaut.
//
// Pourquoi le SERVEUR et pas une interception Playwright : dès que le worker
// contrôle la page, c'est LUI qui va chercher `main.js`, et seul Chromium
// laisse Playwright intercepter les requêtes d'un Service Worker. Sur Firefox
// et WebKit le vrai chargeur revenait — mesuré. Une matrice de sécurité sur
// les trois moteurs exige donc que la neutralisation vienne d'ici.
//
// Le marqueur est dans la QUERY, jamais dans le chemin : `isShellClient` juge
// sur le `pathname`, et le worker réémet la requête d'origine telle quelle,
// query comprise. Le document reste donc la coquille aux yeux du proxy.
export const MARQUEUR_COQUILLE_NUE = "coquille=nue";

// LA MÊME CSP QUE public/index.html, mot pour mot. Sans elle, la coquille nue
// serait plus permissive que la vraie, et l'épreuve d'injection de script
// (tests/e2e/frontiere-coquille.e2e.spec.mjs) ne prouverait rien : c'est
// précisément parce que `script-src 'self'` autorise un `<script src="/app/…">`
// que l'attaque est possible, et que la parade doit être ailleurs.
const CSP_COQUILLE = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "img-src 'self' data:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const COQUILLE_NUE_HTML =
  '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="${CSP_COQUILLE}">` +
  "<title>coquille nue</title></head><body></body></html>";

/**
 * La requête demande-t-elle la coquille nue ?
 *
 * Restreinte aux DEUX adresses de la coquille : une page quelconque affublée
 * du marqueur n'en devient pas une, ce qui garderait la porte que la liste
 * d'admission d'`isShellClient` vient de fermer.
 * @param {string | undefined} urlPath chemin de la requête, query comprise
 * @returns {boolean}
 */
export function estCoquilleNue(urlPath) {
  const [chemin, requete = ""] = String(urlPath ?? "").split("?");
  if (chemin !== "/" && chemin !== "/index.html") return false;
  const [nom, valeur] = MARQUEUR_COQUILLE_NUE.split("=");
  return new URLSearchParams(requete).get(nom) === valeur;
}

// Décisions possibles face à un en-tête Range. Elles sont NOMMÉES parce que
// les trois se traduisent par trois réponses HTTP différentes, et que les
// confondre est exactement le défaut qu'on corrige : un `null` unique faisait
// répondre 200 « voici tout le fichier » à une plage que le client savait
// hors bornes.
export const RANGE_IGNORE = "ignorer";
export const RANGE_PLAGE = "plage";
export const RANGE_HORS_FICHIER = "hors-fichier";

/**
 * Interprète un en-tête Range « bytes=a-b » (bornes ouvertes et suffixe
 * « bytes=-N » acceptés), et dit ce que le serveur doit en faire.
 *
 * La RFC 9110 sépare deux échecs que le code confondait :
 *  - §14.2 — unité inconnue (« octets=0-10 ») ou spec invalide (fin avant
 *    début) : l'en-tête est IGNORÉ, la réponse est un 200 complet ;
 *  - §14.4 — spec valide dont le premier octet est au-delà de la fin du
 *    fichier : la requête est INSATISFIABLE, la réponse est un 416 portant
 *    « Content-Range: bytes * /taille ».
 * Renvoyer 200 dans le second cas ment au client : il a demandé un fragment
 * qui n'existe pas et reçoit un fichier entier qu'il croira être ce fragment.
 * @param {string | undefined} rangeHeader
 * @param {number} fileSize
 * @returns {{ type: "ignorer" } | { type: "hors-fichier" }
 *   | { type: "plage", start: number, end: number }}
 */
export function parseRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (!match) return { type: RANGE_IGNORE };
  const [, premier, dernier] = match;
  if (premier === "" && dernier === "") return { type: RANGE_IGNORE };

  // Suffixe « bytes=-N » : les N derniers octets. « bytes=-0 » ne désigne
  // aucun octet — la spec est valide, elle est simplement insatisfiable.
  if (premier === "") {
    const longueur = Number(dernier);
    if (longueur === 0 || fileSize === 0) return { type: RANGE_HORS_FICHIER };
    return { type: RANGE_PLAGE, start: Math.max(0, fileSize - longueur), end: fileSize - 1 };
  }

  const start = Number(premier);
  const end = dernier === "" ? fileSize - 1 : Number(dernier);
  if (dernier !== "" && end < start) return { type: RANGE_IGNORE };
  if (start >= fileSize) return { type: RANGE_HORS_FICHIER };
  return { type: RANGE_PLAGE, start, end: Math.min(end, fileSize - 1) };
}
