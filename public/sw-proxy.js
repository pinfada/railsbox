// Service Worker unique du projet, quatre rôles :
//  1. Proxy HTTP : intercepte /app/* et relaie vers la VM via un MessagePort
//     fourni par la page hôte (qui elle-même pilote la VM v86).
//  1 bis. Magasin de cookies : un Service Worker ne PEUT PAS faire poser de
//     cookie (Set-Cookie est un en-tête interdit sur une Response construite),
//     donc le proxy tient lui-même le bocal — sans quoi la session Rails, et
//     avec elle le jeton CSRF, n'existe tout simplement pas.
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
import { sanitizeCookieHeader, sanitizeMethod } from "./shared/request-codec.js";
import {
  appPrefix,
  appRequestRefusal,
  errorPage,
  isShellClient,
  parseRootStaticIndex,
  prepareProxyHeaders,
  responseBodyFor,
  rootStaticCandidate,
  ROOT_STATIC_ROOT,
  ROOT_STATIC_INDEX,
  DEFAULT_ROOT_STATIC_FILES,
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
import {
  createCookieJar,
  extractSetCookie,
  mergeBrowserCookies,
  parseDocumentCookie,
} from "./shared/cookie-jar.js";

// lib.webworker type `self` en WorkerGlobalScope générique : ce fichier est
// un Service Worker, on le déclare une fois pour bénéficier des types
// d'événements (FetchEvent, ExtendableMessageEvent) et de sw.clients.
const sw = /** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (
  /** @type {unknown} */ (self)
);

// Un disque lu par requêtes Range produit des 206 que Cache Storage refuse, et
// un instantané d'un seul tenant est un flux de plusieurs centaines de Mo :
// tous deux restent laissés au navigateur. Seuls les artefacts IMMUABLES lus
// d'un bloc — fichiers-parties de disque ET d'instantané, noyau, initrd —
// passent par le cache ci-dessous, morceau par morceau (4 Mio). L'instantané
// décompressé reste par ailleurs mis en cache par la page dans IndexedDB : le
// visiteur qui revient ne relit donc même pas ces morceaux-là.
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
// Délai au-delà duquel on cesse d'ATTENDRE la réponse de la coquille sur les
// cookies qu'elle voit : la requête part alors avec le dernier rapport connu.
// Généreux à dessein — le tout premier aller-retour a été mesuré à 1,3 s sur
// Firefox, le temps que le worker démarre. La demande, elle, n'est jamais
// annulée : une réponse tardive rafraîchit l'instantané, dont la requête
// suivante profite. C'est ce qui rend l'à-coup indolore au lieu de le
// propager.
const DOCUMENT_COOKIE_TIMEOUT_MS = 2_000;
// Au-delà de ce nombre d'attentes déçues d'affilée, on demande SANS attendre :
// une coquille durablement muette (page figée, main.js d'une version
// antérieure encore en cache) ne doit pas taxer chaque requête du délai
// ci-dessus. La première réponse qui arrive remet le compteur à zéro.
const DOCUMENT_COOKIE_MAX_ATTENTES = 3;
// Une demande restée sans réponse est oubliée au bout de ce délai : sans quoi
// une coquille muette ferait enfler la table des demandes en vol.
const DOCUMENT_COOKIE_ABANDON_MS = 30_000;
// Marqueur d'attente déçue, distinct de toute valeur de `document.cookie`.
const RETARD = Symbol("retard");
// Magasin de cookies du visiteur (voir shared/cookie-jar.js) : le navigateur
// ne peut pas le tenir pour nous, un Service Worker ne pouvant pas faire poser
// de cookie. Persisté en IndexedDB sous une clé dérivée de la portée — le SW
// est tué dès qu'il est inactif, et perdre le magasin en cours de parcours
// reviendrait à perdre la session Rails du visiteur (donc son jeton CSRF).
// La page hôte, elle, ne peut PAS nous le rendre comme elle rend le port du
// pont : elle n'a jamais vu ces cookies. Attention à ne pas surestimer ce que
// cela protège — cette base vit dans l'origine, donc un XSS de l'application
// (iframe same-origin) peut l'ouvrir. Ce que le dispositif garantit, c'est que
// `document.cookie` reste vide ; le reste tient au filtre du document coquille
// sur les messages et au refus des requêtes inter-origine (SECURITY.md).
const COOKIE_DB_NAME = "railsbox-cookies";
const COOKIE_STORE = "jars";
const COOKIE_KEY = new URL(sw.registration.scope).pathname;

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
  // Inventaire des fichiers racine extraits de l'image, lu une fois par vie du
  // worker : Promise<Set<string>>, null tant qu'aucune requête n'en a besoin.
  rootStatic: null,
  warned: new Set(), // motifs déjà journalisés, pour ne pas inonder la console
  // Restauration du bocal depuis IndexedDB : tentée une seule fois par vie du
  // Service Worker, avant la première requête relayée.
  cookiesRestored: null,
  cookieDb: null, // connexion IndexedDB du bocal, ouverte à la demande
  // Dernier `document.cookie` rapporté par la coquille, et demandes en vol
  // (identifiant -> résolution). L'instantané est ce qui sert quand la réponse
  // tarde : sans lui, un seul à-coup de la page privait de leurs cookies
  // TOUTES les requêtes qui suivaient.
  documentCookie: "",
  cookieAsks: new Map(),
  nextCookieAsk: 1,
  cookieAskFailures: 0,
};

