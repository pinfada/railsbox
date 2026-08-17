# Chantiers ouverts

Huit chantiers réellement abordables par quelqu'un qui n'a pas écrit ce dépôt.
Chacun porte son **contexte** (pourquoi il existe, et ce qui le rend faisable),
les **fichiers concernés**, et un **critère de réussite** vérifiable — pas une
intention, une preuve qu'on peut relire dans une PR.

Ils sont classés du plus accessible au plus engageant. Aucun n'est réservé :
annoncez-vous dans une issue avant de commencer, pour ne pas doubler quelqu'un.

Prérequis notés une fois pour toutes :

- **Node seul** — `npm ci` suffit, aucun artefact, aucune VM.
- **Navigateur** — plus `npx playwright install --with-deps chromium`.
- **Docker + WSL2/Linux root** — construction d'un disque applicatif, ~1 h de
  machine pour un cycle complet.

---

## 1. Un banc d'essai pour une chaîne npm réelle

**Coût** : moyen · **Prérequis** : Docker + WSL2/Linux root (ou patience : la CI
le rejoue)

### Contexte

Le panel de variantes couvre quatre chemins de construction — sqlite3/i386,
PostgreSQL, Tailwind (gem à binaire), dart-sass (gem sans aucun binaire i386).
Aucun n'a de `package.json` : les quatre entrées de
`tests/panel-variantes.test.mjs` portent `npm: false`.

Or `tools/detect/assets.mjs` sait déjà classer une chaîne npm (`npmInstallCommand`
choisit `npm ci` ou `npm install` selon le verrou), `assets-amd64.Dockerfile`
sait la faire tourner, et `KNOWN_BUILD_SCRIPTS` liste `build`, `build:css`,
`build:js`. **Tout ce code existe et n'est prouvé par aucun banc d'essai** — un
chemin non exercé est un chemin qui casse en silence, et il casse chez un
mainteneur tiers, une heure après le début de sa construction.

### Fichiers concernés

- `tools/demo-app/demo-esbuild/` (nouvelle surcouche : `Gemfile`,
  `Gemfile.lock`, `package.json`, `package-lock.json`, `app/javascript/`)
- `tools/demo-app/preparer-demo-esbuild.sh` (sur le modèle de
  `preparer-demo-tailwind.sh`)
- `tests/panel-variantes.test.mjs` (cinquième entrée du tableau `PANEL`, avec
  `npm: true` et `scripts: ["build"]`)
- `tests/integration/vm-esbuild.it.mjs` (sur le modèle de `vm-tailwind.it.mjs`)
- `.github/workflows/valider-variantes.yml` (entrée de matrice)

### Critère de réussite

`npm test` fige le manifeste attendu de la nouvelle variante, et le test
d'intégration prouve que le **bundle produit par esbuild sur l'étage amd64** est
bien servi par la VM — comme `vm-tailwind.it.mjs` prouve la présence de
`tracking-[0.35em]` dans le CSS servi. Le test doit vérifier un symbole qui
n'existe QUE si le bundler a tourné, pas la simple présence d'un fichier.

---

## 2. Développer sans construire une image de 1,4 Go

**Coût** : moyen · **Prérequis** : Node seul, puis un navigateur pour vérifier

### Contexte

Aujourd'hui, pour voir la coquille booter en local, il faut construire un
disque applicatif : Docker, WSL2, root, une heure. Rien ne permet de
**récupérer les artefacts déjà publiés**, alors que la CI le fait à chaque
construction : `tools/build-v86-image/assemble-artifact.mjs` réassemble un
artefact depuis ses morceaux zstd publiés, et `curl` suffit pour le noyau,
l'initrd et l'instantané.

Cette absence est la plus grosse marche à l'entrée du projet. Elle a un
corollaire mesurable : `tests/e2e/vm-disks.mjs` exige encore
`jiyufit.ext2` et `jiyufit-state.bin`, des noms de la voie monolithique
héritée. Autrement dit, **même avec des artefacts découpés valides,
`tests/e2e/vm-boot.e2e.spec.mjs` s'ignore** — et un test ignoré ressemble trait
pour trait à un test réussi.

Deux pièges à traiter, sans quoi le script ne servira à rien :

