#!/usr/bin/env node
// Valide une configuration BASE + APPLICATION (ADR 0002) en restaurant son
// DELTA d'instantané avec le disque applicatif attaché — exactement ce que fait
// le visiteur. Prouve que GET <mountPath>/ renvoie un 2xx et affiche l'entête +
// le début du corps (la page Posts pré-seedée).
//
//   node tools/build-v86-image/validate-split.mjs [demo-split-config.json] [--path /app/]
//
// Sort en 0 si le statut HTTP est < 400, en 1 sinon.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootHarness } from "../vm-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../..");
const BODY_PREVIEW_BYTES = 1500;

function log(message) {
  process.stdout.write(`[validate-split] ${message}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const pathFlag = args.indexOf("--path");
  const configName = args.find((value) => !value.startsWith("--")) ?? "demo-split-config.json";
  const probePath = pathFlag === -1 ? "/app/" : args[pathFlag + 1];

  log(`restauration du delta (${configName}) + disque applicatif attaché…`);
  const startedAt = Date.now();
  const harness = await bootHarness({
    projectRoot: PROJECT_ROOT,
    configName,
    onLog: (line) => {
      if (/error|fatal|Listening|pont serie pret|montage/i.test(line))
        log(`vm: ${line.slice(0, 160)}`);
    },
  });

  try {
    await harness.waitUntilReady();
    const response = await harness.request({ method: "GET", path: probePath, headers: [] });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const body = Buffer.from(response.body ?? new Uint8Array());
    log(`prêt en ${seconds} s (restauration ${harness.wasRestored ? "delta" : "boot à froid"})`);
    log(
      `GET ${probePath} → HTTP ${response.status} ${response.statusText} (${body.length} octets)`,
    );
    const preview = body.subarray(0, BODY_PREVIEW_BYTES).toString("utf8");
    process.stdout.write(`\n${preview}\n`);
    harness.stop();
    await new Promise((r) => setTimeout(r, 1_000));
    if (!Number.isFinite(response.status) || response.status >= 400) {
      throw new Error(`statut HTTP inattendu : ${response.status}`);
    }
    process.exit(0);
  } catch (error) {
    harness.stop();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`[validate-split] ÉCHEC : ${error.message}\n`);
  process.exit(1);
});
