// Logique pure du découpage base / application (ADR 0002) : géométrie fixe du
// disque applicatif et émission de la configuration v86 « split ». Aucune
// dépendance à l'émulateur ni au système de fichiers → testable sans VM.
//
// La contrainte dure (tranchée par spike, ADR 0002) : v86 refuse de restaurer
// un instantané si le hdb attaché n'a pas la MÊME géométrie que le disque vide
// présent lors de la capture. On fixe donc une taille unique, partagée par le
// placeholder de la capture de base et par TOUS les disques applicatifs.
import { fileURLToPath } from "node:url";

/** Taille fixe (octets) du disque applicatif et de son placeholder. 512 Mo. */
export const APP_DISK_BYTES = 512 * 1024 * 1024;

/**
 * Bibliothèques système présentes dans l'image de BASE (voir base/Dockerfile).
 *
 * Contrairement à la voie monolithique — qui installe `EXTRA_PACKAGES` au build
 * de l'application — la base découplée est mutualisée : son jeu de paquets est
 * figé à sa construction et le disque applicatif ne peut rien y ajouter. Une
 * gem native réclamant autre chose échouerait à la compilation, très loin de la
 * cause. On compare donc en amont, pour refuser avec un message utile.
 */
export const BASE_SYSTEM_PACKAGES = Object.freeze([
  "libsqlite3-dev",
  "libxml2-dev",
  "libxslt1-dev",
  "redis-server",
]);

/**
 * Liste les paquets réclamés par une application que la base ne fournit pas.
 * @param {string|readonly string[]} required paquets réclamés (liste ou chaîne séparée par des espaces)
 * @returns {string[]} paquets manquants, triés et sans doublon
 */
export function unsupportedPackages(required) {
  const names = (typeof required === "string" ? required.split(/\s+/) : [...required]).filter(
    Boolean,
  );
  const missing = names.filter((name) => !BASE_SYSTEM_PACKAGES.includes(name));
  return [...new Set(missing)].sort();
}

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

// Interface en ligne de commande minimale, appelée par build-app-disk.sh :
//   node split-config.mjs --check-packages "libvips-dev libxml2-dev"
// Écrit les paquets manquants sur la sortie standard et sort en 1 s'il y en a.
// Le shell n'a ainsi pas à dupliquer la liste des paquets de la base.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = process.argv.indexOf("--check-packages");
  if (flag === -1) {
    process.stderr.write('Usage : node split-config.mjs --check-packages "<paquets>"\n');
    process.exitCode = 2;
  } else {
    const missing = unsupportedPackages(process.argv[flag + 1] ?? "");
    if (missing.length > 0) {
      process.stdout.write(`${missing.join(" ")}\n`);
      process.exitCode = 1;
    }
  }
}