- la configuration publiée référence le rootfs de base en **URL absolue
  cross-origin**, alors que `public/index.html` déclare `connect-src 'self'` :
  la CSP bloquera les XHR de v86 avant même le CORS.
  `tools/build-v86-image/autoriser-origine-base.mjs` fait exactement cette
  ouverture pour les sandboxes publiées ; il est réutilisable ici ;
- le rootfs réassemblé pèse 1,4 Go sur le disque. C'est le prix à payer sans
  Docker — l'annoncer clairement vaut mieux que le laisser découvrir.

### Fichiers concernés

- `tools/recuperer-artefacts.mjs` (à créer)
- `tools/build-v86-image/assemble-artifact.mjs`,
  `tools/build-v86-image/autoriser-origine-base.mjs` (réutilisés)
- `tests/e2e/vm-disks.mjs` (reconnaître les artefacts découpés en plus des noms
  hérités)
- `CONTRIBUTING.md`, `README.md` (la procédure)

### Critère de réussite

Depuis un clone neuf, sans Docker : une seule commande peuple `public/disks/`
depuis une sandbox publiée, puis `npm start` mène aux quatre badges verts, et
`npm run test:e2e` **exécute** `vm-boot.e2e.spec.mjs` au lieu de l'ignorer. Le
script doit refuser proprement — message et code de sortie — si l'URL ne porte
pas de `disks/v86-config.json`.

---

## 3. Construire une sandbox depuis un fork

**Coût** : petit · **Prérequis** : Node seul, plus un fork pour l'essai

### Contexte

`construire-sandbox.yml` récupère le code de railsbox par un
`actions/checkout` figé sur `repository: pinfada/railsbox`. L'entrée
`railsbox-ref` ne choisit donc qu'une **référence de ce dépôt-là** : un
contributeur qui modifie la coquille ou le proxy ne peut pas construire une
sandbox avec son propre code, donc ne peut pas jouer la recette en ligne sur son
changement.

C'est un plafond dur : la recette en ligne est la seule vérification qui ait
jamais trouvé les défauts de publication (référence absolue hors du site, CSP
qui bloque l'origine de la base, préflight refusé en 405, cookie qui ne circule
plus). La rendre inaccessible aux contributeurs revient à réserver au mainteneur
la seule preuve qui compte.

Le correctif tient en une entrée `railsbox-repo` par défaut à
`pinfada/railsbox`, assainie comme les autres entrées du workflow — celles-ci
sont écrites dans le fichier d'environnement d'un job qui porte
`contents: write`, et le workflow explique en commentaire pourquoi `tr -c` y est
appliqué.

### Fichiers concernés

- `.github/workflows/construire-sandbox.yml`
- `.github/workflows/sandbox-demo.yml`
- `.github/PULL_REQUEST_TEMPLATE.md` (la réserve qui y figure disparaît)
- `README.md` / `README.en.md` (entrées du workflow)

### Critère de réussite

Depuis un fork, « Sandbox de démonstration » avec `railsbox-repo` pointant sur
le fork et `target-repo` laissé vide publie sur le `gh-pages` du fork une
sandbox **construite avec le code du fork**, et
`RAILSBOX_SANDBOX_URL=… npm run test:live` est vert dessus. Le défaut par défaut
reste inchangé pour tous les mainteneurs existants.

---

## 4. Classer les échecs de construction que personne n'explique

**Coût** : petit à moyen, par incréments · **Prérequis** : Node seul

### Contexte

`tools/build-v86-image/classifier-echec.mjs` transforme cinq cents lignes de
journal Docker en catégorie, code, remède et extrait probant. Il couvre onze
familles — analyse, dépendance système, image de base, bundle, assets, base de
données, tâche Rails, volumétrie, instantané, publication, infrastructure — et
une douzième, `INCONNU: "inexpliqué"`, qui est l'aveu d'échec du dispositif.

Chaque journal réel tombé dans « inexpliqué » est un chantier autonome de
quelques dizaines de lignes : un motif, un code, un remède à l'impératif, un
test. C'est le point d'entrée le plus court du dépôt, et le plus directement
utile à un mainteneur tiers — un diagnostic qui constate sans dire quoi faire
le renvoie au journal, c'est-à-dire au point de départ.

### Fichiers concernés

