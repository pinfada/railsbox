// Noyau d'exécution : boot d'une VM Linux x86 (CheerpX) et pont HTTP
// fichier-based. CheerpX gère lui-même ses workers internes ; ce module
// s'exécute sur le thread principal de la page hôte, jamais dans l'iframe.
import * as CheerpX from "https://cxrtnc.leaningtech.com/1.2.8/cx.esm.js";
import {
  APP_SOCKET_PATH,
  BRIDGE_MOUNT,
  DATA_MOUNT,
  bridgePaths,
  buildBridgeRequest,
  buildFallbackScript,
  deviceRelative,
  parseCurlHeaders,
  parseDoneMarker,
} from "../shared/request-codec.js";
import { BOOT_SCRIPT, BRIDGE_CLIENT_PY, MINI_APP_PY, MINI_APP_RB } from "./vm-scripts.js";

const DEFAULT_DISK_IMAGE_URL = "wss://disks.webvm.io/debian_large_20230522_5044875331.ext2";
const BRIDGE_TIMEOUT_MS = 120_000;
const FILE_POLL_INTERVAL_MS = 60;
const READY_MAX_ATTEMPTS = 60;
const READY_INTERVAL_MS = 3_000;
const CURL_CONNECTION_REFUSED = 7;
const SECRET_KEY_BYTES = 64;

export async function bootVm({ onConsole = () => {}, diskImageUrl = DEFAULT_DISK_IMAGE_URL } = {}) {
  const diskDevice = await createDiskDevice(diskImageUrl);
  const rootPersistence = await CheerpX.IDBDevice.create("rails-root");
  const overlayDevice = await CheerpX.OverlayDevice.create(diskDevice, rootPersistence);
  const bridgeDevice = await CheerpX.IDBDevice.create("rails-bridge");
  await bridgeDevice.reset(); // purge les échanges de la session précédente
  const dataDevice = await CheerpX.DataDevice.create();

  const cx = await CheerpX.Linux.create({
    mounts: [
      { type: "ext2", path: "/", dev: overlayDevice },
      { type: "dir", path: BRIDGE_MOUNT, dev: bridgeDevice },
      { type: "dir", path: DATA_MOUNT, dev: dataDevice },
      { type: "devs", path: "/dev" },
    ],
  });
  attachConsole(cx, onConsole);
  return createVmFacade(cx, { bridgeDevice, dataDevice }, onConsole);
}

// wss:// -> image publique WebVM (CloudDevice) ; sinon image ext2 servie en
// HTTP avec support des requêtes Range (image Rails custom, voir tools/).
async function createDiskDevice(url) {
  if (url.startsWith("wss://")) {
    return CheerpX.CloudDevice.create(url);
  }
  return CheerpX.HttpBytesDevice.create(url);
}

function attachConsole(cx, onConsole) {
  if (typeof cx.setCustomConsole !== "function") return;
  const decoder = new TextDecoder();
  let lineBuffer = "";
  cx.setCustomConsole((chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    lineBuffer += text;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) onConsole(line);
    }
  }, 200, 50);
}

function buildRunEnvironment() {
  return [
    "HOME=/root",
    "USER=root",
    "SHELL=/bin/bash",
    "TERM=xterm",
    "LANG=C.UTF-8",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `APP_SOCKET=${APP_SOCKET_PATH}`,
    "RAILS_ENV=production",
    "RAILS_RELATIVE_URL_ROOT=/app",
    "RAILS_SERVE_STATIC_FILES=1",
    "RAILS_LOG_TO_STDOUT=1",
    // Jeton jetable généré par session : jamais de secret codé en dur.
    `SECRET_KEY_BASE=${randomHex(SECRET_KEY_BYTES)}`,
  ];
}

