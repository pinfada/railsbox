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
 * Révisions de base publiées, de la plus ancienne à la plus récente. Sert à
 * choisir LA révision à conseiller quand plusieurs paquets manquent : c'est la
 * plus récente des révisions qui les introduisent.
 */
export const BASE_REVISIONS = Object.freeze(["3.3", "3.3-r2", "3.3-r3"]);

/** Révision de base servie par défaut aux workflows (entrée « base: »). */
export const DEFAULT_BASE_REVISION = "3.3-r2";

/** Gabarit d'issue à ouvrir quand aucune base ne fournit un paquet. */
export const UNSUPPORTED_ISSUE_URL =
  "https://github.com/pinfada/railsbox/issues/new?template=application-non-prise-en-charge.yml";

/**
 * Bibliothèques système présentes dans l'image de BASE (voir base/Dockerfile),
 * et révision qui a INTRODUIT chacune.
 *
 * La base découplée est mutualisée : son jeu de paquets est figé à sa
 * construction, et chaque paquet ajouté pèse sur toutes les sandboxes. Cette
 * table dit ce qu'elle porte, révision par révision. Ce qui n'y figure pas
 * n'est plus un refus depuis l'ADR 0006 : c'est une SURCOUCHE, installée au
 * build du disque applicatif et relocalisée sur celui-ci.
 *
 * La révision n'est pas décorative : elle décide de la frontière. Un paquet
 * absent de la base ÉPINGLÉE mais présent dans une plus récente peut être
 * obtenu des deux façons — et l'épingle coûte moins cher, puisque le rootfs
 * mutualisé n'est lu que par morceaux. C'est ce que la construction conseille.
 */
export const PACKAGE_BASE_REVISIONS = Object.freeze({
  // 3.3 — toolchain de compilation des gems natives et premiers besoins.
  "build-essential": "3.3",
  "libffi-dev": "3.3",
  "libgmp-dev": "3.3",
  "libreadline-dev": "3.3",
  "libsqlite3-dev": "3.3",
  "libssl-dev": "3.3",
  "libxml2-dev": "3.3",
  "libxslt1-dev": "3.3",
  "libyaml-dev": "3.3",
  "pkg-config": "3.3",
  "redis-server": "3.3",
  "zlib1g-dev": "3.3",
  // 3.3-r2 — PostgreSQL : serveur et client, mais AUCUN cluster (celui de la
  // sandbox vit sur le disque applicatif).
  "libpq-dev": "3.3-r2",
  postgresql: "3.3-r2",
  "postgresql-client": "3.3-r2",
  // 3.3-r3 — traitement d'images. libvips est le processeur de variantes par
  // défaut de Rails 7+ ; imagemagick et poppler-utils ne coûtent presque rien
  // de plus, leurs dépendances venant déjà avec libvips. Les coûts mesurés et
  // les candidats écartés (ffmpeg, libvips-dev, rmagick) sont documentés dans
  // base/Dockerfile.
  imagemagick: "3.3-r3",
  "libcurl4-openssl-dev": "3.3-r3",
  "libicu-dev": "3.3-r3",
  "libsodium-dev": "3.3-r3",
  "libvips-tools": "3.3-r3",
  libvips42: "3.3-r3",
  "poppler-utils": "3.3-r3",
});

/** Paquets fournis par la base la plus récente. Dérivé : une seule source. */
export const BASE_SYSTEM_PACKAGES = Object.freeze(Object.keys(PACKAGE_BASE_REVISIONS).sort());

/**
 * Paquets fournis par une révision de base donnée.
 * @param {string} [revision] révision à interroger (défaut : la plus récente)
 * @returns {string[]} paquets présents dans cette révision, triés
 */
export function packagesForRevision(revision) {
  const rank = BASE_REVISIONS.indexOf(revision ?? "");
  if (rank === -1) return [...BASE_SYSTEM_PACKAGES];
  return BASE_SYSTEM_PACKAGES.filter(
    (name) => BASE_REVISIONS.indexOf(PACKAGE_BASE_REVISIONS[name]) <= rank,
  );
}

