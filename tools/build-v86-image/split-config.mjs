// Logique pure du découpage base / application (ADR 0002) : géométrie fixe du
// disque applicatif et émission de la configuration v86 « split ». Aucune
// dépendance à l'émulateur ni au système de fichiers → testable sans VM.
//
// La contrainte dure (tranchée par spike, ADR 0002) : v86 refuse de restaurer
// un instantané si le hdb attaché n'a pas la MÊME géométrie que le disque vide
// présent lors de la capture. On fixe donc une taille unique, partagée par le
// placeholder de la capture de base et par TOUS les disques applicatifs.

/** Taille fixe (octets) du disque applicatif et de son placeholder. 512 Mo. */
export const APP_DISK_BYTES = 512 * 1024 * 1024;

/**
 * Vérifie qu'un contenu applicatif tient dans la géométrie fixe. Le disque est
 * mkfs'é exactement à {@link APP_DISK_BYTES} : au-delà, il déborderait.
 * @param {number} contentBytes taille estimée du contenu (arbre app + bundle)
 * @returns {{ ok: boolean, targetBytes: number, freeBytes: number }}
 */
export function checkAppDiskFit(contentBytes) {
  const freeBytes = APP_DISK_BYTES - contentBytes;
  return { ok: freeBytes >= 0, targetBytes: APP_DISK_BYTES, freeBytes };
}

/**
 * Construit l'objet de configuration v86 en mode base + application, consommé
 * par tools/vm-harness.mjs et public/shared/v86-config.js.
 * @param {{
 *   name: string,
 *   baseName: string,
 *   baseDiskBytes: number,
 *   appDiskBytes?: number,
 *   memoryMb?: number,
 *   mountPath?: string,
 *   database?: string,
 *   cmdline?: string,
 *   statePath?: string | null,
 *   builtAt?: string,
 * }} options
 * @returns {Record<string, any>}
 */
export function buildSplitConfig({
  name,
  baseName,
  baseDiskBytes,
  appDiskBytes = APP_DISK_BYTES,
  memoryMb = 1024,
  mountPath = "/app",
  database = "sqlite3",
  cmdline = "root=/dev/sda rw console=ttyS0 init=/opt/rib/guest-init.sh net.ifnames=0 quiet loglevel=4",
  statePath = null,
  builtAt = new Date().toISOString().replace(/\.\d+Z$/, "Z"),
}) {
  const config = {
    name,
    baseName,
    kernel: `/disks/${baseName}-vmlinuz`,
    initrd: `/disks/${baseName}-initrd`,
    disk: `/disks/${baseName}.ext2`,
    diskSize: baseDiskBytes,
    appDisk: `/disks/${name}-app.ext2`,
    appDiskSize: appDiskBytes,
    cmdline,
    memoryMb,
    mountPath,
    database,
    builtAt,
  };
  if (statePath) config.state = statePath;
  return config;
}
