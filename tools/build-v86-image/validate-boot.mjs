#!/usr/bin/env node
// Valide qu'une image railsbox boote et que l'application répond, HORS
// navigateur et SANS instantané (boot à froid complet) :
//
//   node tools/build-v86-image/validate-boot.mjs [demo-config.json] [--path /app/]
//
// Contrairement à tools/vm-harness.mjs et make-snapshot.mjs — qui codent en
// dur les noms « jiyufit-* » et v86-config.json — ce script lit TOUS les noms
// de fichiers dans la configuration produite par build.sh. Il vaut donc pour
// n'importe quelle application.
//
// Sort en 0 dès qu'une réponse HTTP traverse le pont série, en 1 sinon.
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "v86";

import {
  buildRequestFrames,
  buildTimeSyncFrame,
  createLineAssembler,
  createResponseAssembler,
  splitHttpResponse,
} from "../../public/shared/serial-codec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");
const V86_BUILD_DIR = join(PROJECT_ROOT, "node_modules", "v86", "build");
const VENDOR_DIR = join(PROJECT_ROOT, "public", "vendor", "v86");
const READY_MAX_ATTEMPTS = 240;
const READY_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
/** Extrait du corps affiché en preuve de bon fonctionnement. */
const BODY_PREVIEW_BYTES = 1500;
/** En deçà de cette taille, le corps est imprimé intégralement. */
const FULL_BODY_LIMIT = 16_384;
/** Délai laissé à v86 pour refermer ses lectures disque avant la sortie. */
const SHUTDOWN_SETTLE_MS = 1_000;

/**
 * @param {string} message
 * @returns {void}
 */
function log(message) {
  process.stdout.write(`[validate] ${message}\n`);
}

/**
 * Résout le chemin local d'un artefact référencé par la configuration.
 * @param {string} reference chemin web (`/disks/demo.ext2`) ou chemin local
 * @returns {string} chemin absolu sur le disque
 */
export function artifactPath(reference) {
  if (isAbsolute(reference) && !reference.startsWith("/disks/")) return reference;
  return join(DISKS_DIR, basename(reference));
}

/**
 * Ouvre un pont série minimal (requêtes sans corps) sur un émulateur v86.
 * @param {any} emulator instance V86 démarrée
 * @param {(line: string) => void} onLog rappel pour les lignes de console
 * @returns {{syncClock: () => void, request: (path: string) => Promise<Uint8Array>}} pont
 */
function createBridge(emulator, onLog) {
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  let nextId = 1;

  const assembler = createResponseAssembler({
    onResponse: (id, bytes) => settle(id, { bytes }),
    onError: (id, code) => settle(id, { code }),
    onLog,
  });
  const lines = createLineAssembler((line) => assembler.handleLine(line));
  emulator.add_listener("serial0-output-byte", (byte) => lines.feedByte(byte));

  /**
   * @param {string} id
   * @param {{bytes?: Uint8Array, code?: number}} outcome
   * @returns {void}
   */
  function settle(id, outcome) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (outcome.code !== undefined) entry.reject(new Error(`pont : code ${outcome.code}`));
    else entry.resolve(outcome.bytes);
  }

  return {
    syncClock: () => emulator.serial0_send(buildTimeSyncFrame(Date.now() / 1000)),
    request(path) {
      const id = String(nextId++);
      // x-forwarded-proto: https — même en-tête que le Service Worker. Sans
      // lui, une application en force_ssl (Rails 8 par défaut) répond 301.
      const { head, tail } = buildRequestFrames(id, {
        method: "GET",
        path,
        headers: [["x-forwarded-proto", "https"]],
        forwardHost: "localhost",
        bodyBytes: null,
      });
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("délai dépassé"));
        }, PROBE_TIMEOUT_MS);
        pending.set(id, { resolve: resolvePromise, reject, timer });
        emulator.serial0_send(head);
        emulator.serial0_send(tail);
      });
    },
  };
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * Sonde l'application jusqu'à obtenir une réponse HTTP complète.
 * @param {{syncClock: () => void, request: (path: string) => Promise<Uint8Array>}} bridge pont série
 * @param {string} probePath chemin HTTP à sonder
 * @returns {Promise<{headText: string, bodyBytes: Uint8Array, attempt: number}>} réponse obtenue
 * @throws {Error} si l'application ne répond jamais dans le budget imparti
 */
