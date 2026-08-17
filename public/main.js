// Orchestrateur de la page hôte : Service Worker proxy, isolation
// cross-origin, boot de la VM v86, puis câblage du pont HTTP.

import { createEnvironmentRegistry } from "./shared/env-detector.js";
import { createEnvironmentDrawer } from "./env-drawer.js";
import {
  ROLE_PRINCIPAL,
  creerElection,
  nomVerrou,
  verrousDisponibles,
} from "./shared/election-onglet.js";
import {
  GARDE_CONTROLE,
  GARDE_ISOLATION,
  decisionReprise,
  diagnostiquer,
  releverCapacites,
  resumerManques,
} from "./shared/prerequis-demarrage.js";
import { creerIndicateurDemarrage } from "./shared/progression-demarrage.js";
import { createVeilleController } from "./shared/veille.js";

// Tout est relatif à la page : la coquille est publiée à la racine en
// développement, mais sous « /<depot>/ » sur le Pages de projet de chaque
// démonstration (ADR 0004). Un chemin absolu y sortirait du site.
const APP_URL = new URL("app/", document.baseURI).pathname;
const V86_CONFIG_URL = new URL("disks/v86-config.json", document.baseURI).href;
// Chemin de la coquille elle-même : il nomme le verrou d'élection, pour que
// deux démonstrations publiées sur la même origine ne se bloquent pas.
const SHELL_PATH = new URL("./", document.baseURI).pathname;
// Deuxième chance après réparation : l'application vient d'être relancée
// avec les nouvelles variables, elle doit rebooter (plusieurs minutes).
const MAX_REPAIR_RETRIES = 2;

let inspector = null;
// Élection de l'onglet actif ; null tant que Web Locks n'est pas disponible.
let election = null;
// VM et configuration courantes, retenues au niveau du module : le Service
// Worker peut être tué et redémarré à tout moment, et redemande alors l'une
// ou l'autre à la page — hors de toute pile d'appel.
let vmInstance = null;
let artifactConfig = null;
const MAX_LOG_LINES = 800;
const BADGE_IDS = ["sw", "coi", "vm", "http"];

const TITRE_SECONDAIRE = "Cette démonstration est déjà ouverte dans un autre onglet";
const DETAIL_SECONDAIRE =
  "Une seule sandbox tourne à la fois par navigateur : l'émulation x86 est lourde, et deux " +
  "VM pour un seul service rendu doubleraient la charge du processeur sans rien apporter. " +
  "L'autre onglet garde la main tant que vous ne la reprenez pas ici ; si vous la reprenez, " +
  "il libère sa VM et affiche ce même message.";
const LIBELLE_REPRISE = "Reprendre la sandbox dans cet onglet";

const logElement = document.getElementById("boot-log");
const frameElement = /** @type {HTMLIFrameElement} */ (document.getElementById("app-frame"));
const diagnosticElement = document.getElementById("diagnostic");
const etatElement = document.getElementById("etat-demarrage");

// Le journal de boot est long, gris, et défile : il informe qui le lit, pas qui
// attend. La mesure sous bridage processeur (npm run test:bridage) a chiffré
// cette attente sur la sandbox publiée : 25 s avant que l'application soit
// visible sans bridage, 39 s à 6×, 50 à 54 s à 8×. Cette ligne dit où l'on en
// est, et depuis combien de temps.
const indicateur = creerIndicateurDemarrage({
  afficher: (etat) => {
    if (!etatElement) return;
    etatElement.textContent = etat.texte;
    etatElement.classList.toggle("tres-lente", etat.lenteur === "tres-lente");
    etatElement.hidden = false;
  },
  terminer: () => {
    if (etatElement) etatElement.hidden = true;
  },
});

function logLine(text) {
  // Chaque ligne passe par le détecteur : une variable manquante citée par
  // l'application ouvre l'inspecteur au lieu de se perdre dans le journal.
  inspector?.ingest(text);
  const stamp = new Date().toLocaleTimeString();
  logElement.textContent += `[${stamp}] ${text}\n`;
  const lines = logElement.textContent.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    logElement.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  }
  logElement.scrollTop = logElement.scrollHeight;
}

