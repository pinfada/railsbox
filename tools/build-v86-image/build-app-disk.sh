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

########################################################################
# Fonctions de diagnostic de volumétrie
########################################################################
# Nomme les plus gros répertoires d'un arbre. Sans cela, un refus de volumétrie
# annonce « 589 Mo » et laisse le mainteneur sans la moindre piste : c'est le
# diagnostic qui manquait le plus.
#
# Un répertoire qui ne fait que porter un enfant presque aussi lourd n'apprend
# rien de plus (« vendor », puis « vendor/bundle » à 1 Mo près) : on ne garde
# que le plus PROFOND de la chaîne, le seul chemin réellement parlant.
plus_gros_repertoires() {
  local racine="$1"
  du -m -d 3 "$racine" 2>/dev/null | sort -rn | awk -F'\t' -v racine="$racine" '
    BEGIN { n = 0; gardes = 0 }
    {
      chemin = $2
      if (chemin == racine) next
      if (index(chemin, racine "/") != 1) next
      if ($1 + 0 < 1) next
      poids[n] = $1 + 0
      chemins[n] = substr(chemin, length(racine) + 2)
      n++
    }
    END {
      # Un parent dont un enfant pèse au moins 90 % de lui sert de simple relais.
      for (i = 0; i < n; i++)
        for (j = 0; j < n; j++)
          if (index(chemins[j], chemins[i] "/") == 1 && poids[j] * 10 >= poids[i] * 9) relais[i] = 1
      # Entrée déjà triée par taille décroissante (sort -rn).
      for (i = 0; i < n && gardes < 12; i++) {
        if (relais[i]) continue
        printf "    %6d Mo  %s\n", poids[i], chemins[i]
        gardes++
      }
    }'
}

APP_DIR="$(cd "$APP_DIR" && pwd)"
[ -n "$NAME" ] || NAME="$(basename "$APP_DIR" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"

# BuildKit est une exigence, pas un confort : les contextes de build nommés
# (--build-context), les sorties locales (--output) et les heredocs des
# Dockerfile n'existent pas sans lui.
export DOCKER_BUILDKIT=1

# Révision de base épinglée, tirée du tag de --base. Elle décide de la frontière
# entre ce que la base mutualisée fournit déjà et ce que la surcouche doit
# installer sur le disque applicatif (ADR 0006). Un tag hors convention (image
# locale sans tag, empreinte sha256) laisse la répartition se faire sur la base
# la plus récente que connaît le dépôt — les sondes Docker plus bas rattrapent
# alors le cas.
BASE_REVISION=""
case "$BASE_IMAGE" in *:*) BASE_REVISION="${BASE_IMAGE##*:}" ;; esac

echo "→ Analyse de l'application ($APP_DIR)…"
ARGS_FILE="$(mktemp)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR" "$ARGS_FILE"' EXIT
# La base est passée à l'analyse : c'est elle qui fixe le Ruby que la VM
# exécutera, donc la compatibilité de la directive `ruby` du Gemfile. Sans
# cette information, le désaccord n'éclatait qu'au bundle install de
# app.Dockerfile, plusieurs minutes plus tard (Bundler::RubyVersionMismatch).
# --base accepte aussi bien « 3.3-r2 » que la référence d'image complète.
#
# Passé VIDE quand l'appelant n'a rien précisé, et c'est délibéré : le défaut
# local (railsbox-base-<série>) se déduit de la version de Ruby, donc de cette
# analyse même. Supposer 3.3-r2 refuserait à tort une application d'une autre
# série. Sans --base, la vérification est simplement annoncée comme non faite —
# le workflow, lui, la passe toujours, et c'est là que les neuf minutes vivent.
if ! node "$SCRIPT_DIR/manifest-to-args.mjs" "$APP_DIR" "$NAME" \
     ${BASE_REVISION:+--base "$BASE_REVISION"} > "$ARGS_FILE"; then
  echo "✗ Construction refusée : voir le rapport ci-dessus." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ARGS_FILE"

if [ "$SEED_OVERRIDE_SET" -eq 1 ]; then SEED_COMMAND="$SEED_OVERRIDE"; fi

