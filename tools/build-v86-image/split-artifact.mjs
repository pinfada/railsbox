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
//   --fingerprint          versionne les noms publiés par EMPREINTE DE CONTENU
//                          (ADR 0007) : `demo-app.ext2` devient
//                          `demo-app-<empreinte>.ext2`, et v86 en dérive des
//                          morceaux tout aussi versionnés. Un nom stable au
//                          contenu changeant laissait tout cache — HTTP, CDN,
//                          Cache Storage — resservir légitimement le morceau
//                          d'une AUTRE construction.
//   --config <fichier>     accorde une configuration v86 aux noms réellement
//                          publiés : le champ qui nomme cet artefact y est
//                          réécrit. Exige --fingerprint, et échoue si aucun
//                          champ ne le nomme.
//   --out <dossier>        dossier de sortie (défaut : à côté de la source)
//
// Écrit aussi `<nom>-parts.json` : inventaire consommé par la publication, par
// la coquille (qui y lit taille totale et taille de morceau) et par les tests,
// qui n'ont ainsi pas à redériver la convention de nommage.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip, zstdCompress } from "node:zlib";

import {
  DEFAULT_CHUNK_BYTES,
  DIGEST_HEX_LENGTH,
  MAX_PART_BYTES,
  partName,
  planParts,
  versionedArtifactName,
} from "./artifact-parts.mjs";
import { replacePublishedArtifact } from "./split-config.mjs";

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
 *   compression: "zstd"|"gzip"|null, out: string|null,
 *   fingerprint: boolean, config: string|null }}
 */
export function parseArgs(argv) {
  const options = {
    /** @type {string|undefined} */ source: undefined,
    chunkBytes: DEFAULT_CHUNK_BYTES,
    /** @type {"zstd"|"gzip"|null} */ compression: null,
    /** @type {string|null} */ out: null,
    fingerprint: false,
    /** @type {string|null} */ config: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--chunk-size") options.chunkBytes = Number(argv[++i]);
    else if (argv[i] === "--zstd") options.compression = "zstd";
    else if (argv[i] === "--gzip") options.compression = "gzip";
    else if (argv[i] === "--fingerprint") options.fingerprint = true;
    else if (argv[i] === "--config") options.config = argv[++i];
    else if (argv[i] === "--out") options.out = argv[++i];
    else if (!argv[i].startsWith("--")) options.source = argv[i];
  }
  return options;
}

/**
 * Accorde une configuration v86 au nom réellement publié.
 *
 * Le découpeur est le SEUL à connaître l'empreinte — il vient de lire les
 * octets — et la configuration, elle, a été écrite avant lui. Cette
 * réconciliation est donc faite ici plutôt que de faire relire l'artefact à qui
 * que ce soit. La forme de la configuration, elle, reste la propriété de
 * split-config.mjs.
 *
 * ELLE POSE AUSSI LA MOITIÉ DU LIEN INSTANTANÉ/DISQUE (ADR 0009). Quand
 * l'artefact publié est le DISQUE APPLICATIF, son empreinte complète est
 * inscrite dans `appDiskSha256` : la capture a déjà écrit `stateForAppDiskSha256`
 * en lisant le disque qu'elle attachait, et c'est la divergence entre ces deux
 * lectures INDÉPENDANTES qui trahit un disque échangé entre les deux étapes.
 * Écrire les deux au même endroit les rendrait égales par construction, comme
 * l'étaient `stateFor` et `builtAt` — le défaut que l'issue #4 a démonté.
 *
 * SEUL LE CHAMP `appDisk` DÉCLENCHE L'ÉCRITURE. Le même outil découpe ensuite
 * l'instantané, avec la même ligne de commande à un nom près ; y inscrire
 * l'empreinte remplacerait celle du disque par celle de l'état, et le garde
 * prononcerait un désaccord sur une sandbox parfaitement saine.
 * @param {string} path chemin de la configuration à réécrire
 * @param {string} oldName nom publié jusque-là
 * @param {string} newName nom réellement publié
 * @param {string|null} sha256 empreinte complète de l'artefact, si versionné
 * @throws {Error} si la configuration ne nomme pas cet artefact
 */