function setBadge(id, ok) {
  const badge = document.getElementById(`badge-${id}`);
  badge.classList.remove("pending", "ok", "error");
  badge.classList.add(ok ? "ok" : "error");
}

/**
 * Remet les quatre badges dans un même état. `null` les laisse neutres : dans
 * un onglet secondaire, rien n'est en cours, et un badge « pending » se lirait
 * comme un chargement qui n'arrive jamais.
 * @param {"pending" | null} etat
 */
function setBadges(etat) {
  for (const id of BADGE_IDS) {
    const badge = document.getElementById(`badge-${id}`);
    badge.classList.remove("pending", "ok", "error");
    if (etat) badge.classList.add(etat);
  }
}

async function start() {
  if (!checkBrowserSupport()) return;
  await ensureSingleSandbox();

  indicateur.etape("serviceWorker");
  logLine("Enregistrement du Service Worker proxy…");
  await navigator.serviceWorker.register(new URL("sw-proxy.js", document.baseURI), {
    type: "module",
  });
  await navigator.serviceWorker.ready;
  await ensureControlled();
  setBadge("sw", true);

  // Installé AVANT le boot : la configuration des artefacts est déclarée au
  // Service Worker dès sa lecture, donc avant la première requête de v86.
  navigator.serviceWorker.addEventListener("message", onWorkerMessage);
  // La file de messages du worker vers la page est DÉSACTIVÉE tant qu'on n'a
  // pas posé `onmessage` ou appelé ceci : avec `addEventListener` seul, les
  // demandes du worker (pont, artefacts, cookies) peuvent n'être jamais
  // délivrées. Chromium se montre indulgent, la spécification ne l'est pas.
  navigator.serviceWorker.startMessages?.();

  indicateur.etape("isolation");
  await ensureCrossOriginIsolated();
  setBadge("coi", true);

  indicateur.etape("vm");
  const vm = await bootSelectedEngine();
  vmInstance = vm;
  window.__vm = vm; // hook de diagnostic (DevTools)
  setBadge("vm", true);

  // Le SW peut être tué/redémarré à tout moment par le navigateur : il perd
  // alors le port. On lui en fournit un neuf à chaque demande (onWorkerMessage),
  // et un immédiatement maintenant que la VM sait répondre.
  sendBridgePort(vm);
  await vm.startServer();

  installInspector(vm);

  indicateur.etape("application");
  logLine("Attente du serveur applicatif à l'intérieur de la VM…");
  await waitForApplication(vm);
  setBadge("http", true);

  // Dernière étape, et la seule que rien ne signalait : la VM doit encore
  // RENDRE cette page. Mesuré sous bridage : 1 s sans bridage, 3,7 à 4,4 s à
  // 4×, 7,3 à 7,6 s à 6×, 12,6 à 14,5 s à 8× — le tout sous une rangée de
  // badges déjà tous verts, donc sans qu'aucun signal ne distingue « ça
  // arrive » de « c'est bloqué ».
  // L'indicateur reste donc jusqu'au chargement effectif du cadre, et non
  // jusqu'à la simple affectation de son adresse.
  indicateur.etape("premierePage");
  frameElement.addEventListener("load", () => indicateur.fin(), { once: true });
  frameElement.src = APP_URL;
  logLine(`Application disponible → iframe sur ${APP_URL}`);

  // Une fois l'application servie — jamais pendant le boot, qu'un visiteur
  // parti sur un autre onglet a le droit de laisser finir en arrière-plan —
  // la VM se met en veille quand l'onglet est masqué : le processeur du
  // visiteur ne paie plus une émulation que personne ne regarde.
  installBackgroundPause(vm);

  if (typeof vm.metrics === "function") {
    // Débit du canal série : utile pour juger si les assets passent bien.
    setTimeout(() => {
      const { lastTransfer, serial } = vm.metrics();
      logLine(
        `Pont série : ${serial.bytes.toLocaleString("fr-FR")} octets reçus, ` +
          `dernier transfert ${lastTransfer.bytes.toLocaleString("fr-FR")} o en ` +
          `${lastTransfer.milliseconds} ms (${lastTransfer.kilobytesPerSecond} Ko/s)`,
      );
    }, 30_000);
  }

  // v86 : capture l'état mémoire post-boot pour des démarrages en secondes.
  if (typeof vm.persistSnapshot === "function") {
    logLine("Sauvegarde de l'instantané mémoire en arrière-plan…");
    vm.persistSnapshot()
      .then((message) => logLine(message))
      .catch((error) => logLine(`Instantané non sauvegardé: ${error.message}`));
  }
}

