# syntax=docker/dockerfile:1.7
# Étage amd64 de PRÉCOMPILATION DES ASSETS pour la voie découplée (ADR 0002).
#
# Pourquoi un étage à part : tailwindcss-ruby et dartsass-ruby ne publient
# aucun exécutable i386, et les chaînes npm (esbuild, sass) pas davantage. Or
# ces outils produisent du CSS et du JS ORDINAIRES, indépendants de
# l'architecture. On les exécute donc ici, sur l'hôte de construction amd64,
# et le disque applicatif i386 se contente de recevoir le résultat : le guest
# n'exécute jamais ces binaires.
#
# L'étage final est un `scratch` qui ne contient QUE les répertoires produits :
# il est destiné à `--output type=local`, pas à être exécuté.
#
#   docker build --platform linux/amd64 -f assets-amd64.Dockerfile \
#     --build-arg RUBY_VERSION=3.3.12 --build-arg MOUNT_PREFIX=/depot \
#     --output type=local,dest=<dossier> <app>

ARG RUBY_VERSION=3.3.12
FROM --platform=linux/amd64 ruby:${RUBY_VERSION}-slim AS precompilation

ENV DEBIAN_FRONTEND=noninteractive

# Bibliothèques de développement des gems natives usuelles. En amd64, Bundler
# retient normalement les gems précompilées x86_64 (aucun BUNDLE_FORCE_RUBY_-
# PLATFORM ici, contrairement au disque i386) ; ces paquets ne servent qu'aux
# gems sans variante binaire. nodejs/npm n'est installé que si l'application a
# une chaîne npm — l'économie est réelle sur une application Tailwind pure.
ARG NPM_ASSETS=0
RUN set -eu; \
    paquets="build-essential git curl ca-certificates openssl pkg-config \
      libyaml-dev zlib1g-dev libxml2-dev libxslt1-dev libsqlite3-dev libpq-dev"; \
    if [ "${NPM_ASSETS}" = 1 ]; then paquets="${paquets} nodejs npm"; fi; \
    apt-get update && apt-get install -y --no-install-recommends ${paquets} \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bundle d'abord : couche cachée tant que le Gemfile ne bouge pas.
ENV BUNDLE_WITHOUT="development:test" BUNDLE_JOBS=4 BUNDLE_FROZEN=false
COPY Gemfile* ./
RUN bundle install

COPY . .

# Dépendances front. La commande vient de l'auto-détection : `npm ci` quand un
# package-lock.json est versionné, `npm install` sinon (diagnostic émis).
# node_modules est fréquemment exclu par le .dockerignore de l'application :
# l'installation complète est donc nécessaire, pas seulement souhaitable.
ARG NPM_INSTALL_COMMAND=""
RUN if [ -n "${NPM_INSTALL_COMMAND}" ]; then sh -c "${NPM_INSTALL_COMMAND}"; fi

# MOUNT_PREFIX : racine PUBLIQUE de la sandbox (« /depot » sur un Pages de
# projet). Les URL figées dans le CSS et dans le manifeste d'assets doivent
# porter EXACTEMENT le même préfixe qu'à l'exécution, sinon la page cherche ses
# feuilles de style à la racine du domaine — hors du site, et hors de portée du
# Service Worker. C'est le même RAILS_RELATIVE_URL_ROOT que app.Dockerfile.
ARG MOUNT_PREFIX=""
# Clés jetables : cet étage ne produit que des fichiers d'assets, il est écarté
# de l'image finale. Les vraies clés de session vivent dans l'env.sh de la base.
ENV RAILS_ENV=production \
    RACK_ENV=production \
    RAILS_RELATIVE_URL_ROOT=${MOUNT_PREFIX}/app \
    RAILS_LOG_TO_STDOUT=1 \
    SECRET_KEY_BASE=assets-stage-throwaway \
    ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=0000000000000000000000000000000000000000000000000000000000000000

# Scripts npm explicites (détectés dans package.json) : cssbundling ne les
# déclenche pas de façon fiable, et leur absence donne un rendu sans CSS.
#
# SÉCURITÉ : APP_ENV_MANIFEST provient de railsbox.yml, donc de code TIERS. Ses
# valeurs sont déjà entre apostrophes (manifest-to-args.mjs) : le `.` qui suit
# les charge sans jamais évaluer un $(commande), qui reste une chaîne littérale.
# Elles sont nécessaires ici parce qu'un environnement de production refuse de
# démarrer sans les clés exigées par ses initializers — et assets:precompile
# démarre l'application.
ARG ASSET_SCRIPTS=""
ARG APP_ENV_MANIFEST=""
RUN <<'RIB_ASSETS'
set -eu
mkdir -p /app/public/assets /app/app/assets/builds
printf '%s\n' "${APP_ENV_MANIFEST}" > /tmp/app-env.sh
set -a
. /tmp/app-env.sh
set +a
rm -f /tmp/app-env.sh
for script in ${ASSET_SCRIPTS}; do npm run "$script"; done
bundle exec rails assets:precompile
RIB_ASSETS

########################################################################
# Sortie : uniquement les répertoires d'assets, pour --output type=local
########################################################################
FROM scratch AS export
COPY --from=precompilation /app/public/assets /public/assets
COPY --from=precompilation /app/app/assets/builds /app/assets/builds
