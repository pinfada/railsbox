# railsbox

**Une application Rails complète, non modifiée, qui tourne entièrement dans le
navigateur.** Pas de serveur applicatif, pas de conteneur distant : Puma,
PostgreSQL, Redis et les gems C natives s'exécutent dans une VM Linux x86
émulée en WebAssembly, à l'intérieur de l'onglet.

Validé sur une vraie application de production — [jiyufit](https://github.com/pinfada)
(Rails 7.2.3, Ruby 3.3.10, PostgreSQL 15, Redis, Sidekiq, Devise, Stripe,
70 initializers) — qui rend ses pages, suit ses liens et traite ses POST.

## 1. Démo

> **État : pas encore déployée publiquement.** Les artefacts pèsent 4,2 Go
> (image disque) plus 173 Mo (instantané mémoire compressé), et le dépôt est
> privé. Il n'y a donc pas de lien à cliquer aujourd'hui — le dire clairement
> vaut mieux qu'un lien mort.

Ce qu'un hébergement statique doit fournir pour que le « 1 clic » fonctionne :

| Exigence | Pourquoi |
|---|---|
| En-têtes `Cross-Origin-Opener-Policy: same-origin` et `Cross-Origin-Embedder-Policy: require-corp` | `SharedArrayBuffer`, sans quoi aucun moteur ne démarre |
| Requêtes `Range` sur le `.ext2` | le disque de 4 Go est lu par morceaux, jamais téléchargé en entier |
| `Content-Encoding: gzip` sur l'instantané | 653 Mo bruts → 173 Mo transférés |
| Chrome ou Edge | validé ; les webviews qui bloquent les Service Workers ne peuvent pas fonctionner |

À défaut d'hébergeur posant ces en-têtes, le Service Worker les réinjecte
lui-même — mais le tout premier chargement doit déjà être isolé.

**Ce que verrait le visiteur** : l'application disponible en **26 secondes**
(instantané téléchargé puis restauré), puis une navigation normale — page
d'accueil stylée en 1,1 s, formulaires, redirections.

## 2. Guide d'utilisation

### Tester en local

```bash
npm install
npm start                 # http://localhost:8080 — COOP/COEP, Range et gzip inclus
npm test                  # tests unitaires (node --test, sans réseau ni artefacts)
npm run check             # lint + format + typecheck + tests — la porte de la CI
npm run test:integration  # protocole complet contre une VRAIE VM v86 sous Node
                          # (exige public/disks/ ; ~1 min grâce à l'instantané)
```

Après un build d'image, extrayez les assets précompilés pour qu'ils soient
servis statiquement au lieu de traverser le pont série (levier de
performance n°1) :

```bash
wsl -e sh tools/extract-assets.sh   # → public/disks/assets/ + appstatic/
```

Sans image applicative, le moteur par défaut (CheerpX) boote une image Debian
publique et sert une mini-application de démonstration : la chaîne complète
navigateur → VM → serveur HTTP est vérifiable en une trentaine de secondes.

| URL | Moteur | Ce qui tourne |
|---|---|---|
| `http://localhost:8080` | CheerpX | mini-app de démonstration |
| `http://localhost:8080/?engine=v86` | v86 | votre application Rails |
| `…/?engine=v86&fresh=1` | v86 | idem, en ignorant l'instantané (boot à froid) |

### Packager votre application Rails

Deux commandes, sous **WSL2 ou Linux** (Docker et `e2fsprogs` requis) :

```bash
bash tools/build-v86-image/build.sh /chemin/vers/votre-app   # ~25 min
node tools/build-v86-image/make-snapshot.mjs                 # ~12 min
```

La première construit l'image disque : Dockerfile en deux étages — les assets
se précompilent en x86_64 (tailwind, esbuild et dartsass n'ont pas de binaire
i386), le rootfs est en i386 avec Ruby compilé depuis les sources, la base de
données préparée et le noyau extrait pour un démarrage direct.

La seconde boote cette image **sous Node**, attend que l'application réponde,
capture l'état mémoire et écrit `jiyufit-state.bin(.gz)`. C'est ce qui évite
à l'utilisateur final le boot à froid de treize minutes.

Le `Dockerfile` est aujourd'hui **écrit pour jiyufit** : version de Ruby,
PostgreSQL et Redis, scripts npm, et une quinzaine de variables d'environnement
propres à sa doctrine de sécurité. Le adapter à une autre application demande
d'éditer ces points — voir la section 4 pour ce qui est généralisable.

### Réparer une configuration incomplète

Une application Rails sérieuse refuse de démarrer si une clé manque. Le
panneau **Environnement** (en haut à droite) détecte ces variables dans les
journaux de boot, génère les secrets internes au bon format en un clic, offre
un champ pour les identifiants de services tiers, puis **injecte le tout dans
la VM et relance l'application à chaud** — sans reconstruire l'image.

## 3. Architecture

### Comparatif des moteurs

Les deux backends implémentent la même façade ; seul le transport diffère.

| | **v86** (recommandé) | **CheerpX** |
|---|---|---|
| Licence | BSD-2-Clause | propriétaire (gratuit en usage personnel) |
| Émulation | PC i386 complet, **vrai noyau Linux** | user-mode x86 32 bits, JIT |
| Réseau invité | loopback TCP natif (`127.0.0.1:3000`) | **pas de TCP sans Tailscale** → socket Unix |
| Transport du pont | port série `ttyS0` | fichiers via `DataDevice` / `IDBDevice` |
| Instantané mémoire | oui (`save_state`) → boot en 26 s | aucune API publique |
| Vitesse d'exécution | plus lente | JIT plus rapide |
| Usage dans ce projet | applications réelles | mini-app de démonstration |

### Schéma de flux

```
┌─────────────────────────── NAVIGATEUR ────────────────────────────┐
│  IFRAME APPLICATIVE            PAGE HÔTE (thread principal)       │
│  fetch("/app/gymhouses")       ├─ main.js : orchestration, log    │
│        │                       ├─ vm/v86-vm.js : boot + pont      │
│        ▼                       └─ env-drawer.js : réparation      │
│  SERVICE WORKER (sw-proxy.js)          ▲                          │
│  ├─ intercepte /app/*                  │ MessageChannel           │
│  ├─ réinjecte COOP/COEP                │ (renouvelé si le SW meurt)│
│  └─ réécrit les Location absolues ─────┘                          │
├───────────────────────── VM LINUX i386 (v86) ─────────────────────┤
│  ttyS0 ◄── REQ / BOD+ACK / FIN ─── trames @RIB1 ──► RSB/DAT/END   │
│    │                                                              │
│    ▼                                                              │
│  serial-bridge.py  ──HTTP──►  Puma 127.0.0.1:3000                 │
│  (démon, survit au       (Rack::URLMap monte l'app sous /app)     │
│   plantage de l'app)          │                                   │
│                               ├─ PostgreSQL 15                    │
│                               └─ Redis                            │
└───────────────────────────────────────────────────────────────────┘
```

Le préfixe `/app` est conservé de bout en bout : le Service Worker n'intercepte
que lui, et l'application le génère nativement puisqu'elle est montée dessous
par `Rack::URLMap`.

## 4. Retour d'expérience : les défis résolus

Vingt-deux itérations de build ont été nécessaires. Les obstacles n'étaient
presque jamais où on les attend — voici ceux qui ont coûté le plus cher.

### Le loopback TCP n'existe pas sous CheerpX

`bind()` sur `127.0.0.1` échoue avec un `EADDRINUSE` fantôme : toute la pile
TCP passe par Tailscale. Puma écoute donc sur un **socket Unix**, purement
interne au noyau émulé. C'est ce qui a motivé le passage à v86, dont le vrai
noyau Linux rend le loopback trivial.

### Le canal montant perd les gros POST

Le port série n'a **aucun contrôle de flux** dans le sens navigateur → invité.
Mesuré : un POST de 32 Ko passe, **128 Ko est perdu et bloque le canal
définitivement**. La correction est un protocole en tranches acquittées une
par une (fenêtre d'émission de 1 536 octets), ce qui borne les octets en vol
quelle que soit la taille du tampon.

| Corps du POST | Avant | Après |
|---|---|---|
| 1–32 Ko | arrive | arrive |
| 128 Ko | **perdu**, canal mort | arrive |
| 1 Mo | perdu | **2,5 s** |

Effet de bord bénéfique : le corps n'étant plus embarqué dans le descripteur
JSON lui-même ré-encodé, la charge utile perd **77 %** de son gonflement.

### Le canal est semi-duplex, et ça se voit

Une grosse réponse en cours monopolise l'écriture de l'invité : l'acquittement
d'une tranche montante attend derrière. Le même POST de 4 Ko met **105 s**
pendant le chargement des assets, contre moins d'une seconde canal libre. Le
délai d'acquittement est donc aligné sur celui d'une requête complète — une
valeur courte faisait échouer à tort tout POST concurrent d'un téléchargement.

### Un seul écrivain sur le port série

Un `tail -F` ajouté pour la télémétrie écrivait en concurrence du démon : ses
lignes s'entrelaçaient avec les trames et **corrompaient les transferts
volumineux** (CSS de 270 Ko illisible). Les logs applicatifs sont désormais
relayés par le démon lui-même, sous son verrou.

### L'horloge invitée dérive en permanence

Attendu après restauration d'instantané (le noyau reprend à la date de la
capture), mais la mesure a montré pire : sous émulation chargée, l'invité
prend **jusqu'à 20 s de retard toutes les 5 s**. Sans recalage périodique, les
cookies de session et les jetons CSRF finissent par expirer d'eux-mêmes en
cours d'utilisation.

### `RAILS_RELATIVE_URL_ROOT` ne préfixe que les assets

| Helper | URL générée |
|---|---|
| `stylesheet_link_tag` | `/app/assets/tailwind-…` ✅ |
| `link_to`, `form_with` | `/gymhouses` ❌ échappe au proxy |

Les helpers de routes lisent le `SCRIPT_NAME` de Rack, vide quand Puma sert à
la racine. La correction est le déploiement sous-URI standard : un `config.ru`
fourni par l'image monte l'application via `Rack::URLMap`, **sans toucher au
code applicatif**. Défaut trouvé en cliquant sur un lien — pas en regardant la
page d'accueil s'afficher.

### Quatre pièges de l'instantané mémoire

| Piège | Traitement |
|---|---|
| Gel d'horloge | trame `TIME` + `date -s` au-delà de 2 s de dérive |
| Fuite mémoire — `URL.createObjectURL` sur 650 Mo n'est jamais libéré | supprimé à la racine : v86 accepte `initial_state: { buffer }` |
| Boot à froid de 13 min chez l'utilisateur | instantané généré en CI, livré en gzip, téléchargé si le cache local est vide |
| v86 émet **un événement JS par octet** (369 282 pour le CSS) | assembleur `Uint8Array` pré-alloué : **24 ns/octet**, 8,9 ms pour 270 Ko |

### Détecter une variable manquante sans se tromper de mot

Une expression du type `(VARIABLE).{0,40}(mot-clé)` capture le **premier**
jeton majuscule de la ligne — sur
`{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}` elle proposait
sérieusement `FATAL` comme variable à renseigner. Remplacée par une recherche
par fenêtre autour du mot-clé, avec retrait des étiquettes de journal
(`[DEVISE]`, `[STRIPE]`) et exigence d'un souligné dans le nom.

Autre nuance : « bloquant » se juge sur la **gravité du message**, pas sur la
famille de la variable. Un `WARN` laisse l'application démarrer, seule la
fonctionnalité concernée reste inactive.

### Pièges de construction d'image, en vrac

`docker export` perd `/etc/hosts` et les uid si l'extraction n'est pas faite
en root ; un init maison doit monter `/dev/shm` (PostgreSQL 15) ;
`BUNDLE_WITHOUT` et `BUNDLE_FORCE_RUBY_PLATFORM` doivent exister **au runtime**
et pas seulement au build ; BuildKit n'applique pas la personnalité 32 bits,
donc `uname -m` ment et Bundler installe des gems x86_64 inchargeables ;
nokogiri ne compile pas son libxml2 embarqué en i386 (bibliothèques système
obligatoires) ; `tmp/`, `log/` et `storage/` sont souvent exclus par le
`.dockerignore` alors que Puma exige `tmp/pids` ; le tty série doit être en
`raw -echo`, le mode canonique tronquant à 4 096 caractères.

### Limites connues

- **ActionCable / WebSockets** : hors périmètre, incompatibles avec un pont
  requête/réponse. Piste : long-polling ou flux dédié multiplexé.
- **Débit** : le pont est un tuyau étroit et partagé, suffisant pour du
  Turbo/HTML. Les assets précompilés ne l'empruntent plus : extraits de
  l'image (`tools/extract-assets.sh`), ils sont servis statiquement par le
  Service Worker, avec repli VM transparent.
- **Réseau sortant** (APIs tierces, `bundle install` en ligne) : nécessiterait
  l'option Tailscale, non câblée ici.
- **Généricité** : le runtime est agnostique, la recette de build ne l'est pas
  encore (voir section 2).
- **Licence CheerpX** : usage commercial soumis à licence Leaning Technologies.
  (Le moteur v86, BSD-2-Clause, porte seul la promesse du projet.)

## Arborescence

```
serve.mjs                          serveur de dev : COOP/COEP, Range, gzip
public/
├── index.html · main.js           page hôte : orchestration, badges, journal
├── sw-proxy.js                    SW unique : proxy /app/* + isolation COI
├── env-drawer.js · .css           inspecteur d'environnement
├── shared/
│   ├── request-codec.js           validation HTTP (commun aux deux moteurs)
│   ├── serial-codec.js            trames @RIB1, contrôle de flux montant
│   └── env-detector.js            détection des variables manquantes
└── vm/
    ├── v86-vm.js                  boot v86, instantané, horloge, pont série
    └── rails-vm.js · vm-scripts.js  backend CheerpX
tests/                             37 tests (node --test)
tools/
├── build-v86-image/               Dockerfile i386 + build.sh + make-snapshot.mjs
├── build-rails-image/             image CheerpX (rails new générique)
└── bench-serial.mjs               mesure du coût du chemin chaud série
```
