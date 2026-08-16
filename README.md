# railsbox

**Une application Rails complète, non modifiée, qui tourne entièrement dans le
navigateur.** Pas de serveur applicatif, pas de conteneur distant : Puma,
PostgreSQL, Redis et les gems C natives s'exécutent dans une VM Linux x86
émulée en WebAssembly, à l'intérieur de l'onglet.

Validé sur une vraie application de production — [jiyufit](https://github.com/pinfada)
(Rails 7.2.3, Ruby 3.3.10, PostgreSQL 15, Redis, Sidekiq, Devise, Stripe,
70 initializers) — qui rend ses pages, suit ses liens et traite ses POST — et
sur une application `rails new` de démonstration (sqlite3 + importmap),
construite et bootée automatiquement par le buildpack générique.

## La philosophie

La démonstration technique n'est pas le but — elle est le moyen. L'idée qui
porte railsbox est une **inversion économique** : une application full-stack —
serveur, base de données, cache — cesse d'être un *service qu'on opère* pour
devenir un *fichier qu'on distribue*. Une fois construite, la faire tourner ne
coûte plus rien à personne : pas de dyno, pas de conteneur, pas de facture à la
minute. **Chaque visiteur apporte son propre serveur** — son processeur, sa
mémoire, son onglet. Héberger une démonstration vivante d'une application Rails
redevient aussi simple et aussi gratuit qu'héberger des fichiers sur un CDN.

Trois conséquences qui définissent le projet :

- **Ce que le produit refuse de faire est délibéré.** État éphémère, pas de
  réseau sortant, vitesse d'émulation : ce sont des défauts si l'on se compare
  à un hébergeur, mais des **propriétés** dès qu'on assume le cadrage. railsbox
  sert à *montrer et faire essayer*, jamais à *opérer*. Ce cadrage résout d'un
  coup la moitié des objections — dont la sécurité : une sandbox n'a rien à
  protéger côté serveur, puisqu'il n'y a pas de serveur.
- **L'isolement par visiteur est une qualité, pas une limite.** Chaque personne
  reçoit sa copie ; ses données ne quittent jamais son navigateur. Pour une
  démonstration, c'est exactement ce qu'on veut : personne ne peut polluer
  l'essai d'un autre, et le modèle est compatible RGPD par construction.
- **La valeur défendable est la recette, pas le moteur.** v86 est open source,
  réutilisable par quiconque. Ce qui se capitalise, c'est le buildpack — les
  vingt-deux itérations, les pièges i386, l'auto-détection, la bibliothèque
  d'images de base — le chemin qui va d'une URL GitHub à une sandbox qui boote.

## Le but visé

Un **badge « Try it » pour l'open source**. Un mainteneur colle un badge dans
son README, et n'importe qui essaie son application Rails — peuplée de données
de démonstration, session déjà ouverte — en un clic, sans rien installer, sans
créer de compte. Un lien qui ne tombe jamais, qu'on ne paie pas, qu'on ne
maintient pas. Ce que cela débloque : la démo vivante pour un projet open
source, l'aperçu de pull request jetable, le portfolio d'un développeur
indépendant, l'atelier de formation à trente onglets et zéro serveur, la
reproduction de bug dans une issue.

Le modèle est **gratuit et sans dépendance tierce payante** : le build tourne
dans les GitHub Actions du mainteneur, les artefacts vivent sur ses pages
GitHub, la coquille est une page statique. Les décisions d'architecture qui
rendent cela possible — et leurs limites mesurées — sont consignées dans
[`docs/decisions/`](docs/decisions/). Ce dépôt en construit les fondations ;
le badge lui-même n'est pas encore livré.

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

Trois niveaux de tests, tous requis avant un commit :

| Commande | Portée | Dépendances |
|---|---|---|
| `npm test` | modules purs (codecs, détecteur, buildpack, config) | aucune |
| `npm run test:integration` | protocole série complet contre une **vraie VM v86** sous Node — POST de 1 Mo, ENV/RST, montage base + application | `public/disks/` |
| `npm run test:e2e` | boot navigateur complet dans Chromium (Playwright) : page hôte, isolation, application rendue dans l'iframe, navigation | Chromium ; VM `public/disks/` |

`npm run check` enchaîne lint (ESLint), format (Prettier), typecheck
(`tsc --checkJs` sur trois cibles : navigateur, Service Worker, Node) et tests
unitaires — c'est exactement ce que joue la CI (`.github/workflows/ci.yml`).

Sans image applicative, le moteur par défaut (CheerpX) boote une image Debian
publique et sert une mini-application de démonstration : la chaîne complète
navigateur → VM → serveur HTTP est vérifiable en une trentaine de secondes.

| URL | Moteur | Ce qui tourne |
|---|---|---|
| `http://localhost:8080` | CheerpX | mini-app de démonstration |
| `http://localhost:8080/?engine=v86` | v86 | votre application Rails |
| `…/?engine=v86&fresh=1` | v86 | idem, en ignorant l'instantané (boot à froid) |

### Packager votre application Rails

Le build est **piloté par auto-détection** : `build.sh` inspecte l'application
(version de Ruby via `.ruby-version`/Gemfile, adaptateur de base via
`config/database.yml`, chaîne d'assets via `package.json`, gems natives à
bibliothèques système, services) et en déduit les arguments du Dockerfile
paramétré. Sous **WSL2 ou Linux, en root** (Docker et `e2fsprogs` requis) :

```bash
wsl -u root -e bash tools/build-v86-image/build.sh /chemin/vers/votre-app
node tools/build-v86-image/make-snapshot.mjs   # capture l'instantané mémoire
```

Le Dockerfile reste en deux étages — assets précompilés en x86_64 (tailwind,
esbuild et dartsass n'ont pas de binaire i386, et un étage vide est
sélectionné pour les applications importmap sans npm), rootfs i386 avec Ruby,
base préparée, noyau extrait pour un démarrage direct. Tous les pièges i386
(section 4) sont préservés ; l'étage d'installation des paquets est ordonné
pour partager le cache entre images.

Si la détection ne suffit pas, un fichier **`railsbox.yml`** à la racine de
l'application la complète — et sanctuarise les **données de démonstration** :

```yaml
ruby: "3.3"                        # sinon .ruby-version / Gemfile
database: postgresql               # sinon config/database.yml
seed:
  command: "bin/rails db:seed"     # exécuté au build, AVANT la capture
  auto_login: "demo@railsbox.dev"  # session ouverte au premier chargement
env:
  DEMO_MODE: "true"                # variables exigées par les initializers
```

Sur un diagnostic bloquant (base MySQL non supportée, série de Ruby inconnue,
dossier qui n'est pas une application Rails), le build s'arrête et affiche un
**rapport d'incompatibilité avec un remède par point**. Les valeurs `env:`
d'un `railsbox.yml` sont traitées comme des données inertes, jamais évaluées
au build (voir [`SECURITY.md`](SECURITY.md)).

`make-snapshot.mjs` boote l'image **sous Node**, attend que l'application
réponde, capture l'état mémoire et l'écrit en gzip. C'est ce qui évite à
l'utilisateur final le boot à froid de treize minutes.

> **En cours (ADR 0002)** : le découpage rootfs de base / disque applicatif.
> Un rootfs générique par version de Ruby (mutualisé, mis en cache une fois
> pour toutes les sandboxes) et un petit disque applicatif par app font tomber
> la capture d'instantané de ~12 min à ~2–3 min et le poids par sandbox de
> ~4 Go à ~150–350 Mo. Le runtime le supporte déjà (`public/shared/v86-config.js`) ;
> la recette de build est en construction.

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
  l'option Tailscale, non câblée ici. C'est aussi une propriété du modèle de
  démonstration — voir [`SECURITY.md`](SECURITY.md).
- **Généricité** : le runtime est agnostique et la recette de build l'est
  désormais aussi (auto-détection + `railsbox.yml`), validée sur un
  `rails new` sqlite3 en plus de jiyufit. Le panel de validation reste à
  élargir (PostgreSQL générique, apps à npm) avant d'annoncer « toute app ».
- **Licence CheerpX** : usage commercial soumis à licence Leaning Technologies.
  Le moteur v86 (BSD-2-Clause) porte seul la promesse du projet ; CheerpX sera
  rétrogradé en démonstration optionnelle ou retiré.
- **Sécurité** : tout s'exécute côté client. Le modèle de menace — ce qui est
  défendu, ce qui ne l'est pas, et pourquoi il ne faut jamais embarquer de
  vrais secrets — est décrit dans [`SECURITY.md`](SECURITY.md).

## Arborescence

```
serve.mjs                          serveur de dev : COOP/COEP, Range, gzip, cache
public/
├── index.html · main.js           page hôte : orchestration, badges, CSP, sandbox
├── sw-proxy.js                    SW unique : proxy /app/*, assets statiques, COI
├── env-drawer.js · .css           inspecteur d'environnement (secrets session-only)
├── shared/
│   ├── request-codec.js           validation HTTP (frontière de sécurité)
│   ├── serial-codec.js            trames @RIB1, contrôle de flux montant
│   ├── proxy-logic.js             logique pure du SW (réécriture, CSP, assets)
│   ├── env-detector.js            détection des variables manquantes
│   └── v86-config.js              config v86 : mono-disque ou base + application
└── vm/
    ├── v86-vm.js                  boot v86, instantané, horloge, pont série
    └── rails-vm.js · vm-scripts.js  backend CheerpX
tests/                             150 tests unitaires + intégration (VM réelle) + E2E
├── integration/                   protocole série contre une vraie VM v86 (Node)
└── e2e/                           boot navigateur complet (Playwright)
tools/
├── detect/                        auto-détection d'une app Rails → manifeste
├── build-v86-image/               Dockerfile paramétré, build.sh, make-snapshot,
│                                  manifest-to-args, validate-boot, env/
├── vm-harness.mjs                 boot d'une VM v86 sous Node (piloté par config)
├── extract-assets.sh             extraction des assets de l'image (debugfs)
├── demo-app/                      application `rails new` de validation
└── bench-serial.mjs               mesure du coût du chemin chaud série
docs/decisions/                    ADR : distribution des artefacts, découpage base/app
SECURITY.md · CONTRIBUTING.md      modèle de menace · conventions
```