- `tools/build-v86-image/classifier-echec.mjs` (`CATEGORIES`, `REMEDES`, motifs)
- `tests/classifier-echec.test.mjs`

### Critère de réussite

Un extrait de journal réel (anonymisé) qui produisait « inexpliqué » produit
désormais une catégorie et un remède **actionnable en une ou deux phrases**, et
le test porte cet extrait. Le remède doit nommer le fichier ou la commande à
changer ; « vérifiez votre configuration » n'en est pas un.

---

## 5. Firefox et WebKit : mesurer, puis décider

**Coût** : moyen · **Prérequis** : navigateur (les trois moteurs Playwright)

### Contexte

L'ADR 0004 se termine par une ligne sèche : « Reste non mesuré : les navigateurs
autres que Chromium. » Le point de vigilance n'a pas bougé. `tests/moteurs.mjs`
prévoit pourtant déjà l'élargissement (`RAILSBOX_MOTEURS=tous`), et
`verifier-sandbox.yml` sait installer les trois moteurs à la demande — mais le
passage hebdomadaire reste sur Chromium, et personne n'a écrit ce qui diverge.

Une divergence est même connue d'avance et non mesurée : le Cookie Store API
(`self.cookieStore`), que `sw-proxy.js` utilise pour relire les cookies posés en
JavaScript par l'application, n'existe ni sur Firefox ni sur WebKit. Le code
retombe alors sur le bocal seul — dégradation assumée, mais dont l'effet réel
sur une application ordinaire n'a jamais été observé.

### Fichiers concernés

- `tests/e2e/*.e2e.spec.mjs`, `tests/live/sandbox-publiee.live.spec.mjs`
- `tests/moteurs.mjs`
- `.github/workflows/ci.yml`, `.github/workflows/verifier-sandbox.yml`
- `README.md` § « Limites connues », `docs/decisions/0004-…` (point de vigilance)

### Critère de réussite

Un tableau moteur par moteur : ce qui passe, ce qui échoue, et pour chaque échec
soit un correctif, soit une limite écrite dans « Limites connues » du README —
pas un test désactivé en silence. Si les trois moteurs passent, la CI gagne une
matrice ; sinon, le README gagne une phrase honnête.

---

## 6. Mesurer sur un vrai téléphone

**Coût** : petit en code, réel en matériel · **Prérequis** : deux téléphones

### Contexte

Le README annonce un boot mobile de 21 à 26 secondes — **mesuré en émulation de
bureau**. Il le dit lui-même et en tire la bonne conclusion : « Comptez le
mobile comme praticable, pas comme garanti. » Deux inconnues restent entières :
un processeur de téléphone réel est plus lent qu'un émulateur de bureau, et la
mémoire d'un onglet mobile est arbitrée par le système, qui peut tuer l'onglet
au moment précis où l'instantané de plusieurs centaines de mégaoctets est
restauré.

C'est le chantier le moins technique et l'un des plus utiles : il ne demande pas
de lire le code, il demande un appareil et une méthode.

### Fichiers concernés

- `tests/e2e/coquille-mobile.e2e.spec.mjs` (ce qui est déjà vérifié en émulation)
- `README.md` / `README.en.md` § « Ce que verront vos visiteurs »

### Critère de réussite

