# Développer et exploiter railsbox

Faire tourner la coquille en local, republier une base, construire à la main, et se repérer dans l'arborescence.

*Retour au [README](../README.md).*

---

## Tester en local

```bash
npm install
npm start                 # http://localhost:8080 — COOP/COEP, Range et gzip inclus
npm test                  # tests unitaires (node --test, sans réseau ni artefacts)
npm run check             # lint + format + typecheck + tests — la porte de la CI
npm run test:integration  # protocole complet contre une VRAIE VM v86 sous Node
                          # (exige public/disks/ ; ~1 min grâce à l'instantané)
```

| URL | Ce qui tourne |
| --- | --- |
| `http://localhost:8080` | votre application Rails, restaurée depuis l'instantané |
| `http://localhost:8080/?fresh=1` | idem, en ignorant l'instantané (boot à froid) |

La page hôte lit `public/disks/v86-config.json` : sans artefacts construits, elle
le dit et s'arrête là.

Après un build d'image, extrayez les assets précompilés pour qu'ils soient servis
statiquement au lieu de traverser le pont série (levier de performance n°1) :

```bash
wsl -e sh tools/extract-assets.sh   # → public/disks/assets/ + appstatic/
```

### Quatre niveaux de tests hors ligne, tous requis avant un commit

| Commande | Portée | Dépendances |
| --- | --- | --- |
| `npm test` | modules purs (codecs, détecteur, buildpack, config) | aucune |
| `npm run test:integration` | protocole série complet contre une **vraie VM v86** sous Node — POST de 1 Mo, ENV/RST, montage base + application | `public/disks/` |
| `npm run test:e2e` | boot navigateur complet dans Chromium (Playwright) : page hôte, isolation, application rendue dans l'iframe, navigation | Chromium ; VM `public/disks/` |
| `npm run test:securite` | les épreuves de **frontière** rejouées sur chromium, firefox et webkit — ces défenses reposent sur des différences entre moteurs | les trois moteurs Playwright |

`npm run check` enchaîne lint (ESLint), format (Prettier), typecheck
(`tsc --checkJs` sur quatre cibles : navigateur, Service Worker, Node, et le
périmètre `strict` des modules de sécurité — `tsconfig.strict.json`) et tests
unitaires — c'est exactement ce que joue la CI
([`ci.yml`](.github/workflows/ci.yml)).

Le **panel de variantes** couvre ce qu'une application seule ne peut pas :
`demo` (sqlite3, assets dans le guest), `demo-pg` (cluster PostgreSQL embarqué),
`demo-tailwind` et `demo-dartsass` (assets sur un étage amd64, par deux gems aux
contraintes différentes). `npm test` en fige les
manifestes d'auto-détection ; le workflow
[`valider-variantes.yml`](.github/workflows/valider-variantes.yml) rejoue la
chaîne entière — surcouche, disque applicatif, instantané, boot d'une VM
réelle — à la demande et chaque mercredi, sans rien publier. Il vérifie en plus
le classement de deux applications open source réelles (rubygems.org, mastodon),
clonées en superficiel : ces tests-là s'ignorent hors CI, `npm test` ne devant
dépendre ni du réseau ni de GitHub.

### Vérifier une sandbox publiée

Les trois niveaux ci-dessus testent le **code**. Un quatrième teste le **produit
fini**, à son URL réelle :

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
externe** n'est contactée, et qu'aucune requête d'artefact ne porte d'en-tête non
safelisté ni ne déclenche de préflight OPTIONS (point de vigilance de
l'[ADR 0001](docs/decisions/0001-distribution-artefacts.md) : GitHub Pages répond
405 aux préflights).

Elle **écrit** aussi : un billet est créé par le formulaire du scaffold, jeton
CSRF compris. Ce scénario-là a été ajouté après coup, et il n'est pas
décoratif — la recette a été verte à huit vérifications sur huit pendant que la
démonstration était incapable d'enregistrer quoi que ce soit (voir « Un Service
Worker ne peut pas poser de cookie »). Une suite qui ne fait que lire valide une
sandbox à moitié morte.

Elle dépend du réseau et d'un déploiement : elle est donc **hors de `npm test` et
de la CI**. Le workflow
[`verifier-sandbox.yml`](.github/workflows/verifier-sandbox.yml) la joue à la
demande — utile juste après une publication — et chaque lundi, parce qu'une
démonstration en ligne peut casser sans qu'un seul commit l'ait touchée.

---

# Sous le capot

*Tout ce qui suit sert à comprendre ou à contribuer, pas à publier une sandbox.*

## Republier la base

La base est un artefact **immuable et versionné**
([ADR 0004](docs/decisions/0004-topologie-de-distribution.md)) : on n'écrase
jamais une version que des sandboxes épinglent peut-être. Toute modification de
son contenu — paquet ajouté, script d'init retouché — donne une **révision**
nouvelle, nommée `<série Ruby>-r<N>` (`3.3` vaut r1, la révision PostgreSQL est
`3.3-r2`).

1. Lancer le workflow **Publier la base** (`workflow_dispatch`) avec
   `tag: 3.3-r2`, `ruby: 3.3.12`, `push: true`. Il construit l'image i386, la
   vérifie (architecture déclarée, contenu attendu, absence de cluster dans le
   rootfs, cycle de vie complet du cluster), pousse sur GHCR, puis publie rootfs
   découpé, noyau, initrd et instantané de base dans un répertoire `base-3.3-r2/`
   du dépôt d'artefacts — **à côté** des versions précédentes.
