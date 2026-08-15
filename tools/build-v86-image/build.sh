#!/usr/bin/env bash
# Construit les artefacts v86 de jiyufit : jiyufit.ext2 + vmlinuz + initrd.
# À exécuter sous WSL2/Linux (docker + e2fsprogs requis).
#
#   ./build.sh [chemin-vers-jiyufit]   (défaut : ../../../jiyufit)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JIYUFIT_DIR="${1:-$SCRIPT_DIR/../../../jiyufit}"
OUTPUT_DIR="$SCRIPT_DIR/../../public/disks"
IMAGE_TAG="jiyufit-v86"
# Marge : le rootfs (ruby compilé + gems + pg) approche 3 Go.
SIZE_MB="${SIZE_MB:-4096}"

command -v docker >/dev/null || { echo "docker introuvable"; exit 1; }
command -v mke2fs >/dev/null || { echo "mke2fs introuvable (apt install e2fsprogs)"; exit 1; }
[ -f "$JIYUFIT_DIR/Gemfile" ] || { echo "jiyufit introuvable: $JIYUFIT_DIR"; exit 1; }

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "→ Build Docker i386 (long au premier passage : compilation de Ruby 3.3.10)…"
docker build --platform linux/386 -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_TAG" "$JIYUFIT_DIR"

echo "→ Export du rootfs…"
CONTAINER_ID="$(docker create --platform linux/386 "$IMAGE_TAG")"
docker export "$CONTAINER_ID" | tar -xf - -C "$WORK_DIR" --exclude='dev/*'
docker rm "$CONTAINER_ID" >/dev/null

echo "→ Extraction du noyau et de l'initrd…"
mkdir -p "$OUTPUT_DIR"
VMLINUZ="$(ls "$WORK_DIR"/boot/vmlinuz-* | head -n1)"
INITRD="$(ls "$WORK_DIR"/boot/initrd.img-* | head -n1)"
cp "$VMLINUZ" "$OUTPUT_DIR/jiyufit-vmlinuz"
cp "$INITRD" "$OUTPUT_DIR/jiyufit-initrd"

echo "→ Fabrication de jiyufit.ext2 (${SIZE_MB} Mo)…"
rm -f "$OUTPUT_DIR/jiyufit.ext2"
mke2fs -q -t ext4 -b 4096 -d "$WORK_DIR" "$OUTPUT_DIR/jiyufit.ext2" "${SIZE_MB}M"

DISK_SIZE_BYTES=$(stat -c%s "$OUTPUT_DIR/jiyufit.ext2")
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$OUTPUT_DIR/v86-config.json" <<JSON
{
  "kernel": "/disks/jiyufit-vmlinuz",
  "initrd": "/disks/jiyufit-initrd",
  "disk": "/disks/jiyufit.ext2",
  "diskSize": $DISK_SIZE_BYTES,
  "cmdline": "root=/dev/sda rw console=ttyS0 init=/opt/rib/guest-init.sh net.ifnames=0 quiet loglevel=4",
  "memoryMb": 1024,
  "builtAt": "$BUILT_AT"
}
JSON

echo "✓ Artefacts prêts dans public/disks/ :"
ls -lh "$OUTPUT_DIR"
echo "Ouvrir ensuite : http://localhost:8080/?engine=v86"
