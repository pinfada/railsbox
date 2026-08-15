# Image disque Rails pour CheerpX.
# IMPORTANT : CheerpX exécute du x86 32 bits -> base i386 obligatoire.
# Construire avec :  docker build --platform linux/386 -t rails-vm-image .
FROM --platform=linux/386 i386/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    RAILS_ENV=production \
    RAILS_RELATIVE_URL_ROOT=/app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ruby-full ruby-dev build-essential \
      libsqlite3-dev libyaml-dev zlib1g-dev \
      curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Les gems natives (nokogiri, sqlite3, bcrypt…) compilent ICI, hors ligne du
# navigateur : c'est le chemin nominal, pas gcc-dans-le-navigateur.
RUN gem install rails --no-document

# Application de démonstration ; remplacez par un COPY de votre propre app.
RUN rails new /root/app --database=sqlite3 --skip-git --skip-bundle-audit || \
    rails new /root/app --database=sqlite3 --skip-git

WORKDIR /root/app
RUN bundle install \
    && SECRET_KEY_BASE=build-only bin/rails assets:precompile \
    && SECRET_KEY_BASE=build-only bin/rails db:prepare

# Vérification finale : l'app doit démarrer sans réseau.
RUN SECRET_KEY_BASE=build-only timeout 30 bin/rails runner "puts 'boot OK'"
