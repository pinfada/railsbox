// Scripts injectés dans la VM via le DataDevice (montage /data).
// Ils sont définis ici, côté JS, plutôt que dans des fichiers servis par HTTP :
// cela garantit des fins de ligne LF quel que soit l'OS de développement
// (un shebang + CRLF casse silencieusement /bin/sh).
//
// Contrainte CheerpX vérifiée expérimentalement : la pile TCP (même en
// loopback) exige Tailscale. Le serveur applicatif écoute donc sur un
// SOCKET UNIX ($APP_SOCKET) et le pont l'interroge via curl --unix-socket.

// Boucle de vie unique de la VM : démarre le serveur applicatif en arrière-plan
// puis consomme séquentiellement les requêtes déposées dans /data par la page.
// Un seul cx.run() longue durée : aucune hypothèse sur la concurrence de run().
export const BOOT_SCRIPT = [
  "#!/bin/sh",
  "set -u",
  'log() { echo "[vm] $*"; }',
  "",
  'rm -f "$APP_SOCKET"',
  "",
  "start_app_server() {",
  "  if [ -x /root/app/bin/rails ]; then",
  '    log "Rails detecte - demarrage de Puma sur unix://$APP_SOCKET"',
  '    ( cd /root/app && exec bin/rails server -b "unix://$APP_SOCKET" ) &',
  "  elif command -v python3 >/dev/null 2>&1; then",
  '    log "Rails absent - serveur Python minimal de demonstration (socket Unix)"',
  "    python3 /data/mini-app.py &",
  "  elif command -v ruby >/dev/null 2>&1; then",
  '    log "Rails absent - serveur Ruby minimal de demonstration (socket Unix)"',
  "    ruby /data/mini-app.rb &",
  "  else",
  '    log "ERREUR: aucun interpreteur disponible dans cette image disque"',
  "  fi",
  "}",
  "",
  "start_app_server",
  'log "Pont HTTP pret - attente des requetes"',
  "seq=1",
  "while :; do",
  '  cmd="/data/req-$seq.cmd"',
  '  if [ -f "$cmd" ]; then',
  '    sh "$cmd" 2>/dev/null',
  "    seq=$((seq + 1))",
  "  else",
  "    sleep 0.05",
  "  fi",
  "done",
  "",
].join("\n");

// Client HTTP du pont, exécuté dans la VM pour chaque requête. Parle HTTP/1.0
// sur le socket Unix applicatif et envoie la requête complète (en-têtes +
// corps) en un UNIQUE sendall : la seconde écriture socket (comportement de
// curl pour un POST) déclenche un deadlock dans la couche socket de CheerpX.
// Codes d'erreur alignés sur curl : 7 connexion refusée, 28 timeout, 56 divers.
export const BRIDGE_CLIENT_PY = `
import json
import socket
import sys

RECV_CHUNK = 65536


def read_descriptor(path):
    with open(path, "rb") as handle:
        return json.load(handle)


def build_raw_request(desc, payload):
    lines = [desc["method"] + " " + desc["path"] + " HTTP/1.0"]
    seen = set()
    for name, value in desc["headers"]:
        lines.append(name + ": " + value)
        seen.add(name.lower())
    if "host" not in seen:
        lines.append("Host: localhost")
    if payload and "content-length" not in seen:
        lines.append("Content-Length: " + str(len(payload)))
    lines.append("Connection: close")
    return ("\\r\\n".join(lines) + "\\r\\n\\r\\n").encode("utf-8") + payload


def exchange(desc, payload):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(desc.get("timeoutSeconds", 90))
    try:
        sock.connect(desc["socket"])
        sock.sendall(build_raw_request(desc, payload))
        chunks = []
        while True:
            data = sock.recv(RECV_CHUNK)
            if not data:
                break
            chunks.append(data)
        return b"".join(chunks)
    finally:
        sock.close()


def main():
    desc = read_descriptor(sys.argv[1])
    code, head, body = 0, b"", b""
    try:
        payload = b""
        if desc.get("requestBodyFile"):
            with open(desc["requestBodyFile"], "rb") as handle:
                payload = handle.read()
        response = exchange(desc, payload)
        separator = response.find(b"\\r\\n\\r\\n")
        if separator < 0:
            code = 56
        else:
            head = response[: separator + 4]
            body = response[separator + 4 :]
    except (ConnectionRefusedError, FileNotFoundError):
        code = 7
    except socket.timeout:
        code = 28
    except Exception:
        code = 56
    if head:
        with open(desc["headFile"], "wb") as handle:
            handle.write(head)
    if body:
        with open(desc["bodyFile"], "wb") as handle:
            handle.write(body)
    # .done en DERNIER : il annonce les tailles que le lecteur JS doit attendre
    # (la persistance IndexedDB de CheerpX est asynchrone et non ordonnee).
    with open(desc["doneFile"], "w") as handle:
        handle.write(str(code) + " " + str(len(head)) + " " + str(len(body)))


main()
`;