async function waitForApplication(bridge, probePath) {
  for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt += 1) {
    bridge.syncClock();
    try {
      const raw = await bridge.request(probePath);
      const { headText, bodyBytes } = splitHttpResponse(raw);
      return { headText, bodyBytes, attempt };
    } catch (error) {
      if (attempt % 6 === 0) log(`sonde n°${attempt} : ${error.message}`);
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error("l'application n'a jamais répondu dans la VM");
}

async function main() {
  const args = process.argv.slice(2);
  const pathFlag = args.indexOf("--path");
  const positional = args.filter((value, index) => {
    if (value.startsWith("--")) return false;
    return pathFlag === -1 || index !== pathFlag + 1;
  });
  const configName = positional[0] ?? "v86-config.json";
  const configPath = isAbsolute(configName) ? configName : join(DISKS_DIR, configName);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const probePath = pathFlag === -1 ? `${config.mountPath ?? "/app"}/` : args[pathFlag + 1];

  log(
    `image « ${config.name ?? "?"} » du ${config.builtAt ?? "?"} — boot à FROID (sans instantané)`,
  );
  const emulator = new V86({
    wasm_path: join(V86_BUILD_DIR, "v86.wasm"),
    memory_size: (config.memoryMb ?? 1024) * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    bios: { url: join(VENDOR_DIR, "seabios.bin") },
    vga_bios: { url: join(VENDOR_DIR, "vgabios.bin") },
    bzimage: { url: artifactPath(config.kernel) },
    initrd: { url: artifactPath(config.initrd) },
    cmdline: config.cmdline,
    hda: { url: artifactPath(config.disk), async: true, size: config.diskSize },
    autostart: true,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
  });

  const bridge = createBridge(emulator, (line) => {
    if (/error|fatal|Listening on|pont serie pret|\[init\]/i.test(line)) {
      log(`vm: ${line.slice(0, 200)}`);
    }
  });

  const startedAt = Date.now();
  const response = await waitForApplication(bridge, probePath);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  await shutdown(emulator);

  const statusLine = response.headText.split(/\r?\n/)[0];
  const body = Buffer.from(response.bodyBytes);
  // Corps court : on l'imprime en entier, c'est la preuve la plus parlante.
  const preview = body.length <= FULL_BODY_LIMIT ? body : body.subarray(0, BODY_PREVIEW_BYTES);
  log(`réponse obtenue à la sonde n°${response.attempt}, après ${seconds} s`);
  log(`GET ${probePath} → ${statusLine} (${body.length} octets)`);
  process.stdout.write(`${response.headText}\n\n${preview.toString("utf8")}\n`);
  // La preuve attendue est un code 2xx : un 500 prouverait le pont, pas l'app.
  const status = Number(statusLine.split(" ")[1]);
  if (!Number.isFinite(status) || status >= 400) {
    throw new Error(`statut HTTP inattendu : ${statusLine}`);
  }
  process.exit(0);
}

/**
 * Arrête l'émulateur en laissant ses lectures disque en vol se terminer.
 * Sans ce délai, `process.exit` sous Windows tombe sur une assertion libuv
 * (« UV_HANDLE_CLOSING ») : le processus meurt en 127 après avoir pourtant
 * réussi, ce qui rend la validation illisible.
 * @param {any} emulator instance V86 à arrêter
 * @returns {Promise<void>} résolue une fois l'arrêt sédimenté
 */
async function shutdown(emulator) {
  emulator.stop();
  await sleep(SHUTDOWN_SETTLE_MS);
}

main().catch((error) => {
  process.stderr.write(`[validate] ÉCHEC : ${error.message}\n`);
  process.exit(1);
});
