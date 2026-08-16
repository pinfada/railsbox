#!/bin/sh
# Cycle de vie du cluster PostgreSQL d'une sandbox railsbox (base découplée,
# ADR 0002). Utilisé aux DEUX bouts de la chaîne, ce qui garantit qu'un cluster
# démarré dans la VM est exactement celui préparé à la construction :
#
#   - au build du disque applicatif (app.Dockerfile) : initdb, migrations,
#     seeds, puis arrêt propre — le datadir part dans l'ext2 déjà peuplé ;
#   - au boot du guest (start-app.sh) : démarrage seul, le datadir arrivant
#     tout prêt avec le disque applicatif.
#
# Le datadir vit sur le DISQUE APPLICATIF (PGDATA=/app/var/pg), jamais dans le
# rootfs mutualisé : c'est ce qui permet de capturer une base déjà migrée et
# seedée, exactement comme un fichier sqlite3. Corollaire dur : le cluster ne
# peut démarrer qu'APRÈS le montage de hdb — jamais dans guest-init.sh, dont
# l'instantané de base fige les processus (un postmaster gelé y pointerait un
# datadir qui n'existe pas encore).
#
#   sh /opt/rib/postgres.sh start   # initdb si besoin, démarre, attend
#   sh /opt/rib/postgres.sh stop    # arrêt propre (datadir cohérent sur disque)
set -eu

PGDATA="${PGDATA:-/app/var/pg}"
PG_VERSION="${RIB_PG_VERSION:-15}"
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"
PG_PORT="${PGPORT:-5432}"
PG_LOG="${RIB_PG_LOG:-/var/log/postgres.log}"
PG_RUNTIME_DIR=/var/run/postgresql
PG_ROLE_PASSWORD="${RIB_PG_PASSWORD:-postgres}"
# Démarrage : ~15 s sur un runner, bien plus sous émulation i386.
PG_START_TIMEOUT=180
PG_READY_TRIES=60

log() {
  echo "[postgres] $1"
}

# postgres refuse de tourner en root, et l'init du guest est root.
as_postgres() {
  su -s /bin/sh postgres -c "$1"
}

# /run est un tmpfs remonté à chaque boot : le répertoire de sockets et de
# fichiers de verrou n'y survit pas et doit être recréé ici.
ensure_runtime_dir() {
  mkdir -p "$PG_RUNTIME_DIR"
  chown postgres:postgres "$PG_RUNTIME_DIR"
  chmod 2775 "$PG_RUNTIME_DIR"
}

# initdb n'est joué qu'une fois, à la construction du disque applicatif. Le
# garde ici sert de filet : un disque fabriqué autrement (ou une base réamorcée
# à la main) démarre quand même, au prix d'une base vide.
ensure_cluster() {
  if [ -f "$PGDATA/PG_VERSION" ]; then
    return 0
  fi
  log "initialisation du cluster dans $PGDATA"
  # Seul le datadir change de propriétaire : son parent reste à root, traversable
  # (755). Un chown récursif du parent ferait des dégâts dès que PGDATA est posé
  # ailleurs — /tmp/pgtest dans la répétition de cycle de vie de la CI.
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  # --auth=trust : la VM est un bac à sable sans réseau sortant, et scram
  # coûterait plusieurs secondes de CPU émulé à chaque connexion. Un mot de
  # passe est tout de même posé plus bas, pour les database.yml qui l'exigent.
  as_postgres "$PG_BIN/initdb --pgdata='$PGDATA' --encoding=UTF8 --locale=C.UTF-8 \
    --username=postgres --auth-local=trust --auth-host=trust"
  cat /opt/rib/postgresql-railsbox.conf >> "$PGDATA/postgresql.conf"
}

running() {
  as_postgres "$PG_BIN/pg_ctl --pgdata='$PGDATA' status" >/dev/null 2>&1
}

wait_ready() {
  attempt=1
  while [ "$attempt" -le "$PG_READY_TRIES" ]; do
    if as_postgres "$PG_BIN/pg_isready -h 127.0.0.1 -p $PG_PORT" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  log "le cluster n'a pas répondu — dernières lignes de $PG_LOG :"
  tail -n 20 "$PG_LOG" 2>/dev/null || true
  return 1
}

start() {
  ensure_runtime_dir
  ensure_cluster
  if running; then
    log "cluster déjà démarré"
    return 0
  fi
  # Journal ouvert en AJOUT : le pont série le relaie au navigateur, une
  # troncature lui ferait relire tout le fichier depuis le début.
  touch "$PG_LOG"
  chown postgres:postgres "$PG_LOG"
  as_postgres "$PG_BIN/pg_ctl --pgdata='$PGDATA' --log='$PG_LOG' \
    --timeout=$PG_START_TIMEOUT --wait start"
  wait_ready
  # Mot de passe du rôle : idempotent, sans effet sous authentification trust,
  # mais indispensable aux database.yml qui en déclarent un explicitement.
  as_postgres "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d postgres -qtAc \
    \"ALTER ROLE postgres WITH PASSWORD '$PG_ROLE_PASSWORD';\"" >/dev/null
  log "cluster prêt sur 127.0.0.1:$PG_PORT"
}

# Arrêt en mode « fast » : les transactions en cours sont annulées et un
# checkpoint est écrit. C'est ce qui rend le datadir cohérent AVANT le mkfs de
# l'ext2 applicatif — sans lui, le disque livré porterait un cluster en état de
# reprise, que le premier boot du visiteur devrait rejouer.
stop() {
  if ! running; then
    log "aucun cluster à arrêter"
    return 0
  fi
  as_postgres "$PG_BIN/pg_ctl --pgdata='$PGDATA' --mode=fast --wait stop"
  log "cluster arrêté proprement"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) running && log "démarré" || log "arrêté" ;;
  *)
    echo "Usage : sh /opt/rib/postgres.sh start|stop|status" >&2
    exit 2
    ;;
esac
