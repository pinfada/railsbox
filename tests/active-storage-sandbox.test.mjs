import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  KEEP_VARIABLE,
  buildActiveStorageInitializer,
} from "../tools/build-v86-image/active-storage.mjs";
import { buildArgs } from "../tools/build-v86-image/manifest-to-args.mjs";

test("l'initialiseur Active Storage fournit un Disk local, gardé et désarmable", () => {
  const source = buildActiveStorageInitializer();

  assert.match(source, /RAILSBOX_SANDBOX/);
  assert.match(source, new RegExp(KEEP_VARIABLE));
  assert.match(source, /"service" => "Disk"/);
  assert.match(source, /service = :railsbox_local/);
});

test("buildArgs ne l'émet que pour Active Storage et respecte le désarmement", () => {
  const common = { hasSeeds: false, appName: "demo" };
  const specs = new Map([["activestorage", "8.1.0"]]);

  const enabled = buildArgs({ manifest: { database: "sqlite3" }, specs, ...common });
  const absent = buildArgs({ manifest: { database: "sqlite3" }, specs: new Map(), ...common });
  const kept = buildArgs({
    manifest: { database: "sqlite3", env: { [KEEP_VARIABLE]: "1" } },
    specs,
    ...common,
  });

  assert.match(enabled.ACTIVE_STORAGE_INITIALIZER, /railsbox_local/);
  assert.equal(absent.ACTIVE_STORAGE_INITIALIZER, "");
  assert.equal(kept.ACTIVE_STORAGE_INITIALIZER, "");
});

test("les deux chemins de construction déposent le même initialiseur", () => {
  for (const path of [
    "tools/build-v86-image/Dockerfile",
    "tools/build-v86-image/base/app.Dockerfile",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /ARG ACTIVE_STORAGE_INITIALIZER/);
    assert.match(source, /zzz_railsbox_active_storage\.rb/);
  }
});
