// Serveur statique de développement, sans dépendance. Deux rôles :
//  1. Poser les en-têtes COOP/COEP exigés par SharedArrayBuffer
//     (CheerpX ne démarre pas sans isolation cross-origin).
//  2. Supporter les requêtes Range, indispensables pour streamer une image
//     disque ext2 (HttpBytesDevice lit le disque par morceaux).
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = resolve(fileURLToPath(new URL("./public/", import.meta.url)));

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".ext2", "application/octet-stream"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Accept-Ranges": "bytes",
  "Cache-Control": "no-cache",
};

function resolveSafePath(urlPath) {
  const cleaned = decodeURIComponent(urlPath.split("?")[0]);
  const relative = cleaned.endsWith("/") ? `${cleaned}index.html` : cleaned;
  const absolute = normalize(join(PUBLIC_DIR, relative));
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + sep)) {
    return null; // tentative de traversée de répertoire
  }
  return absolute;
}

function parseRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const start = match[1] === "" ? Math.max(0, fileSize - Number(match[2])) : Number(match[1]);
  const end = match[1] !== "" && match[2] !== "" ? Number(match[2]) : fileSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

// Sert un fichier pré-compressé (X.gz) à la place de X quand il existe : le
// navigateur décompresse de façon transparente. Décisif pour l'instantané
// mémoire pré-calculé (~640 Mo bruts, largement compressibles).
async function resolvePrecompressed(filePath, acceptEncoding) {
  if (!/\bgzip\b/.test(acceptEncoding ?? "")) return null;
  try {
    const info = await stat(`${filePath}.gz`);
    return info.isFile() ? { path: `${filePath}.gz`, size: info.size } : null;
  } catch {
    return null;
  }
}

function sendPrecompressed(response, logicalPath, compressed) {
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extname(logicalPath)) ?? "application/octet-stream",
    "Content-Length": compressed.size,
    "Content-Encoding": "gzip",
    Vary: "Accept-Encoding",
    ...ISOLATION_HEADERS,
  });
  createReadStream(compressed.path).pipe(response);
}

function sendFile(response, filePath, fileSize, rangeHeader) {
  const mime = MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream";
  const range = parseRange(rangeHeader, fileSize);
  if (range) {
    response.writeHead(206, {
      "Content-Type": mime,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
      ...ISOLATION_HEADERS,
    });
    createReadStream(filePath, range).pipe(response);
    return;
  }
  response.writeHead(200, { "Content-Type": mime, "Content-Length": fileSize, ...ISOLATION_HEADERS });
  createReadStream(filePath).pipe(response);
}

async function handleRequest(request, response) {
  const urlPath = request.url ?? "/";

  // /app/* est normalement intercepté par le Service Worker. Si la requête
  // atteint ce serveur, c'est que la VM n'est pas encore prête.
  if (urlPath === "/app" || urlPath.startsWith("/app/")) {
    response.writeHead(503, { "Content-Type": "text/html; charset=utf-8", ...ISOLATION_HEADERS });
    response.end("<h1>503</h1><p>La VM n'est pas prête : ouvrez d'abord la page hôte <a href=\"/\">/</a>.</p>");
    return;
  }

  const filePath = resolveSafePath(urlPath);
  if (filePath === null) {
    response.writeHead(400, ISOLATION_HEADERS);
    response.end("Chemin invalide");
    return;
  }

  try {
    // Content-Encoding et Range ne se combinent pas ici : un fichier
    // pré-compressé est servi d'un bloc (cas d'usage : instantané mémoire).
    const compressed = request.headers.range
      ? null
      : await resolvePrecompressed(filePath, request.headers["accept-encoding"]);
    if (compressed) {
      sendPrecompressed(response, filePath, compressed);
      return;
    }
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("pas un fichier");
    sendFile(response, filePath, fileInfo.size, request.headers.range);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...ISOLATION_HEADERS });
    response.end(`Introuvable: ${urlPath}`);
  }
}

createServer(handleRequest).listen(PORT, () => {
  console.log(`Rails-in-Browser servi sur http://localhost:${PORT} (COOP/COEP + Range actifs)`);
});
