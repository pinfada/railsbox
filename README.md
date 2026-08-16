# railsbox

[![Try with railsbox](https://pinfada.github.io/railsbox-demo/badge.svg)](https://pinfada.github.io/railsbox-demo/)

**Une application Rails complète, non modifiée, qui tourne entièrement dans le
navigateur.** Pas de serveur applicatif, pas de conteneur distant : Puma,
PostgreSQL, Redis et les gems C natives s'exécutent dans une VM Linux x86
émulée en WebAssembly, à l'intérieur de l'onglet.

Validé sur une vraie application de production — [jiyufit](https://github.com/pinfada)
(Rails 7.2.3, Ruby 3.3.10, PostgreSQL 15, Redis, Sidekiq, Devise, Stripe,
70 initializers) — qui rend ses pages, suit ses liens et traite ses POST — et
sur une application `rails new` de démonstration (sqlite3 + importmap),
construite, publiée et bootée automatiquement — **[essayez-la](https://pinfada.github.io/railsbox-demo/)**.

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
[`docs/decisions/`](docs/decisions/).

**Où en est-on** : la chaîne complète fonctionne et se voit —
[une démonstration est en ligne](https://pinfada.github.io/railsbox-demo/),
publiée par le workflow réutilisable, servie gratuitement. Ce qui manque au
badge n'est plus technique : ouvrir ce dépôt, sans quoi aucun mainteneur tiers
ne peut référencer le workflow.

### Les dépôts

| Dépôt | Rôle |
|---|---|
| **railsbox** (celui-ci) | le buildpack, la coquille, les workflows |
| [**railsbox-assets**](https://github.com/pinfada/railsbox-assets) | hébergement statique des rootfs de base, versionnés et immuables |
| [**railsbox-demo**](https://github.com/pinfada/railsbox-demo) | l'application de démonstration et sa sandbox publiée |

Une **origine par démonstration** : chaque sandbox vit sur le domaine de son
propre dépôt, si bien que l'isolation entre démonstrations est celle du
navigateur et non une promesse de notre part (voir
[ADR 0004](docs/decisions/0004-topologie-de-distribution.md)).

## 1. Démo

**→ [pinfada.github.io/railsbox-demo](https://pinfada.github.io/railsbox-demo/)**

Une application Rails `rails new` — scaffold Posts, SQLite, importmap, Turbo,
Stimulus — peuplée de données de démonstration, servie par un GitHub Pages
gratuit. Aucun serveur applicatif n'existe : Puma tourne dans votre onglet.

| Ce que fait le visiteur | Mesuré |
|---|---|
| Application affichée | **25 s** (instantané restauré) |
| Téléchargé pour cela | ~32 Mo depuis le dépôt d'artefacts + l'instantané gzippé |
| Navigation, formulaires, POST | normaux, servis par la VM |

Le rootfs mutualisé de 1,45 Go n'est jamais téléchargé en entier : v86 en lit
les morceaux qu'il touche, une trentaine sur 363. Et il ne les lit qu'une
fois : le Service Worker les garde en Cache Storage, si bien qu'un visiteur
qui revient ne retélécharge rien (voir « Le cache des artefacts » plus bas).

**Ce que l'hébergeur doit fournir** — et GitHub Pages le fournit : CORS `*`,
requêtes `Range`, et rien d'autre. Les en-têtes d'isolation `COOP`/`COEP`,
qu'un hébergement statique ne pose pas, sont réinjectés par le Service Worker.

Navigateurs : validé sur Chromium. Les webviews qui bloquent les Service
Workers ne peuvent pas fonctionner, par construction.

## 2. Guide d'utilisation

### Publier la sandbox de votre application

C'est la voie principale, et elle tient en un fichier. Dans votre dépôt Rails,
`.github/workflows/sandbox.yml` :

```yaml
name: Sandbox railsbox
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
```

Activez ensuite GitHub Pages sur la branche `gh-pages`. Chaque construction
publie votre démonstration sur `https://<compte>.github.io/<depot>/`.

### Le badge

Chaque sandbox sert son propre badge, à côté d'elle :

```markdown
[![Try with railsbox](https://<compte>.github.io/<depot>/badge.svg)](https://<compte>.github.io/<depot>/)
```

Le workflow l'imprime tout prêt, avec vos URL, dans le résumé de chaque
construction. Le badge est servi par votre sandbox et non par un générateur
tiers : rien à maintenir, rien qui puisse tomber sans que votre démonstration
tombe aussi.

> **Le clic ouvre l'onglet courant.** GitHub retire `target="_blank"` des
> README, quelle que soit la syntaxe employée — vérifié sur son API de rendu.
> Aucun badge de l'écosystème n'y échappe. Vos lecteurs gardent le clic-milieu.

Ce que fait le workflow, en ~9 minutes : il réassemble le rootfs mutualisé
depuis le dépôt d'artefacts, construit le disque de votre application depuis
l'image de base, capture un instantané mémoire post-démarrage, découpe le tout
en morceaux compressés et publie la coquille avec. Votre dépôt héberge environ
130 Mo ; le rootfs de 1,45 Go reste chez railsbox.

Entrées utiles : `app-path` si l'application n'est pas à la racine, `seed` pour
forcer une commande d'amorçage, `base` pour épingler une version de base,
`target-repo` pour publier ailleurs que dans le dépôt applicatif.

**Tailwind, dart-sass et les chaînes npm** n'ont rien à déclarer : la détection
les repère et bascule seule la précompilation sur un **étage amd64** (voir
« Où sont précompilés les assets » plus bas). Le résumé de la construction
affiche l'étage retenu.

> **Prérequis actuel** : `railsbox` est un dépôt privé, ce qui empêche un dépôt
> tiers de référencer ce workflow. Cette voie ne sera ouverte qu'avec le dépôt.

### Déclarer ce que la détection ne devine pas

Un fichier **`railsbox.yml`** à la racine complète ou corrige l'auto-détection :

```yaml
ruby: 3.3.12
database: sqlite3
seed:
  command: "bin/rails db:seed"
  auto_login: "demo@example.com"   # le visiteur arrive connecté
env:
  APP_HOST: "http://localhost:8080"
```

`auto_login` accepte un identifiant — résolu strictement, sans repli
silencieux — ou `true` pour le premier utilisateur. Pour une authentification
exotique, `auto_login_code` reçoit un fragment Ruby avec `env` dans sa portée.

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

Trois niveaux de tests hors ligne, tous requis avant un commit :

| Commande | Portée | Dépendances |
|---|---|---|
| `npm test` | modules purs (codecs, détecteur, buildpack, config) | aucune |
| `npm run test:integration` | protocole série complet contre une **vraie VM v86** sous Node — POST de 1 Mo, ENV/RST, montage base + application | `public/disks/` |
| `npm run test:e2e` | boot navigateur complet dans Chromium (Playwright) : page hôte, isolation, application rendue dans l'iframe, navigation | Chromium ; VM `public/disks/` |

`npm run check` enchaîne lint (ESLint), format (Prettier), typecheck
(`tsc --checkJs` sur trois cibles : navigateur, Service Worker, Node) et tests
unitaires — c'est exactement ce que joue la CI (`.github/workflows/ci.yml`).

### Vérifier une sandbox publiée

Les trois niveaux ci-dessus testent le **code**. Un quatrième teste le
**produit fini**, à son URL réelle :

```bash
npm run test:live                                   # la démonstration de référence
RAILSBOX_SANDBOX_URL=https://compte.github.io/depot/ npm run test:live
```

Cette recette ouvre la sandbox publiée dans Chromium, attend que la VM boote
(25–80 s), charge une page du scaffold à travers le proxy, et surveille tout le
trafic réseau. Elle vérifie que la coquille ne référence **que des chemins
relatifs** (un Pages de projet sert sous `/<depot>/` : une seule référence
absolue et plus rien ne charge — le défaut s'est produit quatre fois, toujours
invisible en local), qu'aucune requête ne finit en 404, qu'**aucune origine
externe** n'est contactée, et qu'aucune requête d'artefact ne porte d'en-tête
non safelisté ni ne déclenche de préflight OPTIONS (point de vigilance de
l'[ADR 0001](docs/decisions/0001-distribution-artefacts.md) : GitHub Pages
répond 405 aux préflights).

Elle dépend du réseau et d'un déploiement : elle est donc **hors de `npm test`
et de la CI**. Le workflow
[`verifier-sandbox.yml`](.github/workflows/verifier-sandbox.yml) la joue à la
demande — utile juste après une publication — et chaque lundi, parce qu'une
démonstration en ligne peut casser sans qu'un seul commit l'ait touchée.

La page hôte lit `public/disks/v86-config.json` : sans artefacts construits,
elle le dit et s'arrête là.

| URL | Ce qui tourne |
|---|---|
| `http://localhost:8080` | votre application Rails, restaurée depuis l'instantané |
| `http://localhost:8080/?fresh=1` | idem, en ignorant l'instantané (boot à froid) |

### Où sont précompilés les assets

Le guest est un **i386**, et deux familles d'outils d'assets ne publient aucun
binaire pour cette architecture : les gems à exécutable précompilé
(`tailwindcss-ruby` dont dépend tailwindcss-rails, `dartsass-ruby`) et les
chaînes npm (esbuild, sass). Elles produisent pourtant du CSS et du JS
**ordinaires**, indépendants de l'architecture — on les exécute donc sur un
**étage amd64**, et le disque i386 ne reçoit que `public/assets`. Le guest
n'exécute jamais ces binaires.

L'auto-détection classe seule chaque application :

| Ce qu'elle trouve | Étage retenu | Ce qui tourne |
|---|---|---|
| propshaft/sprockets + importmap | `i386` | `assets:precompile` dans le disque applicatif |
| tailwindcss-rails, dartsass-rails | `amd64` | `assets:precompile` sur l'hôte, copie de `public/assets` |
| `package.json` (jsbundling/cssbundling) | `amd64` | `npm ci` + scripts de build, puis `assets:precompile` |
| aucun pipeline | `aucun` | rien |

L'étage amd64 pose exactement le même `RAILS_RELATIVE_URL_ROOT` que le disque
applicatif : les URL figées dans le CSS portent le préfixe **public complet**
(`/depot/app/assets/…`), sous le site et non à la racine du domaine — sans quoi
le Service Worker ne pourrait même pas les rattraper.

Deux points d'attention plutôt qu'un refus : sans `package-lock.json` (ou avec
un verrou yarn/pnpm/bun, que railsbox ne relit pas), l'installation retombe sur
`npm install` et la construction n'est plus reproductible — c'est un
avertissement du rapport d'analyse. Et si l'étage amd64 ne produit **aucun**
asset, la construction s'arrête là : une application sans CSS est une panne que
le visiteur découvrirait à l'affichage de la page.

### Construire à la main (voie monolithique héritée)

Antérieure au découpage base/application, cette voie produit une image unique
et reste la seule à couvrir PostgreSQL — son Dockerfile précompile les assets
sur le même étage amd64.

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
sélectionné quand rien ne l'exige), rootfs i386 avec Ruby,
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

### Le cache des artefacts

GitHub Pages plafonne ses réponses à `Cache-Control: max-age=600` et ne se
configure pas. Or nos artefacts sont **immuables par construction** : une base
publiée n'est jamais réécrite ([ADR 0004](docs/decisions/0004-topologie-de-distribution.md)),
et un fichier-partie est une tranche figée d'un disque figé
([ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)). Sans rien
faire, un visiteur qui revient le lendemain retélécharge donc les ~48 Mo qu'il
avait déjà lus.

Le Service Worker interceptant déjà tout, il tient un **cache applicatif en
Cache Storage**, en stratégie « cache d'abord » :

| Point | Choix |
|---|---|
| Ce qui est mis en cache | les fichiers-parties des disques découpés, le noyau, l'initrd — **et rien d'autre que ce qui est nommé dans la configuration v86** |
| Ce qui ne l'est pas | l'instantané mémoire, déjà mis en cache par la page dans IndexedDB ; un disque lu par requêtes `Range`, dont les réponses 206 sont refusées par Cache Storage ; toute requête portant un en-tête `Range` |
| Nom du cache | dérivé de la configuration entière, `builtAt` compris. L'URL du disque applicatif étant stable d'une construction à l'autre, un cache indexé par la seule URL panacherait les morceaux de deux images après une reconstruction — c'est-à-dire corromprait le système de fichiers. Un changement de configuration bascule sur un cache neuf et supprime l'ancien. |
| En-têtes | **aucun n'est ajouté.** Les requêtes vers Pages doivent rester « simples » au sens CORS, sous peine d'un préflight que l'hébergeur ne sait pas honorer ([ADR 0001](docs/decisions/0001-distribution-artefacts.md)). La requête est réémise telle quelle, la réponse rendue telle quelle. |
| Quota | `StorageManager.estimate` avant écriture, marge de 10 % ; un échec d'écriture est journalisé une fois et sans effet — **la requête aboutit toujours**, avec ou sans cache. |

La décision (quelles URL, quel nom de cache, quelle invalidation) est isolée
dans `public/shared/artifact-cache.js`, testée sans navigateur. Le fait qu'un
rechargement ne redemande rien au réseau, lui, est vérifié dans un vrai
Chromium (`tests/e2e/artifact-cache.e2e.spec.mjs`) : le fichier est supprimé
du serveur entre les deux lectures, et la seconde réussit quand même.

Ce que ce cache ne change pas : il vit dans l'origine de la démonstration,
donc **deux démonstrations ne le partagent toujours pas** — c'est le coût
assumé de la topologie « une origine par démonstration ». Il économise les
visites répétées d'un même visiteur sur une même sandbox, pas la première.

## 4. Retour d'expérience : les défis résolus

Vingt-deux itérations de build ont été nécessaires. Les obstacles n'étaient
presque jamais où on les attend — voici ceux qui ont coûté le plus cher.

### Le loopback TCP n'existait pas sous le moteur historique

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

Ce qui est **validé de bout en bout** : `rails new` avec SQLite, Propshaft et
importmap, publié et bootant en ligne. Le reste, honnêtement :

| Limite | État |
|---|---|
| **PostgreSQL** | refusé par la construction. Le crochet existe dans `guest-init.sh` (le cluster ne démarrerait qu'après montage du disque applicatif) mais n'est pas branché. SQLite est la voie nominale. |
| **Tailwind, dart-sass** | **pris en charge** : précompilés sur un étage amd64, puis copiés dans le disque i386 (le guest n'exécute jamais ces binaires). Validé sur l'étage lui-même ; un boot de bout en bout reste à faire en CI. |
| **Chaînes npm** (esbuild, cssbundling) | **pris en charge** par le même étage (`npm ci` puis scripts de build). Un verrou yarn/pnpm/bun n'est pas relu : repli sur `npm install`, signalé. |
| **ActionCable / WebSockets** | hors périmètre : incompatibles avec un pont requête/réponse. Piste : long-polling ou flux dédié. |
| **Réseau sortant** | inexistant. C'est aussi une propriété du modèle de démonstration — voir [`SECURITY.md`](SECURITY.md). |
| **Débit du pont** | tuyau étroit et partagé, suffisant pour du Turbo/HTML. Les assets précompilés ne l'empruntent pas : extraits de l'image, ils sont servis statiquement par le Service Worker. |
| **Persistance** | aucune, par conception. Chaque visiteur écrit dans sa copie, qui disparaît avec l'onglet. |

**Sécurité** : tout s'exécute côté client. Ce qui est défendu, ce qui ne l'est
pas, et pourquoi il ne faut jamais embarquer de vrais secrets :
[`SECURITY.md`](SECURITY.md).

## Arborescence

```
serve.mjs                          serveur de dev : COOP/COEP, Range, gzip, cache
public/
├── index.html · main.js           page hôte : orchestration, badges, CSP, sandbox
├── sw-proxy.js                    SW unique : proxy /app/*, assets statiques, COI,
│                                  cache des artefacts immuables
├── env-drawer.js · .css           inspecteur d'environnement (secrets session-only)
├── shared/
│   ├── request-codec.js           validation HTTP (frontière de sécurité)
│   ├── serial-codec.js            trames @RIB1, contrôle de flux montant
│   ├── proxy-logic.js             logique pure du SW (réécriture, CSP, assets)
│   ├── artifact-cache.js          logique pure du cache (URL cacheables, nom, purge)
│   ├── env-detector.js            détection des variables manquantes
│   └── v86-config.js              config v86 : mono-disque ou base + application
└── vm/
    └── v86-vm.js                  boot v86, instantané, horloge, pont série
tests/                             200 tests unitaires + intégration (VM réelle) + E2E
├── integration/                   protocole série contre une vraie VM v86 (Node)
├── e2e/                           boot navigateur complet (Playwright)
└── live/                          recette de la sandbox PUBLIÉE (réseau, hors CI)
tools/
├── detect/                        auto-détection d'une app Rails → manifeste
│                                  (dont assets.mjs : étage de précompilation)
├── build-v86-image/               Dockerfile paramétré, build.sh, make-snapshot,
│                                  manifest-to-args, validate-boot, env/,
│                                  assets-amd64.Dockerfile (étage d'assets),
│                                  base/ (rootfs mutualisé + disque applicatif)
├── vm-harness.mjs                 boot d'une VM v86 sous Node (piloté par config)
├── extract-assets.sh             extraction des assets de l'image (debugfs)
├── demo-app/                      application `rails new` de validation
└── bench-serial.mjs               mesure du coût du chemin chaud série
docs/decisions/                    ADR : distribution des artefacts, découpage base/app
SECURITY.md · CONTRIBUTING.md      modèle de menace · conventions
```
