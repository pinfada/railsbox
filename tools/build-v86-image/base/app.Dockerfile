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

ARG MOUNT_PATH=/app
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
    RAILS_RELATIVE_URL_ROOT=${MOUNT_PATH} \
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

# Précompilation des assets (importmap/propshaft : tout se fait avec le Ruby
# i386 de la base). Les applications à chaîne npm ne sont PAS couvertes par le
# MVP (elles exigeraient l'étage amd64 du build monolithique).
ARG ASSET_PRECOMPILE=1
RUN if [ "${ASSET_PRECOMPILE}" = 1 ]; then bundle exec rails assets:precompile; fi

# Base préparée + seedée PENDANT le build : le premier boot n'a ni migration ni
# amorçage à faire, et l'instantané delta capture une base déjà peuplée. Redis
# de la base démarré au cas où des seeds enfileraient des jobs.
ARG WITH_REDIS=0
ARG DB_PREPARE_COMMAND="bundle exec rails db:prepare"
ARG SEED_COMMAND=""
ARG SEED_OPTIONAL=0
RUN <<'RIB_DB'
set -eu
if [ "${WITH_REDIS}" = 1 ]; then
  redis-server --daemonize yes --port 6379 --save '' --appendonly no
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
# Journaux/caches de build : inutiles sur le disque livré, ils gonflent l'ext2.
rm -rf log/* tmp/* 2>/dev/null || true
RIB_DB

# Environnement propre à l'application, sourcé par start-app.sh après montage.
# Vide pour le MVP sqlite/importmap ; un futur PostgreSQL y fixerait PGDATA.
RUN mkdir -p /app/.railsbox && : > /app/.railsbox/app-env.sh
