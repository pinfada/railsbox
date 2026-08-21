// Capture le DELTA d'instantané d'une application (ADR 0002) : restaure
// l'instantané de BASE, attache le disque applicatif (hdb, même géométrie que
// le placeholder de la capture de base), déclenche le montage de /app + le
// démarrage de Puma (trame RST via le pont), attend la sonde, puis fige un
// instantané prêt à l'emploi. Le visiteur restaure CE delta avec LE MÊME disque
// applicatif — aucun échange risqué à l'ouverture.
//
//   node tools/build-v86-image/make-delta-snapshot.mjs --name demo --base base-3.3
//
// Cible ADR : delta capturé en < 3 min (contre ~12 min pour l'image monolithique).
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootHarness } from "../vm-harness.mjs";
import { buildSplitConfig } from "./split-config.mjs";
import { scellerInstantane } from "./snapshot-cibles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");

function log(message) {
  process.stdout.write(`[delta-snapshot] ${message}\n`);
}

function parseArgs(argv) {
  const options = {
    name: "demo",
    base: "base-3.3",
    memoryMb: 1024,
    mountPath: "/app",
    // Options de PUBLICATION : elles ne changent rien au boot de capture, qui
    // se fait toujours sur des fichiers locaux. Elles ne décrivent que la
    // configuration finale, celle que le visiteur consommera (ADR 0004).
    /** @type {string|null} */ baseUrl: null,
    /** @type {number|null} */ baseChunkBytes: null,
    /** @type {number|null} */ appChunkBytes: null,
    stateSuffix: "",
    // Renseignée par la fiche du disque applicatif quand elle existe ; l'option
    // --database ne sert qu'à forcer la valeur à la main.
    /** @type {string|null} */ database: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--name") options.name = argv[++i];
    else if (argv[i] === "--base") options.base = argv[++i].replace(/^railsbox-/, "");
    else if (argv[i] === "--memory-mb") options.memoryMb = Number(argv[++i]);
    else if (argv[i] === "--mount-path") options.mountPath = argv[++i];
    else if (argv[i] === "--base-url") options.baseUrl = argv[++i];
    else if (argv[i] === "--base-chunk-size") options.baseChunkBytes = Number(argv[++i]);
    else if (argv[i] === "--app-chunk-size") options.appChunkBytes = Number(argv[++i]);
    // Suffixe ajouté au nom de l'instantané DANS LA CONFIGURATION : « .gz »
    // quand la publication le découpe en morceaux gzippés (ADR 0003), ou le
    // sert pré-compressé. Il vaut pour les deux répartitions, sans quoi un
    // contributeur ne pourrait pas reproduire en local ce que la CI publie.
    else if (argv[i] === "--state-suffix") options.stateSuffix = argv[++i];
    else if (argv[i] === "--database") options.database = argv[++i];
  }
  return options;
}

/**
 * Lit la fiche écrite par build-app-disk.sh à côté du disque applicatif. Elle
 * porte le seul renseignement que la capture ne peut pas deviner : la base de
 * données de l'application. Absente (disque fabriqué à la main), on retombe sur
 * sqlite3 — le défaut historique.
 * @param {string} path chemin de la fiche `<nom>-app.json`
 * @returns {Promise<{database?: string}>} fiche analysée, objet vide si absente
 */
async function readDiskCard(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    log(`fiche du disque illisible (${error.message}) — réglages par défaut`);
    return {};
  }
}

