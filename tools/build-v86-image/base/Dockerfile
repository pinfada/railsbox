# syntax=docker/dockerfile:1.7
# Image de BASE railsbox (ADR 0002) : rootfs i386 mutualisé, SANS application.
# Contient Debian bookworm i386, le noyau Linux 686, Ruby compilé depuis les
# sources, Redis, les bibliothèques système des gems natives courantes, le
# démon du pont série et un init générique. Le disque applicatif (hdb) apporte
# séparément l'arbre de l'app, son bundle (BUNDLE_PATH=/app/vendor/bundle),
# ses assets et sa base pré-seedée.
#
# Contexte de build attendu : tools/build-v86-image/base/ (contient rib/).
#   docker build --platform linux/386 -f base/Dockerfile -t railsbox-base-3.3 base
#
# Le bundle NE vit PAS dans la base : seul le runtime Ruby + la toolchain (pour
# compiler les gems natives i386 au build du disque app) + les bibliothèques
# système y figurent. Pour le MVP, on code en dur les besoins de la démo
# (sqlite3, nokogiri→libxml2) ; une base pleinement générique embarquerait
# l'union des bibliothèques système courantes.

ARG RUBY_VERSION=3.3.12

FROM i386/debian:bookworm-slim AS base

# Rattache le paquet GHCR à ce dépôt. Sans cette étiquette, GHCR lie le paquet
# au premier dépôt qui l'a poussé — et le GITHUB_TOKEN des autres dépôts se voit
# ensuite refuser l'écriture (`denied: permission_denied: write_package`).
LABEL org.opencontainers.image.source="https://github.com/pinfada/railsbox"
LABEL org.opencontainers.image.description="Rootfs i386 mutualisé de railsbox : Debian bookworm, Ruby compilé depuis les sources, Redis, pont série. Sans application."
LABEL org.opencontainers.image.licenses="MIT"

# Personnalité 32 bits pour TOUTE la construction. Docker ne la pose pas sur
# une image linux/386 : `uname -m` y renvoie « x86_64 » (le noyau de l'hôte),
# alors que le userland est bien en 32 bits. Les autoconf s'y trompent — sans
# ce correctif, Ruby se compile en binaires ELF32/i386 corrects mais s'étiquette
# `x86_64-linux-x32`, un triplet qui n'existe pas. RubyGems raisonne alors sur
# une plateforme fantôme, et seule la présence de BUNDLE_FORCE_RUBY_PLATFORM
# empêche la sélection d'une gem précompilée amd64 injouable dans la VM.
# `linux32` appelle personality(PER_LINUX32) : `uname -m` renvoie i686 et la
# chaîne de construction retrouve son triplet officiel i686-pc-linux-gnu.
# (util-linux est essentiel dans Debian : linux32 est présent dès l'image nue.)
SHELL ["linux32", "/bin/sh", "-c"]

ENV DEBIAN_FRONTEND=noninteractive

# Socle commun : noyau bootable par v86 (bzImage direct, sans bootloader),
# toolchain de compilation (Ruby + gems natives), bibliothèques système des
# gems natives courantes, Redis mutualisé, Python du pont série.
# libsqlite3-dev + libxml2-dev/libxslt1-dev : besoins de la démo sqlite3 +
# nokogiri, codés en dur pour le MVP (voir en-tête).
RUN apt-get update && apt-get install -y --no-install-recommends \
      linux-image-686 initramfs-tools \
      build-essential libyaml-dev zlib1g-dev libssl-dev libffi-dev \
      libgmp-dev libreadline-dev bison pkg-config patch \
      libxml2-dev libxslt1-dev libsqlite3-dev \
      redis-server \
      python3 iproute2 procps openssl curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && update-initramfs -u -k all

# Ruby exact demandé (les dépôts bookworm i386 ne fournissent que ruby 3.1),
# compilé depuis les sources. C'est de loin la couche la plus coûteuse : elle
# ne dépend d'aucun réglage applicatif, donc partagée par toutes les apps.
ARG RUBY_VERSION
RUN set -eu; \
    series="$(echo "$RUBY_VERSION" | cut -d. -f1,2)"; \
    curl -fsSL "https://cache.ruby-lang.org/pub/ruby/${series}/ruby-${RUBY_VERSION}.tar.gz" -o /tmp/ruby.tar.gz \
    && tar -xzf /tmp/ruby.tar.gz -C /tmp \
    && cd "/tmp/ruby-${RUBY_VERSION}" \
    && ./configure --disable-install-doc \
    && make -j"$(nproc)" \
    && make install \
    && cd / && rm -rf /tmp/ruby*

# nokogiri en bibliothèques système : la compilation de son libxml2 embarqué
# (mini_portile) échoue sous i386.
ENV NOKOGIRI_USE_SYSTEM_LIBRARIES=true

# Scripts du pont série et de l'init (variante base : aucune application).
COPY rib/serial-bridge.py /opt/rib/serial-bridge.py
COPY rib/config.ru /opt/rib/config.ru
COPY rib/start-app.sh /opt/rib/start-app.sh
COPY rib/guest-init.sh /opt/rib/guest-init.sh

ARG BASE_NAME=base-3.3
ARG WITH_REDIS=1
RUN <<'RIB_SETUP'
set -eu
chmod +x /opt/rib/guest-init.sh /opt/rib/start-app.sh

cat > /opt/rib/services.sh <<SERVICES
export RIB_BASE_NAME='${BASE_NAME}'
export RIB_WITH_REDIS=${WITH_REDIS}
SERVICES

# Environnement générique figé à la construction de la base. Les clés sont
# aléatoires mais STABLES pour cette image de base : l'instantané de base et
# tous ses deltas partagent la même SECRET_KEY_BASE (cohérence des sessions).
# BUNDLE_PATH=/app/vendor/bundle : le bundle vit sur le disque applicatif.
cat > /opt/rib/env.sh <<ENVFILE
export RAILS_ENV=production
export RACK_ENV=production
export BUNDLE_GEMFILE=/app/Gemfile
export BUNDLE_PATH=/app/vendor/bundle
export BUNDLE_WITHOUT='development:test'
export BUNDLE_FORCE_RUBY_PLATFORM=true
export BUNDLE_FROZEN=false
export SECRET_KEY_BASE=$(openssl rand -hex 64)
export ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 32)
export ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 32)
export ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 32)
export RAILS_RELATIVE_URL_ROOT=/app
export RAILS_SERVE_STATIC_FILES=true
export RAILS_LOG_TO_STDOUT=true
export LOG_LEVEL=info
export WEB_CONCURRENCY=0
export RAILS_MAX_THREADS=4
export PORT=3000
export TZ=Europe/Paris
export NOKOGIRI_USE_SYSTEM_LIBRARIES=true
export REDIS_URL='redis://127.0.0.1:6379/1'
ENVFILE
chmod 600 /opt/rib/env.sh

# Point de montage du disque applicatif, vide dans la base.
mkdir -p /app
RIB_SETUP
