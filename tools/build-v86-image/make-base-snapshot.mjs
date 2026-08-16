// Capture l'instantané de BASE (ADR 0002) : boot du rootfs mutualisé, services
// démarrés (Redis), pont série prêt, AUCUNE application. L'instantané est pris
// AVEC un hdb placeholder vide de géométrie fixe (512 Mo) attaché — condition
// sine qua non de la restauration (v86 refuse de restaurer un état capturé sans
// hdb quand la configuration en attache un ; voir docs/decisions/0002).
//
//   node tools/build-v86-image/make-base-snapshot.mjs [--base base-3.3]
//
// Le placeholder est un fichier de ZÉROS (creux) : son secteur 0 est nul, donc
// identique au bloc de boot d'un ext2 nu — le cache de blocs éventuellement figé
// dans l'instantané ne peut pas diverger du disque applicatif réel monté au
// moment du delta (voir make-delta-snapshot.mjs).
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "v86";

import {
  buildTimeSyncFrame,
  createLineAssembler,
  createResponseAssembler,
} from "../../public/shared/serial-codec.js";
import { APP_DISK_BYTES } from "./split-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");
const V86_BUILD_DIR = join(PROJECT_ROOT, "node_modules", "v86", "build");
const VENDOR_DIR = join(PROJECT_ROOT, "public", "vendor", "v86");
const DEFAULT_CMDLINE =
  "root=/dev/sda rw console=ttyS0 init=/opt/rib/guest-init.sh net.ifnames=0 quiet loglevel=4";
const READY_TIMEOUT_MS = 300_000;
// Marge après « pont serie pret » : laisse Redis et le pont se stabiliser avant
// de figer la mémoire.
const SETTLE_MS = 8_000;

function log(message) {
  process.stdout.write(`[base-snapshot] ${message}\n`);
}

function parseArgs(argv) {
  const options = { base: "base-3.3", cmdline: DEFAULT_CMDLINE, memoryMb: 1024 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") options.base = argv[++i];
    else if (argv[i] === "--cmdline") options.cmdline = argv[++i];
    else if (argv[i] === "--memory-mb") options.memoryMb = Number(argv[++i]);
  }
  return options;
}

/**
 * Crée le placeholder hdb : un fichier creux de ZÉROS exactement à la géométrie
 * fixe. Idempotent (ne le recrée pas s'il a déjà la bonne taille).
 * @param {string} path
 */
async function ensurePlaceholder(path) {
  if (existsSync(path) && (await stat(path)).size === APP_DISK_BYTES) return;
  const handle = await open(path, "w");
  try {
    await handle.truncate(APP_DISK_BYTES);
  } finally {
    await handle.close();
  }
}

async function gzipFile(source, destination) {
  await pipeline(
    createReadStream(source),
    createGzip({ level: 9 }),
    createWriteStream(destination),
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = options.base;
  const diskPath = join(DISKS_DIR, `${base}.ext2`);
  const kernelPath = join(DISKS_DIR, `${base}-vmlinuz`);
  const initrdPath = join(DISKS_DIR, `${base}-initrd`);
  for (const [label, path] of [
    ["ext2", diskPath],
    ["vmlinuz", kernelPath],
    ["initrd", initrdPath],
  ]) {
    if (!existsSync(path)) {
      throw new Error(`${label} de base introuvable (${path}) — lancez base-build.sh d'abord`);
    }
  }

  const placeholderPath = join(DISKS_DIR, `${base}-placeholder.ext2`);
  await ensurePlaceholder(placeholderPath);
  log(`placeholder hdb : ${base}-placeholder.ext2 (${APP_DISK_BYTES / 1048576} Mo de zéros)`);

  const diskSize = (await stat(diskPath)).size;
  log(`démarrage de la VM de base (${base}, ${Math.round(diskSize / 1048576)} Mo)…`);

  const emulator = new V86({
    wasm_path: join(V86_BUILD_DIR, "v86.wasm"),
    memory_size: options.memoryMb * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    bios: { url: join(VENDOR_DIR, "seabios.bin") },
    vga_bios: { url: join(VENDOR_DIR, "vgabios.bin") },
    bzimage: { url: kernelPath },
    initrd: { url: initrdPath },
    cmdline: options.cmdline,
    hda: { url: diskPath, async: true, size: diskSize },
    // hdb placeholder : PRÉSENT à la capture, jamais monté par le guest.
    hdb: { url: placeholderPath, async: true, size: APP_DISK_BYTES },
    autostart: true,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
  });

  // Détection de « pont serie pret » sur le flux série (le pont l'émet une fois
  // les logs suivis et prêt à traiter des trames).
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const assembler = createResponseAssembler({
    onResponse: () => {},
    onError: () => {},
    onLog: (line) => {
      if (/pont serie pret/i.test(line)) resolveReady();
      if (/error|fatal|redis|horloge|init\]/i.test(line)) log(`vm: ${line.slice(0, 160)}`);
    },
  });
  const lines = createLineAssembler((line) => assembler.handleLine(line));
  emulator.add_listener("serial0-output-byte", (byte) => lines.feedByte(byte));

  const startedAt = Date.now();
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("le pont série n'a jamais signalé sa disponibilité")),
      READY_TIMEOUT_MS,
    );
  });
  await Promise.race([ready, timeout]);
  clearTimeout(timeoutHandle);
  log(`base prête en ${Math.round((Date.now() - startedAt) / 1000)} s — stabilisation…`);
  await sleep(SETTLE_MS);
  emulator.serial0_send(buildTimeSyncFrame(Date.now() / 1000));
  await sleep(500);

  log("capture de l'état mémoire de base…");
  const state = await emulator.save_state();
  emulator.stop();

  const statePath = join(DISKS_DIR, `${base}-state.bin`);
  await writeFile(statePath, Buffer.from(state));
  log(`écrit ${base}-state.bin (${Math.round(state.byteLength / 1048576)} Mo)`);
  await gzipFile(statePath, `${statePath}.gz`);
  const compressed = await stat(`${statePath}.gz`);
  log(`écrit ${base}-state.bin.gz (${Math.round(compressed.size / 1048576)} Mo)`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[base-snapshot] ÉCHEC : ${error.message}\n`);
  process.exit(1);
});
