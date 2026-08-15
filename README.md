# Rails-in-Browser 2.1

Faire tourner une application **Rails complète et non modifiée** (Puma, gems C
natives, PostgreSQL/SQLite) entièrement dans le navigateur, avec **deux
moteurs interchangeables** derrière la même façade :

| Moteur | URL | Licence | Points forts |
|---|---|---|---|
| **CheerpX** (défaut) | `/` | propriétaire (gratuit perso) | JIT le plus rapide ; pont fichiers validé |
| **v86** | `/?engine=v86` | BSD-2-Clause | vrai noyau Linux (TCP loopback natif), pont série, snapshots RAM |

**État : fonctionnel de bout en bout** — GET et POST (avec corps) validés dans
Chrome, de l'iframe jusqu'à un serveur HTTP tournant dans la VM, en ~2–3 s par
requête (VM émulée). Sans image Rails custom, une mini-app de démonstration
prouve la chaîne ; avec l'image produite par `tools/build-rails-image`, c'est
Puma qui répond.

## Démarrage rapide

```bash
npm start        # sert public/ avec COOP/COEP + Range sur http://localhost:8080
npm test         # tests unitaires du codec HTTP (node --test, zéro dépendance)
```

Ouvrir http://localhost:8080 dans **Chrome/Edge** (SharedArrayBuffer requis).
Premier boot : ~25–40 s (streaming du disque Debian, ensuite mis en cache
IndexedDB). Nota : le navigateur intégré de certains environnements (webviews)
bloque les Service Workers — utiliser un vrai Chrome.

## Ce qui a été corrigé par rapport au schéma « 2.0 »

Chaque point ci-dessous a été vérifié expérimentalement pendant le développement.

