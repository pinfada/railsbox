#!/usr/bin/env bash
# Construit le DISQUE APPLICATIF (hdb) d'une application Rails à partir de
# l'image de BASE (ADR 0002) : <nom>-app.ext2, padé à la géométrie fixe de
# 512 Mo (identique au placeholder de la capture de base — condition de la
# restauration d'instantané).
#
# Réutilise l'auto-détection (tools/detect via manifest-to-args.mjs) pour
# déduire Ruby, base de données, assets, seeds, etc.
#
# À exécuter sous WSL2/Linux EN ROOT (docker + e2fsprogs, uid préservés) :
#   wsl -u root -e bash tools/build-v86-image/build-app-disk.sh <dossier-app> [options]
#
# Options :
#   --name <nom>        base des artefacts (défaut : nom du dossier de l'app)
#   --base <image>      image Docker de base (défaut : railsbox-base-<X.Y>)
#   --seed <cmd>        commande de seed ("" pour aucune)
#   --seed-optional     un seed en échec n'arrête pas la construction
#   --no-cache          reconstruction complète de l'image Docker
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/public/disks"
# Géométrie fixe partagée (voir split-config.mjs APP_DISK_BYTES = 512 Mo).
APP_DISK_MB=512

APP_DIR=""
NAME=""
BASE_IMAGE=""
SEED_OVERRIDE=""
SEED_OVERRIDE_SET=0
SEED_OPTIONAL=0
NO_CACHE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --base) BASE_IMAGE="$2"; shift 2 ;;
    --seed) SEED_OVERRIDE="$2"; SEED_OVERRIDE_SET=1; shift 2 ;;
    --seed-optional) SEED_OPTIONAL=1; shift ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help) sed -n '2,25p' "$0" >&2; exit 2 ;;
    -*) echo "Option inconnue : $1" >&2; exit 2 ;;
    *) [ -z "$APP_DIR" ] || { echo "Un seul dossier d'application attendu" >&2; exit 2; }
       APP_DIR="$1"; shift ;;
  esac
done

[ -n "$APP_DIR" ] || { echo "Usage : build-app-disk.sh <dossier-app> [options]" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker introuvable" >&2; exit 1; }
command -v mke2fs >/dev/null || { echo "mke2fs introuvable (apt install e2fsprogs)" >&2; exit 1; }
command -v node >/dev/null || { echo "node introuvable" >&2; exit 1; }
[ -f "$APP_DIR/Gemfile" ] || { echo "Pas d'application Rails ici : $APP_DIR" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || {
  echo "build-app-disk.sh doit tourner en root (préservation des uid à l'extraction)." >&2
  echo "Depuis Windows :  wsl -u root -e bash tools/build-v86-image/build-app-disk.sh $*" >&2
  exit 1
}

APP_DIR="$(cd "$APP_DIR" && pwd)"
[ -n "$NAME" ] || NAME="$(basename "$APP_DIR" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"

echo "→ Analyse de l'application ($APP_DIR)…"
ARGS_FILE="$(mktemp)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR" "$ARGS_FILE"' EXIT
if ! node "$SCRIPT_DIR/manifest-to-args.mjs" "$APP_DIR" "$NAME" > "$ARGS_FILE"; then
  echo "✗ Construction refusée : voir le rapport ci-dessus." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ARGS_FILE"

if [ "$SEED_OVERRIDE_SET" -eq 1 ]; then SEED_COMMAND="$SEED_OVERRIDE"; fi

# MVP : sqlite3 + importmap uniquement. PostgreSQL et chaîne npm hors périmètre.
if [ "${WITH_POSTGRES:-0}" = 1 ]; then
  echo "✗ PostgreSQL hors périmètre du MVP B2 (voir ADR 0002)." >&2
  exit 1
fi
if [ "${NPM_ASSETS:-0}" = 1 ]; then
  echo "✗ Applications à chaîne npm hors périmètre du MVP B2 (importmap seulement)." >&2
  exit 1
fi

SERIES="$(echo "$RUBY_VERSION" | cut -d. -f1,2)"
[ -n "$BASE_IMAGE" ] || BASE_IMAGE="railsbox-base-$SERIES"
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "✗ Image de base introuvable : $BASE_IMAGE" >&2
  echo "  Construisez-la d'abord :  bash tools/build-v86-image/base/base-build.sh --ruby $RUBY_VERSION" >&2
  exit 1
fi

echo "  Base $BASE_IMAGE · Ruby $RUBY_VERSION · db $DATABASE · seed ${SEED_COMMAND:-aucun}"

########################################################################
# Build de l'image applicative (FROM base) et export de /app
########################################################################
IMAGE_TAG="railsbox-app-$NAME"
echo "→ Build Docker i386 du disque applicatif (FROM $BASE_IMAGE)…"
docker build --platform linux/386 $NO_CACHE -f "$SCRIPT_DIR/base/app.Dockerfile" -t "$IMAGE_TAG" \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "ASSET_PRECOMPILE=${ASSET_PRECOMPILE:-1}" \
  --build-arg "WITH_REDIS=${WITH_REDIS:-0}" \
  --build-arg "DB_PREPARE_COMMAND=$DB_PREPARE_COMMAND" \
  --build-arg "SEED_COMMAND=$SEED_COMMAND" \
  --build-arg "SEED_OPTIONAL=$SEED_OPTIONAL" \
  "$APP_DIR"

echo "→ Export de l'arbre /app…"
CONTAINER_ID="$(docker create --platform linux/386 "$IMAGE_TAG")"
docker export "$CONTAINER_ID" | tar -xf - -C "$WORK_DIR" app
docker rm "$CONTAINER_ID" >/dev/null

USED_MB="$(du -sm "$WORK_DIR/app" | cut -f1)"
echo "  Contenu /app : ${USED_MB} Mo (cible ${APP_DISK_MB} Mo)"
if [ "$USED_MB" -gt "$APP_DISK_MB" ]; then
  echo "✗ Le contenu applicatif (${USED_MB} Mo) dépasse la géométrie fixe (${APP_DISK_MB} Mo)." >&2
  echo "  La géométrie ne peut pas changer (contrainte de restauration d'instantané, ADR 0002)." >&2
  exit 1
fi

########################################################################
# Fabrication du disque applicatif ext2 à géométrie FIXE
########################################################################
# ext2 nu, SANS table de partition : le secteur 0 est le bloc de boot ext2
# (zéros), identique au placeholder de la capture de base — le montage se fait
# sur /dev/sdb directement (voir ADR 0002, risque de recouvrement du cache).
echo "→ Fabrication de $NAME-app.ext2 (${APP_DISK_MB} Mo, géométrie fixe)…"
rm -f "$OUTPUT_DIR/$NAME-app.ext2"
mke2fs -q -t ext2 -b 4096 -d "$WORK_DIR/app" "$OUTPUT_DIR/$NAME-app.ext2" "${APP_DISK_MB}M"

APP_DISK_BYTES=$(stat -c%s "$OUTPUT_DIR/$NAME-app.ext2")
echo "✓ Disque applicatif prêt : $NAME-app.ext2 ($((APP_DISK_BYTES / 1048576)) Mo)"
echo "  Delta d'instantané :  node tools/build-v86-image/make-delta-snapshot.mjs --name $NAME --base $BASE_IMAGE"