/**
 * Liste les paquets réclamés par une application que la base ne fournit pas.
 *
 * `revision` permet de comparer à la base RÉELLEMENT épinglée plutôt qu'à la
 * plus récente que connaît le dépôt : c'est ce qui distingue « ce paquet existe,
 * changez d'épingle » de « personne ne le fournit ». Une valeur inconnue (image
 * locale, tag hors convention) retombe sur la base la plus récente.
 * @param {string|readonly string[]} required paquets réclamés (liste ou chaîne séparée par des espaces)
 * @param {string} [revision] révision de base utilisée (défaut : la plus récente)
 * @returns {string[]} paquets manquants, triés et sans doublon
 */
export function unsupportedPackages(required, revision) {
  const names = (typeof required === "string" ? required.split(/\s+/) : [...required]).filter(
    Boolean,
  );
  const fournis = packagesForRevision(revision);
  const missing = names.filter((name) => !fournis.includes(name));
  return [...new Set(missing)].sort();
}

/**
 * Révision de base la plus récente parmi celles qui introduisent ces paquets.
 * @param {readonly string[]} names paquets connus de {@link PACKAGE_BASE_REVISIONS}
 * @returns {string|null} révision à épingler, ou `null` si aucun paquet n'est connu
 */
export function requiredBaseRevision(names) {
  let rank = -1;
  for (const name of names) {
    const index = BASE_REVISIONS.indexOf(PACKAGE_BASE_REVISIONS[name]);
    if (index > rank) rank = index;
  }
  return rank === -1 ? null : BASE_REVISIONS[rank];
}

/**
 * Rédige le constat adressé au mainteneur, et la sortie qui va avec.
 *
 * Depuis l'ADR 0006, ce texte n'est plus produit par la construction — la
 * surcouche applicative absorbe ce que la base ne fournit pas. Il reste le
 * message de la commande de DIAGNOSTIC `--check-packages`, celle que le gabarit
 * d'issue demande d'exécuter : elle répond « quelle base couvre cette
 * application, et que reste-t-il à traiter autrement ».
 *
 * Deux situations, deux issues. Un paquet que RAILSBOX CONNAÎT mais que la base
 * épinglée n'a pas se règle en changeant l'entrée « base: » : le message nomme
 * la révision, et c'est l'option la moins chère. Un paquet qu'aucune base ne
 * fournit passe par la surcouche ; s'il n'existe pas non plus en i386, ou si sa
 * surcouche ne tient pas dans les 512 Mo du disque applicatif, l'arbitrage
 * appartient à railsbox — d'où le renvoi au gabarit d'issue.
 * @param {readonly string[]} missing paquets manquants, issus de {@link unsupportedPackages}
 * @returns {string[]} lignes du message, la première portant le motif que reconnaît le classifieur
 */