// Une seule VM active par navigateur. La promesse rendue ne se résout que
// lorsque CET onglet a la main : dans un onglet secondaire, elle attend le clic
// du visiteur sur « reprendre ici », et rien ne démarre entre-temps — ni
// Service Worker, ni téléchargement d'artefacts, ni VM.
//
// Articulation avec la veille d'arrière-plan (shared/veille.js) : un onglet
// secondaire n'a pas de VM, donc rien à suspendre, et `installBackgroundPause`
// n'y est jamais appelé puisque `start()` s'arrête ici. Une reprise ne peut
// venir que d'un clic, donc d'un onglet visible : aucun onglet masqué ne
// démarre de VM dans le dos du visiteur.
async function ensureSingleSandbox() {
  if (!verrousDisponibles(window)) {
    logLine(
      "Web Locks indisponible : impossible de garantir une seule VM par navigateur — " +
        "un autre onglet ouvert sur cette sandbox ferait tourner sa propre VM.",
    );
    return;
  }
  election = creerElection({
    verrous: navigator.locks,
    nom: nomVerrou(SHELL_PATH),
    onEviction: releaseSandboxToOtherTab,
  });
  if ((await election.candidater()) === ROLE_PRINCIPAL) return;
  logLine("Sandbox déjà active dans un autre onglet — aucune VM démarrée ici.");
  await waitForVisitorTakeover();
}

/** Panneau du rôle secondaire, et attente du geste du visiteur. */
function waitForVisitorTakeover() {
  setBadges(null);
  /** @type {Promise<void>} */
  const reprise = new Promise((resolve) => {
    showDiagnostic(TITRE_SECONDAIRE, DETAIL_SECONDAIRE, {
      ton: "info",
      action: {
        libelle: LIBELLE_REPRISE,
        async onClick(bouton) {
          bouton.disabled = true;
          if ((await election.reprendre()) !== ROLE_PRINCIPAL) {
            // Ne devrait pas arriver : la reprise ARRACHE le verrou. Si cela
            // se produit, le panneau reste affiché et le bouton redevient
            // cliquable — mais sans cette ligne, rien ne le dirait, et le
            // symptôme (« le panneau ne cède pas ») n'aurait aucune cause
            // visible dans le journal.
            logLine("[élection] reprise refusée : le verrou n'a pas été obtenu, réessayez.");
            bouton.disabled = false;
            return;
          }
          hideDiagnostic();
          setBadges("pending");
          logLine("Sandbox reprise dans cet onglet ; l'autre onglet libère la sienne.");
          resolve();
        },
      },
    });
  });
  return reprise;
}

// Un autre onglet vient d'arracher le verrou. On rend le processeur tout de
// suite, puis on recharge : c'est le seul moyen de rendre AUSSI la mémoire de
// la VM, et la coquille rechargée se présentera en secondaire, panneau compris.
// L'onglet qui reprend, lui, ne recharge pas — il tient le verrou de bout en
// bout, donc les deux onglets ne peuvent pas se le disputer.
function releaseSandboxToOtherTab() {
  logLine("Un autre onglet a repris la sandbox : cet onglet libère sa VM.");
  Promise.resolve(vmInstance?.pause?.()).catch(() => {
    // La page se recharge : il n'y a rien à rattraper.
  });
  location.reload();
}

