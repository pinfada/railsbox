// Service Worker unique du projet, trois rôles :
//  1. Proxy HTTP : intercepte /app/* et relaie vers la VM via un MessagePort
//     fourni par la page hôte (qui elle-même pilote la VM v86).
//  2. Spoofing COI : ré-injecte les en-têtes COOP/COEP sur les réponses
//     same-origin pour les hébergeurs statiques qui ne les posent pas
//     (équivalent intégré de coi-serviceworker).
//  3. Cache des artefacts immuables (morceaux de disque, noyau, initrd) en
//     Cache Storage, « cache d'abord » — GitHub Pages plafonnant à
//     max-age=600, sans lui un visiteur qui revient retélécharge tout.
//
// Résilience : le navigateur tue et redémarre les SW à volonté, ce qui perd
// l'état en mémoire. Quand le port manque, le SW le redemande à la page hôte
// (message "bridge-port-request") au lieu d'échouer en 503 ; quand l'identité
// des artefacts manque, il la redemande de même ("artifact-config-request")
// en servant les requêtes du réseau entre-temps.
//
// La logique pure (réécriture des Location, en-têtes d'isolation, pages
// d'erreur) vit dans shared/proxy-logic.js ; celle du cache d'artefacts dans
// shared/artifact-cache.js. Les deux sont testées unitairement.
import { sanitizeMethod } from "./shared/request-codec.js";
import {
  appPrefix,
  errorPage,
  prepareProxyHeaders,
  responseBodyFor,
  rootStaticPath,
  staticAssetPath,
} from "./shared/proxy-logic.js";
import {
  cacheNameFor,
  immutableArtifacts,
  isCacheableArtifactUrl,
  isCacheableRequestShape,
  looksLikeImmutableArtifact,
  obsoleteCacheNames,
  staleFormatCacheNames,
} from "./shared/artifact-cache.js";

// lib.webworker type `self` en WorkerGlobalScope générique : ce fichier est
// un Service Worker, on le déclare une fois pour bénéficier des types
// d'événements (FetchEvent, ExtendableMessageEvent) et de sw.clients.
const sw = /** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (
  /** @type {unknown} */ (self)
);

// Le GROS des artefacts de la VM reste laissé au navigateur : l'instantané
// mémoire (~650 Mo) est déjà mis en cache par la page dans IndexedDB, et un
// disque lu par requêtes Range produit des 206 que Cache Storage refuse.
// Seuls les artefacts IMMUABLES lus d'un bloc — fichiers-parties, noyau,
// initrd — passent par le cache ci-dessous, morceau par morceau (4 Mio) :
// aucun flux de plusieurs centaines de Mo ne traverse le worker.
// Racine de publication de la coquille, déduite de la portée du Service
// Worker : « / » quand le site est servi à la racine, « /depot/ » sur un Pages
// de projet — le cas de chaque démonstration depuis l'ADR 0004. Tout chemin
// écrit en dur casserait dans le second cas.
const BASE_PATH = new URL(sw.registration.scope).pathname;
const APP_PREFIX = appPrefix(BASE_PATH);
const RAW_ASSET_PREFIX = `${BASE_PATH.replace(/\/+$/, "")}/disks/`;
const REQUEST_TIMEOUT_MS = 120_000;
const PORT_RECOVERY_TIMEOUT_MS = 10_000;
// Fraction du quota de stockage au-delà de laquelle on cesse d'écrire dans le
// cache : le navigateur évincerait l'origine entière (dont l'instantané en
// IndexedDB, bien plus coûteux à reconstituer qu'un morceau de 4 Mio).
const QUOTA_HEADROOM = 0.9;
// L'estimation de stockage coûte un aller-retour : elle est mémoïsée le temps
// d'écrire quelques morceaux, jamais plus.
const STORAGE_ESTIMATE_TTL_MS = 5_000;
// Intervalle minimal entre deux demandes de configuration à la page hôte.
const CONFIG_REQUEST_INTERVAL_MS = 2_000;

const state = {
  bridgePort: null,
  portWaiters: [],
  pending: new Map(), // id -> { resolve, reject, timer }
  nextId: 1,
  // Cache d'artefacts en service : { name, cache, artifacts }, null tant que
  // la page hôte n'a pas déclaré la configuration qu'elle boote.
  artifacts: null,
  lastConfigRequest: 0,
  storageEstimate: null, // { at, estimate }
  warned: new Set(), // motifs déjà journalisés, pour ne pas inonder la console
};

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event) =>
  event.waitUntil(Promise.all([sw.clients.claim(), dropStaleFormatCaches()])),
);

