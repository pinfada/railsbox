// Harnais d'intégration : boote la VM v86 SOUS NODE et expose le protocole
// série complet (@RIB1) — requêtes avec corps et contrôle de flux acquitté,
// synchronisation d'horloge, injection d'environnement, redémarrage.
//
// C'est le même codec que le navigateur (public/shared/serial-codec.js) : ce
// qui passe ici passe dans l'onglet. Utilisé par tests/integration/ et, à
// terme, par la capture d'instantané (make-snapshot.mjs).
//
// La restauration d'instantané (initial_state) évite le boot à froid de
// ~13 minutes : les tests d'intégration démarrent en quelques dizaines de
// secondes quand public/disks/ contient un état pré-calculé.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { V86 } from "v86";

import { parseCurlHeaders } from "../public/shared/request-codec.js";
import {
  buildEnvironmentFrame,
  buildRequestFrames,
  buildRestartFrame,
  buildTimeSyncFrame,
  createLineAssembler,
  createResponseAssembler,
  splitHttpResponse,
} from "../public/shared/serial-codec.js";
import {
  buildDiskImages,
  isBootableConfig,
  isSplitConfig,
  memoryBytes,
} from "../public/shared/v86-config.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_READY_ATTEMPTS = 240;
const DEFAULT_READY_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
// Voir v86-vm.js : le canal est semi-duplex, l'acquittement d'une tranche
// montante peut attendre derrière une grosse réponse en cours.
const ACK_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;

/**
 * @param {{
 *   projectRoot: string,
 *   configName?: string,
 *   statePath?: string | null,
 *   useSnapshot?: boolean,
 *   onLog?: (line: string) => void,
 * }} options
 */
