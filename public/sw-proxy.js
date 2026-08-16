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
//
// La logique pure (réécriture des Location, en-têtes d'isolation, pages
// d'erreur) vit dans shared/proxy-logic.js, testée unitairement.
import { sanitizeMethod } from "./shared/request-codec.js";
import {
  appPrefix,
  errorPage,
  prepareProxyHeaders,
  responseBodyFor,
  rootStaticPath,
  staticAssetPath,
} from "./shared/proxy-logic.js";

// lib.webworker type `self` en WorkerGlobalScope générique : ce fichier est
// un Service Worker, on le déclare une fois pour bénéficier des types
// d'événements (FetchEvent, ExtendableMessageEvent) et de sw.clients.
const sw = /** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (
  /** @type {unknown} */ (self)
);

// Artefacts de la VM (disque, noyau, instantané de ~650 Mo) : laissés au
// navigateur. Les faire transiter par le Service Worker n'apporte rien — le
// serveur pose déjà CORP — et forcerait un flux de plusieurs centaines de Mo
// à traverser le worker, au prix d'une latence et d'une pression mémoire
// inutiles (observé : téléchargement bloqué plusieurs minutes).
// Racine de publication de la coquille, déduite de la portée du Service
// Worker : « / » quand le site est servi à la racine, « /depot/ » sur un Pages
// de projet — le cas de chaque démonstration depuis l'ADR 0004. Tout chemin
// écrit en dur casserait dans le second cas.
const BASE_PATH = new URL(sw.registration.scope).pathname;
const APP_PREFIX = appPrefix(BASE_PATH);
const RAW_ASSET_PREFIX = `${BASE_PATH.replace(/\/+$/, "")}/disks/`;
const REQUEST_TIMEOUT_MS = 120_000;
const PORT_RECOVERY_TIMEOUT_MS = 10_000;

const state = {
  bridgePort: null,
  portWaiters: [],
  pending: new Map(), // id -> { resolve, reject, timer }
  nextId: 1,
};

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener("message", (event) => {
  if (event.data?.type !== "bridge-port" || !event.ports[0]) return;
  adoptBridgePort(event.ports[0]);
});

/** @param {MessagePort} port */
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
  const clientList = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
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

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith(RAW_ASSET_PREFIX)) return;
  // /favicon.ico, /site.webmanifest… : écrits en dur par Rails sans préfixe,
  // ils échappaient au proxy et finissaient en 404 silencieux.
  const staticUrl =
    staticAssetPath(url.pathname, BASE_PATH) ?? rootStaticPath(url.pathname, BASE_PATH);
  if (event.request.method === "GET" && staticUrl !== null) {
    event.respondWith(serveStaticFirst(event.request, url, staticUrl));
    return;
  }
  if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
    event.respondWith(proxyToVm(event.request, url));
    return;
  }
  if (event.request.method === "GET") {
    event.respondWith(withIsolationHeaders(event.request));
  }
});

/**
 * Sert un fichier depuis les extractions statiques de l'image
 * (tools/extract-assets.sh) au lieu du pont série. Repli transparent si le
 * fichier n'a pas été extrait (image plus récente, extraction non faite) :
 * vers la VM pour les chemins /app/*, vers le réseau sinon — le comportement
 * d'origine reste garanti.
 * @param {Request} request
 * @param {URL} url
 * @param {string} staticUrl
 */
async function serveStaticFirst(request, url, staticUrl) {
  try {
    const response = await fetch(staticUrl);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, { status: 200, headers });
    }
  } catch {
    // serveur statique indisponible : le repli ci-dessous décide
  }
  if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
    return proxyToVm(request, url);
  }
  return withIsolationHeaders(request);
}

/** @param {Request} request */
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

/**
 * @param {Request} request
 * @param {URL} url
 */
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
  return new Response(responseBodyFor(reply.status, reply.body), {
    status: reply.status,
    statusText: reply.statusText ?? "",
    headers: prepareProxyHeaders(reply.headers, sw.location, BASE_PATH),
  });
}

/**
 * @param {number} status
 * @param {string} message
 */
function errorResponse(status, message) {
  return new Response(errorPage(status, message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
