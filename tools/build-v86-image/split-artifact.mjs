#!/usr/bin/env node
// Découpe un artefact (disque de base, disque applicatif, instantané mémoire)
// en fichiers-parties publiables sur GitHub Pages, où aucun fichier ne peut
// dépasser 100 Mo (ADR 0001).
//
//   node tools/build-v86-image/split-artifact.mjs public/disks/demo-app.ext2
//   node tools/build-v86-image/split-artifact.mjs public/disks/base-3.3.ext2 --zstd
//   node tools/build-v86-image/split-artifact.mjs public/disks/demo-split-state.bin --gzip
//
// Options :
//   --chunk-size <octets>  taille de morceau (défaut : 4 Mio)
//   --zstd                 compresse chaque morceau (suffixe .zst, décompressé
//                          par v86 à la volée) — décisif sur un disque creux,
//                          dont les morceaux vides tombent à quelques octets
//   --gzip                 idem en gzip (suffixe .gz). Réservé aux artefacts que
//                          NOTRE code télécharge — l'instantané mémoire : le
//                          navigateur sait décompresser du gzip nativement
//                          (`DecompressionStream`) sur les trois moteurs, alors
//                          que le zstd n'y est arrivé que sur un seul. Les
//                          disques, eux, sont décompressés par v86 : ils
//                          gardent zstd, qui compresse mieux.
//   --out <dossier>        dossier de sortie (défaut : à côté de la source)
//
// Écrit aussi `<nom>-parts.json` : inventaire consommé par la publication, par
// la coquille (qui y lit taille totale et taille de morceau) et par les tests,
// qui n'ont ainsi pas à redériver la convention de nommage.
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip, zstdCompress } from "node:zlib";

import { DEFAULT_CHUNK_BYTES, MAX_PART_BYTES, partName, planParts } from "./artifact-parts.mjs";

const compressZstd = promisify(zstdCompress);
const compressGzip = promisify(gzip);

/** Suffixe de fichier de chaque compression reconnue. */
const COMPRESSION_SUFFIXES = { zstd: ".zst", gzip: ".gz" };

/**
 * Compresse un morceau selon le mode demandé.
 * @param {Buffer} buffer morceau brut, toujours de la taille nominale
 * @param {"zstd"|"gzip"|null} compression
 * @returns {Promise<Buffer>}
 */
function compressPart(buffer, compression) {
  if (compression === "zstd") return compressZstd(buffer);
  // Niveau 9 : c'est ce que payait déjà l'instantané publié d'un seul tenant,
  // et le temps de compression se dilue dans une construction de vingt minutes.
  if (compression === "gzip") return compressGzip(buffer, { level: 9 });
  return Promise.resolve(buffer);
}

function log(message) {
  process.stdout.write(`[split-artifact] ${message}\n`);
}

/**
 * @param {string[]} argv
 * @returns {{ source: string|undefined, chunkBytes: number,
 *   compression: "zstd"|"gzip"|null, out: string|null }}
 */
export function parseArgs(argv) {
  const options = {
    /** @type {string|undefined} */ source: undefined,
    chunkBytes: DEFAULT_CHUNK_BYTES,
    /** @type {"zstd"|"gzip"|null} */ compression: null,
    /** @type {string|null} */ out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--chunk-size") options.chunkBytes = Number(argv[++i]);
    else if (argv[i] === "--zstd") options.compression = "zstd";
    else if (argv[i] === "--gzip") options.compression = "gzip";
    else if (argv[i] === "--out") options.out = argv[++i];
    else if (!argv[i].startsWith("--")) options.source = argv[i];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) {
    process.stderr.write(
      "Usage : node split-artifact.mjs <artefact> [--chunk-size <octets>] [--zstd|--gzip] [--out <dossier>]\n",
    );
    return 2;
  }

  const sourcePath = resolve(options.source);
  const { size } = await stat(sourcePath);
  const parts = planParts(size, options.chunkBytes);
  const outDir = options.out ? resolve(options.out) : dirname(sourcePath);
  await mkdir(outDir, { recursive: true });

  // L'URL de référence porte le suffixe de compression : c'est elle que reçoit
  // le consommateur (v86 pour un disque, la coquille pour l'instantané), et
  // c'est d'elle qu'il dérive les noms de morceaux.
  const suffix = options.compression ? COMPRESSION_SUFFIXES[options.compression] : "";
  const artifactName = basename(sourcePath) + suffix;
  log(
    `${basename(sourcePath)} — ${Math.round(size / 1048576)} Mo en ${parts.length} morceau(x) ` +
      `de ${Math.round(options.chunkBytes / 1048576)} Mio` +
      `${options.compression ? `, ${options.compression}` : ""}`,
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
      const payload = await compressPart(buffer, options.compression);
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
    compression: options.compression,
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
