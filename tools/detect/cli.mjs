#!/usr/bin/env node
// Analyse une application Rails et imprime son rapport d'incompatibilité :
//   node tools/detect/cli.mjs <dossier-application> [--base 3.3-r2]
// `--base` désigne l'image de base visée : c'est elle qui fixe le Ruby que la
// VM exécutera, et donc la compatibilité de la contrainte du Gemfile.
// Sort en 1 si un diagnostic bloquant existe, 2 en cas d'échec de l'analyse.
import { join } from "node:path";
import { detectApp, readOptionalFile } from "./detect.mjs";
import { mergeManifest, parseRailsboxYml } from "./manifest.mjs";
import { formatReport, hasBlocking } from "./report.mjs";

const EXIT_BLOCKING = 1;
const EXIT_USAGE = 2;

async function main() {
  const argv = process.argv.slice(2);
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? undefined : argv[baseIndex + 1];
  const appDir = argv.filter((value, index) => {
    if (value.startsWith("--")) return false;
    return index !== baseIndex + 1 || baseIndex === -1;
  })[0];
  if (!appDir) {
    console.error("Usage : node tools/detect/cli.mjs <dossier-application> [--base <version>]");
    return EXIT_USAGE;
  }
  const detected = await detectApp(appDir, { base });
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