| Affirmation du schéma 2.0 | Réalité vérifiée | Solution retenue |
|---|---|---|
| « Linux Userland **x86_64** » | CheerpX exécute du x86 **32 bits** (i386) | Dockerfile basé `i386/debian` |
| « Puma sur loopback `127.0.0.1:3000`, zéro patch » | **Le loopback TCP ne fonctionne pas sans Tailscale** : `bind()` échoue (EADDRINUSE fantôme), toute la pile TCP de CheerpX passe par Tailscale | Le serveur écoute sur un **socket Unix** (`unix:///tmp/app.sock`) — purement interne au noyau émulé, fonctionne nativement ; Puma le supporte via `-b unix://…` |
| « Interception fetch → proxy stream direct vers la VM » | Aucune API publique CheerpX pour ouvrir un flux vers un socket de la VM depuis JS | Pont fichier-based : SW → page hôte → `DataDevice` (JS→VM) → client HTTP dans la VM → `IDBDevice`/`readFileAsBlob` (VM→JS) → SW |
| Pont via curl dans la VM | **Deadlock CheerpX** : la 2ᵉ écriture socket de curl (le corps d'un POST) bloque définitivement — même `--max-time` ne se déclenche plus | **Client HTTP Python** embarqué (`bridge-client.py`) : requête complète envoyée en **un seul `sendall()`**, HTTP/1.0 + `Connection: close` (pas de chunked). Bonus sécurité : les données de requête ne traversent plus aucun shell |
| Lecture directe des fichiers produits par la VM | Le write-back IndexedDB de CheerpX est **asynchrone et non ordonné** entre fichiers : lire dès l'apparition d'un marqueur donne des fichiers vides/partiels | Protocole de synchronisation : `.done` écrit **en dernier**, contient `code taille_head taille_body` ; le JS re-lit head/body jusqu'à atteindre ces tailles |
| « COI Service Worker » séparé du proxy | **Un seul SW par scope** : deux SW se désenregistrent mutuellement ; et le navigateur tue les SW inactifs (perte de l'état en mémoire) | SW unique (proxy + en-têtes COI) ; quand il redémarre, il **redemande le MessagePort** à la page hôte au lieu de répondre 503 |
| « Web Worker : noyau d'exécution » | L'API CheerpX s'initialise sur le thread principal ; le moteur gère ses propres workers internes | Module VM isolé sur le thread principal de la page hôte, iframe applicative séparée |
| « GCC + `bundle install` dans le navigateur » | Possible mais très lent, et **exige un réseau sortant** donc Tailscale | Les gems natives compilent hors ligne dans le Dockerfile (chemin nominal) |
| « Heap Cloner, boot < 120 ms » | Aucune API publique de snapshot mémoire dans CheerpX 1.2.8 | Premier boot en dizaines de secondes ; boots suivants accélérés par le cache IndexedDB (`OverlayDevice`) |
| « ActionCable/WebSockets natifs » | Impossible à travers un pont requête/réponse | Hors périmètre V1 — voir Roadmap |

## Architecture réelle (2.1)

```
┌────────────────────────────── NAVIGATEUR ───────────────────────────────┐
│  PAGE HÔTE (thread principal)                 IFRAME APPLICATIVE        │
│  ├─ main.js : orchestration, badges, log      └─ HTML Rails, Turbo…     │
│  ├─ vm/rails-vm.js : boot CheerpX + pont            │ fetch /app/*      │
│  │    (workers internes gérés par CheerpX)          ▼                   │
│  │                                        SW UNIQUE sw-proxy.js         │
│  │  MessageChannel (renouvelé à chaque    ├─ proxy /app/* → page hôte   │
│  └───────────◄─── redémarrage du SW) ─────┤─ en-têtes COOP/COEP (COI)   │
│                                           └─ redemande le port si perdu │
├─────────────────────────── VM LINUX x86 (CheerpX) ──────────────────────┤
│  /            ext2 : OverlayDevice(disque HTTP/wss, IDBDevice) → persist│
│  /data        DataDevice  : JS → VM (scripts, descripteurs, corps)      │
│  /files       IDBDevice   : VM → JS (réponses, lues par readFileAsBlob) │
│  boot.sh      1 seul cx.run : serveur en arrière-plan + boucle de pont  │
│  bridge-client.py   client HTTP/1.0, un seul sendall, codes façon curl  │
│  Puma unix:// (image Rails) │ mini-app Python/Ruby (démo)               │
└─────────────────────────────────────────────────────────────────────────┘
```

Cycle d'une requête : l'iframe fait `fetch("/app/posts")` → le SW la
sérialise (méthode, chemin, en-têtes, corps — **validés** dans
`request-codec.js`) → la page hôte écrit `req-N.json` + `req-N.body` puis
`req-N.cmd` dans `/data` → la boucle shell de la VM lance
`bridge-client.py` → il parle HTTP/1.0 au serveur via le socket Unix →
écrit `res-N.{head,body}` puis `res-N.done` dans `/files` → la page les lit
(en attendant les tailles annoncées) → le SW reconstruit une `Response`.
L'en-tête `Host` d'origine est retransmis pour que `redirect_to` génère des
URLs correctes. En cas d'échec de préparation, un script neutre est tout de
même écrit pour que la boucle (strictement ordonnée) ne se bloque jamais.

## Backend v86 : une vraie application (jiyufit) dans le navigateur

**Validé le 15/08/2026** : jiyufit (Rails 7.2.3, Ruby 3.3.10, PostgreSQL 15,
Redis, Puma 7, Devise, Stripe, Sidekiq) rend sa page d'accueil **entièrement
stylée** (tailwind, 2 492 règles, bannière cookies Stimulus fonctionnelle)
dans Chrome. Mesures : boot à froid ~13 min (noyau 55 s, PostgreSQL 1 min,
Rails 11 min) ; à chaud **home en 1,1 s** (4 requêtes SQL) et 404 en 556 ms.

**Instantané mémoire** : l'état complet de la VM est restauré au lieu d'être
reconstruit — **26 s pour un nouvel utilisateur** (instantané pré-calculé
téléchargé), **~40 s** depuis le cache local, contre ~13 min de boot à froid.
Clé d'invalidation = config disque (`builtAt` régénéré à chaque build) ;
`?fresh=1` purge le cache et force un boot à froid.

### Quatre pièges de l'instantané mémoire (traités)

| Piège | Conséquence | Traitement |
|---|---|---|
| **Gel d'horloge** — le noyau restauré reprend à la date de la capture | cookies de session et jetons CSRF vus comme expirés, TLS invalide | trame `@RIB1 TIME <epoch>` envoyée à chaque sonde et juste avant la première vraie requête ; le démon applique `date -s` si la dérive dépasse 2 s |
| **Fuite Blob** — `URL.createObjectURL` sur 640 Mo n'est jamais libéré | mémoire de l'onglet doublée | supprimé à la racine : v86 accepte `initial_state: { buffer }`, donc plus aucun Object URL (mieux que `revokeObjectURL`) |
| **Boot à froid de 13 min chez l'utilisateur** | inacceptable en production | `make-snapshot.mjs` génère l'instantané en CI (v86 sous Node, même codec série) ; il est livré en `/disks/jiyufit-state.bin(.gz)` et téléchargé si le cache local est vide |
| **Débit série** — v86 émet un événement JS **par octet** (369 282 pour le CSS) | à-coups de rendu potentiels | assembleur en `Uint8Array` pré-alloué à croissance géométrique, zéro allocation par octet : **24 ns/octet, 8,9 ms pour 270 Ko** (`node tools/bench-serial.mjs`) — le coût réel est l'UART émulée, pas le JS |

**Résultat mesuré du parcours « nouvel utilisateur, cache vide »** : instantané
téléchargé (656 Mo décompressés en 4,1 s depuis le `.gz` de 174 Mo) puis
application disponible **26 s après le chargement de la page**, contre ~13 min
de boot à froid. Aucun Object URL créé (vérifié : 0 entrée `blob:`).

Découverte au passage : l'horloge invitée **dérive en continu** sous émulation
chargée, pas seulement au gel de l'instantané — jusqu'à 20 s de retard toutes
les 5 s pendant le boot. Le recalage est donc aussi périodique (toutes les
15 s) en fonctionnement, sinon les sessions finiraient par expirer d'elles-mêmes.

Génération de l'instantané pré-calculé :

```bash
node tools/build-v86-image/make-snapshot.mjs
```

Il écrit `jiyufit-state.bin` + `.gz`, et ajoute `"state"` à `v86-config.json`.
Le serveur de dev sert automatiquement le `.gz` avec `Content-Encoding: gzip`
(décompression transparente par le navigateur).

### Protocole du pont série (v2) et limite mesurée du canal montant

Le canal **descendant** (invité → navigateur) encaisse tout : v86 délivre les
octets à la vitesse où le JS les consomme. Le canal **montant** (navigateur →
invité), lui, passe par le tampon d'entrée du TTY/UART émulé, **sans contrôle
de flux** — et il perd des octets bien avant ce qu'on imagine :

| Corps d'un POST | Avant (une seule ligne) | Après (tranches acquittées) |
|---|---|---|
| 1–32 Ko | arrive | arrive |
| **128 Ko** | **perdu — 502 après 120 s, canal ensuite bloqué** | arrive |
| 256 Ko | perdu | **1,4 s** |
| **1 Mo** | perdu | **2,5 s** |

Aucun « corps incomplet » sur l'ensemble de l'échelle : le démon vérifie que
les tranches reçues totalisent exactement la taille annoncée, donc ces
transferts sont intègres à l'octet près, pas seulement « arrivés ».

D'où le protocole en deux temps, avec fenêtre d'émission de **une** tranche :

```
navigateur → invité :  REQ <id> <b64 descripteur sans corps>
                       BOD <id> <b64 tranche de 1536 o>   ⟵ attend ACK
                       BOD <id> …                          ⟵ attend ACK
                       FIN <id>
                       TIME <epoch>            (recalage d'horloge)
invité → navigateur :  ACK <id>                (après écriture de la tranche)
                       RSB <id> <taille brute> ⟵ le lecteur alloue une fois
                       DAT <id> <b64 8000 car.> ⟵ décodé au vol dans le tampon
                       END <id> | ERR <id> <code> | LOG …
```

Deux effets de bord bénéfiques : le corps n'est plus encodé deux fois en
base64 (**−77 % de charge utile**), et une réponse dont les tranches ne
totalisent pas la taille annoncée est rejetée franchement au lieu d'être
livrée tronquée.

**Le canal reste étroit et semi-duplex** : une grosse réponse en cours (les
assets de la page d'accueil) monopolise l'écriture de l'invité, et
l'acquittement d'une tranche montante attend derrière. Mesuré : le même POST
de 4 Ko met 105 s pendant le chargement des assets, contre moins d'une
seconde une fois le canal libre. C'est pourquoi le délai d'acquittement est
aligné sur celui d'une requête complète (120 s) et non sur une valeur courte
— un délai de 30 s faisait échouer à tort tout POST concurrent d'un
téléchargement.

Règle d'or du pont série : **un seul écrivain**. Les logs applicatifs sont
relayés par le démon du pont lui-même (sous son verrou) — jamais par un
`tail -F` concurrent, dont les lignes s'entrelacent avec les trames et
corrompent les transferts volumineux (vécu : CSS de 270 Ko corrompu).

Pièges rencontrés (tous corrigés dans le Dockerfile/init, dans l'ordre) :
`docker export` perd `/etc/hosts` et les uid si extrait sans root ; l'init
maison doit monter `/dev/shm` (PostgreSQL 15) ; `BUNDLE_WITHOUT` /
`BUNDLE_FORCE_RUBY_PLATFORM` doivent exister au **runtime** (pas seulement au
build) ; BuildKit ne pose pas la personnalité 32 bits (gems précompilées
x86_64 → tout compiler source) ; `tmp/ log/ storage/` sont exclus par le
.dockerignore de jiyufit (Puma exige `tmp/pids`) ; le tty série doit être en
`raw -echo` (le mode canonique tronque à 4096 caractères) ; et le SW doit
**retirer le préfixe /app** (reconnaissance des routes) pendant que
`RAILS_RELATIVE_URL_ROOT` préfixe la génération d'URLs.

v86 (BSD-2-Clause) émule un PC i386 complet avec un vrai noyau Linux : le
loopback TCP fonctionne nativement (Puma écoute en `tcp://127.0.0.1:3000`
sans détour), et le pont passe par le **port série** ttyS0 — un canal ordonné
et fiable, sans les pièges de persistance du pont fichiers CheerpX.

```
iframe → SW → page hôte → serial0_send("@RIB1 REQ id b64(json)")
  → ttyS0 → /opt/rib/serial-bridge.py (démon Python dans la VM)
  → HTTP 127.0.0.1:3000 (Puma) → trames RSB/DAT/END → Response
```

Les requêtes sont multiplexées par id (pas d'ordre strict, contrairement au
pont CheerpX) et toute ligne série sans le préfixe `@RIB1` est affichée comme
log (noyau, Puma) dans le panneau de la page hôte.

Construction de l'image (WSL2, docker + e2fsprogs) :

```bash
cd tools/build-v86-image && bash build.sh /chemin/vers/jiyufit
```

Le Dockerfile est en deux étages : les assets (tailwind/esbuild/dartsass,
binaires amd64 uniquement) se précompilent en x86_64, le rootfs est en i386
avec Ruby 3.3.10 compilé depuis les sources, PostgreSQL 15, Redis, et le
noyau Debian 686 que v86 boote directement (bzImage + initrd, sans
bootloader). La base est préparée pendant le build (`db:prepare` + seeds
légaux) et les clés obligatoires au boot (`ACTIVE_RECORD_ENCRYPTION_*`,
`ACCESS_MASTER_SIGNING_KEY`, `COMPLIANCE_PSEUDONYMIZATION_KEY`) sont
générées aléatoirement — propres à cette image locale de démo.

Particularité jiyufit : `config.force_ssl = true` — le SW ajoute
`X-Forwarded-Proto: https` à toutes les requêtes proxifiées (Chrome accepte
les cookies `Secure` sur localhost, les sessions fonctionnent donc en local).

## Monter votre application Rails (CheerpX)

1. Sous Linux/WSL2 : `cd tools/build-rails-image && ./build.sh`
   (adaptez le Dockerfile : remplacez `rails new` par un `COPY` de votre app ;
   `RAILS_RELATIVE_URL_ROOT=/app` est déjà posé, gardez-le).
2. Copiez `rails.ext2` dans `public/disks/`.
3. Dans `public/main.js` : `bootVm({ diskImageUrl: "/disks/rails.ext2", onConsole: logLine })`.

`boot.sh` détecte `/root/app/bin/rails` et lance
`bin/rails server -b "unix://$APP_SOCKET"` (Puma supporte nativement les
sockets Unix). `SECRET_KEY_BASE` est généré aléatoirement à chaque session
côté navigateur — aucun secret en dur.

L'overlay IndexedDB rend la VM **stateful** : migrations, écritures SQLite et
installations survivent au rechargement de l'onglet. Pour repartir de zéro :
DevTools → Application → IndexedDB → supprimer `cjFS_/rails-root/`.

## Limites connues et roadmap

- **ActionCable / WebSockets** : non supportés par le pont V1. Pistes V2 :
  long-polling côté client, ou multiplexage d'un flux dédié via le protocole
  de fichiers (SSE simulé par polling).
- **Débit** : 1 requête à la fois (boucle strictement ordonnée), ~2–3 s par
  requête sous émulation. Suffisant pour Turbo/HTML, pas pour des rafales
  d'assets — d'où le `assets:precompile` dans l'image.
- **Réseau sortant** (APIs externes, `bundle install`) : nécessite l'option
  Tailscale de CheerpX (`networkInterface` de `Linux.create`), non câblée ici.
- **Image publique WebVM** : Debian avec Ruby 2.5 et Python 3 — suffisante
  pour la démo, pas pour Rails 7 (d'où l'image custom).
- **Licence CheerpX** : gratuit pour usage personnel/évaluation ; usage
  commercial soumis à licence Leaning Technologies. À valider avant prod.
- **Navigateurs** : validé sous Chrome. Les webviews embarquées qui bloquent
  les Service Workers ne peuvent pas fonctionner.
- **SQLite/OPFS** : la persistance passe par IndexedDB (`IDBDevice`), le
  mécanisme natif de CheerpX ; OPFS serait une optimisation future.

## Arborescence

```
serve.mjs                       # serveur dev : COOP/COEP + Range, zéro dépendance
public/
├── index.html                  # page hôte : badges d'état, log, iframe
├── main.js                     # orchestration SW ↔ VM ↔ pont
├── sw-proxy.js                 # SW unique : proxy /app/* + isolation COI
├── shared/request-codec.js     # validation/sérialisation HTTP (testé)
└── vm/
    ├── rails-vm.js             # boot CheerpX, montages, façade du pont
    └── vm-scripts.js           # boot.sh, bridge-client.py, mini-apps (LF garantis)
tests/request-codec.test.mjs    # node --test
tools/build-rails-image/        # Dockerfile i386 + build.sh → rails.ext2
```