// Mini application Python en stdlib pure (préférée : IO http.server éprouvée).
// Sert de preuve de bout en bout : iframe -> SW -> pont -> VM -> serveur ->
// retour. Remplacée par Puma dès qu'une image Rails est montée.
export const MINI_APP_PY = `
import os
import socketserver
from http.server import BaseHTTPRequestHandler

SOCKET_PATH = os.environ.get("APP_SOCKET", "/tmp/app.sock")

PAGE = """<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>railsbox : pont OK</title>
<style>
  body {{ font-family: ui-monospace, monospace; background: #0d1117; color: #d8e1ea;
         display: grid; place-items: center; min-height: 90vh; }}
  main {{ max-width: 40rem; padding: 2rem; border: 1px solid #263241; border-radius: 12px; }}
  h1 {{ color: #7ee787; font-size: 1.3rem; }}
  dt {{ color: #8b98a5; }} dd {{ margin: 0 0 .8rem 0; color: #e6edf3; }}
</style></head>
<body><main>
  <h1>Pont HTTP navigateur &rarr; VM Linux : opérationnel</h1>
  <p>Page générée par un processus <strong>Python</strong> dans la VM x86,
     servie via socket Unix + pont HTTP + Service Worker.</p>
  <dl>
    <dt>Méthode</dt><dd>{method}</dd>
    <dt>Chemin</dt><dd>{path}</dd>
    <dt>Host vu par le serveur</dt><dd>{host}</dd>
  </dl>
  <p>Montez une image disque contenant une app Rails dans /root/app
     pour remplacer cette page par Puma (voir tools/build-rails-image).</p>
  <form method="post" action="{path}"><button>Tester un POST</button></form>
  <p>Corps reçu : <code>{body}</code></p>
</main></body></html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _respond(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw_body = self.rfile.read(length) if length > 0 else b""
        shown = raw_body[:200].decode("utf-8", "replace") if raw_body else "(vide)"
        page = PAGE.format(
            method=self.command,
            path=self.path,
            host=self.headers.get("Host", "(absent)"),
            body=shown,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    do_GET = _respond
    do_POST = _respond
    do_PUT = _respond
    do_PATCH = _respond
    do_DELETE = _respond

    def log_message(self, *args):
        pass


class UnixHTTPServer(socketserver.UnixStreamServer):
    def get_request(self):
        request, _ = super().get_request()
        # BaseHTTPRequestHandler attend un couple (hote, port)
        return request, ("localhost", 0)


if os.path.exists(SOCKET_PATH):
    os.unlink(SOCKET_PATH)
print("[mini-app] en ecoute sur unix://" + SOCKET_PATH + " (Python)", flush=True)
UnixHTTPServer(SOCKET_PATH, Handler).serve_forever()
`;

// Variante Ruby en stdlib pure (WEBrick n'est plus dans la stdlib depuis
// Ruby 3.0), utilisée si python3 est absent de l'image.
export const MINI_APP_RB = `
require "socket"

socket_path = ENV.fetch("APP_SOCKET", "/tmp/app.sock")
File.unlink(socket_path) if File.exist?(socket_path)
server = UNIXServer.new(socket_path)
warn "[mini-app] en ecoute sur unix://#{socket_path} (Ruby #{RUBY_VERSION})"

def read_body(sock, length)
  body = +""
  while body.bytesize < length
    body << sock.readpartial(length - body.bytesize)
  end
  body
rescue EOFError
  body
end

def read_request(sock)
  request_line = sock.gets
  return nil if request_line.nil?
  method, path, = request_line.split(" ", 3)
  headers = {}
  while (line = sock.gets)
    line = line.strip
    break if line.empty?
    name, value = line.split(":", 2)
    headers[name.to_s.downcase] = value.to_s.strip
  end
  length = headers.fetch("content-length", "0").to_i
  body = length.positive? ? read_body(sock, length) : ""
  { method: method, path: path, headers: headers, body: body }
end

def html_page(req)
  <<~HTML
    <!doctype html>
    <html lang="fr"><head><meta charset="utf-8"><title>railsbox : pont OK</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0d1117; color: #d8e1ea;
             display: grid; place-items: center; min-height: 90vh; }
      main { max-width: 40rem; padding: 2rem; border: 1px solid #263241; border-radius: 12px; }
      h1 { color: #7ee787; font-size: 1.3rem; }
      dt { color: #8b98a5; } dd { margin: 0 0 .8rem 0; color: #e6edf3; }
    </style></head>
    <body><main>
      <h1>Pont HTTP navigateur &rarr; VM Linux : opérationnel</h1>
      <p>Cette page est générée par un processus <strong>Ruby #{RUBY_VERSION}</strong>
         tournant dans la VM x86, servie via un socket Unix + curl + Service Worker.</p>
      <dl>
        <dt>Méthode</dt><dd>#{req[:method]}</dd>
        <dt>Chemin</dt><dd>#{req[:path]}</dd>
        <dt>Host vu par le serveur</dt><dd>#{req[:headers].fetch("host", "(absent)")}</dd>
        <dt>En-têtes reçus</dt><dd>#{req[:headers].size}</dd>
      </dl>
      <p>Montez une image disque contenant une app Rails dans /root/app
         pour remplacer cette page par Puma (voir tools/build-rails-image).</p>
      <form method="post" action="#{req[:path]}"><button>Tester un POST</button></form>
      <p>Corps reçu : <code>#{req[:body].empty? ? "(vide)" : req[:body][0, 200]}</code></p>
    </main></body></html>
  HTML
end

# Traitement séquentiel volontaire : un seul client à la fois (le pont curl
# est lui-même séquentiel) et les threads Ruby sont fragiles sous émulation.
loop do
  sock = server.accept
  begin
    req = read_request(sock)
    if req
      body = html_page(req)
      sock.write("HTTP/1.1 200 OK\\r\\n" \\
                 "Content-Type: text/html; charset=utf-8\\r\\n" \\
                 "Content-Length: #{body.bytesize}\\r\\n" \\
                 "Connection: close\\r\\n\\r\\n#{body}")
    end
  rescue StandardError => error
    warn "[mini-app] erreur requete: #{error.class}: #{error.message}"
  ensure
    begin
      sock.close
    rescue StandardError
      nil
    end
  end
end
`;
