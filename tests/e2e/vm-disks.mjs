// Portail d'exécution des tests VM. Les artefacts de public/disks/ pèsent
// plusieurs centaines de mégaoctets et ne sont pas versionnés (voir
// .gitignore) : la CI ne les a pas. Les tests qui en dépendent se déclarent
// donc ignorés au lieu d'échouer, sans masquer pour autant les tests qui n'en
// ont pas besoin.
//
// Le portail lit `v86-config.json` plutôt qu'une liste de noms figée. Un
// contributeur qui construit une variante découpée (demo, demo-pg,
// demo-tailwind…) obtient des artefacts qui ne s'appellent pas comme ceux de
// la voie monolithique historique : exiger un nom précis faisait s'ignorer la
// suite VM alors que tout était là — un test qui s'ignore ressemblant trait
// pour trait à un test qui passe, le défaut se voyait à peine.
//
// La question posée est donc la bonne : « peut-on booter CE que la
// configuration décrit ? » Les artefacts servis par une URL absolue (le rootfs
// mutualisé, ADR 0004) ne sont pas exigés localement — ils viennent du réseau.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DISKS_DIR = fileURLToPath(new URL("../../public/disks/", import.meta.url));
const CONFIG_NAME = "v86-config.json";

/**
 * Un artefact compte comme présent s'il existe en clair ou pré-compressé :
 * serve.mjs sert transparemment le jumeau `.gz` (cas de l'instantané).
 * @param {string} name chemin relatif à public/disks/
 * @returns {boolean}
 */
function artifactExists(name) {
  return existsSync(`${DISKS_DIR}${name}`) || existsSync(`${DISKS_DIR}${name}.gz`);
}

/**
 * Ne retient que les références LOCALES : une URL absolue désigne le dépôt
 * d'artefacts, que le navigateur ira chercher lui-même.
 *
 * Les deux écritures de chemin local sont acceptées. La publication émet du
 * relatif (`disks/x`, obligatoire sur un Pages de projet, ADR 0004) ; une
 * construction locale émet de l'absolu (`/disks/x`). N'accepter que la première
 * faisait s'ignorer TOUTE la suite VM d'un contributeur qui venait de
 * construire ses artefacts — et un test qui s'ignore ressemble trait pour trait
 * à un test qui passe.
 * @param {unknown} value valeur d'une clé de la configuration v86
 * @returns {string | null} chemin relatif à public/disks/, ou null
 */
function localArtifact(value) {
  if (typeof value !== "string" || value === "") return null;
  if (/^https?:\/\//.test(value)) return null;
  return value.replace(/^\/?disks\//, "");
}

/**
 * Artefacts VM manquants (liste vide = la suite VM peut s'exécuter).
 * @returns {string[]}
 */
export function missingVmDisks() {
  if (!artifactExists(CONFIG_NAME)) return [CONFIG_NAME];

  let config;
  try {
    config = JSON.parse(readFileSync(`${DISKS_DIR}${CONFIG_NAME}`, "utf8"));
  } catch (error) {
    return [`${CONFIG_NAME} (illisible : ${error.message})`];
  }

  // `disk` et `state` valent pour les deux voies ; `appDisk` n'existe que sur
  // la voie découplée, où le rootfs de base est distant.
  const requis = [config.disk, config.appDisk, config.state]
    .map(localArtifact)
    .filter((name) => name !== null);

  return requis.filter((name) => !artifactExists(name));
}

/**
 * Motif d'ignorance lisible pour `test.skip`, ou null si tout est présent.
 * @returns {string | null}
 */
export function vmDisksSkipReason() {
  const missing = missingVmDisks();
  if (missing.length === 0) return null;
  return (
    `Artefacts VM absents de public/disks/ : ${missing.join(", ")} — construisez ` +
    `une variante (voir CONTRIBUTING.md, niveau C) ou lancez tools/build-v86-image/build.sh`
  );
}
