#!/usr/bin/env node
// Réassemble un artefact découpé en fichiers-parties (inverse de
// split-artifact.mjs). Le navigateur n'en a pas besoin — v86 lit les morceaux
// un par un — mais la CI d'un mainteneur, si : pour capturer son delta
// d'instantané, elle doit booter sur le rootfs de base, et sur EXACTEMENT
// celui que le navigateur lira.
//
// Reconstruire l'ext2 depuis l'image Docker donnerait un disque différent
// (UUID de système de fichiers, horodatages) : l'instantané capturé dessus
// embarquerait un cache de blocs divergeant du disque réellement servi — le
// risque tranché par l'ADR 0002. On repart donc des octets publiés.
//
//   node tools/build-v86-image/assemble-artifact.mjs \
//     https://pinfada.github.io/railsbox/disks/parts-base/base-3.3.ext2.zst \
//     --size 1524629504 --out public/disks/base-3.3.ext2
//
// La source peut être une URL http(s) ou un chemin local.
import { createWriteStream } from "node:fs";
import { mkdir, stat, truncate } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import { DEFAULT_CHUNK_BYTES, planParts, partName, splitArtifactName } from "./artifact-parts.mjs";

const decompress = promisify(zstdDecompress);

function log(message) {
  process.stdout.write(`[assemble-artifact] ${message}\n`);
}

/**
 * @param {string[]} argv
 * @returns {{ source?: string, size?: number, chunkBytes: number, out?: string }}
 */
export function parseArgs(argv) {
  const options = { chunkBytes: DEFAULT_CHUNK_BYTES };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--size") options.size = Number(argv[++i]);
    else if (argv[i] === "--chunk-size") options.chunkBytes = Number(argv[++i]);
    else if (argv[i] === "--out") options.out = argv[++i];
    else if (!argv[i].startsWith("--")) options.source = argv[i];
  }
  return options;
}

/**
 * Lit un morceau, où qu'il vive.
 * @param {string} location URL http(s) ou chemin de fichier
 * @returns {Promise<Buffer>}
 */
async function readPart(location) {
  if (!/^https?:\/\//.test(location)) return readFile(location);
  const response = await fetch(location);
  if (!response.ok) throw new Error(`${response.status} sur ${location}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Récupère l'inventaire écrit par split-artifact, seule source fiable de la
 * taille totale et de la taille de morceau.
 * @param {string} source URL ou chemin de l'artefact de référence
 * @returns {Promise<{totalBytes: number, chunkBytes: number}|null>}
 */
async function readManifest(source) {
  // L'inventaire est nommé d'après le fichier NON compressé.
  const manifestPath = `${source.replace(/\.zst$/, "")}-parts.json`;
  try {
    const raw = await readPart(manifestPath);
    const manifest = JSON.parse(raw.toString("utf8"));
    if (!Number.isInteger(manifest.totalBytes) || !Number.isInteger(manifest.chunkBytes)) {
      return null;
    }
    return { totalBytes: manifest.totalBytes, chunkBytes: manifest.chunkBytes };
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source || !options.out) {
    process.stderr.write(
      "Usage : node assemble-artifact.mjs <source> --out <fichier> [--size <octets>] [--chunk-size <octets>]\n",
    );
    return 2;
  }

  const manifest = await readManifest(options.source);
  const totalBytes = options.size ?? manifest?.totalBytes;
  const chunkBytes = manifest?.chunkBytes ?? options.chunkBytes;
  if (!totalBytes) {
    throw new Error(
      "Taille totale inconnue : fournissez --size ou publiez l'inventaire -parts.json",
    );
  }

  const { isZstd } = splitArtifactName(options.source);
  const parts = planParts(totalBytes, chunkBytes);
  const target = resolve(options.out);
  await mkdir(dirname(target), { recursive: true });

  log(
    `${parts.length} morceau(x) de ${Math.round(chunkBytes / 1048576)} Mio` +
      `${isZstd ? ", zstd" : ""} → ${Math.round(totalBytes / 1048576)} Mo`,
  );

  const output = createWriteStream(target);
  let downloaded = 0;
  try {
    for (const part of parts) {
      const location = partName(options.source, part.start, chunkBytes);
      const raw = await readPart(location);
      downloaded += raw.length;
      const payload = isZstd ? await decompress(raw) : raw;
      // Le dernier morceau est complété de zéros à l'écriture : on ne recopie
      // que les octets réellement utiles pour retrouver la taille exacte.
      const useful = payload.subarray(0, part.end - part.start);
      if (!output.write(useful)) await new Promise((r) => output.once("drain", r));
      if (part.index % 50 === 0) log(`morceau ${part.index + 1}/${parts.length}`);
    }
  } finally {
    await new Promise((resolveClose) => output.end(resolveClose));
  }

  // Garde-fou : un artefact d'une taille inattendue casserait la restauration
  // d'instantané bien plus loin, sans indice sur la cause.
  await truncate(target, totalBytes);
  const written = (await stat(target)).size;
  if (written !== totalBytes) {
    throw new Error(`Taille finale ${written}, attendue ${totalBytes}`);
  }
  log(
    `écrit ${options.out} (${Math.round(written / 1048576)} Mo, ${Math.round(downloaded / 1048576)} Mo transférés)`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`[assemble-artifact] ÉCHEC : ${error.message}\n`);
    process.exitCode = 1;
  },
);
