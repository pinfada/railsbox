# syntax=docker/dockerfile:1.7
# Construit le DISQUE APPLICATIF (hdb) railsbox découplé (ADR 0002), à partir
# de l'image de BASE. Le résultat exporté (/app) est mkfs'é en un petit ext2 de
# géométrie FIXE (512 Mo). Contient l'arbre de l'application, son bundle
# (BUNDLE_PATH=/app/vendor/bundle — gems natives i386 vivant avec l'app), ses
# assets précompilés et sa base pré-seedée.
#
# Contexte de build attendu : la racine de l'application Rails.
#   docker build --platform linux/386 -f app.Dockerfile \
#     --build-arg BASE_IMAGE=railsbox-base-3.3 --build-arg … -t <tag> <app>

ARG BASE_IMAGE=railsbox-base-3.3
FROM ${BASE_IMAGE} AS appbuild

# La base pose déjà cette personnalité et l'image en hérite ; on la redéclare
# pour que ce Dockerfile reste correct même construit sur une base ancienne.
# Sans elle, les gems natives se compilent en s'étiquetant `x86_64-linux-x32`
# — binaires bons, plateforme fantôme (voir base/Dockerfile).
SHELL ["linux32", "/bin/sh", "-c"]

# Racine PUBLIQUE de la sandbox (« /depot » sur un Pages de projet, vide à la
# racine d'un domaine). Déclarée ici parce que la précompilation des assets en
# a besoin : les URL d'assets figées dans le CSS et le JS doivent porter le
# même préfixe que celles générées à l'exécution.
ARG MOUNT_PREFIX=""
# Clés jetables : ce build ne sert qu'à peupler /app (bundle, assets, base). Les
# vraies clés de session vivent dans l'env.sh figé de la base. BUNDLE_PATH pointe
# dans l'arbre app pour que le bundle soit exporté avec lui.
ENV RAILS_ENV=production \
    RACK_ENV=production \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_JOBS=4 \
    BUNDLE_FROZEN=false \
    BUNDLE_FORCE_RUBY_PLATFORM=true \
    BUNDLE_PATH=/app/vendor/bundle \
    BUNDLE_GEMFILE=/app/Gemfile \
    NOKOGIRI_USE_SYSTEM_LIBRARIES=true \
    RAILS_RELATIVE_URL_ROOT=${MOUNT_PREFIX}/app \
    RAILS_SERVE_STATIC_FILES=true \
    RAILS_LOG_TO_STDOUT=1 \
    SECRET_KEY_BASE=appdisk-build-throwaway \
    ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=0000000000000000000000000000000000000000000000000000000000000000

WORKDIR /app

# ---------------------------------------------------------------------------
# Surcouche de paquets système (ADR 0006)
# ---------------------------------------------------------------------------
# Ce Dockerfile-ci tourne sur le runner de CI, AVEC le réseau — contrairement au
# guest, qui n'en a aucun. On peut donc y faire un apt-get. Ce qu'on ne peut pas
# faire, c'est le laisser écrire dans /usr : ce répertoire vit sur le rootfs de
# base, disque séparé, immuable et mutualisé entre toutes les sandboxes. Seul
# /app voyage avec l'application.
#
# D'où la manœuvre : installer normalement (les gems natives compilent alors
# contre les en-têtes, ici, dans ce conteneur), puis RELOCALISER les fichiers
# des paquets nouvellement installés sous /app/opt/systeme, et écrire le script
# qui les remet dans le chemin de recherche du guest. Les gems compilées, elles,
# vivent déjà sur le disque applicatif (BUNDLE_PATH=/app/vendor/bundle) et
# n'exigent que le SONAME à l'exécution — LD_LIBRARY_PATH suffit.
#
# Le script d'activation est sourcé par app-env.sh, sur le DISQUE APPLICATIF :
# aucune modification de la base n'est nécessaire, la surcouche fonctionne donc
# aussi sur les bases déjà publiées.
#
# SÉCURITÉ : SYSTEM_PACKAGES vient de la table gem → paquets et de la clé
# `system_packages:` de railsbox.yml, donc de code TIERS. Les noms sont validés
# en liste blanche stricte par tools/detect/paquets-systeme.mjs (grammaire
# Debian, premier caractère alphanumérique — donc aucune option apt déguisée) et
# le `--` ci-dessous ferme définitivement la porte : tout ce qui suit est un
# opérande, jamais une option.
# L'installation précède `bundle install` : c'est ce qui permet à une gem
# native de compiler contre les en-têtes fraîchement posées. La relocalisation,
# elle, vient bien plus bas — après `COPY . .`, qui écraserait sinon l'arbre
# relocalisé si l'application possédait elle-même un dossier `opt/`.
ARG SYSTEM_PACKAGES=""
RUN <<'RIB_SYSTEME_INSTALL'
set -eu
: > /tmp/rib-paquets-avant
if [ -z "${SYSTEM_PACKAGES}" ]; then
  echo "[build] aucune surcouche système : la base fournit tout"
  exit 0
