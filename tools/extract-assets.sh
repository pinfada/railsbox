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

# Fichiers statiques que l'application référence EN DUR à la racine (favicon,
# manifeste PWA, 404.html…) : sans eux, 404 silencieux.
#
# On n'en tient PLUS de liste. Une allowlist en dur ne pouvait pas connaître
# les chemins racine d'une application tierce, et tout ce qui n'y figurait pas
# faisait un trou invisible. La source de vérité est l'image elle-même : on
# relève chaque FICHIER à la racine du `public/` de l'application — un
# ensemble petit et clos par construction, les sous-répertoires (assets/,
# images/, dist/…) n'en font pas partie.
#
# `ls -p` est le format machine de debugfs : /inode/mode/uid/gid/nom/taille/.
# Le mode d'un fichier ordinaire commence par 100. Les noms sont filtrés sur
# une forme sûre : ils deviennent des noms de fichiers de l'hôte, puis des
# entrées d'un inventaire JSON lu par le Service Worker.
APPSTATIC="$(dirname "$DEST")/appstatic"
rm -rf "$APPSTATIC"
mkdir -p "$APPSTATIC"

# Les noms que LA COQUILLE sert à sa propre racine sont écartés : le Service
# Worker les refuse déjà (SHELL_OWNED_FILES dans public/shared/proxy-logic.js),
# les extraire ne ferait qu'alourdir la publication d'un fichier mort.
#
# `railsbox-index.json` porte NOTRE inventaire : un fichier de l'application
# qui s'appellerait ainsi l'écraserait. Le nom est choisi improbable, et écarté
# de l'extraction par prudence — l'application, elle, garde le droit d'avoir
# son propre `public/index.json`, servi par la VM comme avant.
INVENTAIRE=railsbox-index.json
MAX_ROOT_FILES=200
COQUILLE="^(index\.html|main\.js|sw-proxy\.js|badge\.svg|env-drawer\.(js|css)|types\.d\.ts|${INVENTAIRE})\$"
LISTE="$(debugfs -R "ls -p ${RACINE}/public" "$IMAGE" 2>/dev/null \
  | awk -F/ '$3 ~ /^100/ { print $6 }' \
  | grep -E '^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$' \
  | grep -Ev "$COQUILLE" \
  | sort -u | head -n "$MAX_ROOT_FILES" || true)"

for file in $LISTE; do
  debugfs -R "dump ${RACINE}/public/$file $APPSTATIC/$file" "$IMAGE" 2>/dev/null || true
  [ -s "$APPSTATIC/$file" ] || rm -f "$APPSTATIC/$file"
done

# Inventaire de ce qui a RÉELLEMENT été extrait : c'est lui, et non une liste
# figée dans le code, qui dit au Service Worker quels chemins racine servir
# statiquement (voir rootStaticPath dans public/shared/proxy-logic.js). Son
# absence n'est pas une panne : le worker retombe alors sur sa liste de repli.
{
  printf '{\n  "files": [\n'
  premier=1
  for chemin in "$APPSTATIC"/*; do
    [ -f "$chemin" ] || continue
    file="${chemin##*/}"
    [ "$file" != "$INVENTAIRE" ] || continue
    [ "$premier" -eq 1 ] || printf ',\n'
    premier=0
    printf '    "%s"' "$file"
  done
  [ "$premier" -eq 1 ] || printf '\n'
  printf '  ]\n}\n'
} > "$APPSTATIC/$INVENTAIRE"

COUNT=$(find "$DEST" -type f | wc -l)
SIZE=$(du -sh "$DEST" | cut -f1)
ROOTCOUNT=$(find "$APPSTATIC" -type f ! -name "$INVENTAIRE" | wc -l)
echo "extrait : $COUNT fichiers, $SIZE → $DEST ; $ROOTCOUNT fichiers racine → $APPSTATIC"
echo "le Service Worker les servira sous /app/assets/* sans passer par la VM"
