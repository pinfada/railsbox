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
# Contexte attendu : le même arbre FILTRÉ que app.Dockerfile (voir
# build-app-disk.sh). `public/assets` en est absent dès que cet étage le
# régénère — sans quoi les empreintes périmées du dépôt redescendraient dans le
# disque applicatif par l'export.
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
#
# EXTRA_PACKAGES porte les en-têtes que les gems natives DE CETTE APPLICATION
# réclament, déduits de son Gemfile.lock (voir detect/gems.mjs et la table de
# manifest-to-args.mjs). Il est INDISPENSABLE ici, et pas seulement au disque
# i386 : `bundle install` tourne AUSSI à cet étage, et une gem sans variante
# binaire y compile. webp-ffi l'a montré — « An error occurred while installing
# webp-ffi (0.4.0) » faute de libwebp-dev, sur le seul chemin découplé.
ARG NPM_ASSETS=0
ARG EXTRA_PACKAGES=""
RUN set -eu; \
    paquets="build-essential git curl ca-certificates openssl pkg-config \
      libyaml-dev zlib1g-dev libxml2-dev libxslt1-dev libsqlite3-dev libpq-dev"; \
    if [ -n "${EXTRA_PACKAGES}" ]; then paquets="${paquets} ${EXTRA_PACKAGES}"; fi; \
    apt-get update && apt-get install -y --no-install-recommends ${paquets} \
    && rm -rf /var/lib/apt/lists/*

# NODE 22, ET PAS CELUI DE DEBIAN.
#
# bookworm livre Node 18.20.4, en fin de vie depuis avril 2025. Toute chaîne
# front récente le refuse : mesuré sur woofed-crm, dont `yarn install` s'arrête
# sur « @vitejs/plugin-react: The engine "node" is incompatible. Expected
# "^20.19.0 || >=22.12.0". Got "18.20.4" ». Aucune option d'installation ne
# contourne cela — c'est le runtime qui est trop vieux.
#
# On copie donc Node depuis son image officielle, elle-même bookworm : mêmes
# bibliothèques système, aucun dépôt tiers à ajouter, et la version est choisie
# par nous plutôt que par la distribution. npm et npx sont des scripts Node,
# d'où les liens.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN set -eu; \
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    node --version; npm --version

# Gestionnaire de paquets front : `npm` ou `pnpm`, IDENTIFIANT SEUL. La
# version déclarée par l'application n'arrive jamais jusqu'ici — Corepack la
# lit lui-même dans le `packageManager` du projet, ce qui évite d'interpoler
# une chaîne tierce dans une commande.
#
# LE PAQUET `nodejs` DE DEBIAN NE LIVRE PAS COREPACK : `corepack enable` y échoue
# en « not found ». Le défaut était latent — la ligne existait pour pnpm sans
# avoir jamais été exercée par une construction réelle — et il est apparu au
# premier vrai build avec yarn, sur woofed-crm. On l'installe donc si besoin,
# puis on VÉRIFIE le shim : sans cette vérification, l'échec surviendrait bien
# plus loin, sur une commande d'installation introuvable.
#
# `corepack enable pnpm` (ou `yarn`) ne fait qu'installer un shim : rien n'est téléchargé
# tant que pnpm n'est pas invoqué DANS le projet, où il provisionne alors la
# version exacte demandée. C'est aussi ce shim que `jsbundling-rails`
# retrouvera pour son `javascript:install`.
ARG PACKAGE_MANAGER="npm"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN set -eu; \
    case "$PACKAGE_MANAGER" in \
      npm) : ;; \
      pnpm|yarn) \
        command -v corepack >/dev/null 2>&1 || npm install -g corepack; \
        corepack enable "$PACKAGE_MANAGER"; \
        command -v "$PACKAGE_MANAGER" >/dev/null ;; \
      *) echo "gestionnaire front inattendu : $PACKAGE_MANAGER" >&2; exit 1 ;; \
    esac

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
# Repère temporel posé JUSTE avant les builds : tout fichier plus récent que
# lui a été écrit ici, et nulle part ailleurs. C'est ce qui permet, plus bas,
# de nommer les répertoires produits qui ne seront pas exportés.
touch /tmp/rib-repere
for script in ${ASSET_SCRIPTS}; do "${PACKAGE_MANAGER}" run "$script"; done
bundle exec rails assets:precompile
RIB_ASSETS

# Récolte : ce qui redescend dans le disque i386, et ce qui va être perdu.
#
# Les COPY d'un Dockerfile ne se mettent pas en boucle : l'étage rassemble donc
# lui-même les répertoires demandés sous /rib-export, que l'étage `scratch`
# final copie d'un bloc. ASSET_OUTPUT_DIRS ouvre TOUJOURS sur les deux
# répertoires structurels ; les suivants viennent de l'auto-détection
# (vite_rails, Shakapacker) ou de `assets.output` du railsbox.yml.
#
# SÉCURITÉ : ces valeurs viennent d'un dépôt tiers. Elles sont validées à
# l'analyse (asset-output.mjs : chemin relatif, aucun segment « .. », aucun
# caractère interprétable par un shell) et ne subissent ici que le découpage en
# mots de l'expansion — jamais de substitution de commande, qui n'a pas lieu
# sur le RÉSULTAT d'une expansion.
ARG ASSET_OUTPUT_DIRS="public/assets app/assets/builds"
RUN <<'RIB_RECOLTE'
set -eu
cd /app
# `set -f` coupe la globalisation : un « * » ne pourrait de toute façon pas
# franchir la validation, mais la boucle ne doit dépendre que d'elle.
set -f
mkdir -p /rib-export
for dir in ${ASSET_OUTPUT_DIRS}; do
  # « ./ » en tête partout où le chemin est un ARGUMENT DE TÊTE : sans lui, un
  # répertoire nommé « -name » ou « -rf » serait lu comme une option par `test`
  # et par `find`, et le comportement ne dépendrait plus de nous mais de
  # l'implémentation du shell. La validation le refuse déjà (asset-output.mjs
  # interdit le tiret en tête de segment) ; ceci est la seconde barrière.
  [ -d "./$dir" ] || { echo "[assets] $dir : rien à exporter (répertoire absent)"; continue; }
  # `cp -a src/. dest/` FUSIONNE le contenu au lieu d'imbriquer : sans cela un
  # export qui demanderait à la fois `public` et `public/assets` produirait un
  # `public/public`, selon l'ordre de la liste.
  mkdir -p "/rib-export/$dir"
  cp -a "./$dir/." "/rib-export/$dir/"
  echo "[assets] exporté : $dir ($(find "./$dir" -type f | wc -l) fichiers)"
done
# Les deux répertoires structurels existent toujours dans le contexte, même
# vides : app.Dockerfile compte dessus pour son garde-fou.
mkdir -p /rib-export/public/assets /rib-export/app/assets/builds
set +f

# Comparaison avant/après. Les arbres qu'aucun build d'assets ne produit sont
# élagués (node_modules à lui seul pèse plus que tout le reste) : sans cela la
# mesure coûterait plus cher que ce qu'elle rapporte.
#
# Un échec de la comparaison n'interrompt PAS la construction — c'est un
# diagnostic, pas un garde-fou — mais il est dit, et le rapport est remis à
# vide : mieux vaut « je n'ai pas su regarder » qu'un rapport muet qui laisse
# croire que tout est exporté.
if ! find . \( -path ./node_modules -o -path ./.git -o -path ./tmp -o -path ./log \
            -o -path ./vendor/bundle -o -path ./.bundle -o -path ./storage \
            -o -path ./coverage \) -prune -o \
          -type f -newer /tmp/rib-repere -print \
  | awk '{ sub(/^\.\//, ""); n = match($0, /\/[^\/]*$/); print (n ? substr($0, 1, n - 1) : ".") }' \
  | sort -u \
  | awk -v exportes="${ASSET_OUTPUT_DIRS}" '
      BEGIN { total = split(exportes, liste, " ") }
      {
        for (i = 1; i <= total; i++)
          if ($0 == liste[i] || index($0, liste[i] "/") == 1) next
        print
      }' \
  | awk '{ if (racine == "" || index($0, racine "/") != 1) { racine = $0; print } }' \
  > /rib-export/.railsbox-hors-export
then
  echo "[assets] comparaison avant/après indisponible : l'export n'a PAS été vérifié" >&2
  : > /rib-export/.railsbox-hors-export
fi

if [ -s /rib-export/.railsbox-hors-export ]; then
  echo "[assets] AVERTISSEMENT — écrit par les builds mais NON exporté :" >&2
  sed 's/^/[assets]   /' /rib-export/.railsbox-hors-export >&2
fi
RIB_RECOLTE

########################################################################
# Sortie : uniquement les répertoires d'assets, pour --output type=local
########################################################################
FROM scratch AS export
COPY --from=precompilation /rib-export/ /