const cookieJar = createCookieJar();

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event) =>
  event.waitUntil(Promise.all([sw.clients.claim(), dropStaleFormatCaches()])),
);

// Les messages de commande du worker — le pont vers la VM, l'identité des
// artefacts, les cookies visibles du document — ne sont acceptés QUE du
// document coquille. L'iframe de l'application est un client same-origin comme
// un autre : sans ce filtre, un XSS dans l'application posait son propre
// `bridge-port` et recevait chaque descripteur de requête, `cookie:` en clair
// (donc les cookies `HttpOnly`). Le filtre s'applique par CONSTRUCTION à tout
// message de cette liste, y compris `cookies-document`, arrivé plus tard : un
// client applicatif ne peut donc pas non plus dicter au proxy des cookies que
// le navigateur ne lui montre pas.
// La décision est pure et testée : shared/proxy-logic.js.
const MESSAGES_COQUILLE = new Set(["artifact-config", "bridge-port", "cookies-document"]);

sw.addEventListener("message", (event) => {
  if (!MESSAGES_COQUILLE.has(event.data?.type)) return;
  if (!isShellClient(sourceUrl(event), { origin: sw.location.origin, basePath: BASE_PATH })) {
    warnOnce(
      "client-refuse",
      `message « ${event.data.type} » refusé : seul le document coquille commande le proxy`,
    );
    return;
  }
  if (event.data.type === "artifact-config") {
    event.waitUntil(adoptArtifactConfig(event.data.config));
    return;
  }
  if (event.data.type === "cookies-document") {
    deliverDocumentCookies(event.data);
    return;
  }
  if (!event.ports[0]) return;
  adoptBridgePort(event.ports[0]);
});

/**
 * URL du client émetteur d'un message. `event.source` peut aussi être un
 * MessagePort ou un autre worker, qui n'en ont pas : sans URL, pas de coquille.
 * @param {ExtendableMessageEvent} event
 * @returns {string | null}
 */
