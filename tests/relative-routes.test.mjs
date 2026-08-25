import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildArgs } from "../tools/build-v86-image/manifest-to-args.mjs";
import { buildRelativeRoutesInitializer } from "../tools/build-v86-image/relative-routes.mjs";

test("l'initialiseur retire seulement le prefixe public de recognize_path", () => {
  const source = buildRelativeRoutesInitializer();

  assert.match(source, /RAILSBOX_SANDBOX/);
  assert.match(source, /RAILS_RELATIVE_URL_ROOT/);
  assert.match(source, /path == prefix \|\| path\.start_with\?/);
  assert.match(source, /super\(path, environment\)/);
  assert.match(source, /RouteSet\.prepend/);
});

test("l'initialiseur est fourni a toutes les images applicatives", () => {
  const args = buildArgs({
    manifest: {
      ruby: "3.3.0",
      database: "sqlite3",
      nativeGems: [],
      services: {},
      assets: { npm: false, scripts: [] },
    },
    specs: new Map(),
    hasSeeds: false,
    appName: "demo",
  });

  assert.match(args.RELATIVE_ROUTES_INITIALIZER, /RailsboxRelativeRoutes/);
});

test("le Dockerfile recoit et verifie l'initialiseur de routes", () => {
  const dockerfile = readFileSync("tools/build-v86-image/base/app.Dockerfile", "utf8");
  const script = readFileSync("tools/build-v86-image/build-app-disk.sh", "utf8");

  assert.match(dockerfile, /ARG RELATIVE_ROUTES_INITIALIZER=""/);
  assert.match(dockerfile, /zzz_railsbox_relative_routes\.rb/);
  assert.match(script, /--build-arg "RELATIVE_ROUTES_INITIALIZER=/);
});
