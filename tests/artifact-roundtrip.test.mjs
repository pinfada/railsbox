// Aller-retour découpage → réassemblage. C'est la garantie sur laquelle repose
// tout le chantier C : le mainteneur capture son delta contre le rootfs de base
// qu'il a réassemblé depuis les morceaux publiés, et le navigateur lit ces
// mêmes morceaux. Si le réassemblage n'est pas identique à l'octet près, la
// restauration d'instantané part sur un cache de blocs divergent (ADR 0002) —
// une panne qui se manifesterait très loin de sa cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const TOOLS = fileURLToPath(new URL("../tools/build-v86-image/", import.meta.url));
const MIB = 1024 * 1024;
const CHUNK = 4 * MIB;

/**
 * Contenu déterministe et partiellement compressible : des zéros (les creux
 * d'un ext2) mêlés à du bruit reproductible (les données réelles). Un contenu
 * uniquement nul ne prouverait rien sur la compression.
 * @param {number} size
 * @returns {Buffer}
 */
function syntheticDisk(size) {
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 8192) {
    if ((offset / 8192) % 3 === 0) continue; // laisse un tiers en creux
    for (let i = 0; i < 512 && offset + i < size; i += 1) {
      buffer[offset + i] = (offset + i * 31) % 251;
    }
  }
  return buffer;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Suffixe de fichier de chaque compression, comme split-artifact.mjs. */
const SUFFIXES = { zstd: ".zst", gzip: ".gz", null: "" };

/**
 * Découpe puis réassemble, et rend les empreintes de part et d'autre.
 * @param {number} size taille de l'artefact synthétique
 * @param {"zstd"|"gzip"|null} compression
 */
async function roundTrip(size, compression) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-parts-"));
  try {
    const source = join(dir, "disque.ext2");
    const original = syntheticDisk(size);
    await writeFile(source, original);

    const splitArgs = [join(TOOLS, "split-artifact.mjs"), source, "--out", join(dir, "parts")];
    if (compression) splitArgs.push(`--${compression}`);
    await run(process.execPath, splitArgs);

    const assembled = join(dir, "reassemble.ext2");
    await run(process.execPath, [
      join(TOOLS, "assemble-artifact.mjs"),
      join(dir, "parts", `disque.ext2${SUFFIXES[String(compression)]}`),
      "--out",
      assembled,
    ]);

    const manifest = JSON.parse(
      await readFile(join(dir, "parts", "disque.ext2-parts.json"), "utf8"),
    );
    return { original: sha256(original), assembled: sha256(await readFile(assembled)), manifest };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("aller-retour identique à l'octet près, morceaux non compressés", async () => {
  const { original, assembled, manifest } = await roundTrip(10 * MIB, null);
  assert.equal(assembled, original);
  assert.equal(manifest.compression, null);
  assert.equal(manifest.partCount, 3);
});

test("aller-retour identique à l'octet près, morceaux zstd", async () => {
  const { original, assembled, manifest } = await roundTrip(10 * MIB, "zstd");
  assert.equal(assembled, original);
  assert.equal(manifest.compression, "zstd");
  assert.equal(manifest.artifact, "disque.ext2.zst");
});

test("aller-retour identique à l'octet près, morceaux gzip", async () => {
  // Le format de l'INSTANTANÉ mémoire (ADR 0003, extension de 2026-08-17) :
  // gzip et non zstd, parce que c'est la coquille qui décompresse, avec
  // `DecompressionStream` — présent sur les trois moteurs, à la différence du
  // zstd. Les disques, décompressés par v86 lui-même, gardent zstd.
  const { original, assembled, manifest } = await roundTrip(10 * MIB, "gzip");
  assert.equal(assembled, original);
  assert.equal(manifest.compression, "gzip");
  assert.equal(manifest.artifact, "disque.ext2.gz");
});

test("une taille non multiple du morceau se réassemble sans les zéros de bourrage", async () => {
  // 10 Mio pour un morceau de 4 Mio : le dernier morceau est complété de 2 Mio
  // de zéros à l'écriture. Le réassemblage doit les retirer, sinon le disque
  // grossit et v86 refuse la géométrie.
  const size = 10 * MIB;
  const { original, assembled, manifest } = await roundTrip(size, "zstd");
  assert.equal(assembled, original);
  assert.equal(manifest.totalBytes, size);
  assert.equal(manifest.chunkBytes, CHUNK);
});

test("l'inventaire publié suffit à réassembler sans connaître la taille", async () => {
  // assemble-artifact n'a reçu ni --size ni --chunk-size dans roundTrip :
  // s'il a produit le bon fichier, c'est qu'il a lu l'inventaire.
  const { original, assembled } = await roundTrip(6 * MIB, "zstd");
  assert.equal(assembled, original);
});