function sourceUrl(event) {
  const source = /** @type {any} */ (event.source);
  return typeof source?.url === "string" ? source.url : null;
}

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
  // Zone des artefacts, décidée par la FORME de la requête et non par son
  // origine : le rootfs mutualisé peut vivre cross-origin (mainteneur tiers,
  // ADR 0004) mais aussi sur un autre chemin du MÊME hôte — le cas de la
  // démonstration de référence, dont le dépôt d'artefacts est un autre Pages
  // de github.io. Un prédicat d'origine y laissait le cache vide, défaut
  // invisible en local. Le verdict définitif reste rendu dans serveArtifact.
  if (isArtifactCandidate(event.request, url)) {
    event.respondWith(serveArtifact(event));
    return;
  }
  // Le reste du cross-origin et du dossier /disks/ (config, instantané,
  // assets extraits hors serveStaticFirst) est laissé au navigateur : ni le
  // proxy /app/* ni la ré-injection COOP/COEP n'ont rien à y faire.
  if (url.origin !== sw.location.origin || url.pathname.startsWith(RAW_ASSET_PREFIX)) {
    return;
  }
  const staticUrl = staticAssetPath(url.pathname, BASE_PATH);
  if (event.request.method === "GET" && staticUrl !== null) {
    event.respondWith(serveStaticFirst(event.request, url, staticUrl));
    return;
  }
  // /favicon.ico, /site.webmanifest, /404.html… : écrits en dur par Rails sans
  // préfixe, ils échappaient au proxy et finissaient en 404 silencieux. La
  // liste des noms servis vient de l'image elle-même (voir rootStaticIndex) :
  // une allowlist en dur ne pouvait pas connaître ceux d'une application
  // tierce. La résolution est donc asynchrone, le temps de lire l'inventaire.
  if (event.request.method === "GET" && rootStaticCandidate(url.pathname, BASE_PATH) !== null) {
    event.respondWith(serveRootStatic(event.request, url));
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
 * Inventaire des fichiers racine réellement extraits de l'image
 * (`/disks/appstatic/index.json`, écrit par tools/extract-assets.sh).
 *
 * Lu UNE fois puis mémoïsé — le Service Worker est tué dès qu'il est inactif,
 * la promesse ne survit donc pas plus longtemps que lui. Absent (sandbox
 * construite avant l'inventaire, ou serveur de développement), on retombe sur
 * la liste de repli : le comportement d'avant, ni plus ni moins.
 * @returns {Promise<Set<string>>}
 */
function rootStaticIndex() {
  if (state.rootStatic === null) {
    const url = `${BASE_PATH.replace(/\/+$/, "")}${ROOT_STATIC_ROOT}${ROOT_STATIC_INDEX}`;
    state.rootStatic = fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (data) => new Set(data === null ? DEFAULT_ROOT_STATIC_FILES : parseRootStaticIndex(data)),
      )
      .catch(() => new Set(DEFAULT_ROOT_STATIC_FILES));
  }
  return state.rootStatic;
}

/**
 * Sert un fichier racine écrit en dur par l'application (/favicon.ico,
 * /404.html, /site.webmanifest…) depuis l'extraction statique de l'image.
 *
 * Rien n'est routé vers un ailleurs : la cible reste une URL same-origin sous
 * /disks/appstatic/, dont le nom a déjà passé le contrôle de forme. Un nom
 * inconnu de l'inventaire retombe exactement là où il tombait avant — la VM
 * sous /app/*, le réseau sinon.
 * @param {Request} request
 * @param {URL} url
 */
async function serveRootStatic(request, url) {
  const bare = rootStaticCandidate(url.pathname, BASE_PATH);
  const known = bare !== null && (await rootStaticIndex()).has(bare);
  if (!known) {
    if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
      return proxyToVm(request, url);
    }
    return withIsolationHeaders(request);
  }
  const staticUrl = `${BASE_PATH.replace(/\/+$/, "")}${ROOT_STATIC_ROOT}${bare}`;
  return serveStaticFirst(request, url, staticUrl);
}

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
  // Frontière de la sandbox, AVANT tout le reste : une navigation initiée par
  // un site tiers arrive bel et bien ici (voir appRequestRefusal), et le bocal
  // y attacherait la session de l'application. Le worker est le seul étage qui
  // connaisse l'origine publique — donc le seul qui puisse trancher.
  //
  // On lui passe la FORME de la requête et pas seulement ses en-têtes : sur
  // Firefox et WebKit, une navigation interceptée n'en porte aucun qui parle
  // d'origine (mesuré), alors que `mode`, `destination` et `referrer` sont
  // renseignés sur les trois moteurs.
  const refus = appRequestRefusal(
    {
      method: request.method,
      mode: request.mode,
      destination: request.destination,
      origin: request.headers.get("origin"),
      referrer: request.referrer,
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    sw.location.origin,
  );
  if (refus !== null) return errorResponse(403, refus);
  try {
    const bridgePort = await ensureBridgePort();
    await ensureCookiesRestored();
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
      // Le bocal du proxy est la source autoritaire (shared/cookie-jar.js) —
      // mais pas la seule : l'iframe étant same-origin, un `document.cookie =`
      // de l'application crée un VRAI cookie du navigateur (fuseau horaire,
      // locale, consentement, js-cookie…). Il faut donc l'y ajouter, sans quoi
      // ces cookies-là n'atteindraient plus jamais le serveur.
      cookie: await cookieHeaderFor(url.pathname),
    };
    const reply = await sendToBridge(bridgePort, descriptor, body);
    const headers = await harvestCookies(reply.headers, url.pathname);
    return buildResponse(reply, headers);
  } catch (error) {
    return errorResponse(502, `Pont HTTP en erreur: ${error.message}`);
  }
}

/**
 * En-tête `Cookie:` complet d'une requête : le bocal du proxy, puis les vrais
 * cookies du navigateur que le bocal ne connaît pas.
 *
 * POURQUOI CE SECOND ÉTAGE. L'iframe est same-origin ; `document.cookie = …`
 * y crée un cookie du navigateur, que le worker ne voit PAS sur la requête
 * (`Cookie` est un en-tête interdit sur une Request de FetchEvent) et dont
 * aucun `Set-Cookie` ne l'a informé. Sans relecture explicite, un motif
 * courant des applications Rails non modifiées — fuseau horaire posé en JS,
 * locale, bandeau de consentement, js-cookie — cessait d'atteindre le serveur.
 * La relecture passe par le document coquille (voir documentCookies), seul
 * chemin qui existe sur les TROIS moteurs.
 *
 * Journalisé quand l'en-tête dépasse ce que la frontière accepte : sans cela,
 * le visiteur perdait TOUTE sa session en silence — soit le 422 que ce
 * dispositif existe pour supprimer.
 * @param {string} requestPath
 * @returns {Promise<string | null>}
 */