function createVmFacade(cx, devices, onConsole) {
  const environment = buildRunEnvironment();
  const state = { seq: 0, serverPromise: null };

  async function startServer() {
    await devices.dataDevice.writeFile("/bridge-client.py", BRIDGE_CLIENT_PY);
    await devices.dataDevice.writeFile("/mini-app.py", MINI_APP_PY);
    await devices.dataDevice.writeFile("/mini-app.rb", MINI_APP_RB);
    await devices.dataDevice.writeFile("/boot.sh", BOOT_SCRIPT);
    state.serverPromise = cx
      .run("/bin/sh", ["/data/boot.sh"], { env: environment, cwd: "/root" })
      .then((result) => onConsole(`[vm] boucle de pont terminée (statut ${result.status})`))
      .catch((error) => onConsole(`[vm] ERREUR fatale du pont: ${error.message}`));
  }

  // Dépose la requête dans /data ; la boucle shell de la VM (boot.sh) exécute
  // le script curl correspondant et signale la fin via un fichier .done.
  async function handleHttpRequest(descriptor, body) {
    const seq = ++state.seq;
    const files = bridgePaths(seq);
    let request;
    try {
      if (descriptor.hasBody) {
        const bytes = body ? new Uint8Array(body) : new Uint8Array(0);
        await devices.dataDevice.writeFile(deviceRelative(files.requestBody, DATA_MOUNT), bytes);
      }
      request = buildBridgeRequest({ ...descriptor, seq });
      await devices.dataDevice.writeFile(deviceRelative(files.descriptor, DATA_MOUNT), request.descriptorJson);
    } catch (error) {
      // La boucle VM consomme req-N.cmd dans l'ordre strict : produire un
      // script neutre pour que les requêtes suivantes ne soient pas bloquées.
      await devices.dataDevice.writeFile(
        deviceRelative(files.command, DATA_MOUNT),
        buildFallbackScript(seq),
      );
      throw error;
    }
    await devices.dataDevice.writeFile(deviceRelative(files.command, DATA_MOUNT), request.commandScript);
    // .done est écrit en dernier par la VM et annonce les tailles attendues :
    // on attend qu'il soit non-vide, puis que head/body atteignent leur taille
    // (le write-back IndexedDB de CheerpX n'a pas d'ordre garanti).
    const doneBlob = await waitForFile(devices.bridgeDevice, deviceRelative(files.done, BRIDGE_MOUNT), 1);
    return readBridgeResponse(files, parseDoneMarker(await doneBlob.text()));
  }

  async function readBridgeResponse(files, marker) {
    if (marker.curlExit !== 0 || marker.headSize === 0) {
      const hint = marker.curlExit === CURL_CONNECTION_REFUSED
        ? "connexion refusée — le serveur applicatif n'écoute pas encore"
        : `curl a échoué (code ${marker.curlExit})`;
      throw new Error(`Aucune réponse HTTP: ${hint}`);
    }
    const headBlob = await waitForFile(
      devices.bridgeDevice,
      deviceRelative(files.head, BRIDGE_MOUNT),
      marker.headSize,
    );
    const parsed = parseCurlHeaders(await headBlob.text());
    let body = null;
    if (marker.bodySize > 0) {
      const bodyBlob = await waitForFile(
        devices.bridgeDevice,
        deviceRelative(files.body, BRIDGE_MOUNT),
        marker.bodySize,
      );
      body = await bodyBlob.arrayBuffer();
    }
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      body,
    };
  }

  async function waitUntilReady(onAttempt = () => {}) {
    for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt += 1) {
      const result = await probe();
      onAttempt(attempt, result.error);
      if (result.ok) return;
      await sleep(READY_INTERVAL_MS);
    }
    throw new Error("Le serveur applicatif n'a jamais répondu dans la VM");
  }

  async function probe() {
    try {
      const response = await handleHttpRequest(
        { method: "GET", path: "/", headers: [], hasBody: false, forwardHost: "localhost" },
        null,
      );
      return { ok: response.status > 0, error: null };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return { startServer, handleHttpRequest, waitUntilReady, _devices: devices };
}

// Attend qu'un fichier du pont existe ET atteigne la taille minimale attendue
// (la persistance est asynchrone : un fichier peut apparaître vide ou partiel).
async function waitForFile(device, devicePath, minimumSize) {
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
  for (;;) {
    try {
      const blob = await device.readFileAsBlob(devicePath);
      if (blob.size >= minimumSize) return blob;
    } catch {
      // pas encore produit par la VM
    }
    if (Date.now() > deadline) {
      throw new Error(`La VM n'a jamais produit ${devicePath} (${minimumSize} octets attendus)`);
    }
    await sleep(FILE_POLL_INTERVAL_MS);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
