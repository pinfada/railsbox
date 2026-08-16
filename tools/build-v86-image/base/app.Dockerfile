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

# Bundle d'abord (couche cachée tant que le Gemfile ne bouge pas). Le lockfile
# du dépôt ne connaît souvent que x86_64-linux : on ajoute la plateforme i386
# (x86-linux) + ruby pour que les gems natives compilent avec la toolchain base.
COPY Gemfile* ./
RUN bundle lock --add-platform x86-linux ruby && bundle install

COPY . .
# COPY . . a rétabli le Gemfile.lock du dépôt : on ré-ajoute la plateforme i386,
# sinon bundle exec refuse le bundle pourtant installé.
RUN bundle lock --add-platform x86-linux ruby && bundle check

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

# Précompilation des assets (importmap/propshaft : tout se fait avec le Ruby
# i386 de la base). Les applications à chaîne npm ne sont PAS couvertes par le
# MVP (elles exigeraient l'étage amd64 du build monolithique).
ARG ASSET_PRECOMPILE=1
RUN if [ "${ASSET_PRECOMPILE}" = 1 ]; then bundle exec rails assets:precompile; fi

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