// Suspend la VM d'un onglet masqué après un délai de grâce, la reprend au
// retour (avec recalage d'horloge, fait par resume()). La décision vit dans
// shared/veille.js, testée sans navigateur.
//
// Les deux économies se composent sans se contredire : l'élection supprime les
// VM en trop (un onglet secondaire n'en a pas, donc rien à suspendre ici), la
// veille suspend celle qui reste quand personne ne la regarde.
function installBackgroundPause(vm) {
  if (typeof vm.pause !== "function" || typeof vm.resume !== "function") return;
  const veille = createVeilleController({
    pause: () => {
      Promise.resolve(vm.pause()).catch((error) =>
        logLine(`[veille] pause impossible : ${error.message}`),
      );
      logLine("[veille] onglet masqué — VM suspendue, le processeur est rendu au visiteur");
    },
    resume: () => {
      vm.resume();
      logLine("[veille] onglet visible — VM reprise, horloge recalée");
    },
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) veille.hidden();
    else veille.visible();
  });
}

// L'inspecteur n'a de sens que si la VM sait recevoir des variables : le
// moteur ne l'expose pas, on ne l'affiche donc pas.
function installInspector(vm) {
  if (typeof vm.applyEnvironment !== "function") return;
  const registry = createEnvironmentRegistry();
  inspector = createEnvironmentDrawer({
    registry,
    onLog: (message) => logLine(message),
    onApply: (variables) => vm.applyEnvironment(variables),
  });
  document.getElementById("env-slot").append(inspector.element);
}

// Attend l'application ; si elle ne démarre pas et que des variables
// manquantes ont été détectées, laisse une chance à la réparation avant
// d'abandonner.
async function waitForApplication(vm, repairAttempt = 0) {
  try {
    await vm.waitUntilReady((attempt, error) =>
      logLine(`Sonde HTTP interne n°${attempt}${error ? ` — ${error}` : " — OK"}`),
    );
  } catch (error) {
    // Toutes les variables détectées comptent, même déjà remplies : une
    // valeur erronée saisie au tour précédent mérite une chance de correction.
    const detectedCount = inspector ? inspector.detectedCount() : 0;
    if (detectedCount === 0 || repairAttempt >= MAX_REPAIR_RETRIES) throw error;
    logLine("L'application n'a pas démarré : configuration incomplète détectée.");
    inspector.open();
    inspector.announce(
      "L'application n'a pas démarré. Renseignez les variables ci-dessous, puis relancez-la.",
      "erreur",
    );
    // Le panneau signale lui-même la fin d'une réparation réussie : aucun
    // besoin d'observer son DOM, on attend son événement explicite.
    await inspector.nextRepair();
    logLine("Nouvelle tentative après réparation de l'environnement…");
    await waitForApplication(vm, repairAttempt + 1);
  }
}

async function bootSelectedEngine() {
  const params = new URLSearchParams(location.search);
  document.getElementById("badge-vm").textContent = "VM v86";
  logLine("Boot de la VM Linux i386 (v86, open source)…");
  logLine(
    "Premier boot à froid : plusieurs minutes. Boots suivants : restaurés depuis l'instantané.",
  );
  const configResponse = await fetch(V86_CONFIG_URL);
  if (!configResponse.ok) {
    throw new Error("v86-config.json introuvable — construisez d'abord la sandbox");
  }
  const config = await configResponse.json();
  // Le Service Worker met en cache les artefacts immuables (morceaux de
  // disque, noyau, initrd) sous un nom dérivé de CETTE configuration. Il faut
  // qu'il la connaisse avant que v86 ne demande son premier morceau — et il
  // faut qu'elle vienne d'ici, pas d'une relecture du fichier : c'est la seule
  // façon que le cache corresponde exactement aux artefacts effectivement
  // bootés, y compris juste après une reconstruction.
  declareArtifacts(config);
  const { bootVm } = await import("./vm/v86-vm.js");
  return bootVm({
    onConsole: logLine,
    config,
    fresh: params.get("fresh") === "1",
  });
}

