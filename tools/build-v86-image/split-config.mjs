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
  "libpq-dev",
  "libsqlite3-dev",
  "libxml2-dev",
  "libxslt1-dev",
  // PostgreSQL est présent depuis la base 3.3-r2 : serveur et client, mais
  // AUCUN cluster (celui de la sandbox vit sur le disque applicatif).
  "postgresql",
  "postgresql-client",
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
 *
 * Deux répartitions coexistent (ADR 0004).
 *
 * SANS `baseUrl` — tout est local, sous `/disks/` : le développement, le
 * harnais Node, et l'ancien format mono-dépôt.
 *
 * AVEC `baseUrl` — la répartition de production. Le rootfs mutualisé, son
 * noyau et son initrd vivent sur le dépôt d'artefacts de railsbox, donc en
 * **URL absolue cross-origin** ; le disque applicatif et l'instantané, eux,
 * sont publiés à côté de la coquille et restent en chemins **relatifs**. Ce
 * détail n'est pas cosmétique : un Pages de projet sert sous
 * `https://compte.github.io/depot/`, où un chemin absolu `/disks/x` pointerait
 * hors du site. Un chemin relatif se résout contre la page, à la racine comme
 * dans un sous-répertoire.
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
 *   baseUrl?: string | null,
 *   baseChunkBytes?: number | null,
 *   appChunkBytes?: number | null,
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
  baseUrl = null,
  baseChunkBytes = null,
  appChunkBytes = null,
}) {
  const racine = baseUrl ? baseUrl.replace(/\/+$/, "") : "/disks";
  // Le rootfs publié porte le suffixe .zst : v86 en dérive le nom des morceaux
  // et les décompresse à la volée.
  const suffixeBase = baseUrl && baseChunkBytes ? ".zst" : "";
  const config = {
    name,
    baseName,
    kernel: `${racine}/${baseName}-vmlinuz`,
    initrd: `${racine}/${baseName}-initrd`,
    disk: `${racine}/${baseName}.ext2${suffixeBase}`,
    diskSize: baseDiskBytes,
    appDisk: baseUrl
      ? `disks/${name}-app.ext2${appChunkBytes ? ".zst" : ""}`
      : `/disks/${name}-app.ext2`,
    appDiskSize: appDiskBytes,
    cmdline,
    memoryMb,
    mountPath,
    database,
    builtAt,
  };
  if (baseChunkBytes) config.diskChunkSize = baseChunkBytes;
  if (appChunkBytes) config.appDiskChunkSize = appChunkBytes;
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
