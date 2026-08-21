#!/usr/bin/env bash
# Construit les artefacts v86 d'une application Rails QUELCONQUE :
# <nom>.ext2 + <nom>-vmlinuz + <nom>-initrd + <nom>-config.json.
#
# Tout ce qui dépend de l'application (Ruby, base de données, services, assets,
# seeds, variables d'environnement) est déduit par l'auto-détection
# (tools/detect) puis passé au Dockerfile en --build-arg.
#
# À exécuter sous WSL2/Linux EN ROOT (docker + e2fsprogs requis) :
#   wsl -u root -e bash tools/build-v86-image/build.sh <dossier-app> [options]
#
# Options :
#   --name <nom>          base des artefacts (défaut : nom du dossier de l'app)
#   --config <fichier>    nom du fichier de configuration (défaut <nom>-config.json)
#   --set-default         écrit aussi public/disks/v86-config.json (page d'accueil)
#   --env-file <fichier>  fragment shell de variables propres à l'application,
#                         évalué à la construction (voir env/jiyufit.env)
#   --mount-path <chemin> point de montage Rack de l'application (défaut /app)
#   --ruby <version>      force la version de Ruby (complète : X.Y.Z), quand le
#                         .ruby-version de l'application contredit son Gemfile
#   --db-prepare <cmd>    commande de préparation de la base
#   --seed <cmd>          commande de seed ("" pour aucune)
#   --seed-optional       un seed en échec n'arrête pas la construction
#   --size-mb <n>         taille de l'image ext2 (défaut : calculée sur le rootfs)
#   --memory-mb <n>       mémoire de la VM annoncée dans la configuration
#   --no-cache            reconstruction complète de l'image Docker
set -euo pipefail

# Mémorisé avant l'analyse des options (qui consomme "$@") : sert au message
# d'erreur qui redonne la commande complète à relancer en root.
ORIGINAL_ARGS="$*"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/public/disks"
CMDLINE="root=/dev/sda rw console=ttyS0 init=/opt/rib/guest-init.sh net.ifnames=0 quiet loglevel=4"
# Marge appliquée à la taille du rootfs exporté : l'ext2 doit encaisser les
# écritures de l'application (base, logs, cache) sans jamais être agrandi.
SIZE_MARGIN_PERCENT=35
SIZE_MARGIN_MB=384

APP_DIR=""
NAME=""
CONFIG_NAME=""
SET_DEFAULT=0
ENV_FILE=""
MOUNT_PATH="/app"
RUBY_OVERRIDE=""
DB_PREPARE_OVERRIDE=""
SEED_OVERRIDE=""
SEED_OVERRIDE_SET=0
SEED_OPTIONAL=0
SIZE_MB="${SIZE_MB:-}"
MEMORY_MB="${MEMORY_MB:-1024}"
NO_CACHE=""

usage() {
  sed -n '2,30p' "$0" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --config) CONFIG_NAME="$2"; shift 2 ;;
    --set-default) SET_DEFAULT=1; shift ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --mount-path) MOUNT_PATH="$2"; shift 2 ;;
    --ruby) RUBY_OVERRIDE="$2"; shift 2 ;;
    --db-prepare) DB_PREPARE_OVERRIDE="$2"; shift 2 ;;
    --seed) SEED_OVERRIDE="$2"; SEED_OVERRIDE_SET=1; shift 2 ;;
    --seed-optional) SEED_OPTIONAL=1; shift ;;
    --size-mb) SIZE_MB="$2"; shift 2 ;;
    --memory-mb) MEMORY_MB="$2"; shift 2 ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help) usage ;;
    -*) echo "Option inconnue : $1" >&2; usage ;;
    *) [ -z "$APP_DIR" ] || { echo "Un seul dossier d'application attendu" >&2; usage; }
       APP_DIR="$1"; shift ;;
  esac
done

[ -n "$APP_DIR" ] || usage
command -v docker >/dev/null || { echo "docker introuvable" >&2; exit 1; }
command -v mke2fs >/dev/null || { echo "mke2fs introuvable (apt install e2fsprogs)" >&2; exit 1; }
command -v node >/dev/null || { echo "node introuvable (requis par l'auto-détection)" >&2; exit 1; }
[ -f "$APP_DIR/Gemfile" ] || { echo "Pas d'application Rails ici : $APP_DIR" >&2; exit 1; }
# docker export ne restitue ni /etc/hosts ni les uid d'origine si l'extraction
# n'est pas faite en root : PostgreSQL refuserait alors de démarrer dans la VM.
[ "$(id -u)" -eq 0 ] || {
  echo "build.sh doit tourner en root (préservation des uid à l'extraction)." >&2
  echo "Depuis Windows :  wsl -u root -e bash tools/build-v86-image/build.sh $ORIGINAL_ARGS" >&2
  exit 1
}

APP_DIR="$(cd "$APP_DIR" && pwd)"
[ -n "$NAME" ] || NAME="$(basename "$APP_DIR" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
[ -n "$CONFIG_NAME" ] || CONFIG_NAME="$NAME-config.json"

########################################################################
# 1. Auto-détection : manifeste -> arguments de construction
########################################################################
echo "→ Analyse de l'application ($APP_DIR)…"
ARGS_FILE="$(mktemp)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR" "$ARGS_FILE"' EXIT

