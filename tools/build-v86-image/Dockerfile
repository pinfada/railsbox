# syntax=docker/dockerfile:1.7
# Image disque railsbox pour v86 (émulateur x86 32 bits dans le navigateur).
# Générique : TOUS les réglages propres à une application arrivent en
# --build-arg, calculés par manifest-to-args.mjs à partir de l'auto-détection.
#
# Trois étages :
#  1. assets-1 (amd64) : ni les chaînes npm (tailwindcss/esbuild/sass) ni les
#     gems à exécutable précompilé (tailwindcss-ruby, dartsass-ruby) n'ont de
#     binaire i386 — la précompilation se fait donc en x86_64.
#  2. assets-0 (i386)  : étage vide, choisi quand aucun de ces outils n'est
#     présent (importmap/propshaft précompile directement dans le rootfs).
#  3. rootfs  (i386)   : Debian bookworm + Ruby compilé depuis les sources
#     (bookworm i386 ne fournit que ruby 3.1) + services + noyau Linux 686
#     (v86 boote le bzImage directement, sans bootloader).
#
# Contexte de build attendu : la racine de l'application Rails.
#   docker build --platform linux/386 -f <ce fichier> --build-arg … -t <tag> <app>

ARG RUBY_VERSION=3.3.10
# 1 : les assets sont précompilés sur l'étage amd64 (chaîne npm et/ou gem à
# exécutable précompilé). 0 : cet étage est entièrement sauté.
ARG HOST_ASSETS=0
# 1 : l'application a un package.json (donc des dépendances front à installer).
ARG NPM_ASSETS=0

########################################################################
# Étage 1a : précompilation des assets (amd64)
########################################################################
FROM --platform=linux/amd64 ruby:${RUBY_VERSION}-slim AS assets-1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libpq-dev libyaml-dev zlib1g-dev libsqlite3-dev \
      git curl ca-certificates openssl nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Gestionnaire de paquets front : `npm` ou `pnpm`, IDENTIFIANT SEUL. La
# version déclarée par l'application n'arrive jamais jusqu'ici — Corepack la
# lit lui-même dans le `packageManager` du projet, ce qui évite d'interpoler
# une chaîne tierce dans une commande.
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
      pnpm) corepack enable pnpm ;; \
      yarn) corepack enable yarn ;; \
      *) echo "gestionnaire front inattendu : $PACKAGE_MANAGER" >&2; exit 1 ;; \
    esac

# LES MÊMES PAQUETS QUE LE ROOTFS, et pour la même raison : cet étage fait lui
# aussi un `bundle install` complet, donc il compile les mêmes gems natives.
# La liste ci-dessus était figée, si bien qu'une application dont une gem
# exigeait des en-têtes supplémentaires échouait ICI, après que le rootfs, lui,
# avait été correctement servi. Trouvé sur tryzealot/zealot : corriger
# `webp-ffi` dans la table gem → bibliothèques n'a fait que déplacer l'échec
# d'un étage.
#
# La liste entière est passée telle quelle, paquets de RUNTIME compris
# (redis-server, libvips-tools…) : cet étage est jetable — seul `public/assets`
# en sort — et le trier coûterait plus en complexité qu'il n'économiserait.
ARG EXTRA_PACKAGES=""
RUN set -eu; \
    if [ -n "$EXTRA_PACKAGES" ]; then \
      apt-get update && apt-get install -y --no-install-recommends $EXTRA_PACKAGES \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
ENV BUNDLE_WITHOUT="development:test" BUNDLE_JOBS=4 BUNDLE_FROZEN=false
COPY Gemfile* ./
RUN bundle install

COPY . .
# node_modules est exclu par le .dockerignore de l'application : installation
# complète nécessaire aux scripts de build. La commande vient de
# l'auto-détection (`npm ci` avec un verrou, `npm install` sinon) et reste vide
# pour une application sans package.json — Tailwind par la gem, par exemple.
ARG NPM_INSTALL_COMMAND=""
RUN if [ -n "${NPM_INSTALL_COMMAND}" ]; then sh -c "${NPM_INSTALL_COMMAND}"; fi

