// Normalisation de la configuration v86, partagée entre le navigateur
// (v86-vm.js) et le harnais Node (tools/vm-harness.mjs). Logique pure, donc
// testable sans émulateur.
//
// Deux formes de configuration coexistent :
//  - MONO-DISQUE (héritée : jiyufit, demo) — un seul `disk` (hda) contenant
//    à la fois la base et l'application.
//  - BASE + APPLICATION (ADR 0002) — un rootfs de base `disk` (hda, mutualisé
//    entre sandboxes) et un disque applicatif `appDisk` (hdb, ~100-300 Mo).
//    Le hdb est « padé » à une géométrie fixe (`appDiskSize`) : c'est la même
//    taille que le disque vide présent lors de la capture de l'instantané de
//    base, condition sine qua non de la restauration (v86 refuse un hdb de
//    géométrie différente — voir docs/decisions/0002).

const DEFAULT_MEMORY_MB = 1024;

/**
 * Vérifie qu'une configuration porte les champs indispensables au boot.
 * @param {Record<string, any> | null | undefined} config
 * @returns {config is Record<string, any> & { disk: string, kernel: string, initrd: string }}
 */
export function isBootableConfig(config) {
  return Boolean(config?.disk && config?.kernel && config?.initrd);
}

/**
 * Indique si la configuration décrit un montage base + application (deux
 * disques) plutôt qu'une image mono-disque.
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
export function isSplitConfig(config) {
  return Boolean(config?.appDisk);
}

/**
 * Construit les descripteurs de disques pour le constructeur v86 : hda
 * (rootfs) toujours, hdb (disque applicatif) si la configuration est en mode
 * base + application. Les deux sont chargés en `async` (lecture par blocs,
 * jamais téléchargés en entier).
 * @param {{ disk: string, diskSize?: number, appDisk?: string, appDiskSize?: number }} config
 * @returns {{ hda: { url: string, async: true, size?: number }, hdb?: { url: string, async: true, size?: number } }}
 */
export function buildDiskImages(config) {
  const images = {
    hda: { url: config.disk, async: /** @type {true} */ (true), size: config.diskSize },
  };
  if (config.appDisk) {
    return {
      ...images,
      hdb: { url: config.appDisk, async: /** @type {true} */ (true), size: config.appDiskSize },
    };
  }
  return images;
}

/**
 * Mémoire allouée à la VM en octets, défaut compris.
 * @param {Record<string, any>} config
 * @returns {number}
 */
export function memoryBytes(config) {
  return (config.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024;
}

export { DEFAULT_MEMORY_MB };