async function cookieHeaderFor(requestPath) {
  const header = mergeBrowserCookies(
    cookieJar.headerFor(requestPath),
    await documentCookies(),
    requestPath,
  );
  if (header !== null && sanitizeCookieHeader(header) === null) {
    warnOnce(
      "cookies-abandon",
      "en-tête Cookie refusé à la frontière (trop long ou illisible) — " +
        "la requête part SANS cookie, l'application peut répondre 422",
    );
  }
  return header;
}

/**
 * Cookies que le NAVIGATEUR tient et dont le bocal n'a jamais entendu parler,
 * relus par le seul client habilité à parler au worker : le document coquille.
 *
 * POURQUOI PAS LE COOKIE STORE API. C'était l'implémentation précédente, et
 * elle ne fonctionnait que sur un moteur : `cookieStore` est absent de WebKit
 * (mesuré, tests/e2e/cookies-proxy.e2e.spec.mjs) et n'est arrivé que
 * tardivement dans Firefox. La fusion n'avait donc pas lieu chez deux visiteurs
 * sur trois, et aucun test ne pouvait le voir — celui qui existait s'ignorait
 * là où le manque était. Un Service Worker n'a pas de DOM, mais ses clients en
 * ont un : on demande, ils répondent. Le motif est celui déjà en service pour
 * `bridge-port` et `artifact-config`, à ceci près que le sens de la demande est
 * inversé (c'est le worker qui interroge).
 *
 * CE QUE ÇA NE DONNE À PERSONNE. On n'interroge que les clients qui passent
 * `isShellClient` — jamais l'iframe applicative, qui pourrait sinon dicter au
 * proxy des cookies que le navigateur ne lui montre pas. Aucun secret ne
 * circule dans ce sens : la demande est vide, la réponse ne peut porter que ce
 * que le navigateur expose déjà à la page (jamais un `HttpOnly`), le bocal
 * reste autoritaire à la fusion, et `mergeBrowserCookies` rejoue sur ce qui
 * revient les validations d'`ingest` (`isTransmissibleCookie`).
 *
 * Clients CONTRÔLÉS uniquement : un client que ce worker ne contrôle pas n'a
 * pas de `controller`, donc aucun moyen de répondre — l'interroger ne
 * coûterait qu'un délai d'attente.
 * @returns {Promise<Array<{ name: string, value: string, path: string }>>}
 */
async function documentCookies() {
  await refreshDocumentCookies();
  return parseDocumentCookie(state.documentCookie);
}

/**
 * Rafraîchit l'instantané des cookies du document. Attend la réponse, mais
 * jamais au-delà du délai : passé celui-ci, la requête part avec le dernier
 * rapport connu plutôt que sans rien. La demande reste en vol, et la réponse
 * qui finit par arriver sert la requête suivante.
 * @returns {Promise<void>}
 */
async function refreshDocumentCookies() {
  const clientList = await sw.clients.matchAll({ type: "window" });
  const coquilles = clientList.filter((client) =>
    isShellClient(client.url, { origin: sw.location.origin, basePath: BASE_PATH }),
  );
  if (coquilles.length === 0) return;
  const id = state.nextCookieAsk++;
  const reponse = new Promise((resolve) => {
    state.cookieAsks.set(id, resolve);
    setTimeout(() => state.cookieAsks.delete(id), DOCUMENT_COOKIE_ABANDON_MS);
  });
  // Toutes les coquilles ouvertes sont interrogées, la première réponse gagne :
  // elles sont same-origin, donc elles voient le même magasin.
  for (const client of coquilles) client.postMessage({ type: "cookies-document-request", id });
  if (state.cookieAskFailures >= DOCUMENT_COOKIE_MAX_ATTENTES) return;
  const arrivee = await Promise.race([reponse, retarder(DOCUMENT_COOKIE_TIMEOUT_MS)]);
  if (arrivee !== RETARD) return;
  state.cookieAskFailures += 1;
  warnOnce(
    "cookies-document",
    "la page hôte tarde à rapporter ses cookies — ceux que l'application pose " +
      "en JavaScript peuvent manquer d'une requête",
  );
}