# Valeurs jetables : ce stage ne sert qu'à produire public/assets, il est
# entièrement écarté de l'image finale. Les vraies clés de la VM sont
# générées aléatoirement dans l'étage rootfs.
ARG MOUNT_PATH=/app
ENV RAILS_ENV=production \
    RACK_ENV=production \
    SECRET_KEY_BASE=assets-stage-throwaway \
    ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=0000000000000000000000000000000000000000000000000000000000000000 \
    RAILS_RELATIVE_URL_ROOT=${MOUNT_PATH} \
    RAILS_LOG_TO_STDOUT=1

# Scripts npm explicites (détectés dans package.json) : cssbundling ne les
# déclenche pas de façon fiable ici, et leur absence donne un rendu sans CSS.
# L'environnement porte les variables exigées par les initializers de
# l'application (clés au format attendu) : sans elles, l'environnement de
# production refuse de démarrer et assets:precompile échoue. Deux sources :
#  - APP_ENV_MANIFEST (railsbox.yml, TIERS) : valeurs single-quotées, un
#    `. source` ne les exécute donc jamais — un $(commande) reste inerte.
#  - APP_ENV_TRUSTED (--env-file, opérateur) : peut contenir des $(openssl
#    rand …), légitimement exécutés au sourcing. Cet étage est jetable
#    (écarté de l'image finale), l'éventuelle rotation ici est sans effet.
ARG ASSET_SCRIPTS=""
ARG APP_ENV_MANIFEST=""
ARG APP_ENV_TRUSTED=""
RUN printf '%s\n' "$APP_ENV_MANIFEST" > /tmp/app-env.sh \
    && printf '%s\n' "$APP_ENV_TRUSTED" >> /tmp/app-env.sh \
    && set -a && . /tmp/app-env.sh && set +a \
    && for script in $ASSET_SCRIPTS; do "$PACKAGE_MANAGER" run "$script"; done \
    && bundle exec rails assets:precompile \
    && rm -f /tmp/app-env.sh

########################################################################
# Étage 1b : substitut vide quand rien n'exige l'étage amd64
########################################################################
# Même base que le rootfs : aucune image supplémentaire à télécharger.
FROM i386/debian:bookworm-slim AS assets-0
RUN mkdir -p /app/public/assets /app/app/assets/builds

# Sélection de l'étage d'assets par la valeur de HOST_ASSETS (0 ou 1).
FROM assets-${HOST_ASSETS} AS assets

########################################################################
# Étage 2 : rootfs i386 bootable par v86
########################################################################
FROM i386/debian:bookworm-slim AS rootfs

ENV DEBIAN_FRONTEND=noninteractive

# Socle commun à TOUTES les applications : cette couche ne dépend d'aucun
# --build-arg, elle est donc réutilisée telle quelle d'une image à l'autre.
# libxml2-dev/libxslt1-dev y figurent d'office : nokogiri est présent dans la
# quasi-totalité des applications Rails et sa compilation les exige.
RUN apt-get update && apt-get install -y --no-install-recommends \
      linux-image-686 initramfs-tools \
      build-essential libyaml-dev zlib1g-dev libssl-dev libffi-dev \
      libgmp-dev libreadline-dev bison pkg-config patch \
      libxml2-dev libxslt1-dev \
      python3 iproute2 procps openssl curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && update-initramfs -u -k all

# Ruby exact demandé par l'application, compilé depuis les sources : les
# dépôts bookworm i386 ne fournissent que ruby 3.1.
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

# Paquets propres à l'application (base de données, Redis, bibliothèques des
# gems natives) : couche séparée pour préserver le cache de la compilation
# Ruby ci-dessus, qui est de loin la plus coûteuse.
ARG EXTRA_PACKAGES=""
RUN set -eu; \
    if [ -n "$EXTRA_PACKAGES" ]; then \
      apt-get update && apt-get install -y --no-install-recommends $EXTRA_PACKAGES \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# nokogiri en bibliothèques système : la compilation de son libxml2 embarqué
# (mini_portile) échoue sous i386.
ENV NOKOGIRI_USE_SYSTEM_LIBRARIES=true