SERIES="$(echo "$RUBY_VERSION" | cut -d. -f1,2)"
[ -n "$BASE_IMAGE" ] || BASE_IMAGE="railsbox-base-$SERIES"
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "✗ Image de base introuvable : $BASE_IMAGE" >&2
  echo "  Construisez-la d'abord :  bash tools/build-v86-image/base/base-build.sh --ruby $RUBY_VERSION" >&2
  exit 1
fi

# PostgreSQL n'existe dans la base qu'à partir de la révision 3.3-r2. Une base
# antérieure produirait un disque applicatif dont l'initdb échoue au milieu du
# build, plusieurs minutes après le début — on tranche ici, avec le remède.
if [ "${WITH_POSTGRES:-0}" = 1 ]; then
  PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin/initdb"
  if ! docker run --rm --platform linux/386 "$BASE_IMAGE" test -x "$PG_BIN" >/dev/null 2>&1; then
    echo "✗ L'image de base $BASE_IMAGE ne fournit pas PostgreSQL $PG_VERSION." >&2
    echo "  PostgreSQL est apparu dans la base 3.3-r2 : utilisez une base au moins" >&2
    echo "  aussi récente (--base ghcr.io/pinfada/railsbox-base:3.3-r2, ou l'entrée" >&2
    echo "  « base: 3.3-r2 » du workflow construire-sandbox)." >&2
    exit 1
  fi
fi

# Surcouche système : ce que la base épinglée ne fournit pas est installé au
# build du disque applicatif puis relocalisé sur celui-ci (ADR 0006). La
# répartition a été calculée par manifest-to-args à partir de BASE_REVISION ;
# on la SONDE ici sur l'image réelle, car un tag hors convention (image locale,
# empreinte) n'a rien pu dire. Un paquet que la base fournit déjà et que la
# sonde ne trouve pas rejoint la surcouche : mieux vaut l'installer deux fois
# que produire une sandbox qui plante au premier redimensionnement.
for sonde_paire in "libvips42:vips" "imagemagick:convert"; do
  paquet="${sonde_paire%%:*}"
  outil="${sonde_paire##*:}"
  case " ${EXTRA_PACKAGES:-} " in *" $paquet "*) ;; *) continue ;; esac
  case " ${SYSTEM_PACKAGES:-} " in *" $paquet "*) continue ;; esac
  if ! docker run --rm --platform linux/386 "$BASE_IMAGE" sh -c "command -v $outil" >/dev/null 2>&1; then
    echo "  ⚠ L'image de base $BASE_IMAGE ne fournit pas « $outil » : $paquet passe en surcouche."
    SYSTEM_PACKAGES="${SYSTEM_PACKAGES:+$SYSTEM_PACKAGES }$paquet"
  fi
done

# Le nombre de variables est affiché : un bloc `env:` silencieusement ignoré
# est une panne très difficile à diagnostiquer depuis le navigateur.
ENV_COUNT="$(printf '%s' "${APP_ENV_MANIFEST:-}" | grep -c '^export ' || true)"
echo "  Base $BASE_IMAGE · Ruby $RUBY_VERSION · db $DATABASE · seed ${SEED_COMMAND:-aucun}"
# Le Ruby du guest n'est PAS RUBY_VERSION : celui-ci ne choisit que la série
# (donc la base) et l'image de l'étage amd64. Les afficher côte à côte évite la
# confusion la plus coûteuse du produit.
echo "  Ruby du guest : ${BASE_RUBY_VERSION:-inconnu} (compilé dans la base, non modifiable)"
if [ "${WITH_POSTGRES:-0}" != 1 ] && [ -n "${SQLITE_DATABASE_URL:-}" ]; then
  echo "  DATABASE_URL sqlite3 : $SQLITE_DATABASE_URL (override réel de config/database.yml)"
fi
if [ -n "${FORCE_SSL_INITIALIZER:-}" ]; then
  echo "  force_ssl : neutralisé dans le guest"
else
  echo "  force_ssl : conservé (RAILSBOX_KEEP_FORCE_SSL)"
fi
if [ "${WITH_POSTGRES:-0}" = 1 ]; then
  echo "  Cluster PostgreSQL $PG_VERSION : $PG_DATABASE dans ${PG_DATA_DIR} (sur le disque applicatif)"
