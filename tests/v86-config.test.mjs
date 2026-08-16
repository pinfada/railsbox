import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiskImages,
  isBootableConfig,
  isSplitConfig,
  memoryBytes,
} from "../public/shared/v86-config.js";

const MONO = {
  kernel: "/disks/demo-vmlinuz",
  initrd: "/disks/demo-initrd",
  disk: "/disks/demo.ext2",
  diskSize: 1969225728,
};

const SPLIT = {
  kernel: "/disks/base-3.3-vmlinuz",
  initrd: "/disks/base-3.3-initrd",
  disk: "/disks/base-3.3.ext2",
  diskSize: 1610612736,
  appDisk: "/disks/demo-app.ext2",
  appDiskSize: 536870912,
};

test("isBootableConfig exige noyau, initrd et disque", () => {
  assert.equal(isBootableConfig(MONO), true);
  assert.equal(isBootableConfig(SPLIT), true);
  assert.equal(isBootableConfig(null), false);
  assert.equal(isBootableConfig({ disk: "/d", kernel: "/k" }), false, "initrd manquant");
  assert.equal(isBootableConfig({}), false);
});

test("isSplitConfig distingue mono-disque et base + application", () => {
  assert.equal(isSplitConfig(MONO), false);
  assert.equal(isSplitConfig(SPLIT), true);
});

test("buildDiskImages n'expose que hda pour une image mono-disque", () => {
  const images = buildDiskImages(MONO);
  assert.deepEqual(images, {
    hda: { url: "/disks/demo.ext2", async: true, size: 1969225728 },
  });
  assert.equal("hdb" in images, false, "pas de disque secondaire en mono-disque");
});

test("buildDiskImages ajoute hdb pour un montage base + application", () => {
  const images = buildDiskImages(SPLIT);
  assert.deepEqual(images.hda, { url: "/disks/base-3.3.ext2", async: true, size: 1610612736 });
  assert.deepEqual(images.hdb, { url: "/disks/demo-app.ext2", async: true, size: 536870912 });
});

test("buildDiskImages laisse size indéfini quand la config ne le précise pas", () => {
  const images = buildDiskImages({ disk: "/disks/x.ext2" });
  assert.equal(images.hda.url, "/disks/x.ext2");
  assert.equal(images.hda.size, undefined);
});

test("memoryBytes applique le défaut de 1 Go", () => {
  assert.equal(memoryBytes({}), 1024 * 1024 * 1024);
  assert.equal(memoryBytes({ memoryMb: 2048 }), 2048 * 1024 * 1024);
});
