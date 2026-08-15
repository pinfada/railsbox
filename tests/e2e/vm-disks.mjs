// Portail d'exécution des tests VM. Les artefacts de public/disks/ pèsent
// plusieurs gigaoctets et ne sont pas versionnés (voir .gitignore) : la CI
// ne les a pas. Les tests qui en dépendent se déclarent donc ignorés au lieu
// d'échouer, sans masquer pour autant les tests qui n'en ont pas besoin.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DISKS_DIR = fileURLToPath(new URL("../../public/disks/", import.meta.url));

// Artefacts minimaux d'un boot v86 restauré : la configuration, l'image
// disque et l'instantané mémoire pré-calculé.
const REQUIRED_ARTIFACTS = ["v86-config.json", "jiyufit.ext2", "jiyufit-state.bin"];

/**
 * Un artefact compte comme présent s'il existe en clair ou pré-compressé :
 * serve.mjs sert transparemment le jumeau `.gz` (cas de l'instantané).
 * @param {string} name
 * @returns {boolean}
 */
function artifactExists(name) {
  return existsSync(`${DISKS_DIR}${name}`) || existsSync(`${DISKS_DIR}${name}.gz`);
}

/**
 * Liste les artefacts VM manquants (vide = la suite VM peut s'exécuter).
 * @returns {string[]}
 */
export function missingVmDisks() {
  return REQUIRED_ARTIFACTS.filter((name) => !artifactExists(name));
}

/**
 * Motif d'ignorance lisible pour `test.skip`, ou null si tout est présent.
 * @returns {string | null}
 */
export function vmDisksSkipReason() {
  const missing = missingVmDisks();
  if (missing.length === 0) return null;
  return `Artefacts VM absents de public/disks/ : ${missing.join(", ")} — lancez tools/build-v86-image/build.sh`;
}
