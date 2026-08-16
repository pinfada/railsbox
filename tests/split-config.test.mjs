import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_DISK_BYTES,
  BASE_SYSTEM_PACKAGES,
  buildSplitConfig,
  checkAppDiskFit,
  unsupportedPackages,
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

test("buildSplitConfig en production : base cross-origin, application relative", () => {
  const config = buildSplitConfig({
    name: "demo",
    baseName: "base-3.3",
    baseDiskBytes: 1519386624,
    baseUrl: "https://pinfada.github.io/railsbox-assets/base-3.3/",
    baseChunkBytes: 4 * 1024 * 1024,
    appChunkBytes: 4 * 1024 * 1024,
    statePath: "disks/demo-split-state.bin",
    builtAt: "2026-08-16T00:00:00Z",
  });
  const racine = "https://pinfada.github.io/railsbox-assets/base-3.3";
  assert.equal(config.disk, `${racine}/base-3.3.ext2.zst`);
  assert.equal(config.kernel, `${racine}/base-3.3-vmlinuz`);
  assert.equal(config.initrd, `${racine}/base-3.3-initrd`);
  assert.equal(config.diskChunkSize, 4 * 1024 * 1024);
  // Relatif, sans barre oblique de tête : un Pages de projet sert sous
  // /depot/, où un chemin absolu sortirait du site.
  assert.equal(config.appDisk, "disks/demo-app.ext2.zst");
  assert.equal(config.appDiskChunkSize, 4 * 1024 * 1024);
  assert.equal(config.state, "disks/demo-split-state.bin");
  assert.equal(isBootableConfig(config), true);
  assert.equal(isSplitConfig(config), true);
});

test("buildSplitConfig conserve la forme locale sans baseUrl", () => {
  const config = buildSplitConfig({ name: "demo", baseName: "base-3.3", baseDiskBytes: 1 });
  assert.equal(config.disk, "/disks/base-3.3.ext2");
  assert.equal(config.appDisk, "/disks/demo-app.ext2");
  assert.equal("diskChunkSize" in config, false);
  assert.equal("appDiskChunkSize" in config, false);
});

test("buildSplitConfig tolère une barre oblique finale sur baseUrl", () => {
  const avec = buildSplitConfig({
    name: "d",
    baseName: "b",
    baseDiskBytes: 1,
    baseUrl: "https://exemple.test/a/",
  });
  const sans = buildSplitConfig({
    name: "d",
    baseName: "b",
    baseDiskBytes: 1,
    baseUrl: "https://exemple.test/a",
  });
  assert.equal(avec.disk, sans.disk);
  assert.equal(avec.disk, "https://exemple.test/a/b.ext2");
});

test("unsupportedPackages accepte ce que la base fournit déjà", () => {
  assert.deepEqual(unsupportedPackages("libsqlite3-dev libxml2-dev libxslt1-dev"), []);
  // PostgreSQL fait partie de la base depuis la révision 3.3-r2.
  assert.deepEqual(unsupportedPackages("libpq-dev postgresql postgresql-client"), []);
  assert.deepEqual(unsupportedPackages(BASE_SYSTEM_PACKAGES), []);
});

test("unsupportedPackages signale les bibliothèques absentes de la base", () => {
  assert.deepEqual(unsupportedPackages("libsqlite3-dev libvips-dev libvips42"), [
    "libvips-dev",
    "libvips42",
  ]);
});

test("unsupportedPackages tolère une liste vide ou mal espacée", () => {
  assert.deepEqual(unsupportedPackages(""), []);
  assert.deepEqual(unsupportedPackages("   "), []);
  assert.deepEqual(unsupportedPackages([]), []);
  // Doublons repliés : le message d'erreur ne doit pas répéter un paquet.
  assert.deepEqual(unsupportedPackages("libvips-dev  libvips-dev"), ["libvips-dev"]);
});

test("buildSplitConfig omet state quand aucun instantané n'est fourni", () => {
  const config = buildSplitConfig({
    name: "demo",
    baseName: "base-3.3",
    baseDiskBytes: 1,
  });
  assert.equal("state" in config, false);
});
