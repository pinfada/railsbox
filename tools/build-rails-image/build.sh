#!/usr/bin/env bash
# Construit une image disque ext2 bootable par CheerpX à partir du Dockerfile.
# Prérequis : docker, e2fsprogs (mke2fs avec support -d). À lancer sous
# Linux/WSL2 — mke2fs -d n'existe pas nativement sous Windows.
set -euo pipefail

IMAGE_TAG="rails-vm-image"
OUTPUT="rails.ext2"
SIZE_MB="${SIZE_MB:-2048}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "→ Build Docker (x86 32 bits)…"
docker build --platform linux/386 -t "${IMAGE_TAG}" "$(dirname "$0")"

echo "→ Export du rootfs…"
CONTAINER_ID="$(docker create --platform linux/386 "${IMAGE_TAG}")"
docker export "${CONTAINER_ID}" | tar -xf - -C "${WORK_DIR}"
docker rm "${CONTAINER_ID}" > /dev/null

echo "→ Fabrication de ${OUTPUT} (${SIZE_MB} Mo, ext2)…"
rm -f "${OUTPUT}"
mke2fs -t ext2 -b 4096 -d "${WORK_DIR}" "${OUTPUT}" "${SIZE_MB}M"

cat <<EOF
✓ ${OUTPUT} prêt.

Déploiement :
  1. Copiez ${OUTPUT} dans public/disks/ du projet rails-in-browser.
  2. Dans public/main.js, passez l'URL à bootVm :
       bootVm({ diskImageUrl: "/disks/${OUTPUT}", onConsole: logLine })
     (une URL non-wss:// est montée via HttpBytesDevice, avec requêtes Range).
  3. Le serveur qui héberge le .ext2 doit accepter les requêtes Range
     (serve.mjs de dev les sert en une pièce : OK pour tester, pas optimal).
EOF