export async function bootHarness({
  projectRoot,
  configName = "v86-config.json",
  statePath,
  useSnapshot = true,
  onLog = () => {},
}) {
  const disksDir = join(projectRoot, "public", "disks");
  const config = JSON.parse(await readFile(join(disksDir, configName), "utf8"));
  if (!isBootableConfig(config)) {
    throw new Error(`${configName} incomplet : kernel, initrd et disk sont requis`);
  }
  // Les chemins de la config sont des URL web (/disks/x) : on les résout vers
  // le système de fichiers pour le boot sous Node.
  // Les chemins de la configuration sont des URL web. Depuis l'ADR 0004 ils
  // prennent trois formes : absolue depuis la racine (`/disks/x`, hérité),
  // relative à la coquille (`disks/x`, publication sous un sous-répertoire),
  // ou URL complète (le rootfs mutualisé, cross-origin). Les deux premières se
  // résolvent vers le disque local ; la troisième est laissée telle quelle et
  // doit avoir été réassemblée en amont par assemble-artifact.
  const toFile = (webPath) =>
    /^https?:\/\//.test(webPath) ? webPath : join(disksDir, webPath.replace(/^\/?disks\//, ""));

  // L'instantané par défaut suit le nom de la config (demo-config → demo-state),
  // avec repli sur le champ `state` de la config, puis sur l'ancien nom jiyufit.
  const resolvedStatePath =
    statePath ??
    (config.state ? toFile(config.state) : join(disksDir, `${config.name ?? "jiyufit"}-state.bin`));
  let initialState = null;
  if (useSnapshot && existsSync(resolvedStatePath)) {
    // Copie explicite : le Buffer de Node partage un pool interne, v86 exige
    // un ArrayBuffer propre qu'il peut consommer.
    const raw = await readFile(resolvedStatePath);
    initialState = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    onLog(`[harness] instantané chargé (${Math.round(initialState.byteLength / 1048576)} Mo)`);
  }

  // hda (rootfs) toujours ; hdb (disque applicatif) en mode base + application.
  // Même construction que le navigateur (découpage en fichiers-parties compris)
  // sur des chemins résolus localement : ce qui boote ici boote dans l'onglet.
  // L'assertion couvre le seul écart avec le type de v86 : il déclare `size`
  // obligatoire sur un disque asynchrone, alors que buildDiskImages recopie ce
  // que porte la configuration — que le format mono-disque hérité peut omettre.
  const diskImages = /** @type {{ hda: import("v86").V86Image, hdb?: import("v86").V86Image }} */ (
    /** @type {unknown} */ (
      buildDiskImages({
        ...config,
        disk: toFile(config.disk),
        ...(config.appDisk ? { appDisk: toFile(config.appDisk) } : {}),
      })
    )
  );
  if (isSplitConfig(config)) {
    onLog(`[harness] montage base + application : ${config.disk} + hdb ${config.appDisk}`);
  }
  for (const [slot, chunkSize] of [
    ["hda", config.diskChunkSize],
    ["hdb", config.appDiskChunkSize],
  ]) {
    if (chunkSize) onLog(`[harness] ${slot} servi en morceaux de ${chunkSize} octets`);
  }

  const emulator = new V86({
    wasm_path: join(projectRoot, "node_modules", "v86", "build", "v86.wasm"),
    memory_size: memoryBytes(config),
    vga_memory_size: 8 * 1024 * 1024,
    bios: { url: join(projectRoot, "public", "vendor", "v86", "seabios.bin") },
    vga_bios: { url: join(projectRoot, "public", "vendor", "v86", "vgabios.bin") },
    bzimage: { url: toFile(config.kernel) },
    initrd: { url: toFile(config.initrd) },
    cmdline: config.cmdline,
    ...diskImages,
    ...(initialState ? { initial_state: { buffer: initialState } } : {}),
    autostart: true,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
  });

  const state = { nextId: 1, pending: new Map(), acks: new Map() };
  const assembler = createResponseAssembler({
    onResponse: (id, bytes) => settle(id, { bytes }),
    onError: (id, code) => settle(id, { code }),
    onLog: (line) => onLog(`[vm] ${line}`),
    onAck: (id) => state.acks.get(id)?.(),
  });
  const lineAssembler = createLineAssembler((line) => assembler.handleLine(line));
  emulator.add_listener("serial0-output-byte", (byte) => lineAssembler.feedByte(byte));

  /**
   * @param {string} id
   * @param {{ bytes?: Uint8Array, code?: number }} outcome
   */
  function settle(id, outcome) {
    const entry = state.pending.get(id);
    if (!entry) return;
    state.pending.delete(id);
    clearTimeout(entry.timer);
    if (outcome.code !== undefined) {
      entry.reject(new Error(`pont série : erreur code ${outcome.code}`));
    } else {
      entry.resolve(outcome.bytes);
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  function waitForAck(id) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        state.acks.delete(id);
        reject(new Error("tranche non acquittée par la VM"));
      }, ACK_TIMEOUT_MS);
      state.acks.set(id, () => {
        clearTimeout(timer);
        state.acks.delete(id);
        resolvePromise();
      });
    });
  }

  function syncClock() {
    emulator.serial0_send(buildTimeSyncFrame(Date.now() / 1000));
  }

  // Recalage périodique, comme dans le navigateur (v86-vm.js) : l'horloge
  // invitée dérive en continu sous émulation — sans entretien, un test long
  // (session, CSRF) divergerait du comportement réel de l'onglet.
  let clockKeeper = null;
  function startClockKeeper() {
    if (clockKeeper) return;
    clockKeeper = setInterval(syncClock, 15_000);
    // Ne retient pas le process Node en vie une fois les tests finis.
    clockKeeper.unref?.();
  }
  function stopClockKeeper() {
    clearInterval(clockKeeper);
    clockKeeper = null;
  }

  /**
   * Exécute une requête HTTP complète à travers le pont série, corps compris
   * (tranches BOD acquittées une à une — même chemin que le navigateur).
   * @param {{ method: string, path: string, headers?: Array<[string, string]> }} descriptor
   * @param {Uint8Array | null} [body]
   * @param {number} [timeoutMs]
   */
  async function request(descriptor, body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const id = String(state.nextId++);
    // x-forwarded-proto: https — même comportement que le Service Worker :
    // les applications en force_ssl répondraient sinon 301/308 en boucle.
    const headers = /** @type {Array<[string, string]>} */ ([
      ["x-forwarded-proto", "https"],
      ...(descriptor.headers ?? []),
    ]);
    const { head, bodyChunks, tail } = buildRequestFrames(id, {
      method: descriptor.method,
      path: descriptor.path,
      headers,
      forwardHost: "localhost",
      bodyBytes: body,
    });

    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error("délai dépassé en attendant la VM"));
      }, timeoutMs);
      state.pending.set(id, { resolve: resolvePromise, reject, timer });
    });

    emulator.serial0_send(head);
    for (const chunk of bodyChunks) {
      const acked = waitForAck(id);
      emulator.serial0_send(chunk);
      await acked;
    }
    emulator.serial0_send(tail);

    const rawBytes = await response;
    const { headText, bodyBytes } = splitHttpResponse(rawBytes);
    const parsed = parseCurlHeaders(headText);
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      body: bodyBytes,
    };
  }

  /**
   * Injecte des variables d'environnement dans la VM (trame ENV acquittée).
   * Le redémarrage applicatif est volontairement séparé : il coûte plusieurs
   * minutes et tous les appelants n'en ont pas besoin.
   * @param {Record<string, string>} variables
   */
  async function sendEnvironment(variables) {
    const id = String(state.nextId++);
    const acked = waitForAck(id);
    emulator.serial0_send(buildEnvironmentFrame(id, variables));
    await acked;
  }

  /** Relance le serveur applicatif dans la VM (trame RST acquittée). */
  async function restartApplication() {
    const id = String(state.nextId++);
    const acked = waitForAck(id);
    emulator.serial0_send(buildRestartFrame(id));
    await acked;
  }

  /**
   * Sonde l'application jusqu'à obtenir une réponse HTTP, en recalant
   * l'horloge à chaque tour (le démon peut ne pas être prêt au premier).
   * @param {{ maxAttempts?: number, intervalMs?: number, mountPath?: string, onAttempt?: (attempt: number, error: string | null) => void }} [options]
   */
  async function waitUntilReady({
    maxAttempts = DEFAULT_READY_ATTEMPTS,
    intervalMs = DEFAULT_READY_INTERVAL_MS,
    onAttempt = () => {},
    // Chemin de montage réel : « /app » en développement, mais
    // « /<depot>/app » pour une sandbox publiée sous un sous-répertoire, où
    // l'application est montée sur son chemin PUBLIC complet. Sonder « /app/ »
    // y récolterait un 404 de Rack, et la capture expirerait sans raison
    // apparente.
    mountPath = config.mountPath ?? "/app",
  } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      syncClock();
      try {
        const response = await request(
          { method: "GET", path: `${mountPath.replace(/\/$/, "")}/`, headers: [] },
          null,
          PROBE_TIMEOUT_MS,
        );
        onAttempt(attempt, null);
        if (response.status > 0) {
          syncClock();
          startClockKeeper();
          return;
        }
      } catch (error) {
        onAttempt(attempt, error.message);
      }
      await sleep(intervalMs);
    }
    throw new Error("l'application n'a jamais répondu dans la VM");
  }

  function stop() {
    stopClockKeeper();
    emulator.stop();
  }

  return {
    request,
    sendEnvironment,
    restartApplication,
    waitUntilReady,
    syncClock,
    stop,
    wasRestored: initialState !== null,
    _emulator: emulator,
  };
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
