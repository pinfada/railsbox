#!/bin/sh
# Extrait les assets précompilés de l'image disque ext2 vers
# public/disks/assets/ pour qu'ils soient servis STATIQUEMENT par le
# Service Worker au lieu de traverser le pont série (le tuyau étroit).
#
# C'est le levier de performance n°1 du plan : ~90 % du trafic série d'un
# chargement de page est constitué d'assets fingerprintés immuables.
#
# Usage (WSL2 ou Linux, e2fsprogs requis) :
#   sh tools/extract-assets.sh [image.ext2] [destination] [racine-dans-image]
#
# La racine par défaut « /app » vaut pour les images mono-disque, où
# l'application vit sous /app. Dans le disque applicatif découplé (ADR 0002),
# l'arbre est à la racine du système de fichiers : passer "" en troisième
# argument.
set -eu

IMAGE="${1:-public/disks/jiyufit.ext2}"
DEST="${2:-public/disks/assets}"
RACINE="${3-/app}"

if ! command -v debugfs >/dev/null 2>&1; then
  echo "debugfs introuvable — installez e2fsprogs (apt install e2fsprogs)" >&2
  exit 1
fi
if [ ! -f "$IMAGE" ]; then
  echo "image introuvable: $IMAGE — lancez tools/build-v86-image/build.sh d'abord" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"

# rdump copie récursivement un répertoire de l'image vers l'hôte, sans
# montage (donc sans droits root). /app est la racine de l'application
# dans le rootfs (WORKDIR du Dockerfile). Les avertissements de chown sont
# attendus hors root (DrvFS/CI) : seuls les contenus nous intéressent.
echo "extraction de ${RACINE}/public/assets depuis $IMAGE…"
debugfs -R "rdump ${RACINE}/public/assets $DEST" "$IMAGE" 2>&1 \
  | grep -v -e "^debugfs" -e "changing ownership" || true

if [ ! -d "$DEST/assets" ]; then
  echo "échec : ${RACINE}/public/assets absent de l'image" >&2
  exit 1
fi

# rdump recrée le répertoire source sous la destination : aplatir, dotfiles
# compris (le manifeste .sprockets-manifest-*.json est un fichier caché).
find "$DEST/assets" -mindepth 1 -maxdepth 1 -exec mv {} "$DEST"/ \;
rmdir "$DEST/assets"

# Fichiers statiques que Rails référence en dur à la racine (favicon,
# manifeste PWA…) : sans eux, 404 silencieux — voir rootStaticPath dans
# public/shared/proxy-logic.js (les deux listes doivent rester alignées).
APPSTATIC="$(dirname "$DEST")/appstatic"
rm -rf "$APPSTATIC"
mkdir -p "$APPSTATIC"
for file in favicon.ico favicon-16x16.png favicon-32x32.png \
  apple-touch-icon.png apple-touch-icon-precomposed.png \
  android-chrome-192x192.png android-chrome-512x512.png \
  site.webmanifest manifest.json browserconfig.xml robots.txt; do
  debugfs -R "dump ${RACINE}/public/$file $APPSTATIC/$file" "$IMAGE" 2>/dev/null || true
  [ -s "$APPSTATIC/$file" ] || rm -f "$APPSTATIC/$file"
done

COUNT=$(find "$DEST" -type f | wc -l)
SIZE=$(du -sh "$DEST" | cut -f1)
ROOTCOUNT=$(find "$APPSTATIC" -type f | wc -l)
echo "extrait : $COUNT fichiers, $SIZE → $DEST ; $ROOTCOUNT fichiers racine → $APPSTATIC"
echo "le Service Worker les servira sous /app/assets/* sans passer par la VM"