sw.addEventListener("message", (event) => {
  if (event.data?.type === "artifact-config") {
    event.waitUntil(adoptArtifactConfig(event.data.config));
    return;
  }
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

// --- Cache des artefacts immuables (Cache Storage, « cache d'abord ») ------
//
// AUCUN EN-TÊTE N'EST AJOUTÉ NULLE PART sur ce chemin : les requêtes vers le
// dépôt d'artefacts doivent rester des requêtes « simples » au sens CORS,
// sous peine de déclencher un préflight que GitHub Pages ne sait pas honorer
// (point de vigilance de l'ADR 0001). La requête d'origine est réémise telle
// quelle, la réponse renvoyée telle quelle.

/**
 * Réponse au cas où le SW vient de redémarrer : la page hôte détient
 * l'identité des artefacts qu'elle boote, on la lui redemande. Les requêtes
 * en vol partent au réseau pendant ce temps — dégradation, jamais échec.
 *
 * Étranglée dans le temps : v86 demande ses morceaux par rafales, et une page
 * qui n'a rien à déclarer (aucune configuration lue) recevrait sinon un
 * message par morceau.
 */
async function requestArtifactConfigFromClients() {
  const now = Date.now();
  if (now - state.lastConfigRequest < CONFIG_REQUEST_INTERVAL_MS) return;
  state.lastConfigRequest = now;
  const clientList = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage({ type: "artifact-config-request" });
  }
}

/**
 * Prend en charge la configuration déclarée par la page hôte : ouvre le cache
 * qui porte l'identité de cette construction et abandonne tous les autres.
 * @param {Record<string, any> | null | undefined} config
 */
async function adoptArtifactConfig(config) {
  try {
    const name = cacheNameFor(config);
    if (name === null) {
      state.artifacts = null;
      return;
    }
    if (state.artifacts?.name === name) return;
    const cache = await caches.open(name);
    state.artifacts = { name, cache, artifacts: immutableArtifacts(config, sw.registration.scope) };
    const names = await caches.keys();
    await Promise.all(obsoleteCacheNames(names, name).map((stale) => caches.delete(stale)));
  } catch (error) {
    // Cache Storage indisponible (mode privé, stockage refusé) : on continue
    // sans cache, tout le reste du Service Worker fonctionne à l'identique.
    state.artifacts = null;
    warnOnce("ouverture", `cache d'artefacts indisponible (${error.message}) — réseau seul`);
  }
}

/** Supprime les caches écrits par une version antérieure du format. */
async function dropStaleFormatCaches() {
  try {
    const names = await caches.keys();
    await Promise.all(staleFormatCacheNames(names).map((stale) => caches.delete(stale)));
  } catch (error) {
    warnOnce("purge", `purge des caches obsolètes impossible (${error.message})`);
  }
}

/**
 * Décision SYNCHRONE, seule possible dans un gestionnaire fetch : cette
 * requête mérite-t-elle qu'on lui réponde nous-mêmes ? Le verdict définitif
 * (l'URL est-elle un artefact DE CETTE construction ?) est rendu plus tard,
 * dans serveArtifact, où il peut consulter la configuration.
 * @param {Request} request
 * @param {URL} url
 * @returns {boolean}
 */
function isArtifactCandidate(request, url) {
  return (
    isCacheableRequestShape({
      method: request.method,
      rangeHeader: request.headers.get("range"),
    }) && looksLikeImmutableArtifact(url.href)
  );
}

/**
 * Stratégie « cache d'abord » : le morceau déjà téléchargé est resservi sans
 * réseau ; sinon la requête part telle quelle et la réponse est rangée en
 * arrière-plan. Toute défaillance du cache est silencieuse pour l'appelant
 * (mais journalisée) : la requête aboutit dans tous les cas.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function serveArtifact(event) {
  const request = event.request;
  const bucket = artifactBucketFor(request.url);
  if (bucket) {
    // ignoreVary : GitHub Pages peut varier sur Accept-Encoding, ce qui ferait
    // manquer une entrée pourtant valide — le contenu, lui, est immuable.
    const hit = await bucket.cache.match(request.url, { ignoreVary: true }).catch(() => null);
    if (hit) return hit;
  }
  const response = await fetch(request);
  // 200 seulement : un 206 est refusé par Cache Storage, un opaque serait
  // illisible, et une erreur n'a rien à faire dans un cache d'immuables.
  if (bucket && response.status === 200 && response.type !== "opaque") {
    event.waitUntil(storeArtifact(bucket.cache, request.url, response.clone()));
  }
  return response;
}

/**
 * Cache en service si l'URL est bien un artefact de la construction courante,
 * null sinon. Quand l'identité manque (SW redémarré), elle est redemandée à
 * la page hôte et la requête part au réseau sans être mise en cache.
 * @param {string} url
 * @returns {{ name: string, cache: Cache, artifacts: any } | null}
 */
function artifactBucketFor(url) {
  if (!state.artifacts) {
    requestArtifactConfigFromClients();
    return null;
  }
  return isCacheableArtifactUrl(url, state.artifacts.artifacts) ? state.artifacts : null;
}

/**
 * Range un morceau, ou renonce proprement.
 *
 * Le clone qu'on reçoit partage sa source avec la réponse déjà rendue au
 * demandeur : un corps cloné qu'on abandonnerait sans le lire ferait gonfler
 * indéfiniment le tampon de dérivation. Tout chemin qui n'écrit pas ANNULE
 * donc explicitement le corps.
 * @param {Cache} cache
 * @param {string} url
 * @param {Response} response clone, dont le corps n'a pas encore été lu
 */
async function storeArtifact(cache, url, response) {
  try {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (!(await hasStorageRoom(Number.isFinite(declared) ? declared : 0))) {
      warnOnce("quota", "quota de stockage presque atteint — artefacts non mis en cache");
      await discardBody(response);
      return;
    }
    await cache.put(url, response);
  } catch (error) {
    // Quota dépassé, stockage évincé, écriture concurrente : sans effet sur
    // la réponse déjà rendue au demandeur, le morceau sera simplement
    // retéléchargé la prochaine fois.
    warnOnce(
      "ecriture",
      `mise en cache impossible (${error.message}) — retéléchargement plus tard`,
    );
    await discardBody(response);
  }
}

/**
 * Libère le corps d'un clone qu'on ne rangera pas.
 * @param {Response} response
 */
async function discardBody(response) {
  try {
    if (response.body && !response.bodyUsed) await response.body.cancel();
  } catch {
    // Corps déjà consommé ou verrouillé : plus rien à libérer.
  }
}

/**
 * Reste-t-il de la place pour `bytes` octets sans frôler le quota d'origine ?
 * Optimiste quand l'estimation n'est pas disponible : mieux vaut un `put` qui
 * échoue proprement qu'un cache jamais alimenté.
 * @param {number} bytes
 * @returns {Promise<boolean>}
 */
async function hasStorageRoom(bytes) {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return true;
  const now = Date.now();
  if (!state.storageEstimate || now - state.storageEstimate.at > STORAGE_ESTIMATE_TTL_MS) {
    const estimate = await navigator.storage.estimate().catch(() => null);
    state.storageEstimate = { at: now, estimate };
  }
  const estimate = state.storageEstimate.estimate;
  if (!estimate?.quota) return true;
  return (estimate.usage ?? 0) + bytes <= estimate.quota * QUOTA_HEADROOM;
}

/**
 * Journalise une fois par motif : un cache saturé produirait sinon une ligne
 * par morceau, ce qui noierait la console au moment où elle sert le plus.
 * @param {string} reason
 * @param {string} message
 */
function warnOnce(reason, message) {
  if (state.warned.has(reason)) return;
  state.warned.add(reason);
  console.warn(`[sw] ${message}`);
}

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Zone des artefacts : tout le cross-origin (le rootfs mutualisé vit sur le
  // Pages du dépôt d'artefacts, ADR 0004) et le dossier /disks/ same-origin.
  // Elle est traitée en premier et sort du gestionnaire : ni le proxy /app/*
  // ni la ré-injection COOP/COEP n'ont rien à y faire.
  if (url.origin !== sw.location.origin || url.pathname.startsWith(RAW_ASSET_PREFIX)) {
    if (isArtifactCandidate(event.request, url)) {
      event.respondWith(serveArtifact(event));
    }
    return;
  }
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
    // Le préfixe /app est conservé de bout en bout : l'application est montée
    // sous /app par Rack::URLMap dans la VM (voir tools/build-v86-image). Elle
    // reçoit donc SCRIPT_NAME=/app et génère des liens déjà préfixés, qui
    // repassent naturellement par ce proxy.
    //
    // La racine de publication est transmise TELLE QUELLE, délibérément. On
    // avait d'abord essayé de la retirer, pour que le guest ignore tout du
    // sous-répertoire de déploiement : Rack répondait bien, mais Rails générait
    // alors ses liens et ses URL d'assets en « /app/… », donc à la racine du
    // domaine — hors du dépôt, et hors de la portée de ce Service Worker, qui
    // ne pouvait même pas les rattraper. L'application doit être montée sur le
    // chemin PUBLIC complet (RAILS_RELATIVE_URL_ROOT, posé à la construction) :
    // c'est la seule façon qu'elle produise des URL qui fonctionnent.
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