function onWorkerMessage(event) {
  if (event.data?.type === "bridge-port-request" && vmInstance) sendBridgePort(vmInstance);
  if (event.data?.type === "artifact-config-request") declareArtifacts(artifactConfig);
  if (event.data?.type === "cookies-document-request") sendDocumentCookies(event.data.id);
}

/**
 * Rapporte au Service Worker les cookies VISIBLES DU DOCUMENT.
 *
 * Un worker n'a pas de DOM : `document.cookie` lui est inaccessible, et le
 * navigateur ne lui montre pas non plus l'en-tête `Cookie` des requêtes qu'il
 * intercepte. Sans ce relais, les cookies que l'application se pose elle-même
 * en JavaScript (fuseau horaire, locale, bandeau de consentement, js-cookie)
 * n'atteignent plus jamais le serveur — l'iframe est same-origin, donc cette
 * page voit exactement les mêmes que l'application, aux cookies de chemin
 * `/app` près (vérifié dans tests/e2e/cookies-proxy.e2e.spec.mjs).
 *
 * On n'envoie que ce que le navigateur nous montre : jamais un `HttpOnly`. Le
 * bocal du worker reste autoritaire, un nom qu'il porte déjà n'est pas écrasé.
 * @param {unknown} id identifiant de la demande, à renvoyer tel quel
 */
function sendDocumentCookies(id) {
  navigator.serviceWorker.controller?.postMessage({
    type: "cookies-document",
    id,
    cookie: document.cookie,
  });
}

/** @param {Record<string, any> | null} config */
function declareArtifacts(config) {
  if (!config) return;
  artifactConfig = config;
  navigator.serviceWorker.controller?.postMessage({ type: "artifact-config", config });
}

function sendBridgePort(vm) {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => relayToVm(vm, channel.port1, event.data);
  controller.postMessage({ type: "bridge-port" }, [channel.port2]);
}

async function relayToVm(vm, port, data) {
  if (data?.type !== "http-request") return;
  const { descriptor, body } = data;
  try {
    const response = await vm.handleHttpRequest(descriptor, body);
    const transfer = response.body ? [response.body] : [];
    port.postMessage({ type: "http-response", id: descriptor.id, ...response }, transfer);
  } catch (error) {
    port.postMessage({ type: "http-response", id: descriptor.id, error: error.message });
  }
}

// Vérification préalable : sur un navigateur qui n'a pas de quoi faire tourner
// la sandbox, mieux vaut le dire tout de suite et le dire clairement qu'échouer
// plus loin sur un « navigator.serviceWorker is undefined ».
function checkBrowserSupport() {
  const { demarrable, bloquants, degradations } = diagnostiquer(releverCapacites(window));
  for (const manque of degradations) {
    logLine(`Fonctionnement dégradé — ${manque.titre} : ${manque.consequence}`);
  }
  if (demarrable) return true;
  const resume = resumerManques(bloquants);
  logLine(`Navigateur non pris en charge :\n${resume}`);
  showDiagnostic("Ce navigateur ne peut pas faire tourner la sandbox", resume);
  for (const id of BADGE_IDS) setBadge(id, false);
  return false;
}

/**
 * Affiche un diagnostic à la place de l'application. Le journal de boot est
 * long et gris : un visiteur dont le navigateur ne convient pas n'y lira rien.
 *
 * Le ton « info » sert aux situations qui ne sont pas des pannes — un onglet
 * secondaire n'a rien cassé —, et l'action facultative ajoute le bouton qui
 * lui permet d'en sortir.
 *
 * @param {string} titre
 * @param {string} detail
 * @param {{ ton?: "erreur" | "info", action?: { libelle: string, onClick: (bouton: HTMLButtonElement) => void } | null }} [options]
 */