WORKDIR /app
# BUNDLE_FORCE_RUBY_PLATFORM : BuildKit n'applique pas la personnalité 32 bits
# (uname -m renvoie x86_64 dans le conteneur i386), Bundler installerait donc
# les gems précompilées x86_64 (ELFCLASS64, inchargeables). On force la
# compilation source de toutes les gems natives avec la toolchain i386.
ENV BUNDLE_WITHOUT="development:test" BUNDLE_JOBS=4 BUNDLE_FROZEN=false \
    BUNDLE_FORCE_RUBY_PLATFORM=true
COPY Gemfile* ./
# Le lockfile ne connaît vraisemblablement que x86_64-linux : on ajoute la
# plateforme i386 (x86-linux) + ruby pour que les gems natives compilent.
RUN bundle lock --add-platform x86-linux ruby && bundle install

# Résidus de compilation des gems natives. Le disque applicatif est figé à
# 512 Mo (ADR 0002) et peuplé par un `docker export`, donc par TOUT ce qui vit
# sous /app. Une gem compilée depuis les sources — et railsbox les compile
# TOUTES, BUNDLE_FORCE_RUBY_PLATFORM oblige — y laisse ses objets
# intermédiaires, dont plus rien n'a besoin une fois le `.so` produit et
# installé.
#
# Mesuré le 21/08/2026 sur woofed-crm : 1 604 Mo d'objets .o/.a sur 1 895 Mo de
# gems, dont 1 677 Mo pour grpc seul, qui retombe à 55 Mo. L'application ne
# tenait pas dans 512 Mo à cause de cela seul.
#
# JAMAIS LES `.so` : ce sont eux que Ruby charge. En supprimer un ne casse rien
# à la construction — l'erreur surgit au boot de la VM, chez le visiteur.
# Le chemin monolithique ne fixe pas BUNDLE_PATH : les gems vont dans le
# répertoire système, que `gem env home` donne sans avoir à le deviner.
RUN find "$(gem env home)" \( -name '*.o' -o -name '*.a' \) -type f -delete 2>/dev/null || true

COPY . .
COPY --from=assets /app/public/assets ./public/assets
COPY --from=assets /app/app/assets/builds ./app/assets/builds
# COPY . . vient de rétablir le Gemfile.lock du dépôt (plateformes x86_64
# uniquement) : on ré-ajoute la plateforme i386, sinon bundle exec refuse le
# bundle pourtant déjà installé (LoadError sur la première gem venue).
RUN bundle lock --add-platform x86-linux ruby && bundle check

########################################################################
# Fichiers du pont série et de l'init (voir railsbox/public/vm)
########################################################################

# Démon du pont : lit des trames "@RIB1 REQ <id> <b64>" sur ttyS0, exécute la
# requête HTTP sur 127.0.0.1:3000 (vrai loopback TCP : v86 fait tourner un
# vrai noyau) et répond en trames RSB/DAT/END. Les lignes sans magic sont
# ignorées côté navigateur (elles servent de log).
COPY <<'RIB_BRIDGE' /opt/rib/serial-bridge.py
import base64
import http.client
import json
import os
import shlex
import signal
import subprocess
import sys
import threading
import time

MAGIC = "@RIB1"
CHUNK = 8000  # multiple de 4 : chaque tranche base64 est decodable seule
HTTP_TIMEOUT = 120
LOG_FILES = ["/var/log/puma.log", "/var/log/bridge-err.log"]
LOG_POLL_SECONDS = 1.0
ENV_OVERRIDE_FILE = "/opt/rib/env.local.sh"
APP_PID_FILE = "/run/rib-app.pid"
APP_LOG = "/var/log/puma.log"
# Seuls des noms de variables d'environnement plausibles sont acceptes : le
# navigateur pilote l'ecriture d'un fichier source par le shell, la surface
# doit rester etroite meme si la VM est un bac a sable local.
ENV_NAME_MAX = 64

write_lock = threading.Lock()