fi
echo "  Environnement déclaré : $ENV_COUNT variable(s)"
echo "  Montée sous : ${MOUNT_PREFIX}/app"
echo "  Assets : précompilation « ${ASSETS_STAGE:-aucun} »${BINARY_ASSET_GEMS:+ (${BINARY_ASSET_GEMS})}"
if [ -n "${SYSTEM_PACKAGES:-}" ]; then
  echo "  Surcouche système : ${SYSTEM_PACKAGES} (installée sur le disque applicatif)"
  if [ -n "${SYSTEM_PACKAGES_HINT:-}" ]; then
    echo "    ↪ la base ${SYSTEM_PACKAGES_HINT} en fournit tout ou partie : l'épingler coûterait"
    echo "      moins cher (rootfs mutualisé, lu par morceaux) que la surcouche, qui pèse"
    echo "      sur les 512 Mo du disque applicatif."
  fi
else
  echo "  Surcouche système : aucune (la base fournit tout)"
fi
if [ -n "${AUTO_LOGIN_INITIALIZER:-}" ]; then
  echo "  Auto-connexion : activée"
else
  echo "  Auto-connexion : aucune (le visiteur arrivera déconnecté)"
fi

########################################################################
# Contexte de construction FILTRÉ
########################################################################
# Le disque applicatif a une géométrie FIXE de 512 Mo (ADR 0002), et
# `COPY . .` y déversait l'arbre du dépôt TEL QUEL : historique git, bundle
# vendorisé d'un autre Ruby, assets précompilés que la construction réémet.
# Sur la première application tierce réelle, cela faisait 261 Mo avant même le
# `bundle install`, et le refus tombait à 589 Mo sans dire d'où ils venaient.
#
# Le filtrage a lieu ICI, en fabriquant un contexte de construction à part,
# plutôt que par un `COPY --exclude=` du Dockerfile ou par un `.dockerignore`
# écrit dans le dépôt analysé. Trois raisons, mesurées :
#   · `COPY --exclude=` exige la syntaxe expérimentale `1.7-labs` et n'expanse
#     PAS les variables : `--exclude=${VAR}` est accepté sans broncher et
#     n'exclut rien. Une liste d'exclusions qui dépend de l'application ne peut
#     donc pas s'écrire ainsi — et l'échec serait silencieux ;
#   · un `.dockerignore` déposé dans le dépôt du mainteneur le modifierait ;
#   · le contexte filtré ne franchit pas non plus la frontière du démon Docker,
#     ce qu'aucune des deux autres options n'évite.
#
# Le `.dockerignore` que l'application fournirait, lui, est CONSERVÉ : il est
# copié avec le reste, et BuildKit l'applique par-dessus ce filtrage.
BUILD_CONTEXT="$WORK_DIR/contexte"
mkdir -p "$BUILD_CONTEXT"
echo "→ Filtrage du contenu applicatif…"
AVANT_MB="$(du -sm "$APP_DIR" | cut -f1)"

# Mesuré AVANT la copie, sur l'arbre d'origine : un mainteneur qui lit
# « vendor/bundle 143 Mo écarté » comprend immédiatement, là où « 589 Mo »
# ne lui laisse aucune prise.
EXCLUS_ABSENTS=""
TAR_EXCLUDES=()
for chemin in ${APP_EXCLUDES:-}; do
  TAR_EXCLUDES+=("--exclude=./$chemin")
  if [ -e "$APP_DIR/$chemin" ]; then
    printf '    %-30s %5s Mo écartés\n' "$chemin" "$(du -sm "$APP_DIR/$chemin" | cut -f1)"
  else
    EXCLUS_ABSENTS="${EXCLUS_ABSENTS:+$EXCLUS_ABSENTS, }$chemin"
  fi
done
[ -z "$EXCLUS_ABSENTS" ] || echo "    (absents du dépôt : $EXCLUS_ABSENTS)"
if [ -f "$APP_DIR/.dockerignore" ]; then
  echo "    .dockerignore fourni par l'application : conservé, BuildKit l'applique en plus."
fi