/**
 * @param {number} delai
 * @returns {Promise<symbol>}
 */
function retarder(delai) {
  return new Promise((resolve) => setTimeout(() => resolve(RETARD), delai));
}

/**
 * Rapport d'une coquille sur ses cookies. L'instantané est mis à jour même
 * quand la demande correspondante a expiré : c'est ce qui fait que le
 * dispositif se remet tout seul d'un à-coup de la page.
 * @param {{ id?: unknown, cookie?: unknown }} data
 */
function deliverDocumentCookies(data) {
  if (typeof data.cookie !== "string") return;
  state.documentCookie = data.cookie;
  const resoudre = state.cookieAsks.get(data.id);
  if (!resoudre) return;
  state.cookieAsks.delete(data.id);
  state.cookieAskFailures = 0;
  resoudre(data.cookie);
}

/**
 * Retire les `Set-Cookie` de la réponse de la VM, les range dans le bocal et
 * persiste celui-ci s'il a changé. Les rendre au document ne servirait à rien
 * — le constructeur `Response` filtre `Set-Cookie` — et les garder ici est ce
 * qui laisse `document.cookie` vide. Pas davantage : voir shared/cookie-jar.js
 * pour ce que cela protège et ce que cela ne protège pas.
 * @param {Array<[string, string]> | undefined} rawHeaders
 * @param {string} requestPath chemin de la requête, sans chaîne de recherche
 * @returns {Promise<Array<[string, string]>>} en-têtes à rendre au document
 */
async function harvestCookies(rawHeaders, requestPath) {
  const { setCookies, headers } = extractSetCookie(rawHeaders);
  if (cookieJar.ingest(setCookies, requestPath)) {
    // Écriture attendue, pas différée : une réponse rendue dont le cookie
    // n'aurait pas été persisté laisserait le visiteur sans session si le
    // navigateur tuait le worker dans la foulée. Le coût (quelques centaines
    // d'octets) est sans commune mesure avec l'aller-retour série qui précède.
    await persistCookies();
  }
  return headers;
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

/**
 * @param {{ status: number, statusText?: string, body?: ArrayBuffer | null }} reply
 * @param {Array<[string, string]>} headers en-têtes déjà débarrassés des cookies
 */
function buildResponse(reply, headers) {
  return new Response(responseBodyFor(reply.status, reply.body), {
    status: reply.status,
    statusText: reply.statusText ?? "",
    headers: prepareProxyHeaders(headers, sw.location, BASE_PATH),
  });
}

// --- Persistance du bocal à cookies (IndexedDB, un enregistrement) ---------

/**
 * Connexion IndexedDB, ouverte une seule fois et réutilisée : le bocal est
 * écrit à chaque réponse porteuse d'un cookie, et rouvrir la base à chaque
 * fois accumulerait les connexions pour rien. La promesse est oubliée en cas
 * d'échec, pour que la tentative suivante reparte proprement.
 * @returns {Promise<IDBDatabase>}
 */
function openCookieDb() {
  state.cookieDb ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(COOKIE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(COOKIE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    state.cookieDb = null;
    throw error;
  });
  return state.cookieDb;
}

/**
 * Restaure le bocal une seule fois par vie du Service Worker. Toute défaillance
 * du stockage (mode privé, quota, stockage refusé) est sans appel : on repart
 * d'un bocal vide, ce qui est exactement l'état d'un premier visiteur.
 * @returns {Promise<void>}
 */
function ensureCookiesRestored() {
  state.cookiesRestored ??= restoreCookies();
  return state.cookiesRestored;
}

async function restoreCookies() {
  try {
    const db = await openCookieDb();
    const saved = await new Promise((resolve, reject) => {
      const request = db.transaction(COOKIE_STORE).objectStore(COOKIE_STORE).get(COOKIE_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    if (Array.isArray(saved)) cookieJar.load(saved);
  } catch (error) {
    warnOnce("cookies-lecture", `bocal à cookies non restauré (${error.message}) — session neuve`);
  }
}

/** @returns {Promise<void>} */
async function persistCookies() {
  try {
    const db = await openCookieDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(COOKIE_STORE, "readwrite");
      transaction.objectStore(COOKIE_STORE).put(cookieJar.snapshot(), COOKIE_KEY);
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (error) {
    // Le bocal en mémoire reste valide : seule sa survie au redémarrage du
    // worker est perdue. La requête en cours, elle, aboutit normalement.
    warnOnce("cookies-ecriture", `bocal à cookies non persisté (${error.message})`);
  }
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