def emit(line):
    with write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def emit_response(req_id, raw_bytes):
    payload = base64.b64encode(raw_bytes).decode("ascii")
    # RSB annonce la taille BRUTE : l'hote alloue une fois a la taille exacte
    # et decode chaque tranche au vol (pas de chaine monolithique). CHUNK est
    # un multiple de 4 pour que chaque tranche soit decodable isolement.
    emit(MAGIC + " RSB " + req_id + " " + str(len(raw_bytes)))
    for i in range(0, len(payload), CHUNK):
        emit(MAGIC + " DAT " + req_id + " " + payload[i:i + CHUNK])
    emit(MAGIC + " END " + req_id)


def emit_error(req_id, code):
    emit(MAGIC + " ERR " + req_id + " " + str(code))


def handle_request(req_id, descriptor, body):
    try:
        headers = {}
        for name, value in descriptor.get("headers", []):
            headers[name] = value
        conn = http.client.HTTPConnection("127.0.0.1", 3000, timeout=HTTP_TIMEOUT)
        # body=None pour un corps vide : evite un Content-Length: 0 parasite
        # sur les GET (que certains middlewares Rack traitent differemment).
        conn.request(descriptor["method"], descriptor["path"],
                     body=body if body else None, headers=headers)
        response = conn.getresponse()
        response_body = response.read()
        conn.close()
        head_lines = ["HTTP/1.1 " + str(response.status) + " " + (response.reason or "")]
        for name, value in response.getheaders():
            if name.lower() in ("transfer-encoding", "connection"):
                continue
            head_lines.append(name + ": " + value)
        raw = ("\r\n".join(head_lines) + "\r\n\r\n").encode("utf-8", "replace") + response_body
        emit_response(req_id, raw)
    except ConnectionRefusedError:
        emit_error(req_id, 7)
    except TimeoutError:
        emit_error(req_id, 28)
    except Exception as error:
        emit(MAGIC + " LOG bridge-error " + type(error).__name__)
        emit_error(req_id, 56)


# Suivi des logs applicatifs SOUS LE VERROU d'écriture : le port série ne
# doit avoir qu'un seul écrivain, sinon les lignes de log s'entrelacent avec
# les trames RSB/DAT et les corrompent (vu en pratique avec un tail -F).
def follow_logs():
    positions = {}
    while True:
        for path in LOG_FILES:
            try:
                with open(path, "r", errors="replace") as handle:
                    start = positions.get(path, 0)
                    # Journal tronque (relance de l'application) : on repart
                    # du debut, sinon plus rien ne remonte au navigateur.
                    if os.path.getsize(path) < start:
                        start = 0
                    handle.seek(start)
                    for line in handle:
                        # Defense : un fichier creux ou une ecriture
                        # concurrente peut produire des octets nuls, qui
                        # n'ont rien a faire dans le flux de trames.
                        line = line.rstrip("\n").replace("\x00", "").strip()
                        if line:
                            emit(line)
                    positions[path] = handle.tell()
            except OSError:
                pass
        time.sleep(LOG_POLL_SECONDS)


# Recalage d'horloge demandé par l'hôte. Après restauration d'un instantané,
# le noyau reprend à la date de la capture : sans ce recalage, Rails rejette
# cookies de session et jetons CSRF (expirés) et TLS échoue.
last_clock_sync = [0]


