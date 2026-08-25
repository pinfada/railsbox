import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildArgs } from "../tools/build-v86-image/manifest-to-args.mjs";
import { buildPrecompiledAssetsInitializer } from "../tools/build-v86-image/precompiled-assets.mjs";

test("l'initialiseur désactive la compilation et résout le manifeste précompilé", () => {
  const source = buildPrecompiledAssetsInitializer();

  assert.match(source, /assets\.compile = false/);
  assert.match(source, /\.sprockets-manifest-/);
  assert.match(source, /define_singleton_method\(:find_asset\)/);
  assert.match(source, /asset_host = nil/);
});

test("l'initialiseur n'est émis que pour l'étage d'assets hôte", () => {
  const base = {
    ruby: "3.3.0",
    database: "sqlite3",
    nativeGems: [],
    services: {},
  };
  const host = buildArgs({
    manifest: {
      ...base,
      assets: { npm: true, scripts: ["build"], install: "npm ci" },
    },
    specs: new Map(),
    hasSeeds: false,
    appName: "demo",
  });
  const guest = buildArgs({
    manifest: { ...base, assets: { npm: false, scripts: [] } },
    specs: new Map(),
    hasSeeds: false,
    appName: "demo",
  });

  assert.match(host.PRECOMPILED_ASSETS_INITIALIZER, /assets\.compile = false/);
  assert.equal(guest.PRECOMPILED_ASSETS_INITIALIZER, "");
});

test("le Dockerfile reçoit et vérifie l'initialiseur", () => {
  const dockerfile = readFileSync("tools/build-v86-image/base/app.Dockerfile", "utf8");
  const script = readFileSync("tools/build-v86-image/build-app-disk.sh", "utf8");

  assert.match(dockerfile, /ARG PRECOMPILED_ASSETS_INITIALIZER=""/);
  assert.match(dockerfile, /zzz_railsbox_precompiled_assets\.rb/);
  assert.match(script, /--build-arg "PRECOMPILED_ASSETS_INITIALIZER=/);
});
