// Test d'intégration du montage base + application (ADR 0002) contre une
// VRAIE VM v86 sous Node. S'ignore tant que les artefacts découpés n'existent
// pas (produits par tools/build-v86-image/base + build-app-disk).
//
// Ce que la suite prouve : un instantané delta capturé avec le disque
// applicatif attaché restaure correctement, monte le hdb sur /app, et
// l'application répond — y compris ses données seedées.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DISKS_DIR = join(PROJECT_ROOT, "public", "disks");
const SPLIT_CONFIG = "demo-split-config.json";

const configPath = join(DISKS_DIR, SPLIT_CONFIG);
const enabled = process.env.RAILSBOX_IT !== "0" && existsSync(configPath);

test(
  "montage base + application (VM v86 réelle, ADR 0002)",
  { skip: enabled ? false : "artefacts découpés absents", timeout: 900_000 },
  async (t) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.ok(config.appDisk, "la config découpée doit déclarer un disque applicatif");
    // Géométrie du hdb : le disque applicatif doit être padé exactement à la
    // taille du placeholder présent lors de la capture de l'instantané de base.
    assert.equal(typeof config.appDiskSize, "number", "appDiskSize requis pour la restauration");

    const { bootHarness } = await import("../../tools/vm-harness.mjs");
    const vm = await bootHarness({
      projectRoot: PROJECT_ROOT,
      configName: SPLIT_CONFIG,
      onLog: (line) => process.stdout.write(`[split] ${line}\n`),
    });
    t.after(() => vm.stop());

    await vm.waitUntilReady({
      onAttempt: (attempt, error) =>
        process.stdout.write(`[split] sonde n°${attempt}${error ? ` — ${error}` : " — OK"}\n`),
    });

    await t.test("le disque applicatif est monté et l'application répond", async () => {
      const response = await vm.request({ method: "GET", path: "/app/" });
      assert.ok(response.status >= 200 && response.status < 600, `statut : ${response.status}`);
      const body = new TextDecoder().decode(response.body);
      assert.ok(body.length > 500, `page trop courte (${body.length} o) — hdb non monté ?`);
    });

    await t.test("les données seedées sont servies (preuve du hdb pré-rempli)", async () => {
      // db/seeds.rb de la démo crée un post « Bienvenue dans railsbox ».
      const list = await vm.request({ method: "GET", path: "/app/posts" });
      const body = new TextDecoder().decode(list.body);
      assert.match(body, /railsbox/i, "le contenu seedé du disque applicatif doit apparaître");
    });
  },
);
