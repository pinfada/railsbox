import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHUNK_BYTES,
  MAX_PART_BYTES,
  partName,
  planParts,
  splitArtifactName,
} from "../tools/build-v86-image/artifact-parts.mjs";
import { buildDiskImages } from "../public/shared/v86-config.js";

const MIB = 1024 * 1024;

test("splitArtifactName isole l'extension et le marqueur zstd", () => {
  assert.deepEqual(splitArtifactName("/disks/demo-app.ext2"), {
    basename: "/disks/demo-app-",
    extension: ".ext2",
    isZstd: false,
  });
  assert.deepEqual(splitArtifactName("/disks/demo-app.ext2.zst"), {
    basename: "/disks/demo-app-",
    extension: ".ext2.zst",
    isZstd: true,
  });
});

test("splitArtifactName n'ajoute pas de séparateur à un répertoire", () => {
  // v86 accepte une base déjà terminée par « / » : les morceaux sont alors
  // « /disks/parts/0-4194304 » et non « /disks/parts/-0-4194304 ».
  const { basename } = splitArtifactName("/disks/parts/");
  assert.equal(basename, "/disks/parts/");
});

test("partName suit la convention de nommage de v86", () => {
  assert.equal(partName("/disks/demo-app.ext2", 0, 4 * MIB), "/disks/demo-app-0-4194304.ext2");
  assert.equal(
    partName("/disks/demo-app.ext2", 4 * MIB, 4 * MIB),
    "/disks/demo-app-4194304-8388608.ext2",
  );
  assert.equal(
    partName("/disks/base-3.3.ext2.zst", 8 * MIB, 4 * MIB),
    "/disks/base-3.3-8388608-12582912.ext2.zst",
  );
});

test("planParts découpe un artefact multiple de la taille de morceau", () => {
  const parts = planParts(512 * MIB, 4 * MIB);
  assert.equal(parts.length, 128);
  assert.deepEqual(parts[0], { index: 0, start: 0, end: 4 * MIB, padded: 0 });
  assert.deepEqual(parts[127], {
    index: 127,
    start: 508 * MIB,
    end: 512 * MIB,
    padded: 0,
  });
});

test("planParts signale le complément de zéros du dernier morceau", () => {
  const parts = planParts(10 * MIB, 4 * MIB);
  assert.equal(parts.length, 3);
  assert.equal(parts[2].end, 10 * MIB);
  // v86 lit toujours un morceau entier : le dernier est complété à 4 Mio.
  assert.equal(parts[2].padded, 2 * MIB);
});

test("planParts refuse des tailles invalides", () => {
  assert.throws(() => planParts(0), /Taille d'artefact invalide/);
  assert.throws(() => planParts(-1), /Taille d'artefact invalide/);
  assert.throws(() => planParts(1024, 0), /Taille de morceau invalide/);
});

test("planParts refuse un morceau au-delà de la limite GitHub Pages", () => {
  assert.throws(() => planParts(1024 * MIB, MAX_PART_BYTES + 1), /GitHub Pages/);
  assert.equal(planParts(MAX_PART_BYTES, MAX_PART_BYTES).length, 1);
});

test("le morceau par défaut divise exactement le disque applicatif de 512 Mo", () => {
  assert.equal((512 * MIB) % DEFAULT_CHUNK_BYTES, 0);
  assert.ok(DEFAULT_CHUNK_BYTES <= MAX_PART_BYTES);
});

test("buildDiskImages active use_parts quand la config donne une taille de morceau", () => {
  const images = buildDiskImages({
    disk: "/disks/base-3.3.ext2.zst",
    diskSize: 1610612736,
    diskChunkSize: 4 * MIB,
    appDisk: "/disks/demo-app.ext2.zst",
    appDiskSize: 512 * MIB,
    appDiskChunkSize: 4 * MIB,
  });
  assert.equal(images.hda.use_parts, true);
  assert.equal(images.hda.fixed_chunk_size, 4 * MIB);
  assert.equal(images.hdb?.use_parts, true);
  assert.equal(images.hdb?.fixed_chunk_size, 4 * MIB);
});

test("buildDiskImages laisse un disque d'un seul tenant intact", () => {
  const images = buildDiskImages({
    disk: "/disks/base-3.3.ext2",
    diskSize: 1610612736,
    appDisk: "/disks/demo-app.ext2",
    appDiskSize: 512 * MIB,
  });
  assert.equal("use_parts" in images.hda, false);
  assert.equal("fixed_chunk_size" in images.hda, false);
  assert.equal("use_parts" in (images.hdb ?? {}), false);
});

test("buildDiskImages peut découper un seul des deux disques", () => {
  // Cas réel visé : rootfs de base découpé pour Pages, disque applicatif
  // suffisamment petit pour être servi d'un seul tenant.
  const images = buildDiskImages({
    disk: "/disks/base-3.3.ext2",
    diskChunkSize: 4 * MIB,
    appDisk: "/disks/demo-app.ext2",
  });
  assert.equal(images.hda.use_parts, true);
  assert.equal("use_parts" in (images.hdb ?? {}), false);
});
