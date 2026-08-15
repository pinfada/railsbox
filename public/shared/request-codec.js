// Codec HTTP partagé entre le Service Worker (interception des requêtes de
// l'iframe applicative) et le pont VM (exécution via curl dans la VM CheerpX).
// Tout ce qui entre dans un script shell exécuté par la VM passe par ici :
// c'est la frontière de validation (injection shell = risque n°1 de ce design).

export const BRIDGE_MOUNT = "/files"; // IDBDevice lisible depuis JS (VM -> page)
export const DATA_MOUNT = "/data";    // DataDevice écrit depuis JS (page -> VM)

// Le serveur applicatif écoute sur un socket Unix, pas sur 127.0.0.1 : la
// pile TCP de CheerpX exige Tailscale, alors que les sockets Unix sont
// purement internes au noyau émulé (vérifié : bind TCP échoue en EADDRINUSE).
export const APP_SOCKET_PATH = "/tmp/app.sock";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_PATH_LENGTH = 2048;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8192;
const CURL_TIMEOUT_SECONDS = 90;
const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;
const HOST_PATTERN = /^[a-zA-Z0-9.\-:[\]]+$/;
const SOCKET_PATH_PATTERN = /^\/[a-zA-Z0-9/._-]+$/;

// En-têtes hop-by-hop, ou recalculés par curl / le constructeur Response.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host", "connection", "content-length", "accept-encoding",
  "upgrade", "keep-alive", "transfer-encoding", "expect",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection", "transfer-encoding", "keep-alive", "content-length",
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
    if (/[\r\n\u0000]/.test(stringValue)) continue;
    kept.push([lowerName, stringValue]);
    if (kept.length >= MAX_HEADER_COUNT) break;
  }
  return kept;
}

// Chemins (vus depuis la VM) des fichiers d'échange d'une requête donnée.
export function bridgePaths(seq) {
  const safeSeq = String(seq).replace(/[^a-zA-Z0-9_-]/g, "");
  if (safeSeq.length === 0) throw new Error("Identifiant de requête invalide");
  return {
    requestBody: `${DATA_MOUNT}/req-${safeSeq}.body`,
    descriptor: `${DATA_MOUNT}/req-${safeSeq}.json`,
    command: `${DATA_MOUNT}/req-${safeSeq}.cmd`,
    head: `${BRIDGE_MOUNT}/res-${safeSeq}.head`,
    body: `${BRIDGE_MOUNT}/res-${safeSeq}.body`,
    done: `${BRIDGE_MOUNT}/res-${safeSeq}.done`,
  };
}

// Convertit un chemin vu de la VM en chemin relatif au périphérique
// (readFileAsBlob/writeFile travaillent relativement à la racine du device).
export function deviceRelative(vmPath, mount) {
  if (!vmPath.startsWith(`${mount}/`)) {
    throw new Error(`${vmPath} n'est pas sous le montage ${mount}`);
  }
  return vmPath.slice(mount.length);
}

// Construit la requête pour le client HTTP Python embarqué dans la VM
// (bridge-client.py). Le descripteur est du JSON pur : aucune donnée de
// requête ne traverse une interprétation shell — la ligne de commande du
// .cmd est entièrement statique (seq numérique validé par bridgePaths).
//
// Pourquoi pas curl ? Vérifié expérimentalement : l'envoi du corps en
// SECONDE écriture socket (comportement de curl) déclenche un deadlock dans
// la couche socket Unix de CheerpX. Le client Python envoie en-têtes + corps
// en un unique sendall(), et parle HTTP/1.0 pour exclure le chunked.
export function buildBridgeRequest({ seq, method, path, headers, hasBody, forwardHost, socketPath = APP_SOCKET_PATH }) {
  const safeMethod = sanitizeMethod(method);
  const safePath = sanitizeAppPath(path);
  if (!SOCKET_PATH_PATTERN.test(socketPath)) {
    throw new Error("Chemin de socket applicatif invalide");
  }
  const files = bridgePaths(seq);
  const finalHeaders = [];
  const safeHost = sanitizeForwardHost(forwardHost);
  if (safeHost !== null) {
    // Conserve le host d'origine pour que Rails génère des URLs correctes
    // (redirect_to, url_for) pointant vers la page hôte et non vers localhost.
    finalHeaders.push(["host", safeHost]);
  }
  finalHeaders.push(...filterRequestHeaders(headers));
  const descriptor = {
    method: safeMethod,
    path: safePath,
    headers: finalHeaders,
    socket: socketPath,
    timeoutSeconds: CURL_TIMEOUT_SECONDS,
    requestBodyFile: hasBody ? files.requestBody : null,
    headFile: files.head,
    bodyFile: files.body,
    doneFile: files.done,
  };
  return {
    descriptorJson: JSON.stringify(descriptor),
    commandScript: [
      "#!/bin/sh",
      `python3 /data/bridge-client.py ${shellSingleQuote(files.descriptor)}`,
      "",
    ].join("\n"),
  };
}

// Script neutre : signale un échec local sans exécuter curl. Utilisé quand la
// préparation d'une requête échoue côté JS — la boucle VM consomme les
// requêtes strictement dans l'ordre, il faut donc TOUJOURS produire req-N.cmd
// sous peine de bloquer toutes les requêtes suivantes.
export const LOCAL_FAILURE_CURL_CODE = 97;

export function buildFallbackScript(seq) {
  const files = bridgePaths(seq);
  return [
    "#!/bin/sh",
    `echo "${LOCAL_FAILURE_CURL_CODE} 0 0" > ${shellSingleQuote(files.done)}`,
    "",
  ].join("\n");
}

// Parse le contenu du fichier .done : "code_curl taille_head taille_body".
export function parseDoneMarker(text) {
  const parts = String(text).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`Marqueur de fin illisible: ${String(text).slice(0, 40)}`);
  }
  return { curlExit: parts[0], headSize: parts[1], bodySize: parts[2] };
}

// Parse la sortie de `curl -D` : ligne de statut + en-têtes.
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