async function reconcileConfig(path, oldName, newName, sha256) {
  const original = JSON.parse(await readFile(path, "utf8"));
  const { config, fields } = replacePublishedArtifact(original, oldName, newName);
  if (fields.length === 0) {
    throw new Error(
      `Aucun champ de ${basename(path)} ne nomme ${oldName} : la configuration publiée ` +
        "désignerait des morceaux qui n'existent pas.",
    );
  }
  const marque = sha256 && fields.includes("appDisk") ? { appDiskSha256: sha256 } : {};
  await writeFile(path, `${JSON.stringify({ ...config, ...marque }, null, 2)}\n`);
  log(`${basename(path)} : ${fields.join(", ")} → ${newName}`);
  if (marque.appDiskSha256) log(`${basename(path)} : appDiskSha256 → ${sha256}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) {
    process.stderr.write(
      "Usage : node split-artifact.mjs <artefact> [--chunk-size <octets>] [--zstd|--gzip] " +
        "[--fingerprint [--config <config v86>]] [--out <dossier>]\n",
    );
    return 2;
  }

  if (options.config && !options.fingerprint) {
    process.stderr.write("--config n'a de sens qu'avec --fingerprint (ADR 0007).\n");
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
  const plainName = basename(sourcePath) + suffix;
  log(
    `${basename(sourcePath)} — ${Math.round(size / 1048576)} Mo en ${parts.length} morceau(x) ` +
      `de ${Math.round(options.chunkBytes / 1048576)} Mio` +
      `${options.compression ? `, ${options.compression}` : ""}` +
      `${options.fingerprint ? ", noms versionnés" : ""}`,
  );

  // L'empreinte se calcule PENDANT la lecture qui découpe : l'artefact est lu
  // une seule fois, et le versionnement ne coûte donc rien de plus qu'un
  // SHA-256 sur des octets déjà en mémoire. Mais elle n'est complète qu'à la
  // fin, alors que le nom des morceaux en dépend : les morceaux sont donc
  // écrits sous un nom provisoire, puis renommés. Un renommage dans le même
  // dossier est atomique et gratuit, là où une seconde lecture coûterait
  // 512 Mo.
  const hash = createHash("sha256");
  const handle = await open(sourcePath, "r");
  /** @type {{ start: number, path: string }[]} */
  const written = [];
  let writtenBytes = 0;
  try {
    for (const part of parts) {
      // Tampon toujours de la taille NOMINALE du morceau : le complément de
      // zéros du dernier morceau est implicite (Buffer.alloc), et v86 lit
      // toujours un morceau entier.
      const buffer = Buffer.alloc(options.chunkBytes);
      await handle.read(buffer, 0, part.end - part.start, part.start);
      // L'empreinte porte sur le CONTENU RÉEL, pas sur le bourrage de zéros du
      // dernier morceau ni sur les octets compressés : deux constructions au
      // même contenu doivent s'accorder, quels que soient le compresseur et sa
      // version.
      hash.update(buffer.subarray(0, part.end - part.start));
      const payload = await compressPart(buffer, options.compression);
      if (payload.length > MAX_PART_BYTES) {
        throw new Error(
          `Morceau ${part.index} de ${payload.length} octets au-delà de la limite Pages.`,
        );
      }
      const target = join(outDir, `${plainName}.${part.index}.partiel`);
      await writeFile(target, payload);
      written.push({ start: part.start, path: target });
      writtenBytes += payload.length;
    }
  } finally {
    await handle.close();
  }

  // L'empreinte COMPLÈTE est conservée, pas seulement les douze caractères qui
  // nomment l'artefact : un nom doit rester court, une identité de contenu n'a
  // aucune raison de l'être (ADR 0009). Les deux sortent de la même lecture.
  const sha256 = hash.digest("hex");
  const digest = sha256.slice(0, DIGEST_HEX_LENGTH);
  const artifactName = options.fingerprint
    ? versionedArtifactName(basename(sourcePath), digest) + suffix
    : plainName;
  for (const { start, path } of written) {
    await rename(path, join(outDir, basename(partName(artifactName, start, options.chunkBytes))));
  }

  const manifest = {
    artifact: artifactName,
    ...(options.fingerprint ? { digest, sha256 } : {}),
    totalBytes: size,
    chunkBytes: options.chunkBytes,
    compression: options.compression,
    partCount: parts.length,
    publishedBytes: writtenBytes,
    parts: parts.map((part) => basename(partName(artifactName, part.start, options.chunkBytes))),
  };
  // L'inventaire est nommé d'après l'artefact NON compressé : c'est la règle
  // que redérivent la coquille (`manifestUrlFor`) et le réassembleur, sans se
  // concerter. Le versionnement la suit donc de lui-même.
  const manifestPath = join(
    outDir,
    `${artifactName.slice(0, artifactName.length - suffix.length)}-parts.json`,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (options.config) {
    await reconcileConfig(
      options.config,
      plainName,
      artifactName,
      options.fingerprint ? sha256 : null,
    );
  }

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
