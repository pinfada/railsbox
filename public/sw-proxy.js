// Service Worker unique du projet, deux rôles :
//  1. Proxy HTTP : intercepte /app/* et relaie vers la VM via un MessagePort
//     fourni par la page hôte (qui elle-même parle au module CheerpX).
//  2. Spoofing COI : ré-injecte les en-têtes COOP/COEP sur les réponses
//     same-origin pour les hébergeurs statiques qui ne les posent pas
//     (équivalent intégré de coi-serviceworker).
//
// Résilience : le navigateur tue et redémarre les SW à volonté, ce qui perd
// l'état en mémoire. Quand le port manque, le SW le redemande à la page hôte
// (message "bridge-port-request") au lieu d'échouer en 503.
import { sanitizeMethod } from "./shared/request-codec.js";

const APP_PREFIX = "/app";
// Artefacts de la VM (disque, noyau, instantané de ~650 Mo) : laissés au
// navigateur. Les faire transiter par le Service Worker n'apporte rien — le
// serveur pose déjà CORP — et forcerait un flux de plusieurs centaines de Mo
// à traverser le worker, au prix d'une latence et d'une pression mémoire
// inutiles (observé : téléchargement bloqué plusieurs minutes).
const RAW_ASSET_PREFIX = "/disks/";
const REQUEST_TIMEOUT_MS = 120_000;
const PORT_RECOVERY_TIMEOUT_MS = 10_000;
// Codes pour lesquels le constructeur Response interdit un corps.
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

const state = {
  bridgePort: null,
  portWaiters: [],
  pending: new Map(), // id -> { resolve, reject, timer }
  nextId: 1,
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data?.type !== "bridge-port" || !event.ports[0]) return;
  adoptBridgePort(event.ports[0]);
});

function adoptBridgePort(port) {
  state.bridgePort = port;
  port.onmessage = (event) => resolvePending(event.data);
  const waiters = state.portWaiters.splice(0);
  for (const waiter of waiters) waiter.resolve(port);
}

function ensureBridgePort() {
  if (state.bridgePort) return Promise.resolve(state.bridgePort);
  const waiting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.portWaiters = state.portWaiters.filter((w) => w.resolve !== wrapped.resolve);
      reject(new Error("La page hôte n'a pas fourni le pont VM (est-elle ouverte ?)"));
    }, PORT_RECOVERY_TIMEOUT_MS);
    const wrapped = {
      resolve: (port) => {
        clearTimeout(timer);
        resolve(port);
      },
    };
    state.portWaiters.push(wrapped);
  });
  requestPortFromClients();
  return waiting;
}

async function requestPortFromClients() {
  const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage({ type: "bridge-port-request" });
  }
}

function resolvePending(data) {
  if (data?.type !== "http-response") return;
  const entry = state.pending.get(data.id);
  if (!entry) return; // requête expirée entre-temps
  state.pending.delete(data.id);
  clearTimeout(entry.timer);
  if (data.error) {
    entry.reject(new Error(data.error));
  } else {
    entry.resolve(data);
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(RAW_ASSET_PREFIX)) return;
  if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
    event.respondWith(proxyToVm(event.request, url));
    return;
  }
  if (event.request.method === "GET") {
    event.respondWith(withIsolationHeaders(event.request));
  }
});

async function withIsolationHeaders(request) {
  const response = await fetch(request);
  if (response.status === 0 || response.type === "opaque") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyToVm(request, url) {
  try {
    const bridgePort = await ensureBridgePort();
    const method = sanitizeMethod(request.method);
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : null;
    // Le préfixe est conservé de bout en bout : l'application est montée sous
    // /app par Rack::URLMap dans la VM (voir tools/build-v86-image). Elle
    // reçoit donc SCRIPT_NAME=/app et génère des liens déjà préfixés, qui
    // repassent naturellement par ce proxy.
    const descriptor = {
      id: state.nextId++,
      method,
      path: url.pathname + url.search,
      // X-Forwarded-Proto https : les apps en `force_ssl` (jiyufit) verraient
      // sinon une requête http et boucleraient en redirection. Chrome accepte
      // les cookies Secure sur localhost, donc les sessions fonctionnent.
      headers: [...request.headers.entries(), ["x-forwarded-proto", "https"]],
      hasBody: hasBody && body !== null,
      forwardHost: url.host,
    };
    const reply = await sendToBridge(bridgePort, descriptor, body);
    return buildResponse(reply);
  } catch (error) {
    return errorResponse(502, `Pont HTTP en erreur: ${error.message}`);
  }
}

function sendToBridge(bridgePort, descriptor, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(descriptor.id);
      reject(new Error("Délai dépassé en attendant la VM"));
    }, REQUEST_TIMEOUT_MS);
    state.pending.set(descriptor.id, { resolve, reject, timer });
    const transfer = body ? [body] : [];
    bridgePort.postMessage({ type: "http-request", descriptor, body }, transfer);
  });
}

function buildResponse(reply) {
  const body = BODYLESS_STATUS.has(reply.status) ? null : reply.body ?? null;
  const headers = new Headers(reply.headers ?? []);

  // Sécurisation des redirections : la cible doit rester un chemin relatif
  // sous /app, donc réintercepté par ce proxy. Deux cas à ramener :
  //  - chemin absolu sans préfixe (« /users/sign_in ») ;
  //  - URL absolue « https://localhost:8080/… » que Rails génère à cause du
  //    X-Forwarded-Proto ; la suivre telle quelle ferait tenter au navigateur
  //    une connexion TLS vers un port qui n'écoute qu'en clair.
  const location = headers.get("location");
  if (location) {
    headers.set("location", rewriteLocation(location));
  }


  // Sous COEP:require-corp, un document imbriqué (l'iframe applicative) doit
  // lui-même porter ces en-têtes, et ses sous-ressources un CORP explicite.
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(body, {
    status: reply.status,
    statusText: reply.statusText ?? "",
    headers,
  });
}

function rewriteLocation(location) {
  let target;
  try {
    target = new URL(location, self.location.origin);
  } catch {
    return location; // en-tête inexploitable : laissé intact
  }
  const isSelf =
    target.host === self.location.host ||
    target.hostname === "localhost" ||
    target.hostname === "127.0.0.1";
  if (!isSelf) return location; // redirection externe : ne pas y toucher
  const path = target.pathname.startsWith(`${APP_PREFIX}/`) || target.pathname === APP_PREFIX
    ? target.pathname
    : `${APP_PREFIX}${target.pathname}`;
  return `${path}${target.search}${target.hash}`;
}

function errorResponse(status, message) {
  const page = `<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui;background:#101418;color:#dce3ea;padding:2rem">
<h1 style="color:#ff6b6b">${status}</h1><p>${message}</p></body>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