# GNU tar sort en 1 pour de simples avertissements (fichier modifié pendant la
# lecture, socket ignorée) et en 2 pour une erreur véritable : tout arrêter au
# premier avertissement rendrait la construction capricieuse sans rien protéger.
set +e
if [ ${#TAR_EXCLUDES[@]} -gt 0 ]; then
  tar -c -C "$APP_DIR" "${TAR_EXCLUDES[@]}" . | tar -x -C "$BUILD_CONTEXT"
else
  tar -c -C "$APP_DIR" . | tar -x -C "$BUILD_CONTEXT"
fi
TAR_STATUS=$?
set -e
[ "$TAR_STATUS" -le 1 ] || {
  echo "✗ Copie filtrée du contexte impossible (tar : $TAR_STATUS)." >&2
  exit 1
}

APRES_MB="$(du -sm "$BUILD_CONTEXT" | cut -f1)"
echo "  Arbre du dépôt ${AVANT_MB} Mo → contexte livré au build ${APRES_MB} Mo" \
  "($((AVANT_MB - APRES_MB)) Mo écartés)"

# Credentials : un dépôt tiers livre `config/credentials.yml.enc` SANS sa clé
# (master.key est gitignoré, c'est la règle). Une application qui exige la clé
# — `config.require_master_key = true` — refuse alors de démarrer, et
# assets:precompile meurt sur « Missing encryption key to decrypt file with ».
# Une paire JETABLE est substituée dans le contexte, jamais dans le dépôt, et
# jamais quand l'application fournit sa propre clé : voir credentials-jetables.mjs.
echo "→ Credentials de la sandbox…"
APP_ENV_MANIFEST="${APP_ENV_MANIFEST:-}" \
  node "$SCRIPT_DIR/credentials-jetables.mjs" "$BUILD_CONTEXT"

########################################################################
# Étage amd64 de précompilation des assets (critère C8)
########################################################################
# tailwindcss-ruby, dartsass-ruby et les chaînes npm ne publient aucun binaire
# i386. Leur sortie, elle, est du CSS et du JS ordinaires : on les exécute sur
# l'hôte de construction (amd64) et l'on injecte public/assets dans le disque
# i386 par un contexte de build nommé. Ce contexte existe TOUJOURS — vide quand
# la précompilation a lieu dans le guest — pour que app.Dockerfile reste unique.
ASSETS_CONTEXT="$WORK_DIR/assets"
mkdir -p "$ASSETS_CONTEXT/public/assets" "$ASSETS_CONTEXT/app/assets/builds"

if [ "${ASSETS_STAGE:-aucun}" = "amd64" ]; then
  echo "→ Précompilation des assets sur un étage amd64…"
  # Le repli n'est pas décoratif : une valeur VIDE écraserait le défaut de
  # l'ARG côté Dockerfile et l'étage n'exporterait plus rien.
  ASSET_OUTPUT_DIRS="${ASSET_OUTPUT_DIRS:-public/assets app/assets/builds}"
  echo "  Répertoires exportés : $ASSET_OUTPUT_DIRS"
  docker build --platform linux/amd64 $NO_CACHE -f "$SCRIPT_DIR/assets-amd64.Dockerfile" \
    --build-arg "RUBY_VERSION=$RUBY_VERSION" \
    --build-arg "NPM_ASSETS=${NPM_ASSETS:-0}" \
    --build-arg "NPM_INSTALL_COMMAND=${NPM_INSTALL_COMMAND:-}" \
    --build-arg "ASSET_SCRIPTS=${ASSET_SCRIPTS:-}" \
    --build-arg "ASSET_OUTPUT_DIRS=$ASSET_OUTPUT_DIRS" \
    --build-arg "APP_ENV_MANIFEST=$APP_ENV_MANIFEST" \
    --build-arg "MOUNT_PREFIX=$MOUNT_PREFIX" \
    --output "type=local,dest=$ASSETS_CONTEXT" \
    "$BUILD_CONTEXT"

  # Avertissement remonté de l'étage : des répertoires ont été écrits par les
  # scripts de build sans faire partie de l'export. C'est la panne SILENCIEUSE
  # que le garde-fou « aucun asset » ne voit pas — Tailwind produit ses
  # fichiers, la construction réussit, et le bundle React reste sur l'étage.
  HORS_EXPORT="$ASSETS_CONTEXT/.railsbox-hors-export"
  if [ -s "$HORS_EXPORT" ]; then
    echo "⚠ Répertoires produits par les builds mais NON exportés vers la sandbox :" >&2
    sed 's/^/    /' "$HORS_EXPORT" >&2
    echo "  Leur contenu reste sur l'étage amd64 : la sandbox servira la version" >&2
    echo "  versionnée dans le dépôt, ou rien du tout. Déclarez-les dans railsbox.yml :" >&2
    echo "    assets:" >&2
    echo "      output: [$(paste -sd, - < "$HORS_EXPORT")]" >&2
  fi
  # Le rapport ne doit pas voyager dans le disque applicatif : il a été lu.
  rm -f "$HORS_EXPORT"

  ASSET_COUNT="$(find "$ASSETS_CONTEXT/public/assets" -type f | wc -l)"
  # Seul refus qui subsiste sur les assets, et il est tardif par nature : un
  # étage muet livrerait une application sans CSS, panne que le visiteur ne
  # découvrirait qu'à l'affichage de la page.
  if [ "$ASSET_COUNT" -eq 0 ]; then
    echo "✗ L'étage amd64 n'a produit aucun asset dans public/assets." >&2
    echo "  Vérifiez que « rails assets:precompile » aboutit hors railsbox, et que les" >&2
    echo "  scripts npm de build (${ASSET_SCRIPTS:-aucun}) écrivent bien dans app/assets/builds." >&2
    exit 1
  fi
  echo "  $ASSET_COUNT fichiers précompilés sous ${MOUNT_PREFIX}/app"
fi

########################################################################
# Build de l'image applicative (FROM base) et export de /app
########################################################################
IMAGE_TAG="railsbox-app-$NAME"
echo "→ Build Docker i386 du disque applicatif (FROM $BASE_IMAGE)…"
docker build --platform linux/386 $NO_CACHE -f "$SCRIPT_DIR/base/app.Dockerfile" -t "$IMAGE_TAG" \
  --build-context "railsbox-assets=$ASSETS_CONTEXT" \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "ASSET_PRECOMPILE=${ASSET_PRECOMPILE:-0}" \
  --build-arg "HOST_ASSETS=${HOST_ASSETS:-0}" \
  --build-arg "WITH_REDIS=${WITH_REDIS:-0}" \
  --build-arg "DATABASE=$DATABASE" \
  --build-arg "WITH_POSTGRES=${WITH_POSTGRES:-0}" \
  --build-arg "PG_VERSION=$PG_VERSION" \
  --build-arg "PG_DATA_DIR=${PG_DATA_DIR:-}" \
  --build-arg "PG_DATABASE_URL=${PG_DATABASE_URL:-}" \
  --build-arg "SQLITE_DATABASE_URL=${SQLITE_DATABASE_URL:-}" \
  --build-arg "DB_PREPARE_COMMAND=$DB_PREPARE_COMMAND" \
  --build-arg "SEED_COMMAND=$SEED_COMMAND" \
  --build-arg "SEED_OPTIONAL=$SEED_OPTIONAL" \
  --build-arg "APP_ENV_MANIFEST=$APP_ENV_MANIFEST" \
  --build-arg "AUTO_LOGIN_INITIALIZER=$AUTO_LOGIN_INITIALIZER" \
  --build-arg "FORCE_SSL_INITIALIZER=$FORCE_SSL_INITIALIZER" \
  --build-arg "SYSTEM_PACKAGES=${SYSTEM_PACKAGES:-}" \
  --build-arg "APP_DISK_MB=$APP_DISK_MB" \
  --build-arg "MOUNT_PREFIX=$MOUNT_PREFIX" \
  "$BUILD_CONTEXT"

echo "→ Export de l'arbre /app…"
CONTAINER_ID="$(docker create --platform linux/386 "$IMAGE_TAG")"
docker export "$CONTAINER_ID" | tar -xf - -C "$WORK_DIR" app
docker rm "$CONTAINER_ID" >/dev/null

# Marqueur posé par app.Dockerfile quand les seeds ont tourné sans rien insérer.
# La panne qu'il révèle est SILENCIEUSE par nature : la construction est verte,
# la sandbox démarre, et c'est le visiteur qui découvre des listes vides. Elle
# échappe à l'analyse amont, qui ne peut que lire le fichier de seeds — pas
# savoir qu'un `if ENV[...]` l'a court-circuité.
BASE_VIDE="$WORK_DIR/app/.railsbox/base-vide"
if [ -f "$BASE_VIDE" ]; then
  echo "⚠ Les seeds se sont exécutés et la base est VIDE (aucun enregistrement)." >&2
  echo "  La sandbox démarrera, et ne montrera rien : listes vides, pages « nothing" >&2
  echo "  here yet », formulaires sans contexte. Rien d'autre ne le signalera." >&2
  echo "  Cause la plus fréquente : des seeds conditionnés à des variables" >&2
  echo "  d'environnement absentes ici. Déclarez-les dans le bloc env: de" >&2
  echo "  railsbox.yml — avec des valeurs FACTICES, le disque est public." >&2
  # Lu, donc retiré : il n'a rien à faire dans le disque livré.
  rm -f "$BASE_VIDE"
fi

USED_MB="$(du -sm "$WORK_DIR/app" | cut -f1)"
echo "  Contenu /app : ${USED_MB} Mo (cible ${APP_DISK_MB} Mo)"
if [ "$USED_MB" -gt "$APP_DISK_MB" ]; then
  echo "✗ Le contenu applicatif (${USED_MB} Mo) dépasse la géométrie fixe (${APP_DISK_MB} Mo)." >&2
  echo "  La géométrie ne peut pas changer (contrainte de restauration d'instantané, ADR 0002)." >&2
  echo >&2
  # Le chiffre seul ne se traite pas : c'est le NOM des répertoires coupables
  # qui dit au mainteneur ce qu'il peut alléger.
  echo "  Les plus gros répertoires du contenu livré :" >&2
  plus_gros_repertoires "$WORK_DIR/app" >&2
  echo >&2
  echo "  Déjà écarté du contexte : ${APP_EXCLUDES:-aucun}" >&2
  echo "  Pour en écarter davantage, ajoutez ces chemins à railsbox.yml :" >&2
  echo "    exclude: [doc, db/fixtures]" >&2
  echo "  Les gems (vendor/bundle) et la surcouche système (opt/systeme), elles, ne" >&2
  echo "  s'allègent qu'en retirant des dépendances du Gemfile ou de system_packages:." >&2
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

# Fiche du disque, lue par make-delta-snapshot.mjs : c'est ici, et nulle part
# ailleurs, qu'on sait quelle base de données porte l'application. Sans elle, la
# configuration v86 publiée annoncerait « sqlite3 » à une sandbox PostgreSQL —
# une contre-vérité qui se paierait au diagnostic, pas au boot.
cat > "$OUTPUT_DIR/$NAME-app.json" <<FICHE
{
  "name": "$NAME",
  "database": "$DATABASE",
  "ruby": "$RUBY_VERSION",
  "base": "$BASE_IMAGE"
}
FICHE

echo "✓ Disque applicatif prêt : $NAME-app.ext2 ($((APP_DISK_BYTES / 1048576)) Mo)"
# Le --base de make-delta-snapshot.mjs n'est PAS celui de ce script : il nomme
# le préfixe des artefacts LOCAUX (public/disks/base-3.3-r2.ext2), pas l'image
# Docker de construction. Recopier $BASE_IMAGE ici imprimait une commande qui
# ne peut pas marcher — elle faisait chercher un fichier
# « public/disks/ghcr.io/pinfada/railsbox-base:3.3-r2.ext2 », et l'erreur
# « introuvable » ne disait pas que la faute venait de la ligne suggérée.
BASE_ARTEFACTS="base-${BASE_REVISION:-3.3}"
echo "  Delta d'instantané :  node tools/build-v86-image/make-delta-snapshot.mjs --name $NAME --base $BASE_ARTEFACTS"
echo "    (artefacts attendus : public/disks/$BASE_ARTEFACTS.ext2 et $BASE_ARTEFACTS-state.bin)"
