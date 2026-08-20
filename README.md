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

> **Votre dépôt est privé ?** Sur un compte gratuit, ce bloc-ci construira sans
> jamais rien publier de visible — et sans le dire. Lisez « **[Dépôt
> privé](#dépôt-privé)** » avant de coller : selon votre plan, c'est le même
> workflow ou quatre lignes de plus, avec une commande d'amorçage à jouer avant.

```yaml
name: Sandbox railsbox
on:
  push:
    branches: [main, master] # ← votre branche par défaut
  workflow_dispatch:

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
```

> **Vérifiez la ligne `branches:`.** Un filtre qui ne nomme pas votre branche par
> défaut ne déclenche jamais rien, et **GitHub ne le signale pas** : pas
> d'erreur, pas d'exécution, pas de mention dans l'onglet Actions — le workflow
> semble simplement absent. Les deux noms sont listés ci-dessus pour que le
> copier-coller marche sur un dépôt en `main` comme sur un dépôt en `master` ;
> gardez le vôtre et supprimez l'autre si vous préférez. Dans le doute,
> déclenchez une première construction à la main (`workflow_dispatch`, bouton
> *Run workflow*) : si elle passe et qu'un `push` ne fait rien, c'est le filtre.

Le dépôt railsbox est public : n'importe quel dépôt peut référencer ce workflow
directement.

> **`@main` bouge. Épinglez un tag si votre démonstration doit tenir.**
> `uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@v2.2.0`
> vous donne une chaîne de construction figée ; `@main` vous donne les
> correctifs au fil de l'eau, et le risque qu'une modification en amont change
> votre sandbox sans prévenir. Sur une démonstration que vous montrez à des
> tiers, épinglez. La version employée est écrite en première ligne du journal
> de boot de chaque sandbox : c'est ce qu'on vous demandera si vous signalez un
> problème.

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

> **C'est à vous de le coller, et c'est délibéré.** railsbox n'écrit JAMAIS
> dans votre branche par défaut : il ne pousse que sur `gh-pages`. Réécrire le
> README d'un dépôt pour y glisser un badge serait une intrusion, et le jour
> où ça se passe mal, ça se passe mal dans votre historique. Il génère en
> revanche un README complet **sur la branche `gh-pages`**, badge compris —
> visible tel quel sur un dépôt vitrine, dont `gh-pages` est la branche par
> défaut, mais invisible sur votre dépôt source, où elle ne l'est pas.

> **Le clic ouvre l'onglet courant.** GitHub retire `target="_blank"` des
> README, quelle que soit la syntaxe employée — vérifié sur son API de rendu.
> Aucun badge de l'écosystème n'y échappe. Vos lecteurs gardent le clic-milieu.

### Dépôt privé

Sur un dépôt public, les trois étapes ci-dessus suffisent et tout est gratuit :
Actions et Pages le sont. Sur un dépôt privé, elles ne suffisent pas — et
l'échec est du genre qu'on met une soirée à comprendre : la construction passe,
`gh-pages` est bien poussée, l'onglet Actions reste vert, et **il n'y a pas de
page**. GitHub Pages ne sert pas un dépôt privé sur un compte gratuit ; il ne le
dit nulle part. C'est exactement ce qui est arrivé au premier dépôt privé
installé avec le workflow public : jamais aucune page, jamais aucun message.

Deux issues, dont une seule est gratuite :

- **Plan Pro, Team ou Enterprise** : Pages fonctionne depuis un dépôt privé, et
  le workflow public ci-dessus marche tel quel. Notez ce qu'il publie : **le
  site, lui, est public** — seul le code reste privé. Les minutes Actions
  restent facturées.
- **N'importe quel plan, y compris gratuit** : le code reste privé et la sandbox
  est publiée dans un **dépôt vitrine public dédié**. C'est le chemin
  recommandé, et le seul qui ne coûte rien.

Le reste de cette section décrit le second.

#### 1. Amorcez la vitrine

Le workflow **ne crée rien** : il pousse. Son jeton n'a de droits que sur le
dépôt courant, donc il ne peut ni créer le dépôt vitrine, ni y poser une clé, ni
s'écrire un secret. Un script fait ces gestes depuis votre machine, avec votre
authentification `gh` — aucun jeton supplémentaire à créer, et la clé privée
qu'il génère est effacée en fin d'exécution :

```sh
curl -fsSL -o amorcer-vitrine.sh https://raw.githubusercontent.com/pinfada/railsbox/main/tools/amorcer-vitrine.sh
sh amorcer-vitrine.sh <compte>/<depot-source> <compte>/<depot-vitrine>
```

Deux lignes, et pas de `curl … | sh` : le script vous demande confirmation
**sur l'entrée standard**, que le tube occupe déjà — il partirait sans vous
attendre, ou refuserait de lire. Sur un projet qui explique par ailleurs ce
qu'il ne protège pas, avaler un script distant sans l'avoir sous les yeux serait
en plus un mauvais signal. Téléchargez, lisez si vous voulez, exécutez.

Il crée la vitrine **vide** (un README coché à la création suffirait à garder
`main` comme branche par défaut, et la page du dépôt resterait vide aux yeux des
visiteurs), génère une paire de clés dédiée, pose la publique en clé de
déploiement écriture sur la vitrine, la privée en secret `PUBLISH_KEY` sur votre
dépôt, pousse une branche `gh-pages` d'attente et **active GitHub Pages dessus
dans la foulée** — il n'y a donc rien à activer après la première construction.
Il **refuse plutôt que de deviner**, et il refuse **avant** de créer quoi que
ce soit : `gh` non authentifié, dépôt source inaccessible ou dont vous n'êtes
pas administrateur, vitrine visée chez un autre compte personnel, organisation
qui interdit les dépôts publics, vitrine existante que vous n'administrez pas
ou qui n'est pas publique. En revanche une vitrine **déjà amorcée** ne l'arrête
pas : il reprend là où il faut, et ne touche jamais à une branche `gh-pages`
existante — ce serait effacer une démonstration en ligne.

Un amorçage déjà fait se contrôle sans rien modifier :
`sh amorcer-vitrine.sh --verifier <compte>/<depot-source> <compte>/<depot-vitrine>`.

#### 2. Collez ce workflow

```yaml
name: Sandbox railsbox

on:
  workflow_dispatch: # ← à la demande : voir « Le coût » ci-dessous
  # push:
  #   branches: [main]

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
    with:
      target-repo: <compte>/<depot-vitrine>
    secrets:
      publish-key: ${{ secrets.PUBLISH_KEY }}
```

`target-repo` dit où publier, `publish-key` est la clé d'écriture posée par le
script : le jeton du workflow ne vaut que pour le dépôt courant, il ne peut rien
écrire ailleurs. Sans ce secret, la construction s'arrête au moment de publier.
La démonstration sera servie sur `https://<compte>.github.io/<depot-vitrine>/`,
et c'est cette URL-là que porte votre badge.

#### Le coût

Sur un dépôt privé, les minutes Actions sont **facturées**, et une construction
railsbox en consomme **~9**. Avec `on: push`, c'est neuf minutes à chaque
poussée sur votre branche par défaut — y compris pour les commits qui ne
changent rien à ce que la démonstration montre. D'où le `workflow_dispatch` seul
ci-dessus : sur un dépôt privé, republiez quand vous avez quelque chose de
nouveau à montrer, pas à chaque `git push`. Décommentez le `push:` en
connaissance de cause.

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
| Téléchargé pour cela | ~32 Mo depuis le dépôt d'artefacts + l'instantané, en morceaux de 4 Mio gzippés (76 Mo pour la démonstration) |
| Navigation, formulaires, POST | normaux, servis par la VM |

Pendant l'attente, une barre nomme l'étape en cours et compte les secondes
(« Étape 5/5 · Rendu de la première page par la VM · 31 s »). Elle existe
parce que la mesure sous processeur bridé l'exigeait : la dernière phase, entre
badges tous verts et première page affichée, dure 1 s sur une machine de bureau
mais jusqu'à 14 s sur un appareil lent — sans rien qui distingue « ça arrive »
de « c'est bloqué ».

Le rootfs mutualisé de 1,45 Go n'est jamais téléchargé en entier : v86 en lit
les morceaux qu'il touche, une trentaine sur 363. Et il ne les lit qu'une fois :
le Service Worker les garde en Cache Storage, si bien qu'un visiteur qui revient
ne retélécharge rien (voir « [Le cache des artefacts](docs/fonctionnement.md#le-cache-des-artefacts) »).

**Navigateurs** — mesuré par la recette `npm run test:live` (voir
« [Vérifier une sandbox publiée](docs/developpement.md) ») sur la
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
**Une seule sandbox tourne à la fois par navigateur** : un verrou exclusif
(Web Locks) désigne l'onglet actif, et un second onglet ouvert sur la même
sandbox ne démarre aucune VM — il affiche « déjà ouverte dans un autre
onglet » et un bouton pour reprendre la main ici, auquel cas l'autre onglet
libère la sienne.

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
arrive connecté (`auto_login` ouvre une session — une interface qui
s'authentifie par jeton demande [la recette
JWT](docs/spa.md)), et
l'addition reste à zéro même le jour où votre lien passe sur Hacker News. Contrepartie non négociable : **rien de réel ne doit
être embarqué** — ni clé Stripe live, ni identifiants OAuth, ni dump contenant
des données clients. Tout ce qui entre dans une sandbox est public
([`SECURITY.md`](SECURITY.md)).

**Développeurs freelances, candidats, portfolios.** Un recruteur clique et voit
l'application tourner, pas une capture d'écran. Pas de cold start payant, pas
d'instance gratuite mise en veille, pas de facture qui arrive parce que le lien
a bien marché.

**Formateurs, bootcamps, auteurs de tutoriels.** Trente apprenants, c'est trente
environnements isolés : chaque apprenant est root dans SA copie, ses erreurs ne
polluent celles de personne, et il n'y a rien à installer avant de commencer.
L'isolation est celle du navigateur, donc elle sépare des **visiteurs**, pas des
onglets : deux onglets d'un même navigateur partagent la même sandbox, et un
seul la fait tourner à la fois — le second propose de reprendre la main.
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
| **Active Storage, traitement d'images** | `libvips` (défaut de Rails 7+), ImageMagick et les aperçus PDF sont dans la base à partir de `3.3-r3` |
| **Autres bibliothèques système** | installées en surcouche sur le disque applicatif — voir « [Bibliothèques système](docs/configuration.md#bibliothèques-système) » et [l'ADR 0006](docs/decisions/0006-bibliotheques-systeme.md) |

### Limites connues

| Limite | État |
| --- | --- |
| **PostgreSQL** | **branché** sur la voie découplée : le serveur vit dans la base (à partir de la révision `3.3-r2`), le répertoire de données sur le disque applicatif, et le cluster ne démarre qu'après le montage de celui-ci. Exige une base `3.3-r2` ou plus récente — la construction refuse explicitement une base antérieure. Voir « [PostgreSQL](docs/configuration.md#postgresql) ». |
| **Tailwind, dart-sass** | **pris en charge** : précompilés sur un étage amd64, puis copiés dans le disque i386 (le guest n'exécute jamais ces binaires). Tailwind est validé **de bout en bout** — variante `demo-tailwind`, boot d'une VM v86 réelle, feuille compilée servie par le guest — et rejoué par le workflow [`valider-variantes.yml`](.github/workflows/valider-variantes.yml). dart-sass a désormais son propre banc d'essai (`demo-dartsass`), plus strict encore : `sass-embedded` ne publie aucun binaire i386 là où `tailwindcss-ruby` offre une variante « ruby ». |
| **Chaînes npm** (esbuild, cssbundling) | **pris en charge** par le même étage (`npm ci` puis scripts de build). Un verrou yarn/pnpm/bun n'est pas relu : repli sur `npm install`, signalé. |
| **SPA côté client** (React, Vue, Svelte) | **demande une adaptation de votre code** — la seule que railsbox ne puisse pas faire à votre place. L'application est servie sous `/<depot>/app/` ; les helpers Rails suivent ce préfixe, votre JavaScript ne le devine pas. Patron recommandé, avec code copiable : « [Votre application embarque un SPA ?](docs/spa.md) ». |
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

---

## Qui l'utilise

**Ils l'utilisent, et l'ont dit** — cette liste est tenue à la main, par
demande de fusion. Elle est la **seule** façon de figurer ici depuis un dépôt
privé : aucune détection automatique ne le verra jamais.

La liste vit dans **[docs/utilisateurs.md](docs/utilisateurs.md)** — une ligne,
dans l'ordre alphabétique, par demande de fusion. Elle est reprise dans
[docs/adoption.md](docs/adoption.md) à chaque mesure.

_Personne pour l'instant. Si railsbox vous sert, ajoutez-vous : c'est le seul
retour que le projet reçoit._

Les sandboxes **publiques** sont détectées automatiquement et recensées dans
[docs/adoption.md](docs/adoption.md), régénéré chaque semaine avec les mesures
de trafic. Cette page dit aussi, explicitement, ce qu'elle ne peut pas
mesurer : un dépôt privé qui utilise railsbox est invisible — pas de serveur,
pas de compte, pas de télémétrie. C'est le modèle, pas un manque d'outillage.

---

## Aller plus loin

Le reste de la documentation est découpé par sujet — chaque page se lit seule.

| Page | Ce qu'on y trouve |
| --- | --- |
| **[Configuration](docs/configuration.md)** | `railsbox.yml`, entrées du workflow, PostgreSQL, seeds, auto-connexion, paquets système |
| **[Applications à SPA](docs/spa.md)** | React/Vue/Vite sous un préfixe d'URL, auto-connexion par jeton |
| **[Assets](docs/assets.md)** | Tailwind, dart-sass, chaînes npm : pourquoi un étage amd64 |
| **[Fonctionnement](docs/fonctionnement.md)** | modèle d'exécution, trajet d'une requête, cache des artefacts, dépôts |
| **[Développement](docs/developpement.md)** | tester en local, republier la base, construire à la main, arborescence |
| **[Retour d'expérience](docs/retour-experience.md)** | les défis résolus — la mémoire du projet |
| **[Architecture du code](docs/architecture.md)** | par où commencer à lire les 17 000 lignes |
| **[Décisions (ADR)](docs/decisions/)** | pourquoi les choix structurants ont été faits |
| **[Modèle de menace](SECURITY.md)** | ce qui est protégé, ce qui ne l'est pas |
| **[Contribuer](CONTRIBUTING.md)** · **[Chantiers ouverts](docs/chantiers.md)** | comment aider |

---

## Licences tierces

railsbox est sous licence MIT ([`LICENSE`](LICENSE)). Il vendorise l'émulateur
[v86](https://github.com/copy/v86) (BSD 2-Clause,
[`public/vendor/v86/LICENSE`](public/vendor/v86/LICENSE)) et les firmwares qu'il
embarque : SeaBIOS (`seabios.bin`, LGPLv3) et le VGABIOS de Bochs
(`vgabios.bin`, LGPL). Les rootfs publiés dans `railsbox-assets` contiennent des
logiciels libres (Linux, Ruby, Rails…) sous leurs licences respectives.

## Contribuer

railsbox n'a qu'un mainteneur. Ces trois portes existent pour que ça change —
elles se lisent dans cet ordre :

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — monter un environnement (trois niveaux,
  du plus léger au plus coûteux), quels tests jouer selon ce qu'on touche, où
  vivent les décisions, conventions et processus.
- [`docs/architecture.md`](docs/architecture.md) — la carte du code : les six
  fichiers qui portent l'essentiel, et le trajet complet d'une requête HTTP du
  clic du visiteur jusqu'à Puma et retour.
- [`docs/chantiers.md`](docs/chantiers.md) — huit chantiers ouverts, chacun avec
  son contexte, ses fichiers et un critère de réussite vérifiable.

Pour signaler quelque chose, les gabarits d'issue demandent ce qui permet de
diagnostiquer : une sandbox tourne entièrement dans l'onglet du visiteur, il n'y
a aucun journal serveur à consulter. Une faille se signale en privé (onglet
Security du dépôt), jamais par une issue publique — voir
[`SECURITY.md`](SECURITY.md).
