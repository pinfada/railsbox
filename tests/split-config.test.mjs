import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_DISK_BYTES,
  buildSplitConfig,
  checkAppDiskFit,
} from "../tools/build-v86-image/split-config.mjs";
import { isBootableConfig, isSplitConfig } from "../public/shared/v86-config.js";

test("APP_DISK_BYTES vaut 512 Mo pile", () => {
  assert.equal(APP_DISK_BYTES, 536870912);
});

test("checkAppDiskFit accepte un contenu qui rentre", () => {
  const { ok, targetBytes, freeBytes } = checkAppDiskFit(300 * 1024 * 1024);
  assert.equal(ok, true);
  assert.equal(targetBytes, APP_DISK_BYTES);
  assert.equal(freeBytes, APP_DISK_BYTES - 300 * 1024 * 1024);
});

test("checkAppDiskFit refuse un contenu qui déborde", () => {
  const { ok, freeBytes } = checkAppDiskFit(600 * 1024 * 1024);
  assert.equal(ok, false);
  assert.ok(freeBytes < 0);
});

test("buildSplitConfig émet une config split valide et bootable", () => {
  const config = buildSplitConfig({
    name: "demo",
    baseName: "base-3.3",
    baseDiskBytes: 1610612736,
    statePath: "/disks/demo-split-state.bin",
    builtAt: "2026-08-16T00:00:00Z",
  });
  assert.equal(isBootableConfig(config), true);
  assert.equal(isSplitConfig(config), true);
  assert.equal(config.disk, "/disks/base-3.3.ext2");
  assert.equal(config.appDisk, "/disks/demo-app.ext2");
  assert.equal(config.appDiskSize, APP_DISK_BYTES);
  assert.equal(config.kernel, "/disks/base-3.3-vmlinuz");
  assert.equal(config.initrd, "/disks/base-3.3-initrd");
  assert.equal(config.state, "/disks/demo-split-state.bin");
  assert.equal(config.mountPath, "/app");
});

test("buildSplitConfig omet state quand aucun instantané n'est fourni", () => {
  const config = buildSplitConfig({
    name: "demo",
    baseName: "base-3.3",
    baseDiskBytes: 1,
  });
  assert.equal("state" in config, false);
});