2. Vérifier le récapitulatif du workflow : les URL publiées y figurent.
3. Basculer les sandboxes qui en ont besoin sur `base: "3.3-r2"`. Celles qui
   restent sur `3.3` continuent de fonctionner à l'identique.

## Construire à la main (voie monolithique héritée)

Antérieure au découpage base/application, cette voie produit une image unique.
Elle n'a plus d'exclusivité : PostgreSQL, Tailwind, dart-sass et les chaînes npm
sont désormais couverts des deux côtés.

Le découpage rootfs de base / disque applicatif
([ADR 0002](docs/decisions/0002-decoupage-base-application.md)) est ce qui fait
tomber la capture d'instantané de ~12 min à ~2–3 min, et le poids par sandbox de
~4 Go à ~150–350 Mo : un rootfs générique par version de Ruby, mutualisé et mis
en cache une fois pour toutes les sandboxes, plus un petit disque applicatif par
application. C'est la voie qu'emprunte `construire-sandbox.yml`.

La voie monolithique reste **pilotée par auto-détection** : `build.sh` inspecte
l'application (version de Ruby via `.ruby-version`/Gemfile, adaptateur de base
via `config/database.yml`, chaîne d'assets via `package.json`, gems natives à
bibliothèques système, services) et en déduit les arguments du Dockerfile
paramétré. Sous **WSL2 ou Linux, en root** (Docker et `e2fsprogs` requis) :

```bash
wsl -u root -e bash tools/build-v86-image/build.sh /chemin/vers/votre-app
node tools/build-v86-image/make-snapshot.mjs   # capture l'instantané mémoire
```

Le Dockerfile reste en deux étages — assets précompilés en x86_64 (tailwind,
esbuild et dartsass n'ont pas de binaire i386, et un étage vide est sélectionné
quand rien ne l'exige), rootfs i386 avec Ruby, base préparée, noyau extrait pour
un démarrage direct. Tous les pièges i386 (voir « Retour d'expérience ») sont
préservés ; l'étage d'installation des paquets est ordonné pour partager le cache
entre images.

`make-snapshot.mjs` boote l'image **sous Node**, attend que l'application
réponde, capture l'état mémoire et l'écrit en gzip. C'est ce qui évite à
l'utilisateur final le boot à froid de treize minutes.

## Arborescence

```
serve.mjs                          serveur de dev : COOP/COEP, Range, gzip, cache
public/
├── index.html · main.js           page hôte : orchestration, badges, CSP, sandbox
├── sw-proxy.js                    SW unique : proxy /app/*, bocal à cookies,
│                                  assets statiques, COI, cache des artefacts
├── env-drawer.js · .css           inspecteur d'environnement (secrets session-only)
├── shared/
│   ├── request-codec.js           validation HTTP (frontière de sécurité)
│   ├── serial-codec.js            trames @RIB1, contrôle de flux montant
│   ├── proxy-logic.js             logique pure du SW (réécriture, CSP, assets)
│   ├── artifact-cache.js          logique pure du cache (URL cacheables, nom, purge)
│   ├── cookie-jar.js              magasin de cookies du proxy (un SW ne peut pas
│   │                              faire poser de cookie : sans lui, pas de session)
│   ├── prerequis-demarrage.js     capacités du navigateur, reprise après rechargement
│   ├── veille.js                  suspension de la VM quand l'onglet est masqué
│   ├── election-onglet.js         verrou Web Locks : une seule VM par navigateur
│   ├── env-detector.js            détection des variables manquantes
│   └── v86-config.js              config v86 : mono-disque ou base + application
└── vm/
    └── v86-vm.js                  boot v86, instantané, horloge, pont série
tests/                             408 tests unitaires + intégration (VM réelle) + E2E
├── integration/                   protocole série contre une vraie VM v86 (Node)
├── e2e/                           boot navigateur complet (Playwright)
├── live/                          recette de la sandbox PUBLIÉE (réseau, hors CI)
└── bridage/                       boot sous processeur bridé (CDP, hors CI)
tools/
├── detect/                        auto-détection d'une app Rails → manifeste
│                                  (dont assets.mjs : étage de précompilation)
├── build-v86-image/               Dockerfile paramétré, build.sh, make-snapshot,
│                                  manifest-to-args, validate-boot, env/,
│                                  assets-amd64.Dockerfile (étage d'assets),
│                                  classifier-echec.mjs (diagnostic des pannes),
│                                  base/ (rootfs mutualisé + disque applicatif)
├── vm-harness.mjs                 boot d'une VM v86 sous Node (piloté par config)
├── extract-assets.sh              extraction des assets de l'image (debugfs)
├── demo-app/                      application `rails new` de validation (demo/)
│                                  + surcouches PostgreSQL (demo-pg/) et
│                                  Tailwind (demo-tailwind/)
└── bench-serial.mjs               mesure du coût du chemin chaud série
docs/
├── architecture.md                carte du code : trajet d'une requête, par où lire
├── chantiers.md                   chantiers ouverts, avec critère de réussite
└── decisions/                     ADR : distribution des artefacts, découpage base/app
SECURITY.md · CONTRIBUTING.md      modèle de menace · conventions
```
