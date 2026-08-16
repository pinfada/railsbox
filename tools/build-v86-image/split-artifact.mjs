#!/usr/bin/env node
// Découpe un artefact (disque de base, disque applicatif) en fichiers-parties
// lisibles par v86 (`use_parts`) et publiables sur GitHub Pages, où aucun
// fichier ne peut dépasser 100 Mo (ADR 0001).
//
//   node tools/build-v86-image/split-artifact.mjs public/disks/demo-app.ext2
//   node tools/build-v86-image/split-artifact.mjs public/disks/base-3.3.ext2 --zstd
//
// Options :
//   --chunk-size <octets>  taille de morceau (défaut : 4 Mio)
//   --zstd                 compresse chaque morceau (suffixe .zst, décompressé
//                          par v86 à la volée) — décisif sur un disque creux,
//                          dont les morceaux vides tombent à quelques octets
//   --out <dossier>        dossier de sortie (défaut : à côté de la source)
//
// Écrit aussi `<nom>-parts.json` : inventaire consommé par la publication et
// par les tests, qui n'ont pas à redériver la convention de nommage.
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";

import { DEFAULT_CHUNK_BYTES, MAX_PART_BYTES, partName, planParts } from "./artifact-parts.mjs";

const compress = promisify(zstdCompress);

function log(message) {
  process.stdout.write(`[split-artifact] ${message}\n`);
}

/**
 * @param {string[]} argv
 * @returns {{ source: string|undefined, chunkBytes: number, zstd: boolean, out: string|null }}
 */
export function parseArgs(argv) {
  const options = {
    /** @type {string|undefined} */ source: undefined,
    chunkBytes: DEFAULT_CHUNK_BYTES,
    zstd: false,
    /** @type {string|null} */ out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--chunk-size") options.chunkBytes = Number(argv[++i]);
    else if (argv[i] === "--zstd") options.zstd = true;
    else if (argv[i] === "--out") options.out = argv[++i];
    else if (!argv[i].startsWith("--")) options.source = argv[i];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) {
    process.stderr.write(
      "Usage : node split-artifact.mjs <artefact> [--chunk-size <octets>] [--zstd] [--out <dossier>]\n",
    );
    return 2;
  }

  const sourcePath = resolve(options.source);
  const { size } = await stat(sourcePath);
  const parts = planParts(size, options.chunkBytes);
  const outDir = options.out ? resolve(options.out) : dirname(sourcePath);
  await mkdir(outDir, { recursive: true });

  // L'URL de référence porte le suffixe .zst quand les morceaux sont
  // compressés : c'est elle que v86 reçoit, et dont il dérive les noms.
  const artifactName = basename(sourcePath) + (options.zstd ? ".zst" : "");
  log(
    `${basename(sourcePath)} — ${Math.round(size / 1048576)} Mo en ${parts.length} morceau(x) ` +
      `de ${Math.round(options.chunkBytes / 1048576)} Mio${options.zstd ? ", zstd" : ""}`,
  );

  const handle = await open(sourcePath, "r");
  let writtenBytes = 0;
  try {
    for (const part of parts) {
      // Tampon toujours de la taille NOMINALE du morceau : le complément de
      // zéros du dernier morceau est implicite (Buffer.alloc), et v86 lit
      // toujours un morceau entier.
      const buffer = Buffer.alloc(options.chunkBytes);
      await handle.read(buffer, 0, part.end - part.start, part.start);
      const payload = options.zstd ? await compress(buffer) : buffer;
      if (payload.length > MAX_PART_BYTES) {
        throw new Error(
          `Morceau ${part.index} de ${payload.length} octets au-delà de la limite Pages.`,
        );
      }
      const target = join(outDir, basename(partName(artifactName, part.start, options.chunkBytes)));
      await writeFile(target, payload);
      writtenBytes += payload.length;
    }
  } finally {
    await handle.close();
  }

  const manifest = {
    artifact: artifactName,
    totalBytes: size,
    chunkBytes: options.chunkBytes,
    compression: options.zstd ? "zstd" : null,
    partCount: parts.length,
    publishedBytes: writtenBytes,
    parts: parts.map((part) => basename(partName(artifactName, part.start, options.chunkBytes))),
  };
  const manifestPath = join(outDir, `${basename(sourcePath)}-parts.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const ratio = size === 0 ? 0 : Math.round((writtenBytes / size) * 100);
  log(`publié ${Math.round(writtenBytes / 1048576)} Mo (${ratio} % de l'original)`);
  log(`inventaire écrit : ${basename(manifestPath)}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`[split-artifact] ÉCHEC : ${error.message}\n`);
    process.exitCode = 1;
  },
);
