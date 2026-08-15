// Orchestrateur de la page hôte : Service Worker proxy, isolation
// cross-origin, boot de la VM (CheerpX ou v86), puis câblage du pont HTTP.
// Choix du moteur : ?engine=v86 (image jiyufit) ou défaut cheerpx (démo).

import { createEnvironmentRegistry } from "./shared/env-detector.js";
import { createEnvironmentDrawer } from "./env-drawer.js";

const APP_URL = "/app/";
const V86_CONFIG_URL = "/disks/v86-config.json";
// Deuxième chance après réparation : l'application vient d'être relancée
// avec les nouvelles variables, elle doit rebooter (plusieurs minutes).
const MAX_REPAIR_RETRIES = 2;

let inspector = null;
const MAX_LOG_LINES = 800;
const RELOAD_GUARD_KEY = "rib-reloaded";

const logElement = document.getElementById("boot-log");
const frameElement = /** @type {HTMLIFrameElement} */ (document.getElementById("app-frame"));

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

async function start() {
  logLine("Enregistrement du Service Worker proxy…");
  await navigator.serviceWorker.register("/sw-proxy.js", { type: "module" });
  await navigator.serviceWorker.ready;
  await ensureControlled();
  setBadge("sw", true);

  ensureCrossOriginIsolated();
  setBadge("coi", true);

  const vm = await bootSelectedEngine();
  window.__vm = vm; // hook de diagnostic (DevTools)
  setBadge("vm", true);

  // Le SW peut être tué/redémarré à tout moment par le navigateur : il perd
  // alors le port. On lui en fournit un neuf à chaque demande, et un
  // immédiatement maintenant que la VM sait répondre.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "bridge-port-request") sendBridgePort(vm);
  });
  sendBridgePort(vm);
  await vm.startServer();

  installInspector(vm);

  logLine("Attente du serveur applicatif à l'intérieur de la VM…");
  await waitForApplication(vm);
  setBadge("http", true);

  frameElement.src = APP_URL;
  logLine(`Application disponible → iframe sur ${APP_URL}`);

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

// L'inspecteur n'a de sens que si la VM sait recevoir des variables : le
// moteur CheerpX n'expose pas cette capacité, on ne l'affiche donc pas.
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
  const engine = params.get("engine") ?? "cheerpx";
  const badge = document.getElementById("badge-vm");
  badge.textContent = `VM ${engine}`;
  if (engine === "v86") {
    logLine("Boot de la VM Linux i386 (v86, open source)…");
    logLine(
      "Premier boot à froid : plusieurs minutes. Boots suivants : restaurés depuis l'instantané.",
    );
    const configResponse = await fetch(V86_CONFIG_URL);
    if (!configResponse.ok) {
      throw new Error(
        "v86-config.json introuvable — lancez tools/build-v86-image/build.sh d'abord",
      );
    }
    const { bootVm } = await import("./vm/v86-vm.js");
    return bootVm({
      onConsole: logLine,
      config: await configResponse.json(),
      fresh: params.get("fresh") === "1",
    });
  }
  logLine("Boot de la VM Linux x86 (CheerpX 1.2.8)…");
  logLine("Premier lancement : le disque Debian est streamé puis mis en cache — patience.");
  const { bootVm } = await import("./vm/rails-vm.js");
  return bootVm({ onConsole: logLine });
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

// Après la toute première installation, la page n'est pas encore contrôlée
// par le SW : un unique rechargement règle ça (garde anti-boucle en session).
function ensureControlled() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  if (sessionStorage.getItem(RELOAD_GUARD_KEY)) {
    throw new Error("Le Service Worker ne prend pas le contrôle de la page");
  }
  sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
  logLine("Premier passage : rechargement pour activer le Service Worker…");
  location.reload();
  return new Promise(() => {}); // la page se recharge, on n'ira pas plus loin
}

function ensureCrossOriginIsolated() {
  if (crossOriginIsolated) return;
  // Le SW vient d'être installé et ré-injecte COOP/COEP : un rechargement
  // suffit sur un hébergeur statique. En local, serve.mjs pose les en-têtes.
  if (!sessionStorage.getItem(RELOAD_GUARD_KEY)) {
    sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
    location.reload();
    throw new Error("Rechargement pour obtenir l'isolation cross-origin");
  }
  throw new Error(
    "SharedArrayBuffer indisponible : servez la page avec les en-têtes COOP/COEP (voir serve.mjs)",
  );
}

start().catch((error) => {
  logLine(`ERREUR FATALE: ${error.message}`);
  for (const id of ["sw", "coi", "vm", "http"]) {
    const badge = document.getElementById(`badge-${id}`);
    if (badge.classList.contains("pending")) setBadge(id, false);
  }
});