def sync_clock(epoch_text):
    try:
        epoch = int(epoch_text)
    except ValueError:
        return
    drift = abs(epoch - int(time.time()))
    # Sous 2 s, l'écart n'est pas significatif : on évite de marteler date(1).
    if drift < 2:
        return
    try:
        subprocess.run(["date", "-s", "@" + str(epoch)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as error:
        emit(MAGIC + " LOG echec recalage horloge: " + type(error).__name__)
        return
    if last_clock_sync[0] != epoch:
        last_clock_sync[0] = epoch
        emit(MAGIC + " LOG horloge recalee (derive " + str(drift) + "s)")


# Requetes en cours de reception : le corps arrive en tranches acquittees,
# jamais d'un seul tenant (le tampon d'entree du TTY deborde au-dela de
# quelques dizaines de Ko et la requete est perdue).
inflight = {}


def start_request(line):
    try:
        _, _, req_id, b64 = line.split(" ", 3)
        descriptor = json.loads(base64.b64decode(b64))
    except Exception:
        return
    inflight[req_id] = {"descriptor": descriptor, "body": bytearray()}


def append_body(line):
    try:
        _, _, req_id, b64 = line.split(" ", 3)
    except ValueError:
        return
    entry = inflight.get(req_id)
    if entry is None:
        return
    try:
        entry["body"].extend(base64.b64decode(b64))
    except Exception:
        entry["broken"] = True
    # Acquittement APRES ecriture : l'hote n'envoie la tranche suivante
    # qu'ici, ce qui borne les octets en vol a une seule tranche.
    emit(MAGIC + " ACK " + req_id)


def finish_request(line):
    try:
        req_id = line.split(" ", 2)[2].strip()
    except IndexError:
        return
    entry = inflight.pop(req_id, None)
    if entry is None:
        return
    descriptor = entry["descriptor"]
    expected = descriptor.get("bodyLength", 0)
    if entry.get("broken") or len(entry["body"]) != expected:
        emit(MAGIC + " LOG corps incomplet (" + str(len(entry["body"])) + "/" + str(expected) + ")")
        emit_error(req_id, 56)
        return
    threading.Thread(target=handle_request, args=(req_id, descriptor, bytes(entry["body"])),
                     daemon=True).start()


def valid_env_name(name):
    if not name or len(name) > ENV_NAME_MAX:
        return False
    if not (name[0].isalpha() or name[0] == "_"):
        return False
    return all(c.isalnum() or c == "_" for c in name)


def write_environment(line):
    """@RIB1 ENV <id> <b64 json> : ecrit les variables fournies par le
    navigateur dans un fichier source par le lanceur de l'application.
    Les valeurs sont echappees (shlex.quote) : aucune injection shell."""
    try:
        _, _, req_id, b64 = line.split(" ", 3)
        variables = json.loads(base64.b64decode(b64))
    except Exception:
        return
    retenues = {}
    for name, value in variables.items():
        if valid_env_name(name) and isinstance(value, str) and value != "":
            retenues[name] = value
    try:
        with open(ENV_OVERRIDE_FILE, "w") as handle:
            handle.write("# Genere par l'inspecteur d'environnement du navigateur\n")
            for name in sorted(retenues):
                handle.write("export " + name + "=" + shlex.quote(retenues[name]) + "\n")
        os.chmod(ENV_OVERRIDE_FILE, 0o600)
        emit(MAGIC + " LOG environnement ecrit (" + str(len(retenues)) + " variables)")
    except OSError as error:
        emit(MAGIC + " LOG echec ecriture environnement: " + error.strerror)
    emit(MAGIC + " ACK " + req_id)


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_application():
    """Arrete l'ancien serveur et ATTEND sa mort : sans cela le nouveau
    demarre pendant que l'ancien tient encore le port 3000, et echoue."""
    pid = None
    try:
        with open(APP_PID_FILE) as handle:
            pid = int(handle.read().strip())
    except (OSError, ValueError):
        pass
    if pid is None or not process_alive(pid):
        subprocess.run(["pkill", "-f", "puma"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        time.sleep(3)
        return
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        os.kill(pid, signal.SIGTERM)
    for _ in range(30):  # jusqu'a ~15 s d'arret gracieux
        if not process_alive(pid):
            break
        time.sleep(0.5)
    if process_alive(pid):
        emit(MAGIC + " LOG arret force de l'ancien serveur")
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except OSError:
            os.kill(pid, signal.SIGKILL)
        time.sleep(1)


def restart_application(line):
    """@RIB1 RST <id> : relance le serveur applicatif avec le nouvel
    environnement, sans reconstruire l'image ni rebooter la VM."""
    try:
        req_id = line.split(" ", 2)[2].strip()
    except IndexError:
        return
    stop_application()
    # Journal ouvert en AJOUT, jamais tronque : l'ancien processus peut encore
    # ecrire pendant son arret, et une troncature laisserait un fichier creux
    # rempli d'octets nuls (vu en pratique, le flux serie en etait pollue).
    handle = open(APP_LOG, "a")
    handle.write("\n--- redemarrage de l'application ---\n")
    handle.flush()
    child = subprocess.Popen(["sh", "/opt/rib/start-app.sh"], stdout=handle,
                             stderr=subprocess.STDOUT, start_new_session=True)
    try:
        with open(APP_PID_FILE, "w") as pid_handle:
            pid_handle.write(str(child.pid))
    except OSError:
        pass
    emit(MAGIC + " LOG application relancee (pid " + str(child.pid) + ")")
    emit(MAGIC + " ACK " + req_id)


def main():
    threading.Thread(target=follow_logs, daemon=True).start()
    emit(MAGIC + " LOG pont serie pret")
    for line in sys.stdin:
        line = line.strip()
        if line.startswith(MAGIC + " TIME "):
            sync_clock(line.split(" ", 2)[2])
        elif line.startswith(MAGIC + " REQ "):
            start_request(line)
        elif line.startswith(MAGIC + " BOD "):
            append_body(line)
        elif line.startswith(MAGIC + " FIN "):
            finish_request(line)
        elif line.startswith(MAGIC + " ENV "):
            write_environment(line)
        elif line.startswith(MAGIC + " RST "):
            restart_application(line)


main()
RIB_BRIDGE

# Montage sous-URI : le config.ru de l'application la lance à la RACINE, donc
# ses helpers de routes génèrent « /posts » — des liens qui échappent au
# périmètre /app du Service Worker et tombent sur le serveur statique.
# RAILS_RELATIVE_URL_ROOT ne suffit pas : il ne préfixe que les assets, car
# les helpers de routes s'appuient sur le SCRIPT_NAME Rack. On monte donc
# l'application via Rack::URLMap, sans toucher au code applicatif.
COPY <<'RIB_RACKUP' /opt/rib/config.ru
require "/app/config/environment"

map ENV.fetch("RAILS_RELATIVE_URL_ROOT", "/") do
  run Rails.application
end
Rails.application.load_server
RIB_RACKUP

# Lanceur de l'application, partagé par l'init et par la relance à chaud
# demandée depuis le navigateur (inspecteur d'environnement). env.local.sh
# est écrit par le pont et surcharge les valeurs figées dans l'image.
COPY <<'RIB_START' /opt/rib/start-app.sh
#!/bin/sh
. /opt/rib/env.sh
[ -f /opt/rib/env.local.sh ] && . /opt/rib/env.local.sh
cd /app
mkdir -p tmp/pids tmp/cache log storage
exec bundle exec puma /opt/rib/config.ru -b tcp://127.0.0.1:3000
RIB_START

# Init du guest (remplace systemd) : monte les pseudo-fs, active le loopback,
# démarre les services détectés puis Puma, et attache le pont série à ttyS0.
# Les services à démarrer viennent de /opt/rib/services.sh, généré plus bas à
# partir des --build-arg : le corps du script reste identique d'une image à
# l'autre (couche de cache partagée).
COPY <<'RIB_INIT' /opt/rib/guest-init.sh
#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/rib/services.sh

mount -o remount,rw / 2>/dev/null
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
# /dev/shm : requis par PostgreSQL 15 (dynamic_shared_memory_type=posix)
mount -t tmpfs -o mode=1777 tmpfs /dev/shm 2>/dev/null
mount -t tmpfs tmpfs /run 2>/dev/null
mount -t tmpfs tmpfs /tmp 2>/dev/null

hostname "$RIB_APP_NAME"
ip link set lo up
# docker export ne conserve pas /etc/hosts (bind-mount runtime de Docker) :
# sans lui, PostgreSQL ne résout pas "localhost" et refuse de démarrer.
printf "127.0.0.1\tlocalhost %s\n::1\tlocalhost\n" "$RIB_APP_NAME" > /etc/hosts
dmesg -n 1

if [ "$RIB_WITH_POSTGRES" = 1 ]; then
  echo "[init] demarrage PostgreSQL..."
  mkdir -p /var/run/postgresql
  # Ceinture et bretelles : si l'ext2 a été fabriqué avec des uid décalés,
  # on rétablit la propriété des répertoires PostgreSQL avant le démarrage.
  chown -R postgres:postgres /var/run/postgresql /var/lib/postgresql /etc/postgresql /var/log/postgresql 2>/dev/null
  su -s /bin/sh postgres -c "pg_ctlcluster ${RIB_PG_VERSION} main start"
fi

if [ "$RIB_WITH_REDIS" = 1 ]; then
  echo "[init] demarrage Redis..."
  redis-server --daemonize yes --port 6379 --save '' --appendonly no
fi

. /opt/rib/env.sh
cd /app

echo "[init] demarrage Puma (monte sous \$RAILS_RELATIVE_URL_ROOT)..."
# Le .dockerignore des applications exclut souvent tmp/*, log/* et storage/* :
# ces répertoires n'existent pas dans l'image. Puma exige tmp/pids (pidfile),
# ActiveStorage exige storage/. start-app.sh les recrée.
sh /opt/rib/start-app.sh >/var/log/puma.log 2>&1 &
echo $! > /run/rib-app.pid

# Les logs applicatifs sont relayés vers la console série PAR le démon du
# pont (un seul écrivain, sous verrou) — jamais par un tail concurrent qui
# entrelacerait ses lignes avec les trames et les corromprait.
touch /var/log/puma.log /var/log/bridge-err.log

echo "[init] pont serie actif sur ttyS0"
# raw : le mode canonique du tty tronque les lignes > 4096 caractères (nos
# trames base64 peuvent être bien plus longues). -echo : sans lui, chaque
# trame reçue est renvoyée en écho et pollue le flux de log.
stty -F /dev/ttyS0 raw -echo
exec python3 /opt/rib/serial-bridge.py </dev/ttyS0 >/dev/ttyS0 2>/var/log/bridge-err.log
RIB_INIT

########################################################################
# Environnement d'exécution : services, clés jetables, variables de l'app
########################################################################
ARG APP_NAME=app
ARG DATABASE=sqlite3
ARG WITH_POSTGRES=0
ARG WITH_REDIS=0
ARG MOUNT_PATH=/app
# Deux sources d'environnement traitées différemment (voir plus bas) :
# APP_ENV_MANIFEST (railsbox.yml tiers) ajouté verbatim, APP_ENV_TRUSTED
# (--env-file opérateur) évalué une fois pour figer ses $(…).
ARG APP_ENV_MANIFEST=""
ARG APP_ENV_TRUSTED=""
ARG PG_VERSION=15
RUN <<'RIB_SETUP'
set -eu
chmod +x /opt/rib/guest-init.sh /opt/rib/start-app.sh

cat > /opt/rib/services.sh <<SERVICES
export RIB_APP_NAME='${APP_NAME}'
export RIB_WITH_POSTGRES=${WITH_POSTGRES}
export RIB_WITH_REDIS=${WITH_REDIS}
export RIB_PG_VERSION=${PG_VERSION}
SERVICES

# Clés de session aléatoires, propres à CETTE image locale de démo — jamais
# des clés de production.
cat > /opt/rib/env.sh <<ENVFILE
export RAILS_ENV=production
export RACK_ENV=production
# Ces réglages Bundler existaient comme ENV Docker pendant le build : sans eux
# au runtime, bundler exec exige les gems dev/test (jamais installées) et les
# variantes x86_64 du lockfile -> "Could not find pg-x.y-x86_64-linux…".
export BUNDLE_WITHOUT='development:test'
export BUNDLE_FORCE_RUBY_PLATFORM=true
export BUNDLE_FROZEN=false
export SECRET_KEY_BASE=$(openssl rand -hex 64)
export ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 32)
export ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 32)
export ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 32)
export RAILS_RELATIVE_URL_ROOT=${MOUNT_PATH}
export RAILS_SERVE_STATIC_FILES=true
export RAILS_LOG_TO_STDOUT=true
export LOG_LEVEL=info
export WEB_CONCURRENCY=0
export RAILS_MAX_THREADS=4
export PORT=3000
export TZ=Europe/Paris
ENVFILE

if [ "${WITH_POSTGRES}" = 1 ]; then
  echo "export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/${APP_NAME}_production?sslmode=disable'" >> /opt/rib/env.sh
fi
if [ "${WITH_REDIS}" = 1 ]; then
  echo "export REDIS_URL='redis://127.0.0.1:6379/1'" >> /opt/rib/env.sh
fi

# Variables issues de railsbox.yml (code TIERS non fiable) : ajoutées
# VERBATIM. Leurs valeurs sont déjà entre apostrophes (échappement POSIX
# bulletproof côté manifest-to-args.mjs) ; sourcées au boot, un `$(commande)`
# y reste une chaîne littérale et n'est JAMAIS exécuté. Aucune évaluation ici.
if [ -n "${APP_ENV_MANIFEST}" ]; then
  printf '%s\n' "${APP_ENV_MANIFEST}" >> /opt/rib/env.sh
fi

# Variables du --env-file (fournies par l'opérateur du build, DE CONFIANCE) :
# ÉVALUÉES une fois ici pour figer les $(openssl rand …) qu'elles contiennent
# — sans quoi la clé de session serait rejouée à chaque boot et invaliderait
# toutes les sessions. Ce chemin n'est JAMAIS alimenté par railsbox.yml.
if [ -n "${APP_ENV_TRUSTED}" ]; then
  printf '%s\n' "${APP_ENV_TRUSTED}" > /tmp/app-env-trusted.in
  eval "cat <<APPENV
$(cat /tmp/app-env-trusted.in)
APPENV" >> /opt/rib/env.sh
  rm -f /tmp/app-env-trusted.in
fi
chmod 600 /opt/rib/env.sh
RIB_SETUP

# Précompilation des assets DANS le rootfs quand aucun outil n'exige l'étage
# amd64 (importmap + propshaft/sprockets) : tout se fait avec le Ruby i386 déjà
# présent. L'auto-détection met ASSET_PRECOMPILE à 0 dès que l'étage amd64 est
# retenu — ses assets ont alors déjà été copiés plus haut.
ARG ASSET_PRECOMPILE=0
RUN <<'RIB_ASSETS'
set -eu
if [ "${ASSET_PRECOMPILE}" != 1 ]; then
  echo "[build] precompilation d'assets non requise dans le rootfs"
  exit 0
fi
. /opt/rib/env.sh
cd /app
bundle exec rails assets:precompile
RIB_ASSETS

# Préparation de la base PENDANT la construction (schéma + seeds) : le premier
# boot dans le navigateur n'a ainsi ni migration ni amorçage à faire, et
# l'instantané mémoire capture une base déjà peuplée.
# La préparation ne SÈME jamais : `db:prepare` chargeait aussi db/seeds.rb
# sur une base qu'il venait d'initialiser, et railsbox rejouait ensuite
# SEED_COMMAND — les seeds tournaient deux fois.
ARG DB_PREPARE_COMMAND="bundle exec rails db:create db:schema:load db:migrate"
ARG SEED_COMMAND=""
# 1 : un seed en échec n'arrête pas la construction (validations métier qui
# refusent des données de démo sur une application réelle).
ARG SEED_OPTIONAL=0
RUN <<'RIB_DATABASE'
set -eu
if [ "${WITH_POSTGRES}" = 1 ]; then
  mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql
  su -s /bin/sh postgres -c "pg_ctlcluster ${PG_VERSION} main start"
  su -s /bin/sh postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
fi
if [ "${WITH_REDIS}" = 1 ]; then
  # Redis doit tourner : des seeds enfilent parfois des jobs Sidekiq.
  redis-server --daemonize yes --port 6379 --save '' --appendonly no
fi

. /opt/rib/env.sh
cd /app
mkdir -p tmp/pids tmp/cache log storage
sh -c "${DB_PREPARE_COMMAND}"
if [ -n "${SEED_COMMAND}" ]; then
  if [ "${SEED_OPTIONAL}" = 1 ]; then
    sh -c "${SEED_COMMAND}" || echo "[build] seeds partiels — voir erreurs ci-dessus, non bloquant"
  else
    sh -c "${SEED_COMMAND}"
  fi
fi

if [ "${WITH_REDIS}" = 1 ]; then redis-cli shutdown nosave || true; fi
if [ "${WITH_POSTGRES}" = 1 ]; then
  su -s /bin/sh postgres -c "pg_ctlcluster ${PG_VERSION} main stop"
fi
RIB_DATABASE
