#!/bin/sh
# Lanceur applicatif de la base découplée (ADR 0002). Appelé par le pont série
# (trame RST), JAMAIS au boot de la base : l'instantané de base est capturé
# sans application. Monte d'abord le disque applicatif (hdb, /dev/sdb) sur
# /app, puis lance Puma.
set -eu

# Précédence de l'environnement, du plus générique au plus spécifique — chaque
# étage écrase le précédent, le visiteur a toujours le dernier mot :
#   1. base    env.sh          figé à la construction de la base mutualisée
#   2. app     app-env.sh      déclaré dans le railsbox.yml de l'application
#   3. visiteur env.local.sh   saisi dans l'inspecteur d'environnement
# L'étage 2 vit sur le disque applicatif : il ne peut être lu qu'après montage,
# d'où le sourcing de l'étage 3 APRÈS le montage et non avant.

# 1. Environnement générique de la base (Rails production, réglages Bundler,
#    BUNDLE_PATH=/app/vendor/bundle) — voir env.sh, figé à la construction.
. /opt/rib/env.sh

# Montage du disque applicatif. Le noyau expose /dev/sdb via devtmpfs dès que
# v86 attache le hdb. On tente ext2 puis ext4 (le pilote ext4 lit aussi ext2).
if ! mountpoint -q /app; then
  echo "[start-app] montage du disque applicatif /dev/sdb sur /app"
  mount /dev/sdb /app 2>/dev/null ||
    mount -t ext4 /dev/sdb /app 2>/dev/null ||
    mount -t ext2 /dev/sdb /app
fi

# 2. Environnement déclaré par l'application (bloc `env:` de railsbox.yml),
#    écrit sur le disque applicatif par build-app-disk.sh. Y figurent aussi les
#    réglages de la base : RAILSBOX_DATABASE, et pour PostgreSQL PGDATA +
#    DATABASE_URL.
[ -f /app/.railsbox/app-env.sh ] && . /app/.railsbox/app-env.sh

# 3. Surcharge écrite à chaud par le pont (inspecteur d'environnement) : en
#    dernier, sinon les valeurs de railsbox.yml annuleraient la saisie.
[ -f /opt/rib/env.local.sh ] && . /opt/rib/env.local.sh

# Cluster PostgreSQL : ici et nulle part ailleurs. Le datadir est sur le disque
# applicatif qu'on vient de monter, et l'environnement qui en fixe le chemin
# vient d'être sourcé. Un échec n'arrête pas le lancement : Puma démarrera et
# l'erreur ActiveRecord sera visible dans la page plutôt que dans un silence.
if [ "${RAILSBOX_DATABASE:-sqlite3}" = postgresql ]; then
  sh /opt/rib/postgres.sh start ||
    echo "[start-app] PostgreSQL n'a pas demarre — voir /var/log/postgres.log"
fi

cd /app
# Le .dockerignore des applications exclut souvent tmp/*, log/*, storage/* :
# Puma exige tmp/pids (pidfile), ActiveStorage exige storage/.
mkdir -p tmp/pids tmp/cache log storage
exec bundle exec puma /opt/rib/config.ru -b tcp://127.0.0.1:3000