function showDiagnostic(titre, detail, { ton = "erreur", action = null } = {}) {
  if (!diagnosticElement) return;
  diagnosticElement.replaceChildren();
  diagnosticElement.classList.toggle("info", ton === "info");
  const titreElement = document.createElement("h2");
  titreElement.textContent = titre;
  const detailElement = document.createElement("p");
  // textContent, jamais innerHTML : ce texte peut citer un message d'erreur.
  detailElement.textContent = detail;
  diagnosticElement.append(titreElement, detailElement);
  if (action) {
    const bouton = document.createElement("button");
    bouton.type = "button";
    bouton.id = "diagnostic-action";
    bouton.textContent = action.libelle;
    bouton.addEventListener("click", () => action.onClick(bouton));
    diagnosticElement.append(bouton);
  }
  diagnosticElement.hidden = false;
  frameElement.hidden = true;
}

/** Rend la place à l'application : le diagnostic n'a plus lieu d'être. */
function hideDiagnostic() {
  if (!diagnosticElement) return;
  diagnosticElement.replaceChildren();
  diagnosticElement.classList.remove("info");
  diagnosticElement.hidden = true;
  frameElement.hidden = false;
}

/**
 * Étape que la première visite ne peut satisfaire qu'après un rechargement.
 *
 * Le rechargement fait PARTIE du démarrage normal : il ne doit donc rien
 * signaler d'anormal. La promesse rendue ne se résout jamais — la page part,
 * la suite n'a plus lieu d'être — au lieu de lever, ce qui affichait
 * auparavant une « ERREUR FATALE » et passait tous les badges au rouge à
 * chaque première visite sur Firefox et WebKit.
 *
 * @param {{ satisfait: boolean, garde: string, attente: string, echec: string }} etape
 * @returns {Promise<void>}
 */
function resumeAfterReload({ satisfait, garde, attente, echec }) {
  const decision = decisionReprise({
    satisfait,
    dejaRecharge: sessionStorage.getItem(garde) !== null,
  });
  if (decision === "poursuivre") return Promise.resolve();
  if (decision === "abandonner") throw new Error(echec);
  sessionStorage.setItem(garde, "1");
  logLine(`${attente} — rechargement…`);
  location.reload();
  return new Promise(() => {}); // la page se recharge, on n'ira pas plus loin
}

// Après la toute première installation, la page n'est pas encore contrôlée
// par le SW : un unique rechargement règle ça.
function ensureControlled() {
  return resumeAfterReload({
    satisfait: navigator.serviceWorker.controller !== null,
    garde: GARDE_CONTROLE,
    attente: "Premier passage : activation du Service Worker",
    echec: "Le Service Worker ne prend pas le contrôle de la page",
  });
}

// Le SW ré-injecte COOP/COEP, mais seulement sur les navigations qu'il
// intercepte : celle qui l'a installé, elle, est déjà partie sans. Un
// rechargement de plus suffit sur un hébergeur statique. En local, serve.mjs
// pose les en-têtes et cette étape passe du premier coup.
function ensureCrossOriginIsolated() {
  return resumeAfterReload({
    satisfait: crossOriginIsolated,
    garde: GARDE_ISOLATION,
    attente: "Isolation cross-origin absente : en-têtes COOP/COEP réinjectés par le Service Worker",
    echec:
      "SharedArrayBuffer indisponible : servez la page avec les en-têtes COOP/COEP (voir serve.mjs)",
  });
}

start().catch((error) => {
  // Le diagnostic remplace l'application : l'indicateur d'attente n'a plus
  // rien à indiquer et masquerait le bas de l'explication.
  indicateur.fin();
  logLine(`ERREUR FATALE: ${error.message}`);
  showDiagnostic("Le démarrage a échoué", error.message);
  for (const id of BADGE_IDS) {
    const badge = document.getElementById(`badge-${id}`);
    if (badge.classList.contains("pending")) setBadge(id, false);
  }
});
