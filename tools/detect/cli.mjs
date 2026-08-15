#!/usr/bin/env node
// Analyse une application Rails et imprime son rapport d'incompatibilité :
//   node tools/detect/cli.mjs <dossier-application>
// Sort en 1 si un diagnostic bloquant existe, 2 en cas d'échec de l'analyse.
import { join } from "node:path";
import { detectApp, readOptionalFile } from "./detect.mjs";
import { mergeManifest, parseRailsboxYml } from "./manifest.mjs";
import { formatReport, hasBlocking } from "./report.mjs";

const EXIT_BLOCKING = 1;
const EXIT_USAGE = 2;

async function main() {
  const appDir = process.argv[2];
  if (!appDir) {
    console.error("Usage : node tools/detect/cli.mjs <dossier-application>");
    return EXIT_USAGE;
  }
  const detected = await detectApp(appDir);
  const findings = [...detected.findings];
  let manifest = detected.manifest;

  const declaredText = await readOptionalFile(join(appDir, "railsbox.yml"));
  if (declaredText !== null) {
    const declared = parseRailsboxYml(declaredText);
    findings.push(...declared.findings);
    const merged = mergeManifest(manifest, declared.manifest);
    manifest = merged.manifest;
    findings.push(...merged.findings);
  }

  console.log(formatReport({ manifest, findings }));
  return hasBlocking(findings) ? EXIT_BLOCKING : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Échec de l'analyse : ${error.message}`);
    process.exitCode = EXIT_USAGE;
  },
);
