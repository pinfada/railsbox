#!/bin/sh
# Init du guest de la BASE découplée (ADR 0002) — remplace systemd.
# Monte les pseudo-fs, active le loopback, démarre les services mutualisés
# (Redis), puis attache le pont série à ttyS0. AUCUNE application n'est lancée
# ici : l'instantané de base est capturé sans app, et le disque applicatif
# (hdb) n'est ni monté ni sondé (condition de la restauration — voir ADR 0002,
# risque de recouvrement du cache de blocs).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/rib/services.sh

mount -o remount,rw / 2>/dev/null
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp /app
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
# /dev/shm : requis par PostgreSQL (dynamic_shared_memory_type=posix) — laissé
# en place pour le hook PG ultérieur même si la base MVP ne lance que Redis.
mount -t tmpfs -o mode=1777 tmpfs /dev/shm 2>/dev/null
mount -t tmpfs tmpfs /run 2>/dev/null
mount -t tmpfs tmpfs /tmp 2>/dev/null

hostname "$RIB_BASE_NAME"
ip link set lo up
# docker export ne conserve pas /etc/hosts (bind-mount runtime de Docker).
printf "127.0.0.1\tlocalhost %s\n::1\tlocalhost\n" "$RIB_BASE_NAME" > /etc/hosts
dmesg -n 1

# Redis mutualisé, présent dans TOUTE base (ADR 0002). Il tourne déjà dans
# l'instantané de base ; l'application le trouve prêt dès son lancement.
if [ "$RIB_WITH_REDIS" = 1 ]; then
  echo "[init] demarrage Redis..."
  redis-server --daemonize yes --port 6379 --save '' --appendonly no
fi

# Hook PostgreSQL (HORS PÉRIMÈTRE B2, documenté pour la suite) : un futur
# disque applicatif PostgreSQL fixerait PGDATA=/app/var/pg et le cluster ne
# démarrerait qu'APRÈS montage de hdb (dans start-app.sh), jamais ici.

# Le pont relaie les logs applicatifs vers la console série (un seul écrivain,
# sous verrou). Les fichiers doivent exister avant qu'il ne les suive.
touch /var/log/puma.log /var/log/bridge-err.log

echo "[init] pont serie actif sur ttyS0 (base sans application)"
# raw : le mode canonique du tty tronque les lignes > 4096 caractères (nos
# trames base64 peuvent être bien plus longues). -echo : sans lui, chaque
# trame reçue est renvoyée en écho et pollue le flux de log.
stty -F /dev/ttyS0 raw -echo
exec python3 /opt/rib/serial-bridge.py </dev/ttyS0 >/dev/ttyS0 2>/var/log/bridge-err.log