Un tableau de mesures reproductibles : appareil, système, navigateur, temps
jusqu'au badge « Serveur HTTP » vert, et comportement de l'onglet après un
passage en arrière-plan (la VM se met en veille — `public/shared/veille.js` —
mais l'onglet lui-même peut être évincé). Au moins un appareil de milieu de
gamme, pas seulement un modèle récent. La phrase « non mesuré » du README est
remplacée par des chiffres, ou confirmée avec sa raison.

---

## 7. Rendre le projet lisible sans lire le français

**Coût** : moyen · **Prérequis** : Node seul

### Contexte

Le produit s'adresse à des mainteneurs Rails du monde entier — le badge dit
« Try with railsbox », et `README.en.md` existe pour eux. Mais tout le reste du
raisonnement est en français : `CONTRIBUTING.md`, `SECURITY.md`, les quatre
ADR, les commentaires du code, les messages du classifieur d'échecs.

Ce n'est pas un oubli, c'est un choix assumé : un contributeur qui ne lit pas le
français ne peut de toute façon pas relire ce code, dont l'essentiel du
raisonnement vit dans les commentaires. Mais il y a une marche intermédiaire
entre « tout traduire » (intenable : la traduction diverge au premier correctif)
et « rien » : **ce qu'il faut pour ouvrir une PR**. Les quatre niveaux de test,
la porte de qualité, les conventions de commit.

Il y a aussi une dérive à empêcher : les deux README se suivent aujourd'hui
section par section, et rien ne le garantit.

### Fichiers concernés

- `CONTRIBUTING.en.md` (à créer, ou section en anglais de `CONTRIBUTING.md`)
- `README.en.md` (alignement)
- `tests/` (un test qui compare la structure des deux README — même suite de
  titres de niveau 2, dans le même ordre — sur le modèle des tests de contrat
  existants comme `panel-variantes.test.mjs`)

### Critère de réussite

Quelqu'un qui ne lit pas le français peut, sans aide : installer, lancer
`npm run check`, savoir quel niveau de test jouer selon ce qu'il touche, et
ouvrir une PR conforme. Et une divergence de structure entre les deux README
fait échouer `npm test` au lieu de passer inaperçue.

---

## 8. Un adaptateur de plus : mesurer d'abord, décider ensuite

**Coût** : engageant · **Prérequis** : Docker + WSL2/Linux root

### Contexte

`tools/detect/detect.mjs` reconnaît `mysql2` et `trilogy` et les **refuse
explicitement** : la construction s'arrête avec un rapport, plutôt que d'échouer
une heure plus tard sur une gem native qui ne compile pas. C'est la bonne
frontière, mais c'est aussi la limite la plus souvent rencontrée par les
applications réelles.

Le piège est architectural, pas technique. La base est **mutualisée** : son jeu
de paquets est figé à sa construction (`BASE_SYSTEM_PACKAGES` dans
`tools/build-v86-image/split-config.mjs`), et le disque applicatif ne peut rien
y ajouter. Un serveur MariaDB ajouté à la base pèse sur **toutes** les
sandboxes, y compris celles qui ne s'en servent pas — exactement le
raisonnement qui, pour PostgreSQL, a conduit à mettre les binaires dans la base
et le cluster sur le disque applicatif (ADR 0002).

Ce chantier commence donc par une mesure, pas par du code : combien coûte
l'ajout, en taille de rootfs publié, en temps de boot à froid, en taille
d'instantané ? Le chemin est déjà tracé par `publier-base.yml`, qui vérifie
l'architecture déclarée, l'absence de cluster dans le rootfs et le cycle de vie
complet de PostgreSQL.

### Fichiers concernés

- `tools/build-v86-image/base/Dockerfile`, `base/rib/` (cycle de vie du service)
- `tools/build-v86-image/split-config.mjs` (`BASE_SYSTEM_PACKAGES`)
- `tools/detect/detect.mjs` (`SUPPORTED_ADAPTERS`, `UNSUPPORTED_ADAPTERS`)
- `.github/workflows/publier-base.yml` (vérifications de la base)
- `docs/decisions/0005-…md` (à créer)

### Critère de réussite

Un ADR chiffré — poids publié avant/après, temps de boot, taille d'instantané —
et une recommandation argumentée, y compris si elle est « non ». Un « non »
mesuré est un livrable : il ferme une question qui revient, et il donne au refus
de `detect.mjs` une raison à citer. Si c'est un « oui », il s'accompagne d'une
variante de panel et d'un test d'intégration, comme `demo-pg`.

---

## Ce qui n'est pas ici

**ActionCable et les WebSockets** restent hors périmètre : le pont est
requête/réponse par construction. Le README évoque le long-polling comme piste ;
ce n'est pas un chantier de contribution, c'est un changement de modèle qui
demanderait son propre ADR et une refonte du protocole `@RIB1`. Si vous voulez
vous y attaquer, ouvrez d'abord une issue de discussion.

**Les micro-optimisations du chemin chaud série** non plus : `bench-serial.mjs`
mesure déjà ce coût, et les assets — ~90 % du trafic — ne passent plus par le
pont depuis qu'ils sont extraits et servis statiquement. Le gain restant est
faible, et le risque de régression sur un code sans allocation par octet ne
l'est pas.
