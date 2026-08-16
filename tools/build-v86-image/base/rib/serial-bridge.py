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
    """@RIB1 RST <id> : (re)lance le serveur applicatif. Dans la base
    decouplee (ADR 0002), start-app.sh monte d'abord le disque applicatif
    (hdb, /dev/sdb) : c'est le declencheur utilise par make-delta-snapshot
    apres restauration de l'instantane de base + attachement du disque app."""
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
