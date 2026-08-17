# railsbox

*English version → [README.en.md](README.en.md)*

[![Try with railsbox](https://pinfada.github.io/railsbox-demo/badge.svg)](https://pinfada.github.io/railsbox-demo/)

**railsbox transforme une application Rails en démonstration jouable dans le
navigateur.** Vous collez un workflow GitHub Actions dans votre dépôt, vous
obtenez une URL publique où Puma, la base de données et vos gems C natives
tournent dans une VM Linux x86 émulée — sans serveur, sans conteneur, sans
facture.

**Voir tout de suite → [pinfada.github.io/railsbox-demo](https://pinfada.github.io/railsbox-demo/)**

---

## Démarrer en 5 minutes

### 1. Ajoutez le workflow

Dans votre dépôt Rails, créez `.github/workflows/sandbox.yml` :

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

Le dépôt railsbox est public : n'importe quel dépôt peut référencer ce workflow
directement. Épinglez un tag ou un SHA à la place de `@main` si vous préférez
figer la version.

### 2. Activez GitHub Pages sur la branche `gh-pages`

Poussez d'abord sur `main` : c'est la première construction qui **crée** la
branche `gh-pages` — avant elle, GitHub ne vous la proposera pas.

*Settings → Pages → Source : Deploy from a branch → `gh-pages` / `(root)`.*
Chaque construction republie votre démonstration sur
`https://<compte>.github.io/<depot>/`.

> **`gh-pages` est entièrement remplacée à chaque construction** (force-push,
> historique remis à plat : la sandbox est régénérée, conserver l'historique
> n'empilerait que des binaires morts). Si vous y publiez déjà autre chose —
> doc YARD, site du projet — **publiez la sandbox ailleurs** avec l'entrée
> `target-repo` (voir « Entrées du workflow »).

### 3. Collez le badge

```markdown
[![Try with railsbox](https://<compte>.github.io/<depot>/badge.svg)](https://<compte>.github.io/<depot>/)
```

Le workflow imprime ce badge tout prêt, avec vos URL, dans le résumé de chaque
construction. Il est servi par votre propre sandbox et non par un générateur
tiers : rien à maintenir, rien qui puisse tomber sans que votre démonstration
tombe aussi.

> **Le clic ouvre l'onglet courant.** GitHub retire `target="_blank"` des
> README, quelle que soit la syntaxe employée — vérifié sur son API de rendu.
> Aucun badge de l'écosystème n'y échappe. Vos lecteurs gardent le clic-milieu.

> **Dépôt public, ou dépôt vitrine séparé.** Sur un dépôt public, tout est
> gratuit : Actions et Pages le sont. Sur un **dépôt privé**, GitHub Pages exige
> un plan payant et les minutes Actions sont facturées. Le cas est prévu :
> gardez le code en privé et publiez la sandbox dans un dépôt public dédié avec
> `target-repo` + le secret `publish-key` (voir « Entrées du workflow »).

### Ce que fait le workflow, en ~9 minutes

Il réassemble le rootfs mutualisé depuis le dépôt d'artefacts railsbox,
construit le disque de votre application depuis l'image de base, exécute vos
seeds, capture un instantané mémoire post-démarrage, découpe le tout en
morceaux compressés et publie la coquille avec. **Votre dépôt héberge environ
130 Mo** pour l'application de démonstration — comptez ~150–350 Mo selon la
vôtre ; le rootfs de 1,45 Go reste chez railsbox.

Tailwind, dart-sass et les chaînes npm n'ont rien à déclarer : la détection les
repère et bascule seule la précompilation sur un étage amd64. Le résumé de la
construction affiche l'étage retenu, la version de Ruby et la base détectée.

### Ce que verront vos visiteurs

| Ce que fait le visiteur | Mesuré |
| --- | --- |
| Application affichée | **~20–25 s** (instantané restauré) |
| Téléchargé pour cela | ~32 Mo depuis le dépôt d'artefacts + l'instantané gzippé |
| Navigation, formulaires, POST | normaux, servis par la VM |

Le rootfs mutualisé de 1,45 Go n'est jamais téléchargé en entier : v86 en lit
les morceaux qu'il touche, une trentaine sur 363. Et il ne les lit qu'une fois :
le Service Worker les garde en Cache Storage, si bien qu'un visiteur qui revient
ne retélécharge rien (voir « [Le cache des artefacts](#le-cache-des-artefacts) »).

**Navigateurs** — mesuré par la recette `npm run test:live` (voir
« [Vérifier une sandbox publiée](#vérifier-une-sandbox-publiée) ») sur la
démonstration publiée et sur une réplique locale de la publication :

| Moteur | Coquille | Service Worker | Isolation COI | Boot VM | Application servie | Cache d'artefacts |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 151 | ok | ok | ok | 18–24 s | ok | ok |
| Firefox 153 | ok | ok | ok | 21 s | ok | ok |
| WebKit 26.5 | ok | ok | ok | 20 s | ok | ok |

Seule différence mesurée : la première requête traversant le pont série coûte
environ 6 s sous Firefox, contre 1 s ailleurs.

**Mobile** : la coquille est adaptée aux téléphones — mise en page vérifiée à
320, 390 et 393 px (`tests/e2e/coquille-mobile.e2e.spec.mjs`). Le processeur,
lui, est maintenant mesuré pour de bon. L'émulation mobile de Playwright ne
change que la fenêtre et l'agent utilisateur ; `npm run test:bridage`
(`tests/bridage/`) ralentit **réellement** le fil d'exécution du navigateur par
Chrome DevTools Protocol et rejoue le démarrage de la sandbox publiée à chaque
taux. Deux boots par taux, contexte neuf à chaque fois :

| Bridage processeur | Application annoncée | Application **visible** | 1re page du scaffold | Page suivante |
| --- | --- | --- | --- | --- |
| 1× — poste de bureau | 23,7 / 24,4 s | 24,7 / 25,5 s | 1,3 s | 0,3 s |
| 4× — téléphone milieu de gamme | 26,8 / 26,8 s | 30,4 / 31,2 s | 7,2 / 7,7 s | 1,6 / 2,2 s |
| 6× — entrée de gamme | 31,7 / 31,8 s | 39,0 / 39,4 s | 13,5 / 13,9 s | 3,1 / 4,4 s |
| 8× — vieil appareil | 37,1 / 39,6 s | 49,7 / 54,0 s | 24,2 / 25,8 s | 5,3 / 8,0 s |

**Le démarrage ne casse pas, il s'allonge** : jamais d'échec, toujours deux
sondes internes, et la sonde la plus lente (1,3 s) reste huit fois sous le délai
que la coquille lui accorde. Sa croissance (+60 % de 1× à 8×) ne vient d'ailleurs
presque pas de l'émulation — l'instantané a déjà fait ce travail, et la phase
« VM prête → application prête » ne bouge que de 14,9 à 17,1 s — mais du chemin
de chargement, décompression et mise en cache de l'instantané comprises, qui
s'exécute lui aussi sur le fil bridé.

**Ce qui se dégrade vraiment, c'est l'usage.** Chaque page servie traverse Rails
puis le pont série, tous deux sur le processeur de l'onglet : la première page du
scaffold passe de 1,3 s à 25 s, et les suivantes de 0,3 s à 5–8 s — soit un peu
plus que proportionnel au bridage. Le seuil pratique est donc **entre 6× et 8×** :
à 4× la sandbox reste confortable, à 6× elle est lente mais utilisable, à 8× il
faut compter une minute avant de voir l'application et une poignée de secondes
par clic — de quoi montrer une application, pas y travailler. C'est aussi
pourquoi la coquille affiche désormais l'étape de démarrage en cours et le temps
écoulé, jusqu'à la première page **rendue** : la dernière attente (1 s à 1×, mais
12 à 15 s à 8×) se déroulait sous une rangée de badges déjà tous verts, sans rien
qui distingue « ça arrive » de « c'est bloqué ».

**Ce qui reste hors de portée** : un **vrai** téléphone, physique. Le bridage CDP
ralentit le fil d'exécution ; il ne reproduit ni un cache processeur plus petit,
ni la mémoire d'un onglet mobile — bien plus vite arbitrée par le système — ni la
limitation thermique après quelques minutes d'émulation continue. Comptez le
mobile comme mesuré et praticable, pas comme garanti. Les recettes jouent
Chromium par défaut ; `RAILSBOX_MOTEURS=tous` (ou une liste : `firefox,webkit`)
élargit `npm run test:live` et `npm run test:e2e` aux trois moteurs — le bridage,
lui, reste Chromium seul, faute d'équivalent CDP ailleurs. Les webviews qui
bloquent les Service Workers ne peuvent pas fonctionner, par construction — la
coquille l'explique alors au visiteur au lieu d'échouer en silence.

**Processeur du visiteur** : l'émulation utilise le CPU de l'onglet — c'est le
« serveur » que chaque visiteur apporte. Un onglet masqué plus de 15 s met la
VM en veille et rend le processeur ; le retour la reprend, horloge recalée.

**Ce que l'hébergeur doit fournir** — et GitHub Pages le fournit : CORS `*`,
requêtes `Range`, et rien d'autre. Les en-têtes d'isolation `COOP`/`COEP`, qu'un
hébergement statique ne pose pas, sont réinjectés par le Service Worker.

---

## Pour qui c'est fait

**Mainteneurs open source Ruby/Rails.** Votre README montre du code ; il ne
montre pas votre application. Le badge « Try with railsbox » donne à quiconque
lit votre projet une instance jouable en un clic — peuplée de données de
démonstration, session déjà ouverte, sans installation ni création de compte.
Le lien ne tombe pas et ne coûte rien, parce qu'il n'y a pas de serveur derrière.

**Fondateurs de SaaS B2B, créateurs de produits.** Une démonstration permanente
sans infrastructure : vous choisissez les données affichées (`seed`), le visiteur
arrive connecté (`auto_login`), et l'addition reste à zéro même le jour où votre
lien passe sur Hacker News. Contrepartie non négociable : **rien de réel ne doit
être embarqué** — ni clé Stripe live, ni identifiants OAuth, ni dump contenant
des données clients. Tout ce qui entre dans une sandbox est public
([`SECURITY.md`](SECURITY.md)).

**Développeurs freelances, candidats, portfolios.** Un recruteur clique et voit
l'application tourner, pas une capture d'écran. Pas de cold start payant, pas
d'instance gratuite mise en veille, pas de facture qui arrive parce que le lien
a bien marché.

**Formateurs, bootcamps, auteurs de tutoriels.** Trente onglets, c'est trente
environnements isolés : chaque apprenant est root dans SA copie, ses erreurs ne
polluent celles de personne, et il n'y a rien à installer avant de commencer.
Un `F5` remet tout à zéro. Ajoutez `?fresh=1` à la fin de
l'URL pour ignorer l'instantané et repartir d'un boot à froid.

Deux usages dérivent des mêmes propriétés : l'**aperçu de pull request jetable**
(une sandbox par branche, publiée puis oubliée) et la **reproduction de bug dans
une issue** (l'état exact qui plante, joignable en une URL).

---

## Ce que railsbox n'est PAS

- **Ce n'est pas un hébergeur de production.** railsbox sert à *montrer et faire
  essayer*, jamais à *opérer*. Pas de paiements bancaires live, pas de base de
  données partagée entre vos clients, pas de données qui survivent à l'onglet :
  chaque visiteur reçoit sa propre copie jetable. Une application qui doit
  encaisser, appeler des API tierces ou conserver de l'état n'a rien à faire ici.
- **Ce n'est pas un remplaçant de VS Code.** Ce n'est pas un IDE de développement
  quotidien, ni un environnement de travail distant : c'est un **lecteur
  universel de démonstration**. Vous développez chez vous, comme avant ; railsbox
  publie le résultat.
- **Ce n'est pas un émulateur de tout Rails.** ActionCable et les WebSockets sont
  hors périmètre, le réseau sortant n'existe pas, et la vitesse est celle d'une
  émulation — voir « [Limites connues](#limites-connues) ».

Ces refus sont **délibérés**. Ce sont des défauts si l'on compare railsbox à un
hébergeur, et des propriétés dès qu'on assume le cadrage : une sandbox n'a rien
à protéger côté serveur, puisqu'il n'y a pas de serveur.

---

## Ce qui est pris en charge

| | État |
| --- | --- |
| **SQLite** | validé de bout en bout : `rails new` + Propshaft + importmap, publié et bootant en ligne |
| **PostgreSQL** | pris en charge sur la voie découplée, à partir de la base `3.3-r2` (la valeur par défaut du workflow) |
| **MySQL / MariaDB** | non supporté : la construction s'arrête avec un rapport explicite |
| **importmap, Propshaft, Sprockets** | précompilés dans le disque i386 |
| **Tailwind, dart-sass** | précompilés sur un étage amd64, copiés dans le disque i386 |
| **Chaînes npm** (esbuild, cssbundling, jsbundling) | même étage amd64 : `npm ci` puis vos scripts de build |
| **Redis, Sidekiq** | détectés depuis le `Gemfile.lock`, présents dans la base |

### Limites connues

| Limite | État |
| --- | --- |
| **PostgreSQL** | **branché** sur la voie découplée : le serveur vit dans la base (à partir de la révision `3.3-r2`), le répertoire de données sur le disque applicatif, et le cluster ne démarre qu'après le montage de celui-ci. Exige une base `3.3-r2` ou plus récente — la construction refuse explicitement une base antérieure. Voir « [PostgreSQL](#postgresql) ». |
| **Tailwind, dart-sass** | **pris en charge** : précompilés sur un étage amd64, puis copiés dans le disque i386 (le guest n'exécute jamais ces binaires). Tailwind est validé **de bout en bout** — variante `demo-tailwind`, boot d'une VM v86 réelle, feuille compilée servie par le guest — et rejoué par le workflow [`valider-variantes.yml`](.github/workflows/valider-variantes.yml). dart-sass a désormais son propre banc d'essai (`demo-dartsass`), plus strict encore : `sass-embedded` ne publie aucun binaire i386 là où `tailwindcss-ruby` offre une variante « ruby ». |
| **Chaînes npm** (esbuild, cssbundling) | **pris en charge** par le même étage (`npm ci` puis scripts de build). Un verrou yarn/pnpm/bun n'est pas relu : repli sur `npm install`, signalé. |
| **ActionCable / WebSockets** | hors périmètre : incompatibles avec un pont requête/réponse. Piste : long-polling ou flux dédié. |
| **Réseau sortant** | inexistant. C'est aussi une propriété du modèle de démonstration — voir [`SECURITY.md`](SECURITY.md). |
| **Débit du pont** | tuyau étroit et partagé, suffisant pour du Turbo/HTML. Les assets précompilés ne l'empruntent pas : extraits de l'image, ils sont servis statiquement par le Service Worker. |
| **Persistance** | aucune, par conception. Chaque visiteur écrit dans sa copie, qui disparaît avec l'onglet. |

### Sécurité, en une ligne

Tout s'exécute côté client : l'image disque et l'instantané mémoire sont
**téléchargeables par n'importe qui**, et le visiteur est root dans sa VM.
N'embarquez jamais de vrais secrets ni de vraies données. Ce qui est défendu,
ce qui ne l'est pas, et pourquoi : [`SECURITY.md`](SECURITY.md).

---

## Configuration

Tout est auto-détecté (version de Ruby, adaptateur de base, chaîne d'assets,
gems natives, services). Vous ne configurez que ce que la détection ne peut pas
deviner.

### `railsbox.yml`

Un fichier à la racine de l'application complète ou corrige l'auto-détection :

```yaml
ruby: 3.3.12 # sinon .ruby-version, Gemfile, puis Gemfile.lock
database: sqlite3 # sinon config/database.yml, puis la gem pg du lock
seed:
  command: "bin/rails db:seed" # exécuté au BUILD, avant la capture d'instantané
  auto_login: "demo@example.com" # le visiteur arrive connecté
env:
  APP_HOST: "http://localhost:8080" # variables exigées par vos initializers
assets:
  scripts: ["build", "build:css"] # scripts npm de build à déclencher
```

Cinq clés sont reconnues — `ruby`, `database`, `seed`, `env`, `assets` — et
toute autre déclenche un diagnostic. Dans le bloc `assets:`, seule la clé
`scripts` est lue : toute autre y est ignorée avec un avertissement. `database` accepte `postgresql` ou
`sqlite3`. Les valeurs `env:` sont traitées comme des **données inertes**,
jamais évaluées au build (voir [`SECURITY.md`](SECURITY.md)).

### Données de démonstration et auto-connexion

`seed.command` tourne **à la construction**, avant la capture de l'instantané :
le visiteur trouve donc la base déjà peuplée, sans attendre.

`seed.auto_login` accepte un identifiant — une **adresse e-mail** ou un **id
numérique**, cherché dans le modèle **`User`**, résolu strictement et sans
repli silencieux — ou `true` pour le premier utilisateur (`User.first`). Si
votre modèle ne s'appelle pas `User`, ou si l'identifiant n'est ni un e-mail ni
un id, passez par `seed.auto_login_code` : un fragment Ruby (scalaire en bloc
`|`) avec `env` dans sa portée. L'auto-connexion s'exécute **chez le visiteur**,
au premier chargement : elle dépend de sa session, qu'aucun instantané ne peut
contenir.

### Entrées du workflow

| Entrée | Défaut | Rôle |
| --- | --- | --- |
| `app-path` | `.` | chemin de l'application Rails dans le dépôt appelant |
| `name` | nom du dépôt | nom court de la sandbox (assaini dans tous les cas) |
| `base` | `3.3-r2` | version de la base railsbox (convient à SQLite comme à PostgreSQL) |
| `seed` | (détectée) | commande de seed, si vous voulez la forcer |
| `publish` | `true` | publier sur `gh-pages`, ou construire seulement |
| `target-repo` | (le dépôt appelant) | publier ailleurs — exige alors le secret `publish-key` |
| `assets-url` | `https://pinfada.github.io/railsbox-assets` | racine du dépôt d'artefacts |
| `base-image` | `ghcr.io/pinfada/railsbox-base` | image de construction (doit correspondre à `base`) |
| `railsbox-ref` | `main` | version de railsbox utilisée pour construire |

Secret `publish-key` : clé de déploiement en écriture, **obligatoire** dès que
`target-repo` est renseigné — le jeton du workflow ne vaut que pour le dépôt
courant.

Deux garde-fous refusent explicitement plutôt que de publier une démonstration
qui échouerait au chargement : la limite de **95 Mo par fichier** de GitHub
Pages, et une application dont l'étage amd64 ne produit **aucun** asset (une
application sans CSS est une panne que le visiteur découvrirait à l'affichage).

### PostgreSQL

Rien à déclarer : la base par défaut (`3.3-r2`) embarque le serveur, et la
détection reconnaît un `adapter: postgresql` — à défaut, la seule présence de la
gem `pg` dans le `Gemfile.lock`, le cas des applications dont le `database.yml`
n'est qu'un `url: <%= ENV["DATABASE_URL"] %>`. Si vous épinglez une base
antérieure (`base: "3.3"`), la construction s'arrête avec un message qui vous
renvoie vers `3.3-r2`.

Ce que fait railsbox, et pourquoi c'est fait comme ça :

| Élément | Choix | Raison |
| --- | --- | --- |
| Serveur | dans le rootfs de base, **sans aucun cluster** | mutualisé entre sandboxes ; un datadir dans la base pèserait sur tous les visiteurs, y compris ceux en sqlite3 |
| Répertoire de données | `/app/var/pg`, sur le **disque applicatif** | il voyage avec l'application : l'état migré et seedé à la construction est livré tel quel, sans migration au premier boot |
| Démarrage du cluster | dans `start-app.sh`, **après** le montage du disque | l'instantané de base fige les processus ; un postmaster démarré à l'init y serait gelé sur un datadir encore inexistant |
| Connexion | `DATABASE_URL` posée sur le disque applicatif | surcharge hôte, rôle et base sans toucher au `config/database.yml` de l'application |
| Durabilité | `fsync = off`, WAL minimal | la base est reconstruite à chaque build et la copie du visiteur est jetable ; sous émulation, `fsync` domine le coût des migrations |

Le mot de passe du rôle (`postgres`) n'est pas un secret : la VM n'a aucun
réseau sortant et le cluster n'écoute que le loopback émulé (voir
[`SECURITY.md`](SECURITY.md)). N'embarquez jamais de vraies données.

Une variante PostgreSQL de l'application de démonstration sert de banc d'essai.
Elle n'est pas une seconde application mais une surcouche de quatre fichiers :

```bash
APP="$(bash tools/demo-app/preparer-demo-pg.sh)"
wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP"   --name demo-pg --base ghcr.io/pinfada/railsbox-base:3.3-r2
node tools/build-v86-image/make-delta-snapshot.mjs --name demo-pg --base base-3.3-r2
```

### Réparer une configuration incomplète

Une application Rails sérieuse refuse de démarrer si une clé manque. Le panneau
**Environnement** (en haut à droite de la sandbox) détecte ces variables dans les
journaux de boot, génère les secrets internes au bon format en un clic, offre un
champ pour les identifiants de services tiers, puis **injecte le tout dans la VM
et relance l'application à chaud** — sans reconstruire l'image.

Sur un diagnostic bloquant (base MySQL, série de Ruby inconnue, dossier qui n'est
pas une application Rails), la construction s'arrête et affiche un **rapport
d'incompatibilité avec un remède par point**, directement dans le résumé du
workflow.

---

### Quand la construction échoue

Un refus **amont** (avant construction) est déjà lisible : code, message et
remède dans le résumé du job. Un échec **aval** — `bundle install`, assets,
migration, capture d'instantané, publication — l'est désormais aussi. Le
workflow capture le journal de l'étape faillible et publie dans le résumé un
bloc **« Pourquoi la construction a échoué »** : catégorie, code stable,
extrait du journal qui prouve le diagnostic, et remède actionnable. Le journal
complet reste dans les traces du runner pour qui veut creuser.

La taxonomie vit dans
[`tools/build-v86-image/classifier-echec.mjs`](tools/build-v86-image/classifier-echec.mjs)
(module pur, testé). Elle nomme ce que le journal ne dit pas : le **paquet
Debian** à ajouter à la base derrière un `libpq-fe.h` introuvable, l'étage
amd64 derrière un « Exec format error », l'erreur ActiveRecord exacte derrière
une migration qui plante. Faute de motif connu, elle livre honnêtement les
trente dernières lignes utiles, débarrassées du bruit de progression Docker.
L'extrait est **caviardé** avant publication : le journal capturé n'a pas
traversé le masquage des secrets du runner.

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

### Trois niveaux de tests hors ligne, tous requis avant un commit

| Commande | Portée | Dépendances |
| --- | --- | --- |
| `npm test` | modules purs (codecs, détecteur, buildpack, config) | aucune |
| `npm run test:integration` | protocole série complet contre une **vraie VM v86** sous Node — POST de 1 Mo, ENV/RST, montage base + application | `public/disks/` |
| `npm run test:e2e` | boot navigateur complet dans Chromium (Playwright) : page hôte, isolation, application rendue dans l'iframe, navigation | Chromium ; VM `public/disks/` |

`npm run check` enchaîne lint (ESLint), format (Prettier), typecheck
(`tsc --checkJs` sur trois cibles : navigateur, Service Worker, Node) et tests
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

## Le modèle

L'idée qui porte railsbox est une **inversion économique** : une application
full-stack — serveur, base de données, cache — cesse d'être un *service qu'on
opère* pour devenir un *fichier qu'on distribue*. Une fois construite, la faire
tourner ne coûte plus rien à personne : **chaque visiteur apporte son propre
serveur** — son processeur, sa mémoire, son onglet. Le build tourne dans les
GitHub Actions du mainteneur, les artefacts vivent sur ses GitHub Pages, la
coquille est une page statique : gratuit, sans dépendance tierce payante.

Deux conséquences qui définissent le projet :

- **L'isolement par visiteur est une qualité, pas une limite.** Chaque personne
  reçoit sa copie ; ses données ne quittent jamais son navigateur. Personne ne
  peut polluer l'essai d'un autre, et le modèle est compatible RGPD par
  construction.
- **La valeur défendable est la recette, pas le moteur.** v86 est open source,
  réutilisable par quiconque. Ce qui se capitalise, c'est le buildpack — les
  vingt-deux itérations, les pièges i386, l'auto-détection, la bibliothèque
  d'images de base — le chemin qui va d'une URL GitHub à une sandbox qui boote.

railsbox est validé sur une vraie application de production —
[jiyufit](https://github.com/pinfada) (Rails 7.2.3, Ruby 3.3.10, PostgreSQL 15,
Redis, Sidekiq, Devise, Stripe, 70 initializers) — qui rend ses pages, suit ses
liens et traite ses POST, et sur une application `rails new` de démonstration
(sqlite3 + importmap), construite, publiée et bootée automatiquement.

Les décisions d'architecture et leurs limites mesurées sont consignées dans
[`docs/decisions/`](docs/decisions/).

## Les dépôts

| Dépôt | Rôle |
| --- | --- |
| **railsbox** (celui-ci) | le buildpack, la coquille, les workflows |
| [**railsbox-assets**](https://github.com/pinfada/railsbox-assets) | hébergement statique des rootfs de base, versionnés et immuables |
| [**railsbox-demo**](https://github.com/pinfada/railsbox-demo) | l'application de démonstration et sa sandbox publiée |

Une **origine par démonstration** : chaque sandbox vit sur le domaine de son
propre dépôt, si bien que l'isolation entre démonstrations est celle du
navigateur et non une promesse de notre part (voir
[ADR 0004](docs/decisions/0004-topologie-de-distribution.md)).

## Schéma de flux

```
┌─────────────────────────── NAVIGATEUR ────────────────────────────┐
│  IFRAME APPLICATIVE            PAGE HÔTE (thread principal)       │
│  fetch("/app/gymhouses")       ├─ main.js : orchestration, log    │
│        │                       ├─ vm/v86-vm.js : boot + pont      │
│        ▼                       └─ env-drawer.js : réparation      │
│  SERVICE WORKER (sw-proxy.js)          ▲                          │
│  ├─ intercepte /app/*                  │ MessageChannel           │
│  ├─ réinjecte COOP/COEP                │ (renouvelé s'il meurt)   │
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
que lui, et l'application le génère nativement puisqu'elle est montée dessous par
`Rack::URLMap`.

## Où sont précompilés les assets

Le guest est un **i386**, et deux familles d'outils d'assets ne publient aucun
binaire pour cette architecture : les gems à exécutable précompilé
(`tailwindcss-ruby` dont dépend tailwindcss-rails, `dartsass-ruby`) et les
chaînes npm (esbuild, sass). Elles produisent pourtant du CSS et du JS
**ordinaires**, indépendants de l'architecture — on les exécute donc sur un
**étage amd64**, et le disque i386 ne reçoit que `public/assets`. Le guest
n'exécute jamais ces binaires.

L'auto-détection classe seule chaque application :

| Ce qu'elle trouve | Étage retenu | Ce qui tourne |
| --- | --- | --- |
| propshaft/sprockets + importmap | `i386` | `assets:precompile` dans le disque applicatif |
| tailwindcss-rails, dartsass-rails | `amd64` | `assets:precompile` sur l'hôte, copie de `public/assets` |
| `package.json` (jsbundling/cssbundling) | `amd64` | `npm ci` + scripts de build, puis `assets:precompile` |
| aucun pipeline | `aucun` | rien |

L'étage amd64 pose exactement le même `RAILS_RELATIVE_URL_ROOT` que le disque
applicatif : les URL figées dans le CSS portent le préfixe **public complet**
(`/depot/app/assets/…`), sous le site et non à la racine du domaine — sans quoi
le Service Worker ne pourrait même pas les rattraper.

Une variante Tailwind de l'application de démonstration sert de banc d'essai —
surcouche de sept fichiers sur `demo/`, comme `demo-pg` :

```bash
APP="$(bash tools/demo-app/preparer-demo-tailwind.sh)"
wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP"     --name demo-tailwind --base ghcr.io/pinfada/railsbox-base:3.3-r2
node tools/build-v86-image/make-delta-snapshot.mjs --name demo-tailwind --base base-3.3-r2
node --test tests/integration/vm-tailwind.it.mjs
```

Le test d'intégration ne se contente pas de constater qu'une feuille de style
existe : il va chercher dans le CSS **servi par la VM** un utilitaire à valeur
arbitraire (`tracking-[0.35em]`), qu'aucune feuille pré-construite ne peut
contenir. Sa présence prouve que le binaire `tailwindcss` a balayé les vues
pendant cette construction — sur l'hôte amd64, jamais dans le guest.

Deux points d'attention plutôt qu'un refus : sans `package-lock.json` (ou avec un
verrou yarn/pnpm/bun, que railsbox ne relit pas), l'installation retombe sur
`npm install` et la construction n'est plus reproductible — c'est un
avertissement du rapport d'analyse. Et si l'étage amd64 ne produit **aucun**
asset, la construction s'arrête là.

## Le cache des artefacts

GitHub Pages plafonne ses réponses à `Cache-Control: max-age=600` et ne se
configure pas. Or nos artefacts sont **immuables par construction** : une base
publiée n'est jamais réécrite
([ADR 0004](docs/decisions/0004-topologie-de-distribution.md)), et un
fichier-partie est une tranche figée d'un disque figé
([ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)). Sans rien
faire, un visiteur qui revient le lendemain retélécharge donc les ~32 Mo du
premier chargement — et jusqu'à ~48 Mo après avoir navigué — qu'il
avait déjà lus.

Le Service Worker interceptant déjà tout, il tient un **cache applicatif en Cache
Storage**, en stratégie « cache d'abord » :

| Point | Choix |
| --- | --- |
| Ce qui est mis en cache | les fichiers-parties des disques découpés, le noyau, l'initrd — **et rien d'autre que ce qui est nommé dans la configuration v86** |
| Ce qui ne l'est pas | l'instantané mémoire, déjà mis en cache par la page dans IndexedDB ; un disque lu par requêtes `Range`, dont les réponses 206 sont refusées par Cache Storage ; toute requête portant un en-tête `Range` |
| Nom du cache | dérivé de la configuration entière, `builtAt` compris. L'URL du disque applicatif étant stable d'une construction à l'autre, un cache indexé par la seule URL panacherait les morceaux de deux images après une reconstruction — c'est-à-dire corromprait le système de fichiers. Un changement de configuration bascule sur un cache neuf et supprime l'ancien. |
| En-têtes | **aucun n'est ajouté.** Les requêtes vers Pages doivent rester « simples » au sens CORS, sous peine d'un préflight que l'hébergeur ne sait pas honorer ([ADR 0001](docs/decisions/0001-distribution-artefacts.md)). La requête est réémise telle quelle, la réponse rendue telle quelle. |
| Quota | `StorageManager.estimate` avant écriture, marge de 10 % ; un échec d'écriture est journalisé une fois et sans effet — **la requête aboutit toujours**, avec ou sans cache. |

La décision (quelles URL, quel nom de cache, quelle invalidation) est isolée dans
`public/shared/artifact-cache.js`, testée sans navigateur. Le fait qu'un
rechargement ne redemande rien au réseau, lui, est vérifié dans un vrai Chromium
(`tests/e2e/artifact-cache.e2e.spec.mjs`) : le fichier est supprimé du serveur
entre les deux lectures, et la seconde réussit quand même.

Ce que ce cache ne change pas : il vit dans l'origine de la démonstration, donc
**deux démonstrations ne le partagent toujours pas** — c'est le coût assumé de la
topologie « une origine par démonstration ». Il économise les visites répétées
d'un même visiteur sur une même sandbox, pas la première.

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

## Retour d'expérience : les défis résolus

Vingt-deux itérations de build ont été nécessaires. Les obstacles n'étaient
presque jamais où on les attend — voici ceux qui ont coûté le plus cher.

### Le loopback TCP n'existait pas sous le moteur historique

`bind()` sur `127.0.0.1` échoue avec un `EADDRINUSE` fantôme : toute la pile TCP
passe par Tailscale. Puma écoute donc sur un **socket Unix**, purement interne au
noyau émulé. C'est ce qui a motivé le passage à v86, dont le vrai noyau Linux
rend le loopback trivial.

### Le canal montant perd les gros POST

Le port série n'a **aucun contrôle de flux** dans le sens navigateur → invité.
Mesuré : un POST de 32 Ko passe, **128 Ko est perdu et bloque le canal
définitivement**. La correction est un protocole en tranches acquittées une par
une (fenêtre d'émission de 1 536 octets), ce qui borne les octets en vol quelle
que soit la taille du tampon.

| Corps du POST | Avant | Après |
| --- | --- | --- |
| 1–32 Ko | arrive | arrive |
| 128 Ko | **perdu**, canal mort | arrive |
| 1 Mo | perdu | **2,5 s** |

Effet de bord bénéfique : le corps n'étant plus embarqué dans le descripteur JSON
lui-même ré-encodé, la charge utile perd **77 %** de son gonflement.

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
capture), mais la mesure a montré pire : sous émulation chargée, l'invité prend
**jusqu'à 20 s de retard toutes les 5 s**. Sans recalage périodique, les cookies
de session et les jetons CSRF finissent par expirer d'eux-mêmes en cours
d'utilisation.

### `RAILS_RELATIVE_URL_ROOT` ne préfixe que les assets

| Helper | URL générée |
| --- | --- |
| `stylesheet_link_tag` | `/app/assets/tailwind-…` ✅ |
| `link_to`, `form_with` | `/gymhouses` ❌ échappe au proxy |

Les helpers de routes lisent le `SCRIPT_NAME` de Rack, vide quand Puma sert à la
racine. La correction est le déploiement sous-URI standard : un `config.ru`
fourni par l'image monte l'application via `Rack::URLMap`, **sans toucher au code
applicatif**. Défaut trouvé en cliquant sur un lien — pas en regardant la page
d'accueil s'afficher.

### Quatre pièges de l'instantané mémoire

| Piège | Traitement |
| --- | --- |
| Gel d'horloge | trame `TIME` + `date -s` au-delà de 2 s de dérive |
| Fuite mémoire — `URL.createObjectURL` sur 650 Mo n'est jamais libéré | supprimé à la racine : v86 accepte `initial_state: { buffer }` |
| Boot à froid de 13 min chez l'utilisateur | instantané généré en CI, livré en gzip, téléchargé si le cache local est vide |
| v86 émet **un événement JS par octet** (369 282 pour le CSS) | assembleur `Uint8Array` pré-alloué : **24 ns/octet**, 8,9 ms pour 270 Ko |

### Un Service Worker ne peut pas poser de cookie

`Set-Cookie` est un en-tête **interdit** sur une `Response` construite : l'API
Fetch le filtre en silence. Le proxy relayait donc les réponses de Rails sans
que le navigateur n'enregistre jamais le cookie de session — celui qui porte la
graine du jeton CSRF. Conséquence : chaque requête ouvrait une session vierge,
et **tout POST répondait 422 `InvalidAuthenticityToken`**. La démonstration
promettait « créez, modifiez, supprimez un billet » et ne savait qu'afficher.

Le proxy tient donc lui-même le magasin (`shared/cookie-jar.js`) : il moissonne
les `Set-Cookie` des réponses de la VM, les range, et repose l'en-tête `Cookie`
sur chaque requête relayée. Le bocal est persisté en IndexedDB — un Service
Worker est tué dès qu'il est inactif, et perdre le bocal en cours de parcours
reviendrait à déconnecter le visiteur. `document.cookie` reste vide côté page,
ce qui n'est PAS une mise hors de portée du script : voir
[`SECURITY.md`](SECURITY.md).

Corollaire de sécurité, découvert en revue : ce magasin attache le cookie de
session à **toute** requête que le Service Worker relaie — or un SW prend en
charge les **navigations** vers sa portée quelle qu'en soit l'origine
initiatrice, pas seulement les sous-ressources de ses clients. Un formulaire
hébergé ailleurs pouvait donc écrire dans la VM du visiteur. Le proxy refuse
désormais en 403 toute requête dont l'`Origin` ou le `Sec-Fetch-Site` trahit
une provenance inter-origine — plus strict que le `SameSite=Lax` qu'un
navigateur aurait appliqué de lui-même.

**La leçon, elle, dépasse le cookie** : la recette en ligne était verte à 8/8
sur une démonstration incapable d'écrire, parce qu'elle ne faisait que des GET
— et Rails n'a besoin d'aucune session pour servir un GET. Un scénario POST
complet y a été ajouté, et le défaut a été trouvé en cliquant réellement dans
la page publiée, pas en lisant un rapport de tests.

### Détecter une variable manquante sans se tromper de mot

Une expression du type `(VARIABLE).{0,40}(mot-clé)` capture le **premier** jeton
majuscule de la ligne — sur
`{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}` elle proposait
sérieusement `FATAL` comme variable à renseigner. Remplacée par une recherche par
fenêtre autour du mot-clé, avec retrait des étiquettes de journal (`[DEVISE]`,
`[STRIPE]`) et exigence d'un souligné dans le nom.

Autre nuance : « bloquant » se juge sur la **gravité du message**, pas sur la
famille de la variable. Un `WARN` laisse l'application démarrer, seule la
fonctionnalité concernée reste inactive.

### Pièges de construction d'image, en vrac

`docker export` perd `/etc/hosts` et les uid si l'extraction n'est pas faite en
root ; un init maison doit monter `/dev/shm` (PostgreSQL 15) ; `BUNDLE_WITHOUT`
et `BUNDLE_FORCE_RUBY_PLATFORM` doivent exister **au runtime** et pas seulement
au build ; BuildKit n'applique pas la personnalité 32 bits, donc `uname -m` ment
et Bundler installe des gems x86_64 inchargeables ; nokogiri ne compile pas son
libxml2 embarqué en i386 (bibliothèques système obligatoires) ; `tmp/`, `log/` et
`storage/` sont souvent exclus par le `.dockerignore` alors que Puma exige
`tmp/pids` ; le tty série doit être en `raw -echo`, le mode canonique tronquant à
4 096 caractères.

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
│   ├── env-detector.js            détection des variables manquantes
│   └── v86-config.js              config v86 : mono-disque ou base + application
└── vm/
    └── v86-vm.js                  boot v86, instantané, horloge, pont série
tests/                             370 tests unitaires + intégration (VM réelle) + E2E
├── integration/                   protocole série contre une vraie VM v86 (Node)
├── e2e/                           boot navigateur complet (Playwright)
└── live/                          recette de la sandbox PUBLIÉE (réseau, hors CI)
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
docs/decisions/                    ADR : distribution des artefacts, découpage base/app
SECURITY.md · CONTRIBUTING.md      modèle de menace · conventions
```

## Licences tierces

railsbox est sous licence MIT ([`LICENSE`](LICENSE)). Il vendorise l'émulateur
[v86](https://github.com/copy/v86) (BSD 2-Clause,
[`public/vendor/v86/LICENSE`](public/vendor/v86/LICENSE)) et les firmwares qu'il
embarque : SeaBIOS (`seabios.bin`, LGPLv3) et le VGABIOS de Bochs
(`vgabios.bin`, LGPL). Les rootfs publiés dans `railsbox-assets` contiennent des
logiciels libres (Linux, Ruby, Rails…) sous leurs licences respectives.

## Contribuer

Conventions, style et attentes de tests : [`CONTRIBUTING.md`](CONTRIBUTING.md).