# Un diagnostic bloquant (MySQL, dossier qui n'est pas une app Rails…) arrête
# ici : le rapport de l'auto-détection est déjà parti sur la sortie d'erreur.
if ! node "$SCRIPT_DIR/manifest-to-args.mjs" "$APP_DIR" "$NAME" > "$ARGS_FILE"; then
  echo "✗ Construction refusée : voir le rapport ci-dessus." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ARGS_FILE"

if [ -n "$RUBY_OVERRIDE" ]; then RUBY_VERSION="$RUBY_OVERRIDE"; fi
if [ -n "$DB_PREPARE_OVERRIDE" ]; then DB_PREPARE_COMMAND="$DB_PREPARE_OVERRIDE"; fi
if [ "$SEED_OVERRIDE_SET" -eq 1 ]; then SEED_COMMAND="$SEED_OVERRIDE"; fi
# Deux sources d'environnement, traitées DIFFÉREMMENT côté Dockerfile :
#  - APP_ENV_MANIFEST (railsbox.yml, tiers non fiable) : ajouté verbatim,
#    jamais évalué — un $(commande) y reste une chaîne inerte.
#  - APP_ENV_TRUSTED (--env-file, fourni par l'opérateur du build) : peut
#    contenir des $(openssl rand …) à figer une fois, donc évalué.
# Ne JAMAIS fusionner les deux : ce serait rouvrir l'injection de commandes.
APP_ENV_TRUSTED=""
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || { echo "--env-file introuvable : $ENV_FILE" >&2; exit 1; }
  APP_ENV_TRUSTED="$(cat "$ENV_FILE")"$'\n'
fi

echo "  Ruby $RUBY_VERSION · base $DATABASE · redis $WITH_REDIS · assets « $ASSETS_STAGE »"
echo "  paquets supplémentaires : ${EXTRA_PACKAGES:-aucun}"
echo "  seed : ${SEED_COMMAND:-aucun}"

########################################################################
# 2. Construction de l'image Docker i386
########################################################################
IMAGE_TAG="railsbox-$NAME"
echo "→ Build Docker i386 (long au premier passage : compilation de Ruby $RUBY_VERSION)…"
docker build --platform linux/386 $NO_CACHE -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_TAG" \
  --build-arg "APP_NAME=$NAME" \
  --build-arg "RUBY_VERSION=$RUBY_VERSION" \
  --build-arg "DATABASE=$DATABASE" \
  --build-arg "WITH_POSTGRES=$WITH_POSTGRES" \
  --build-arg "PG_VERSION=${PG_VERSION:-15}" \
  --build-arg "WITH_REDIS=$WITH_REDIS" \
  --build-arg "NPM_ASSETS=$NPM_ASSETS" \
  --build-arg "HOST_ASSETS=$HOST_ASSETS" \
  --build-arg "NPM_INSTALL_COMMAND=$NPM_INSTALL_COMMAND" \
  --build-arg "PACKAGE_MANAGER=${PACKAGE_MANAGER:-npm}" \
  --build-arg "ASSET_SCRIPTS=$ASSET_SCRIPTS" \
  --build-arg "ASSET_PRECOMPILE=$ASSET_PRECOMPILE" \
  --build-arg "EXTRA_PACKAGES=$EXTRA_PACKAGES" \
  --build-arg "MOUNT_PATH=$MOUNT_PATH" \
  --build-arg "DB_PREPARE_COMMAND=$DB_PREPARE_COMMAND" \
  --build-arg "SEED_COMMAND=$SEED_COMMAND" \
  --build-arg "SEED_OPTIONAL=$SEED_OPTIONAL" \
  --build-arg "APP_ENV_MANIFEST=$APP_ENV_MANIFEST" \
  --build-arg "APP_ENV_TRUSTED=$APP_ENV_TRUSTED" \
  "$APP_DIR"

########################################################################
# 3. Export du rootfs et fabrication de l'image disque
########################################################################
echo "→ Export du rootfs…"
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

########################################################################
# 4. Configuration lue par public/main.js et par validate-boot.mjs
########################################################################
DISK_SIZE_BYTES=$(stat -c%s "$OUTPUT_DIR/$NAME.ext2")
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
write_config() {
  cat > "$1" <<JSON
{
  "name": "$NAME",
  "kernel": "/disks/$NAME-vmlinuz",
  "initrd": "/disks/$NAME-initrd",
  "disk": "/disks/$NAME.ext2",
  "diskSize": $DISK_SIZE_BYTES,
  "cmdline": "$CMDLINE",
  "memoryMb": $MEMORY_MB,
  "mountPath": "$MOUNT_PATH",
  "database": "$DATABASE",
  "builtAt": "$BUILT_AT"
}
JSON
}
write_config "$OUTPUT_DIR/$CONFIG_NAME"
# v86-config.json est le seul nom que la page d'accueil sait charger : on ne
# l'écrase que sur demande explicite, pour ne pas détrôner une autre image.
if [ "$SET_DEFAULT" -eq 1 ]; then
  write_config "$OUTPUT_DIR/v86-config.json"
fi

echo "✓ Artefacts prêts dans public/disks/ :"
ls -lh "$OUTPUT_DIR/$NAME".* "$OUTPUT_DIR/$NAME-"* 2>/dev/null | sort -u
echo "Valider le boot :  node tools/build-v86-image/validate-boot.mjs $CONFIG_NAME"
if [ "$SET_DEFAULT" -eq 1 ]; then
  echo "Ouvrir ensuite : http://localhost:8080/"
fi
exit 0