export function refusalLines(missing) {
  const known = missing.filter((name) => name in PACKAGE_BASE_REVISIONS);
  const unknown = missing.filter((name) => !(name in PACKAGE_BASE_REVISIONS));
  // Première ligne figée : le classifieur d'échecs la reconnaît dans le journal
  // de construction (règle « base-paquet-manquant »).
  const lines = [`✗ La base ne fournit pas les bibliothèques système : ${missing.join(" ")}`];
  if (known.length > 0) {
    const revision = requiredBaseRevision(known);
    const present = known.length > 1 ? "présents" : "présent";
    lines.push(
      "",
      `  ${known.join(", ")} : ${present} dans la base ${revision}. Épinglez-la —`,
      `    · workflow construire-sandbox : entrée « base: ${revision} »`,
      `    · en local : --base ghcr.io/pinfada/railsbox-base:${revision}`,
    );
  }
  if (unknown.length > 0) {
    lines.push(
      "",
      `  ${unknown.join(", ")} : aucune base publiée ne ${unknown.length > 1 ? "les" : "le"} fournit.`,
      "  Ils passeront par la SURCOUCHE applicative (ADR 0006) : installés au build",
      "  du disque applicatif, relocalisés sous /app/opt/systeme, activés au",
      "  démarrage. Rien à faire — sauf si l'un d'eux n'existe pas en i386, ou si",
      "  l'ensemble déborde des 512 Mo du disque applicatif. Dans ce cas seulement,",
      "  ouvrez une issue « Ma stack n'est pas prise en charge » : l'arbitrage entre",
      "  fréquence d'usage et mégaoctets imposés à toutes les sandboxes appartient à",
      "  railsbox.",
      `    ${UNSUPPORTED_ISSUE_URL}`,
    );
  }
  return lines;
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

/**
 * Substitue, dans une configuration v86, le nom d'un artefact par celui qui
 * vient réellement d'être publié (ADR 0007).
 *
 * POURQUOI CETTE FONCTION EXISTE. La configuration est écrite AVANT le
 * découpage — c'est elle qui nomme les artefacts — mais l'empreinte de contenu
 * n'est connue QUE du découpeur, qui seul lit les octets. Plutôt que de faire
 * relire 512 Mo à quelqu'un d'autre, le découpeur rend la main ici : il ne
 * décide de rien sur la forme de la configuration, il fournit deux noms et
 * cette fonction — qui vit avec le reste de la connaissance du format — fait la
 * substitution.
 *
 * Seul le NOM DE FICHIER est comparé et remplacé : le chemin qui le précède
 * (`disks/`, `/disks/`, une URL absolue) relève de la topologie de l'ADR 0004
 * et n'a aucune raison de bouger.
 *
 * Rend la liste des champs touchés — vide si aucun ne nomme cet artefact.
 * L'appelant DOIT traiter ce cas : publier des morceaux versionnés en laissant
 * la configuration nommer les anciens est exactement l'incohérence que le
 * versionnement vient supprimer.
 * @param {Record<string, any>} config configuration v86, laissée intacte
 * @param {string} oldName nom de fichier publié jusque-là (`demo-app.ext2.zst`)
 * @param {string} newName nom de fichier réellement publié
 * @returns {{ config: Record<string, any>, fields: string[] }} copie modifiée et champs touchés
 */
export function replacePublishedArtifact(config, oldName, newName) {
  const fields = [];
  const patched = { ...config };
  for (const [field, value] of Object.entries(config)) {
    if (typeof value !== "string") continue;
    const cut = value.lastIndexOf("/") + 1;
    if (value.slice(cut) !== oldName) continue;
    patched[field] = `${value.slice(0, cut)}${newName}`;
    fields.push(field);
  }
  return { config: patched, fields };
}

// Interface en ligne de commande minimale, appelée par build-app-disk.sh :
//   node split-config.mjs --check-packages "libmagickwand-dev libxml2-dev" \
//                         [--base-revision 3.3-r2]
// Écrit les paquets manquants sur la sortie standard (pour un script qui
// voudrait les relire) et le REFUS COMPLET sur la sortie d'erreur, puis sort en
// 1. Le shell n'a ainsi ni la liste des paquets de la base ni le texte du refus
// à dupliquer : les deux vivent ici, avec la table qui les justifie.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = process.argv.indexOf("--check-packages");
  const flagRevision = process.argv.indexOf("--base-revision");
  if (flag === -1) {
    process.stderr.write(
      'Usage : node split-config.mjs --check-packages "<paquets>" [--base-revision <rév>]\n',
    );
    process.exitCode = 2;
  } else {
    const revision = flagRevision === -1 ? undefined : process.argv[flagRevision + 1];
    const missing = unsupportedPackages(process.argv[flag + 1] ?? "", revision);
    if (missing.length > 0) {
      process.stdout.write(`${missing.join(" ")}\n`);
      process.stderr.write(`${refusalLines(missing).join("\n")}\n`);
      process.exitCode = 1;
    }
  }
}
