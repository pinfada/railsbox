import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { localDiskImages } from "../tools/build-v86-image/validate-boot.mjs";
import { readFileSync } from "node:fs";

test("validate-boot conserve un seul disque pour une configuration monolithique", () => {
  const images = localDiskImages({ disk: "/disks/demo.ext2", diskSize: 123 });

  assert.deepEqual(images.hda, {
    url: join(process.cwd(), "public", "disks", "demo.ext2"),
    async: true,
    size: 123,
  });
  assert.equal("hdb" in images, false);
});

test("validate-boot attache le disque applicatif d'une configuration split", () => {
  const images = localDiskImages({
    disk: "/disks/base.ext2",
    diskSize: 456,
    appDisk: "/disks/shop-app.ext2",
    appDiskSize: 789,
  });

  assert.deepEqual(images.hdb, {
    url: join(process.cwd(), "public", "disks", "shop-app.ext2"),
    async: true,
    size: 789,
  });
});

test("validate-boot déclenche le montage applicatif pour une configuration split", () => {
  const source = readFileSync(
    join(process.cwd(), "tools", "build-v86-image", "validate-boot.mjs"),
    "utf8",
  );

  assert.match(source, /config\.appDisk[\s\S]*bridge\.restartApplication\(\)/);
  assert.match(source, /buildRestartFrame/);
});
