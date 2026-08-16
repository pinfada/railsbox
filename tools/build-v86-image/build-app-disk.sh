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
#   --mount-prefix <p>  racine PUBLIQUE de la sandbox (« /depot » sur un Pages
#                       de projet) : l'application y est montée sur <p>/app
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
MOUNT_PREFIX=""

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --base) BASE_IMAGE="$2"; shift 2 ;;
    --seed) SEED_OVERRIDE="$2"; SEED_OVERRIDE_SET=1; shift 2 ;;
    --seed-optional) SEED_OPTIONAL=1; shift ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    --mount-prefix) MOUNT_PREFIX="$2"; shift 2 ;;
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
# Tailwind et dart-sass précompilent leurs assets avec un EXÉCUTABLE livré par
# plateforme, et aucun n'existe pour i386 (vérifié sur rubygems). Sans cette
# garde, `rails assets:precompile` échouerait dans la VM sur un binaire
# illisible — un message incompréhensible, dix minutes après le début du build.
if [ -n "${BINARY_ASSET_GEMS:-}" ]; then
  echo "✗ Outils d'assets à binaire précompilé, indisponibles en i386 : $BINARY_ASSET_GEMS" >&2
  echo "  Ces gems livrent un exécutable par plateforme (x86_64, arm64) et railsbox" >&2
  echo "  construit en 32 bits. Contournement : précompilez vos assets en amont et" >&2
  echo "  versionnez public/assets, ou attendez l'étage de précompilation amd64." >&2
  exit 1
fi
# La base est mutualisée : son jeu de bibliothèques système est figé à sa
# construction et le disque applicatif ne peut rien y ajouter. Une gem native
# réclamant autre chose échouerait à la compilation, loin de la cause — on
# refuse ici, avec le nom des paquets et le remède.
MISSING="$(node "$SCRIPT_DIR/split-config.mjs" --check-packages "${EXTRA_PACKAGES:-}")" || {
  echo "✗ La base ne fournit pas les bibliothèques système : $MISSING" >&2
  echo "  Ajoutez ces paquets à tools/build-v86-image/base/Dockerfile puis reconstruisez" >&2
  echo "  la base (base-build.sh) — le disque applicatif ne peut pas les installer." >&2
  exit 1
}

SERIES="$(echo "$RUBY_VERSION" | cut -d. -f1,2)"
[ -n "$BASE_IMAGE" ] || BASE_IMAGE="railsbox-base-$SERIES"
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "✗ Image de base introuvable : $BASE_IMAGE" >&2
  echo "  Construisez-la d'abord :  bash tools/build-v86-image/base/base-build.sh --ruby $RUBY_VERSION" >&2
  exit 1
fi

# Le nombre de variables est affiché : un bloc `env:` silencieusement ignoré
# est une panne très difficile à diagnostiquer depuis le navigateur.
ENV_COUNT="$(printf '%s' "${APP_ENV_MANIFEST:-}" | grep -c '^export ' || true)"
echo "  Base $BASE_IMAGE · Ruby $RUBY_VERSION · db $DATABASE · seed ${SEED_COMMAND:-aucun}"
echo "  Environnement déclaré : $ENV_COUNT variable(s)"
echo "  Montée sous : ${MOUNT_PREFIX}/app"
if [ -n "${AUTO_LOGIN_INITIALIZER:-}" ]; then
  echo "  Auto-connexion : activée"
else
  echo "  Auto-connexion : aucune (le visiteur arrivera déconnecté)"
fi

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
  --build-arg "APP_ENV_MANIFEST=$APP_ENV_MANIFEST" \
  --build-arg "AUTO_LOGIN_INITIALIZER=$AUTO_LOGIN_INITIALIZER" \
  --build-arg "MOUNT_PREFIX=$MOUNT_PREFIX" \
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
