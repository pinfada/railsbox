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
import {
  CHEMIN_ETAT,
  CHEMIN_RENOUVELER,
  COOKIE_SESSION,
  cookieSession,
  decisionBord,
  etatDeSession,
  lireSimulation,
  refusDeSession,
  valeurCookie,
} from "./tools/simuler-session.mjs";

const PORT = Number(process.env.PORT ?? 8080);
// Bord authentifiant simulé (RAILSBOX_SIMULER_AUTH=1). ÉTEINT PAR DÉFAUT, et
// c'est la seule chose à retenir : hors de ce mode, pas une réponse de ce
// serveur ne change. Voir tools/simuler-session.mjs pour le contrat simulé.
const SIMULATION = lireSimulation(process.env);
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

/**
 * Écrit une réponse courte du bord simulé (refus, état, renouvellement). Les
 * en-têtes d'isolation restent posés : le bord de production les pose sur
 * TOUTES ses réponses, celle-ci comprise.
 * @param {import("node:http").ServerResponse} response
 * @param {{ status: number, headers: Record<string, string>, body: string }} reponse
 */
function envoyerReponseBord(response, reponse) {
  response.writeHead(reponse.status, {
    ...ISOLATION_HEADERS,
    ...reponse.headers,
    "Content-Length": Buffer.byteLength(reponse.body),
  });
  response.end(reponse.body);
}

/**
 * Bord authentifiant simulé. Rend `true` quand il a répondu lui-même, auquel
 * cas le serveur statique n'a plus rien à faire.
 *
 * AUCUN 3XX N'EST JAMAIS ÉMIS ICI (contrat C1) : une redirection sur une
 * requête d'artefact est indiscernable d'un succès pour v86, et empoisonne le
 * cache du Service Worker avec la page de connexion sous l'URL d'un morceau de
 * disque. C'est le défaut que toute cette simulation existe pour ne pas
 * reproduire.
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} urlPath
 * @returns {boolean} la requête est-elle déjà traitée ?
 */
function appliquerBordSimule(request, response, urlPath) {
  const maintenant = Date.now();
  const cookie = request.headers.cookie;
  const chemin = urlPath.split("?")[0];

  // Renouvellement : réémet le cookie, sans condition sur l'état précédent —
  // c'est le geste du visiteur qui vient de se reconnecter.
  if (chemin === CHEMIN_RENOUVELER) {
    if (request.method !== "POST") {
      envoyerReponseBord(response, {
        status: 405,
        headers: { "Content-Type": "application/json; charset=utf-8", Allow: "POST" },
        body: JSON.stringify({ erreur: "methode_non_autorisee" }),
      });
      return true;
    }
    response.setHeader("Set-Cookie", cookieSession(maintenant, SIMULATION.ttlRenouvellementMs));
    envoyerReponseBord(response, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ etat: "renouvelee" }),
    });
    return true;
  }

  // Sonde d'état : 200 ou 401, jamais autre chose. C'est ce que la coquille
  // interroge pendant qu'elle tient la VM en pause.
  if (chemin === CHEMIN_ETAT) {
    envoyerReponseBord(response, etatDeSession(valeurCookie(cookie, COOKIE_SESSION), maintenant));
    return true;
  }

  const decision = decisionBord({ urlPath, cookie, maintenant, ttlMs: SIMULATION.ttlMs });
  if (decision.verdict === "refus") {
    envoyerReponseBord(response, refusDeSession());
    return true;
  }
  if (decision.verdict === "poser") {
    response.setHeader("Set-Cookie", decision.setCookie);
  }
  // C6 : les artefacts privés varient selon la session. Sans effet sur le
  // cache applicatif du worker (il interroge avec `ignoreVary`), requis pour
  // que le cache HTTP du navigateur ne resserve pas un morceau à une autre
  // session.
  if (urlPath.startsWith("/disks/")) response.setHeader("Vary", "Cookie");
  return false;
}

async function handleRequest(request, response) {
  const urlPath = request.url ?? "/";

  if (SIMULATION.active && appliquerBordSimule(request, response, urlPath)) return;

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
  if (SIMULATION.active) {
    console.log(
      `bord authentifiant SIMULÉ : session de ${SIMULATION.ttlMs} ms ` +
        `(renouvellement ${SIMULATION.ttlRenouvellementMs} ms), /disks/* refusé en 401 ` +
        `passé ce délai — voir tools/simuler-session.mjs`,
    );
  }
});
