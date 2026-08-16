#!/usr/bin/env bash
# Construit les artefacts de la BASE railsbox découplée (ADR 0002) :
#   base-<ruby>.ext2 + base-<ruby>-vmlinuz + base-<ruby>-initrd
# Aucune application : rootfs mutualisé, partagé par toutes les sandboxes.
#
# À exécuter sous WSL2/Linux EN ROOT (docker + e2fsprogs requis, uid préservés
# à l'export) :
#   wsl -u root -e bash tools/build-v86-image/base/base-build.sh
#
# Options :
#   --ruby <X.Y.Z>   version de Ruby compilée dans la base (défaut 3.3.12)
#   --name <nom>     base des artefacts (défaut : base-<X.Y>)
#   --size-mb <n>    taille de l'ext2 de base (défaut : calculée sur le rootfs)
#   --no-cache       reconstruction complète de l'image Docker
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/public/disks"
# Le noyau boote la base (hda=/dev/sda) ; le disque applicatif est attaché en
# hdb (/dev/sdb) et monté par start-app.sh, jamais au boot.
CMDLINE="root=/dev/sda rw console=ttyS0 init=/opt/rib/guest-init.sh net.ifnames=0 quiet loglevel=4"
SIZE_MARGIN_PERCENT=25
SIZE_MARGIN_MB=256

RUBY_VERSION="3.3.12"
NAME=""
SIZE_MB="${SIZE_MB:-}"
NO_CACHE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ruby) RUBY_VERSION="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --size-mb) SIZE_MB="$2"; shift 2 ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help) sed -n '2,20p' "$0" >&2; exit 2 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo "docker introuvable" >&2; exit 1; }
command -v mke2fs >/dev/null || { echo "mke2fs introuvable (apt install e2fsprogs)" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || {
  echo "base-build.sh doit tourner en root (préservation des uid à l'extraction)." >&2
  echo "Depuis Windows :  wsl -u root -e bash tools/build-v86-image/base/base-build.sh $*" >&2
  exit 1
}

SERIES="$(echo "$RUBY_VERSION" | cut -d. -f1,2)"
[ -n "$NAME" ] || NAME="base-$SERIES"
IMAGE_TAG="railsbox-$NAME"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "→ Build Docker i386 de la base ($NAME, Ruby $RUBY_VERSION)…"
docker build --platform linux/386 $NO_CACHE -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_TAG" \
  --build-arg "RUBY_VERSION=$RUBY_VERSION" \
  --build-arg "BASE_NAME=$NAME" \
  --build-arg "WITH_REDIS=1" \
  "$SCRIPT_DIR"

echo "→ Export du rootfs de base…"
CONTAINER_ID="$(docker create --platform linux/386 "$IMAGE_TAG")"
docker export "$CONTAINER_ID" | tar -xf - -C "$WORK_DIR" --exclude='dev/*'
docker rm "$CONTAINER_ID" >/dev/null

echo "→ Extraction du noyau et de l'initrd…"
mkdir -p "$OUTPUT_DIR"
VMLINUZ="$(ls "$WORK_DIR"/boot/vmlinuz-* | head -n1)"
INITRD="$(ls "$WORK_DIR"/boot/initrd.img-* | head -n1)"
cp "$VMLINUZ" "$OUTPUT_DIR/$NAME-vmlinuz"
cp "$INITRD" "$OUTPUT_DIR/$NAME-initrd"

if [ -z "$SIZE_MB" ]; then
  USED_MB="$(du -sm "$WORK_DIR" | cut -f1)"
  SIZE_MB=$(( USED_MB + USED_MB * SIZE_MARGIN_PERCENT / 100 + SIZE_MARGIN_MB ))
fi
echo "→ Fabrication de $NAME.ext2 (${SIZE_MB} Mo)…"
rm -f "$OUTPUT_DIR/$NAME.ext2"
mke2fs -q -t ext4 -b 4096 -d "$WORK_DIR" "$OUTPUT_DIR/$NAME.ext2" "${SIZE_MB}M"

DISK_SIZE_BYTES=$(stat -c%s "$OUTPUT_DIR/$NAME.ext2")
echo "✓ Base prête : $NAME.ext2 ($((DISK_SIZE_BYTES / 1048576)) Mo), noyau + initrd extraits."
echo "  Instantané de base :  node tools/build-v86-image/make-base-snapshot.mjs --base $NAME --cmdline \"$CMDLINE\""
