import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_DISK_BYTES,
  BASE_REVISIONS,
  BASE_SYSTEM_PACKAGES,
  PACKAGE_BASE_REVISIONS,
  UNSUPPORTED_ISSUE_URL,
  buildSplitConfig,
  checkAppDiskFit,
  packagesForRevision,
  refusalLines,
  requiredBaseRevision,
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
  // Le traitement d'images depuis la révision 3.3-r3 : libvips est le
  // processeur de variantes par défaut de Rails 7+, refuser une application qui
  // redimensionne une image reviendrait à refuser Rails moderne.
  assert.deepEqual(unsupportedPackages("libvips42 libvips-tools imagemagick"), []);
  assert.deepEqual(unsupportedPackages(BASE_SYSTEM_PACKAGES), []);
});

test("unsupportedPackages signale les bibliothèques absentes de la base", () => {
  // libvips-dev est ABSENT à dessein : ruby-vips est une liaison FFI, les
  // en-têtes coûteraient 170 Mo et n'achèteraient rien.
  assert.deepEqual(unsupportedPackages("libsqlite3-dev libvips-dev ffmpeg"), [
    "ffmpeg",
    "libvips-dev",
  ]);
});

test("unsupportedPackages compare à la révision de base réellement épinglée", () => {
  // Arrange / Act : la même application, jugée sur deux révisions.
  const surR2 = unsupportedPackages("libvips42 imagemagick libpq-dev", "3.3-r2");
  const surR3 = unsupportedPackages("libvips42 imagemagick libpq-dev", "3.3-r3");

  // Assert
  assert.deepEqual(surR2, ["imagemagick", "libvips42"]);
  assert.deepEqual(surR3, []);
  // PostgreSQL n'existe pas dans la toute première base.
  assert.deepEqual(unsupportedPackages("postgresql", "3.3"), ["postgresql"]);
});

test("une révision inconnue retombe sur la base la plus récente", () => {
  // Image locale sans tag, ou empreinte sha256 : on ne peut rien en déduire.
  assert.deepEqual(packagesForRevision("sha256:abcdef"), [...BASE_SYSTEM_PACKAGES]);
  assert.deepEqual(unsupportedPackages("libvips42", "latest"), []);
});

test("chaque paquet de la base est rattaché à une révision publiée", () => {
  for (const [paquet, revision] of Object.entries(PACKAGE_BASE_REVISIONS)) {
    assert.ok(
      BASE_REVISIONS.includes(revision),
      `${paquet} annonce la révision inconnue « ${revision} »`,
    );
  }
  assert.deepEqual(BASE_SYSTEM_PACKAGES, [...BASE_SYSTEM_PACKAGES].sort());
});

test("requiredBaseRevision retient la plus récente des révisions nécessaires", () => {
  assert.equal(requiredBaseRevision(["libsqlite3-dev", "postgresql"]), "3.3-r2");
  assert.equal(requiredBaseRevision(["libsqlite3-dev", "libvips42"]), "3.3-r3");
  assert.equal(requiredBaseRevision(["ffmpeg"]), null);
  assert.equal(requiredBaseRevision([]), null);
});

test("le refus nomme la révision à épingler quand elle existe", () => {
  // Arrange / Act
  const lignes = refusalLines(["imagemagick", "libvips42"]);
  const texte = lignes.join("\n");

  // Assert : la première ligne est celle que reconnaît le classifieur d'échecs.
  assert.equal(
    lignes[0],
    "✗ La base ne fournit pas les bibliothèques système : imagemagick libvips42",
  );
  assert.match(texte, /présents dans la base 3\.3-r3/);
  assert.match(texte, /base: 3\.3-r3/);
  assert.match(texte, /--base ghcr\.io\/pinfada\/railsbox-base:3\.3-r3/);
  // Aucune issue à ouvrir : le mainteneur a une sortie immédiate.
  assert.doesNotMatch(texte, /issues\/new/);
});

test("le refus renvoie au gabarit d'issue quand aucune base ne fournit le paquet", () => {
  // Arrange / Act
  const texte = refusalLines(["ffmpeg"]).join("\n");

  // Assert
  assert.match(texte, /aucune base publiée ne le fournit/);
  // La sortie normale est la surcouche, et le message le dit AVANT de parler
  // d'issue : ouvrir un ticket pour ffmpeg n'est utile que s'il déborde.
  assert.match(texte, /SURCOUCHE applicative/);
  assert.ok(texte.includes(UNSUPPORTED_ISSUE_URL));
  assert.match(texte, /Ma stack n'est pas prise en charge/);
  assert.doesNotMatch(texte, /Épinglez-la/);
});

test("le refus traite les deux cas à la fois sans les confondre", () => {
  // Arrange / Act : libvips existe ailleurs, ffmpeg nulle part.
  const texte = refusalLines(["ffmpeg", "libvips42"]).join("\n");

  // Assert
  assert.match(texte, /libvips42 : présent dans la base 3\.3-r3/);
  assert.match(texte, /ffmpeg : aucune base publiée ne le fournit/);
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
