// Validation des requêtes HTTP traversant la frontière navigateur → VM.
// Partagé par le Service Worker (qui intercepte les requêtes de l'iframe) et
// par le codec série (qui les transmet au guest). Tout ce qui vient de
// l'application passe par ici : méthodes en liste blanche, chemins filtrés,
// en-têtes hop-by-hop retirés.

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_PATH_LENGTH = 2048;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8192;
const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;
const HOST_PATTERN = /^[a-zA-Z0-9.\-:[\]]+$/;

// En-têtes hop-by-hop, ou recalculés par curl / le constructeur Response.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "expect",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "content-length",
]);

export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function sanitizeMethod(method) {
  const upper = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(upper)) {
    throw new Error(`Méthode HTTP refusée: ${upper.slice(0, 20)}`);
  }
  return upper;
}

export function sanitizeAppPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) {
    throw new Error("Chemin invalide (doit commencer par /)");
  }
  if (rawPath.length > MAX_PATH_LENGTH) {
    throw new Error("Chemin trop long");
  }
  // Un pathname+search issu de `new URL()` est déjà percent-encodé : espaces,
  // quotes, backslashes et caractères de contrôle n'ont rien à y faire.
  // eslint-disable-next-line no-control-regex -- filtrer les caractères de contrôle est le but
  if (/[\s'"\\`$\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new Error("Caractères interdits dans le chemin");
  }
  return rawPath;
}

export function sanitizeForwardHost(host) {
  if (typeof host !== "string" || host.length === 0) return null;
  return HOST_PATTERN.test(host) ? host : null;
}

export function filterRequestHeaders(entries) {
  const kept = [];
  for (const [name, value] of entries ?? []) {
    const lowerName = String(name).toLowerCase();
    const stringValue = String(value);
    if (STRIPPED_REQUEST_HEADERS.has(lowerName)) continue;
    if (!HEADER_NAME_PATTERN.test(lowerName)) continue;
    if (stringValue.length > MAX_HEADER_VALUE_LENGTH) continue;
    // eslint-disable-next-line no-control-regex -- CRLF/NUL dans un en-tête = injection
    if (/[\r\n\u0000]/.test(stringValue)) continue;
    kept.push([lowerName, stringValue]);
    if (kept.length >= MAX_HEADER_COUNT) break;
  }
  return kept;
}

// Chemins (vus depuis la VM) des fichiers d'échange d'une requête donnée.
export function parseCurlHeaders(headText) {
  const blocks = String(headText)
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) {
    throw new Error("Réponse HTTP vide (le serveur a-t-il répondu ?)");
  }
  // Plusieurs blocs possibles (ex: 100 Continue) : seul le dernier compte.
  const lines = blocks[blocks.length - 1].split(/\r?\n/);
  const statusMatch = lines[0].match(/^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/);
  if (!statusMatch) {
    throw new Error(`Ligne de statut illisible: ${lines[0].slice(0, 80)}`);
  }
  const headers = [];
  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    headers.push([name, line.slice(separatorIndex + 1).trim()]);
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers,
  };
}