async function gzipFile(source, destination) {
  await pipeline(
    createReadStream(source),
    createGzip({ level: 9 }),
    createWriteStream(destination),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { name, base } = options;
  const baseDiskPath = join(DISKS_DIR, `${base}.ext2`);
  const appDiskPath = join(DISKS_DIR, `${name}-app.ext2`);
  const baseStatePath = join(DISKS_DIR, `${base}-state.bin`);
  for (const [label, path] of [
    ["disque de base", baseDiskPath],
    ["disque applicatif", appDiskPath],
    ["instantané de base", baseStatePath],
  ]) {
    if (!existsSync(path)) throw new Error(`${label} introuvable (${path})`);
  }

  const baseDiskBytes = (await stat(baseDiskPath)).size;
  const appDiskBytes = (await stat(appDiskPath)).size;
  const stateName = `${name}-split-state.bin`;
  const configName = `${name}-split-config.json`;
  const configPath = join(DISKS_DIR, configName);
  const card = await readDiskCard(join(DISKS_DIR, `${name}-app.json`));
  const database = options.database ?? card.database ?? "sqlite3";
  log(`base de données de la sandbox : ${database}`);

  // Config SANS state : le harnais boote dessus en restaurant l'instantané de
  // BASE (statePath explicite), pas encore le delta (qu'on va justement créer).
  const configNoState = buildSplitConfig({
    name,
    baseName: base,
    baseDiskBytes,
    appDiskBytes,
    memoryMb: options.memoryMb,
    mountPath: options.mountPath,
    database,
  });
  await writeFile(configPath, `${JSON.stringify(configNoState, null, 2)}\n`);
  log(`config split écrite (${configName}) — base ${base} + hdb ${name}-app.ext2`);

  log("restauration de l'instantané de base + attachement du disque applicatif…");
  const startedAt = Date.now();
  const harness = await bootHarness({
    projectRoot: PROJECT_ROOT,
    configName,
    statePath: baseStatePath,
    onLog: (line) => {
      if (/error|fatal|montage|start-app|postgres|relancee|Listening|pont/i.test(line)) {
        log(`vm: ${line.slice(0, 160)}`);
      }
    },
  });

  try {
    // Laisse la base restaurée reprendre la main avant de piloter le pont.
    harness.syncClock();
    await new Promise((r) => setTimeout(r, 2_000));

    log("déclenchement du montage de /app + démarrage de Puma (trame RST)…");
    await harness.restartApplication();

    log("attente de la sonde applicative (/app/)…");
    await harness.waitUntilReady({
      onAttempt: (attempt, error) => {
        if (error && attempt % 6 === 0) log(`sonde n°${attempt} : ${error}`);
      },
    });
    const bootSeconds = Math.round((Date.now() - startedAt) / 1000);
    log(`application prête (montage + Puma) en ${bootSeconds} s`);

    // Marge de stabilisation avant de figer (init paresseuse de Puma).
    await new Promise((r) => setTimeout(r, 12_000));
    harness.syncClock();

    const captureStart = Date.now();
    log("capture du delta d'instantané…");
    const state = await harness._emulator.save_state();
    const captureSeconds = Math.round((Date.now() - captureStart) / 1000);
    harness.stop();

    const statePath = join(DISKS_DIR, stateName);
    await writeFile(statePath, Buffer.from(state));
    log(
      `écrit ${stateName} (${Math.round(state.byteLength / 1048576)} Mo, capture ${captureSeconds} s)`,
    );
    await gzipFile(statePath, `${statePath}.gz`);
    const compressed = await stat(`${statePath}.gz`);
    log(`écrit ${stateName}.gz (${Math.round(compressed.size / 1048576)} Mo)`);

    // La config finale référence le delta : le visiteur restaure CE delta avec
    // le MÊME disque applicatif. En mode publication, elle décrit en plus la
    // répartition de l'ADR 0004 — base cross-origin, application relative.
    const finalConfig = options.baseUrl
      ? {
          ...buildSplitConfig({
            name,
            baseName: base,
            baseDiskBytes,
            appDiskBytes,
            memoryMb: options.memoryMb,
            mountPath: options.mountPath,
            database,
            baseUrl: options.baseUrl,
            baseChunkBytes: options.baseChunkBytes,
            appChunkBytes: options.appChunkBytes,
          }),
        }
      : configNoState;
    // Scellée comme la capture monolithique : sans `stateFor`, la coquille
    // classe la sandbox SANS_MARQUE et ne vérifie plus rien — or c'est CE
    // chemin que la chaîne publique emploie.
    const configScellee = scellerInstantane(
      finalConfig,
      options.baseUrl
        ? `disks/${stateName}${options.stateSuffix}`
        : `/disks/${stateName}${options.stateSuffix}`,
    );
    await writeFile(configPath, `${JSON.stringify(configScellee, null, 2)}\n`);
    log(`${configName} référence désormais le delta pré-calculé`);

    const totalSeconds = Math.round((Date.now() - startedAt) / 1000);
    log(`TERMINÉ en ${totalSeconds} s au total`);
    process.exit(0);
  } catch (error) {
    harness.stop();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`[delta-snapshot] ÉCHEC : ${error.message}\n`);
  process.exit(1);
});
