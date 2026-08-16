// Découpage des artefacts en FICHIERS-PARTIES (chantier C, distribution).
//
// GitHub Pages refuse les fichiers de plus de 100 Mo (limite git) alors qu'un
// disque applicatif en fait 512 et un rootfs de base 1,45 Go. v86 sait lire un
// disque servi en morceaux (`use_parts`) : il calcule le nom du fichier qui
// contient l'offset demandé et ne télécharge que celui-là. Aucun réassemblage
// n'est donc nécessaire côté coquille, et le visiteur ne paie que les blocs
// réellement lus.
//
// Ce module reproduit EXACTEMENT la convention de nommage de v86
// (AsyncXHRPartfileBuffer, format standard) :
//
//   url        /disks/demo-app.ext2
//   partie n   /disks/demo-app-<début>-<début + taille de morceau>.ext2
//
// Logique pure (aucune E/S) → testable sans disque ni émulateur. L'écriture
// des fichiers est dans split-artifact.mjs.

/**
 * Taille de morceau par défaut. 4 Mio divise exactement les géométries en jeu
 * (512 Mo applicatif, rootfs multiples de 4 Mio) et reste loin sous la limite
 * de 95 Mo, tout en gardant le nombre de fichiers raisonnable (128 pour le
 * disque applicatif).
 */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Taille maximale acceptée pour un fichier publié sur GitHub Pages (ADR 0001). */
export const MAX_PART_BYTES = 95 * 1024 * 1024;

/**
 * Sépare une URL d'artefact en base et extension, selon la règle de v86 : la
 * dernière extension, suivie du `.zst` optionnel qui marque la compression.
 * @param {string} url URL ou chemin de l'artefact (`/disks/demo-app.ext2.zst`)
 * @returns {{ basename: string, extension: string, isZstd: boolean }}
 */
export function splitArtifactName(url) {
  const match = String(url).match(/\.[^.]+(\.zst)?$/);
  const extension = match ? match[0] : "";
  let basename = String(url).slice(0, String(url).length - extension.length);
  // v86 insère le séparateur lui-même, sauf si la base est déjà un répertoire.
  if (!basename.endsWith("/")) basename += "-";
  return { basename, extension, isZstd: extension.endsWith(".zst") };
}

/**
 * Nom du fichier-partie contenant un offset donné.
 * @param {string} url URL de l'artefact complet
 * @param {number} start offset de début du morceau, multiple de `chunkBytes`
 * @param {number} [chunkBytes] taille de morceau
 * @returns {string} URL du fichier-partie
 */
export function partName(url, start, chunkBytes = DEFAULT_CHUNK_BYTES) {
  const { basename, extension } = splitArtifactName(url);
  return `${basename}${start}-${start + chunkBytes}${extension}`;
}

/**
 * Plan de découpage d'un artefact.
 *
 * Le DERNIER morceau est complété de zéros jusqu'à `chunkBytes` : v86 nomme
 * les parties sur les bornes nominales et lit toujours un morceau entier. Une
 * taille de morceau qui divise l'artefact évite ce complément.
 * @param {number} byteLength taille de l'artefact complet
 * @param {number} [chunkBytes] taille de morceau
 * @returns {{ index: number, start: number, end: number, padded: number }[]} morceaux
 * @throws {Error} si les tailles sont invalides ou le morceau trop gros pour Pages
 */
export function planParts(byteLength, chunkBytes = DEFAULT_CHUNK_BYTES) {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`Taille d'artefact invalide : ${byteLength}`);
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`Taille de morceau invalide : ${chunkBytes}`);
  }
  if (chunkBytes > MAX_PART_BYTES) {
    throw new Error(
      `Morceau de ${chunkBytes} octets au-delà de la limite GitHub Pages ` +
        `(${MAX_PART_BYTES} octets, voir ADR 0001).`,
    );
  }
  const parts = [];
  for (let start = 0; start < byteLength; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, byteLength);
    parts.push({ index: parts.length, start, end, padded: start + chunkBytes - end });
  }
  return parts;
}
