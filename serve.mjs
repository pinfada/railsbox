// Serveur statique de développement, sans dépendance. Deux rôles :
//  1. Poser les en-têtes COOP/COEP exigés par SharedArrayBuffer
//     (SharedArrayBuffer et l'isolation exigés par la coquille).
//  2. Supporter les requêtes Range, indispensables pour streamer une image
//     disque ext2 (HttpBytesDevice lit le disque par morceaux).
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRange, resolveSafePath } from "./tools/serve-logic.mjs";

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
  // Assets extraits de l'image (tools/extract-assets.sh) : polices, images
  // et source maps servis statiquement au lieu de traverser le pont série.
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".map", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".xml", "application/xml; charset=utf-8"],
]);

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Accept-Ranges": "bytes",
  "Cache-Control": "no-cache",
};

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

// Les assets extraits de l'image sont fingerprintés : immuables par
// construction, ils méritent un cache long — le reste reste en no-cache.
function cacheHeadersFor(urlPath) {
  return urlPath.startsWith("/disks/assets/")
    ? { "Cache-Control": "public, max-age=31536000, immutable" }
    : {};
}

function sendPrecompressed(response, logicalPath, compressed, urlPath) {
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extname(logicalPath)) ?? "application/octet-stream",
    "Content-Length": compressed.size,
    "Content-Encoding": "gzip",
    Vary: "Accept-Encoding",
    ...ISOLATION_HEADERS,
    ...cacheHeadersFor(urlPath),
  });
  createReadStream(compressed.path).pipe(response);
}

function sendFile(response, filePath, fileSize, rangeHeader, urlPath) {
  const mime = MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream";
  const range = parseRange(rangeHeader, fileSize);
  if (range) {
    response.writeHead(206, {
      "Content-Type": mime,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
      ...ISOLATION_HEADERS,
      ...cacheHeadersFor(urlPath),
    });
    createReadStream(filePath, range).pipe(response);
    return;
  }
  response.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": fileSize,
    ...ISOLATION_HEADERS,
    ...cacheHeadersFor(urlPath),
  });
  createReadStream(filePath).pipe(response);
}

async function handleRequest(request, response) {
  const urlPath = request.url ?? "/";

  // /app/* est normalement intercepté par le Service Worker. Si la requête
  // atteint ce serveur, c'est que la VM n'est pas encore prête.
  if (urlPath === "/app" || urlPath.startsWith("/app/")) {
    response.writeHead(503, { "Content-Type": "text/html; charset=utf-8", ...ISOLATION_HEADERS });
    response.end(
      "<h1>503</h1><p>La VM n'est pas prête : ouvrez d'abord la page hôte <a href=\"/\">/</a>.</p>",
    );
    return;
  }

  const filePath = resolveSafePath(urlPath, PUBLIC_DIR);
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
      sendPrecompressed(response, filePath, compressed, urlPath);
      return;
    }
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("pas un fichier");
    sendFile(response, filePath, fileInfo.size, request.headers.range, urlPath);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...ISOLATION_HEADERS });
    response.end(`Introuvable: ${urlPath}`);
  }
}

createServer(handleRequest).listen(PORT, () => {
  console.log(`railsbox servi sur http://localhost:${PORT} (COOP/COEP + Range actifs)`);
});
