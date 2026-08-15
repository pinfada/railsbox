// Génère l'instantané mémoire post-boot HORS navigateur (CI/CD), pour que
// personne n'ait à subir le boot à froid de ~13 minutes.
//
//   node tools/build-v86-image/make-snapshot.mjs
//
// Boote l'image dans v86 côté Node, attend que jiyufit réponde (même codec
// série que le navigateur), capture save_state(), écrit jiyufit-state.bin
// puis sa version gzip, et référence l'instantané dans v86-config.json.
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
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
const STATE_NAME = "jiyufit-state.bin";
const READY_MAX_ATTEMPTS = 240;
const READY_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
// Marge après la première réponse : laisse Puma finir son initialisation
// paresseuse (pools de connexions, caches) avant de figer la mémoire.
const SETTLE_MS = 20_000;

function log(message) {
  process.stdout.write(`[snapshot] ${message}\n`);
}

async function loadConfig() {
  const path = join(DISKS_DIR, "v86-config.json");
  try {
    return { path, config: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    throw new Error(`v86-config.json illisible (${error.message}) — lancez build.sh d'abord`);
  }
}

function createBridge(emulator) {
  const pending = new Map();
  let nextId = 1;

  const assembler = createResponseAssembler({
    onResponse: (id, bytes) => settle(id, { bytes }),
    onError: (id, code) => settle(id, { code }),
    onLog: (line) => {
      if (/error|fatal|Listening on|pont serie pret|horloge/i.test(line)) {
        log(`vm: ${line.slice(0, 160)}`);
      }
    },
  });
  const lines = createLineAssembler((line) => assembler.handleLine(line));
  emulator.add_listener("serial0-output-byte", (byte) => lines.feedByte(byte));

  function settle(id, outcome) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (outcome.code !== undefined) {
      entry.reject(new Error(`pont: code ${outcome.code}`));
    } else {
      entry.resolve(outcome.bytes);
    }
  }

  return {
    syncClock: () => emulator.serial0_send(buildTimeSyncFrame(Date.now() / 1000)),
    request(path) {
      const id = String(nextId++);
      // Sondes sans corps : head + tail suffisent (aucune tranche BOD).
      const { head, tail } = buildRequestFrames(id, {
        method: "GET",
        path,
        headers: [],
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

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForApplication(bridge) {
  for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt += 1) {
    bridge.syncClock();
    try {
      // Chemin réel de l'application (montée sous /app via Rack::URLMap) :
      // sonder « / » ne testerait que le routeur Rack.
      const raw = await bridge.request("/app/");
      const { headText } = splitHttpResponse(raw);
      log(`prêt à la sonde n°${attempt} — ${headText.split(/\r?\n/)[0]}`);
      return;
    } catch (error) {
      if (attempt % 6 === 0) log(`sonde n°${attempt} : ${error.message}`);
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error("l'application n'a jamais répondu");
}

async function gzipFile(source, destination) {
  await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(destination));
}

async function main() {
  const { path: configPath, config } = await loadConfig();
  log(`image du ${config.builtAt ?? "?"} — démarrage de la VM (Node)`);

  const emulator = new V86({
    wasm_path: join(V86_BUILD_DIR, "v86.wasm"),
    memory_size: (config.memoryMb ?? 1024) * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    bios: { url: join(VENDOR_DIR, "seabios.bin") },
    vga_bios: { url: join(VENDOR_DIR, "vgabios.bin") },
    bzimage: { url: join(DISKS_DIR, "jiyufit-vmlinuz") },
    initrd: { url: join(DISKS_DIR, "jiyufit-initrd") },
    cmdline: config.cmdline,
    hda: { url: join(DISKS_DIR, "jiyufit.ext2"), async: true, size: config.diskSize },
    autostart: true,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
  });

  const bridge = createBridge(emulator);
  const startedAt = Date.now();
  await waitForApplication(bridge);
  log(`boot complet en ${Math.round((Date.now() - startedAt) / 1000)} s — stabilisation…`);
  await sleep(SETTLE_MS);
  bridge.syncClock();

  log("capture de l'état mémoire…");
  const state = await emulator.save_state();
  emulator.stop();

  const statePath = join(DISKS_DIR, STATE_NAME);
  await writeFile(statePath, Buffer.from(state));
  log(`écrit ${STATE_NAME} (${Math.round(state.byteLength / 1048576)} Mo)`);

  log("compression gzip (servie telle quelle via Content-Encoding)…");
  await gzipFile(statePath, `${statePath}.gz`);
  const compressed = await stat(`${statePath}.gz`);
  log(`écrit ${STATE_NAME}.gz (${Math.round(compressed.size / 1048576)} Mo)`);

  await writeFile(configPath, `${JSON.stringify({ ...config, state: `/disks/${STATE_NAME}` }, null, 2)}\n`);
  log("v86-config.json référence désormais l'instantané pré-calculé");
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[snapshot] ÉCHEC : ${error.message}\n`);
  process.exit(1);
});
