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

/**
 * Interprète un en-tête Range « bytes=a-b » (bornes ouvertes acceptées).
 * Retourne null si l'en-tête est absent, illisible ou hors du fichier.
 * @param {string | undefined} rangeHeader
 * @param {number} fileSize
 * @returns {{ start: number, end: number } | null}
 */
export function parseRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const start = match[1] === "" ? Math.max(0, fileSize - Number(match[2])) : Number(match[1]);
  const end = match[1] !== "" && match[2] !== "" ? Number(match[2]) : fileSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}