fi
# Garde-fou de dernier recours, indépendant de la validation en amont : un nom
# qui ne commence pas par une lettre ou un chiffre, ou qui contient autre chose
# que la grammaire Debian, ne peut pas devenir une option d'apt-get.
for nom in ${SYSTEM_PACKAGES}; do
  case "$nom" in
    [a-z0-9]*) ;;
    *) echo "[build] nom de paquet système refusé : ${nom}" >&2; exit 1 ;;
  esac
  case "$nom" in
    *[!a-z0-9+.-]*) echo "[build] nom de paquet système refusé : ${nom}" >&2; exit 1 ;;
  esac
done
echo "[build] surcouche système demandée : ${SYSTEM_PACKAGES}"
dpkg-query -W -f='${Package}\n' | sort > /tmp/rib-paquets-avant
apt-get update
# shellcheck disable=SC2086
apt-get install -y --no-install-recommends -- ${SYSTEM_PACKAGES}
rm -rf /var/lib/apt/lists/*
RIB_SYSTEME_INSTALL

# Bundle d'abord (couche cachée tant que le Gemfile ne bouge pas). Le lockfile
# du dépôt ne connaît souvent que x86_64-linux : on ajoute la plateforme i386
# (x86-linux) + ruby pour que les gems natives compilent avec la toolchain base.
COPY Gemfile* ./
RUN bundle lock --add-platform x86-linux ruby && bundle install

COPY . .
# COPY . . a rétabli le Gemfile.lock du dépôt : on ré-ajoute la plateforme i386,
# sinon bundle exec refuse le bundle pourtant installé.
RUN bundle lock --add-platform x86-linux ruby && bundle check

# Relocalisation de la surcouche (ADR 0006). Les paquets sont installés dans
# /usr, qui vit sur le rootfs de base — disque séparé, immuable, mutualisé. On
# recopie donc les fichiers des paquets NOUVELLEMENT installés sous
# /app/opt/systeme, seul arbre qui voyage avec l'application, et l'on écrit le
# script qui les remet dans le chemin de recherche du guest.
#
# Après `COPY . .` à dessein : une application possédant un dossier `opt/`
# écraserait sinon l'arbre relocalisé.
ARG APP_DISK_MB=512
RUN <<'RIB_SYSTEME_RELOC'
set -eu
RACINE=/app/opt/systeme
[ -s /tmp/rib-paquets-avant ] || { echo "[build] pas de surcouche à relocaliser"; exit 0; }

apres=$(mktemp); liste=$(mktemp)
dpkg-query -W -f='${Package}\n' | sort > "$apres"
nouveaux=$(comm -13 /tmp/rib-paquets-avant "$apres")
echo "[build] $(printf '%s\n' "$nouveaux" | grep -c .) paquets nouvellement installés"
for p in $nouveaux; do dpkg -L "$p"; done | sort -u > "$liste"

mkdir -p "$RACINE"
while IFS= read -r brut; do
  # Documentation, manuels et traductions : inutiles dans une VM sans terminal,
  # et ce sont eux qui gonflent le plus vite un disque applicatif de 512 Mo.
  case "$brut" in
    /usr/share/doc/*|/usr/share/man/*|/usr/share/lintian/*|/usr/share/locale/*) continue ;;
    /) continue ;;
  esac
  # Debian a fusionné /usr : /lib, /bin et /sbin sont des LIENS vers /usr/…, et
  # dpkg -L rend les deux formes. Sans cette normalisation, la copie tente de
  # créer un répertoire là où un lien existe déjà.
  parent=$(readlink -f "$(dirname "$brut")" 2>/dev/null || dirname "$brut")
  chemin="$parent/$(basename "$brut")"
  if [ -d "$chemin" ] && [ ! -L "$chemin" ]; then mkdir -p "$RACINE$chemin"; continue; fi
  [ -e "$chemin" ] || [ -L "$chemin" ] || continue
  mkdir -p "$RACINE$(dirname "$chemin")"
  cp -a "$chemin" "$RACINE$chemin"
done < "$liste"

poids=$(du -sm "$RACINE" | cut -f1)
echo "[build] surcouche relocalisée : ${poids} Mo dans ${RACINE}"
# Le disque applicatif a une géométrie FIXE de 512 Mo (ADR 0002) partagée par
# l'application, son bundle, sa base seedée ET la surcouche. On tranche ici,
# avec le chiffre : mesuré, ffmpeg pèse 623 Mo à lui seul et ne tiendra jamais.
plafond=$(( APP_DISK_MB * 3 / 5 ))
if [ "$poids" -gt "$plafond" ]; then
  echo "✗ La surcouche système pèse ${poids} Mo, au-delà des ${plafond} Mo qu'un" >&2
  echo "  disque applicatif de ${APP_DISK_MB} Mo peut lui céder sans étouffer" >&2
  echo "  l'application, son bundle et sa base." >&2
  echo "  Retirez des paquets de system_packages:, ou demandez leur entrée dans la" >&2
  echo "  base mutualisée avec le gabarit « Ma stack n'est pas prise en charge »." >&2
  exit 1
fi

mkdir -p /app/.railsbox
cat > /app/.railsbox/systeme.sh <<'ACTIVATION'
# Surcouche de paquets système, relocalisée sur le disque applicatif (ADR 0006).
# Sourcée par app-env.sh, après le montage de /app par start-app.sh — donc sans
# rien exiger de la base, qui reste immuable et fonctionne telle quelle.
RIB_SYS=/app/opt/systeme
if [ -d "$RIB_SYS" ]; then
  for rep in "$RIB_SYS/usr/lib/i386-linux-gnu" "$RIB_SYS/usr/lib"; do
    [ -d "$rep" ] && LD_LIBRARY_PATH="$rep${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  done
  export LD_LIBRARY_PATH
  for rep in "$RIB_SYS/usr/bin" "$RIB_SYS/usr/sbin"; do
    [ -d "$rep" ] && PATH="$rep:$PATH"
  done
  export PATH
fi
ACTIVATION
RIB_SYSTEME_RELOC

# Auto-connexion du visiteur (contrainte produit : arriver sur une démonstration
# peuplée, session ouverte). Déposé dans l'arbre de l'application plutôt que
# dans la base : le middleware doit s'insérer DANS la pile de Rails, après la
# session et Warden, ce que seul un initialiseur permet. Vide quand le manifeste
# n'en demande pas — aucun fichier n'est alors créé.
#
# SÉCURITÉ : contenu produit par auto-login.mjs à partir de railsbox.yml, donc
# de code TIERS. Écrit VERBATIM, jamais évalué ici ; il ne s'exécute que dans le
# guest, où le code de l'application tourne déjà.
ARG AUTO_LOGIN_INITIALIZER=""
RUN <<'RIB_AUTOLOGIN'
set -eu
if [ -n "${AUTO_LOGIN_INITIALIZER}" ]; then
  mkdir -p config/initializers
  printf '%s\n' "${AUTO_LOGIN_INITIALIZER}" > config/initializers/zzz_railsbox_auto_login.rb
  ruby -c config/initializers/zzz_railsbox_auto_login.rb
  echo "[build] auto-connexion installée"
else
  echo "[build] aucune auto-connexion demandée"
fi
RIB_AUTOLOGIN

# Assets précompilés sur l'étage amd64 (tailwindcss-ruby, dartsass-ruby et les
# chaînes npm n'ont aucun binaire i386 — voir assets-amd64.Dockerfile). Le
# contexte nommé « railsbox-assets » est TOUJOURS fourni par build-app-disk.sh :
# vide quand la précompilation a lieu dans le guest, ces deux COPY ne créent
# alors que des répertoires. Ils précèdent la précompilation i386, qui ne
# tourne que dans l'autre cas.
COPY --from=railsbox-assets public/assets ./public/assets
COPY --from=railsbox-assets app/assets/builds ./app/assets/builds

# Précompilation des assets DANS le guest (importmap/propshaft pur : tout se
# fait avec le Ruby i386 de la base). Vaut 0 dès que l'étage amd64 s'en est
# chargé — relancer ici échouerait précisément sur les binaires absents.
ARG ASSET_PRECOMPILE=1
ARG HOST_ASSETS=0
RUN <<'RIB_ASSETS'
set -eu
if [ "${HOST_ASSETS}" = 1 ]; then
  fichiers="$(find public/assets -type f | wc -l)"
  # Garde-fou : un étage amd64 muet laisserait une application sans CSS, panne
  # que le visiteur ne découvrirait qu'à l'affichage de la page.
  if [ "${fichiers}" -eq 0 ]; then
    echo "[build] AUCUN asset reçu de l'étage amd64 — construction interrompue" >&2
    exit 1
  fi
  echo "[build] ${fichiers} assets précompilés reçus de l'étage amd64"
elif [ "${ASSET_PRECOMPILE}" = 1 ]; then
  bundle exec rails assets:precompile
else
  echo "[build] aucun pipeline d'assets détecté"
fi
RIB_ASSETS

# Base préparée + seedée PENDANT le build : le premier boot n'a ni migration ni
# amorçage à faire, et l'instantané delta capture une base déjà peuplée. Redis
# de la base démarré au cas où des seeds enfileraient des jobs.
#
# PostgreSQL suit exactement la même logique que le fichier sqlite3, à ceci près
# que l'« état » est un répertoire : le cluster est initialisé dans
# PG_DATA_DIR (/app/var/pg), migré, seedé, puis ARRÊTÉ PROPREMENT — c'est cet
# arrêt qui rend le datadir cohérent sur disque avant le mkfs de l'ext2. Le
# datadir étant sous /app, il est exporté avec l'arbre applicatif et voyage avec
# lui : le visiteur reçoit une base déjà peuplée, sans migration au boot.
ARG WITH_REDIS=0
ARG WITH_POSTGRES=0
ARG PG_VERSION=15
ARG PG_DATA_DIR=""
ARG PG_DATABASE_URL=""
ARG DB_PREPARE_COMMAND="bundle exec rails db:prepare"
ARG SEED_COMMAND=""
ARG SEED_OPTIONAL=0
RUN <<'RIB_DB'
set -eu
if [ "${WITH_REDIS}" = 1 ]; then
  redis-server --daemonize yes --port 6379 --save '' --appendonly no
fi
if [ "${WITH_POSTGRES}" = 1 ]; then
  export PGDATA="${PG_DATA_DIR}"
  export RIB_PG_VERSION="${PG_VERSION}"
  export DATABASE_URL="${PG_DATABASE_URL}"
  sh /opt/rib/postgres.sh start
fi
mkdir -p tmp/pids tmp/cache log storage
sh -c "${DB_PREPARE_COMMAND}"
if [ -n "${SEED_COMMAND}" ]; then
  if [ "${SEED_OPTIONAL}" = 1 ]; then
    sh -c "${SEED_COMMAND}" || echo "[build] seeds partiels — non bloquant"
  else
    sh -c "${SEED_COMMAND}"
  fi
fi
if [ "${WITH_REDIS}" = 1 ]; then redis-cli shutdown nosave || true; fi
if [ "${WITH_POSTGRES}" = 1 ]; then
  PGDATA="${PG_DATA_DIR}" RIB_PG_VERSION="${PG_VERSION}" sh /opt/rib/postgres.sh stop
  du -sh "${PG_DATA_DIR}"
fi
# Journaux/caches de build : inutiles sur le disque livré, ils gonflent l'ext2.
rm -rf log/* tmp/* 2>/dev/null || true
RIB_DB

# Environnement propre à l'application, sourcé par start-app.sh après montage
# du disque applicatif. C'est LE canal par lequel le guest apprend quelle base
# la sandbox utilise : RAILSBOX_DATABASE commande le démarrage (ou non) du
# cluster PostgreSQL, PGDATA en désigne le datadir sur ce même disque, et
# DATABASE_URL fait pointer Rails dessus quel que soit son config/database.yml.
#
# SÉCURITÉ : APP_ENV_MANIFEST provient de railsbox.yml, donc de code TIERS. Il
# est écrit VERBATIM, jamais évalué ici : les valeurs sont déjà single-quotées
# par manifest-to-args.mjs (un `$(commande)` reste une chaîne littérale) et les
# noms de variables sont validés à l'analyse du manifeste (invalid-env-name).
#
# RAILSBOX_SANDBOX marque le contexte d'exécution : l'initialiseur
# d'auto-connexion s'en sert comme garde et reste inerte partout ailleurs. Il
# est posé ici, sur le disque applicatif, plutôt que dans l'env.sh de la base —
# celle-ci est publiée et immuable, la toucher imposerait une nouvelle version.
#
# MOUNT_PREFIX : racine PUBLIQUE de la sandbox, « /depot » sur un Pages de
# projet, vide à la racine d'un domaine. L'application est montée sur
# « <préfixe>/app » et non sur « /app » : sans cela Rails générerait ses liens
# et ses URL d'assets à la racine du domaine, hors du site — et hors de la
# portée du Service Worker, qui ne pourrait même pas les rattraper.
ARG APP_ENV_MANIFEST=""
ARG DATABASE=sqlite3
RUN <<'RIB_APP_ENV'
set -eu
mkdir -p /app/.railsbox
{
  # EN PREMIER : la surcouche système (ADR 0006). LD_LIBRARY_PATH et PATH
  # doivent être posés avant tout le reste — le cluster PostgreSQL comme Puma
  # sont lancés par start-app.sh après ce sourcing, et une gem FFI cherche sa
  # bibliothèque au premier `require`. Le test d'existence garde le fichier
  # facultatif : sans surcouche, il n'est pas écrit.
  # `if` plutôt que `[ … ] && …` : start-app.sh tourne sous `set -e`, et un
  # test faux en fin de fichier sourcé y ferait remonter un état d'échec.
  echo 'if [ -f /app/.railsbox/systeme.sh ]; then . /app/.railsbox/systeme.sh; fi'
  echo "export RAILSBOX_SANDBOX=1"
  echo "export RAILS_RELATIVE_URL_ROOT=${MOUNT_PREFIX}/app"
  echo "export RAILSBOX_DATABASE=${DATABASE}"
  if [ "${WITH_POSTGRES}" = 1 ]; then
    echo "export PGDATA=${PG_DATA_DIR}"
    echo "export DATABASE_URL='${PG_DATABASE_URL}'"
  fi
  # En DERNIER : le bloc `env:` du railsbox.yml a le dernier mot, y compris sur
  # DATABASE_URL — une application peut ainsi imposer sa propre chaîne.
  printf '%s\n' "${APP_ENV_MANIFEST}"
} > /app/.railsbox/app-env.sh
chmod 600 /app/.railsbox/app-env.sh
RIB_APP_ENV
