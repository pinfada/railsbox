# Contribuer à railsbox

Merci de votre intérêt ! Ce document décrit ce qu'il faut savoir pour changer
quelque chose ici sans se cogner : comment monter un environnement, quels tests
jouer selon ce qu'on touche, où vivent les décisions, et par quelles portes
passer.

Deux compagnons :

- [`docs/architecture.md`](docs/architecture.md) — la carte du code : les six
  fichiers qui portent l'essentiel, et le trajet complet d'une requête HTTP du
  clic du visiteur jusqu'à Puma et retour. **Lisez-le avant votre première
  modification.**
- [`docs/chantiers.md`](docs/chantiers.md) — huit chantiers ouverts, avec leur
  contexte, les fichiers concernés et un critère de réussite vérifiable.

Le projet est écrit **en français** : commentaires, documentation, décisions,
messages d'erreur, messages de commit. C'est un choix assumé et non un oubli —
l'essentiel du raisonnement de ce dépôt vit dans ses commentaires, et une
traduction diverge au premier correctif. Les gabarits d'issue acceptent
l'anglais, et rendre l'entrée praticable sans lire le français est
[un chantier ouvert](docs/chantiers.md#7-rendre-le-projet-lisible-sans-lire-le-français).

## Monter un environnement

Il y a trois niveaux d'installation, de plus en plus coûteux. **Commencez par le
premier** : la majorité du code du dépôt s'y modifie et s'y teste entièrement.

### Niveau A — Node seul (quelques secondes)

```bash
npm install
npm run check    # lint + format + typecheck + 370 tests unitaires
npm start        # serveur de dev sur http://localhost:8080
```

Aucun artefact, aucun Docker, aucun réseau. Ce niveau suffit pour tout ce qui
est logique pure — et c'est là que vit l'essentiel : codecs série et HTTP,
logique du proxy, bocal à cookies, cache d'artefacts, auto-détection,
classifieur d'échecs, configuration v86, veille d'onglet.

`npm start` sert la coquille, mais **la VM ne bootera pas** sans artefacts dans
`public/disks/` : la page le dit et s'arrête là.

### Niveau B — plus un navigateur (quelques minutes)

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

Exerce le **vrai** `sw-proxy.js` dans un vrai navigateur : installation du
Service Worker, isolation cross-origin, bocal à cookies, cache d'artefacts, page
hôte, page de navigateur non pris en charge. Les specs qui exigent une VM
s'ignorent proprement — c'est le comportement voulu.

C'est le niveau minimum pour toucher au Service Worker : sa logique pure est
testée au niveau A, mais son câblage événementiel n'existe que dans un
navigateur.

### Niveau C — plus des artefacts VM (Docker, WSL2/Linux root, ~1 h)

Nécessaire seulement pour `npm run test:integration` et pour les specs VM de
`npm run test:e2e`. Le cycle complet, sur l'application de démonstration :

```bash
# 1. Le rootfs de base est RÉASSEMBLÉ depuis les morceaux publiés, jamais
#    reconstruit : un ext2 refabriqué aurait d'autres UUID et horodatages, et
#    l'instantané capturé dessus divergerait (ADR 0002).
mkdir -p public/disks
node tools/build-v86-image/assemble-artifact.mjs \
  https://pinfada.github.io/railsbox-assets/base-3.3-r2/base-3.3-r2.ext2.zst \
  --out public/disks/base-3.3-r2.ext2
curl -sSfL https://pinfada.github.io/railsbox-assets/base-3.3-r2/base-3.3-r2-vmlinuz \
  -o public/disks/base-3.3-r2-vmlinuz
curl -sSfL https://pinfada.github.io/railsbox-assets/base-3.3-r2/base-3.3-r2-initrd \
  -o public/disks/base-3.3-r2-initrd
curl -sSfL https://pinfada.github.io/railsbox-assets/base-3.3-r2/base-3.3-r2-state.bin.gz \
  -o public/disks/base-3.3-r2-state.bin.gz
gunzip -kf public/disks/base-3.3-r2-state.bin.gz

# 2. Le disque applicatif (Docker, root : les uid doivent être préservés).
#    Sous Linux, remplacez « wsl -u root -e bash » par « sudo -E bash ».
wsl -u root -e bash tools/build-v86-image/build-app-disk.sh \
  tools/demo-app/demo --name demo --base ghcr.io/pinfada/railsbox-base:3.3-r2

# 3. Le delta d'instantané : restauration de la base, montage du hdb,
#    démarrage de Puma, puis gel de la mémoire.
node tools/build-v86-image/make-delta-snapshot.mjs --name demo --base base-3.3-r2

npm run test:integration
```

Comptez ~9 min pour le réassemblage seul, et 1,4 Go sur votre disque. Rendre ce
niveau accessible sans Docker est
[le chantier n° 2](docs/chantiers.md#2-développer-sans-construire-une-image-de-14-go).

Si vous ne pouvez pas monter ce niveau, **dites-le simplement dans votre PR** :
c'est une information utile, pas un aveu. La CI et le mainteneur prennent le
relais.

## Quels tests jouer selon ce qu'on touche

Quatre niveaux, quatre coûts, quatre choses prouvées. Ils ne se remplacent pas.

| Niveau                      | Commande                  | Ce qu'il prouve                                                                         | Coût     |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------------------- | -------- |
| **N1 — unitaires**          | `npm test`                | Toute la logique pure : décisions, codecs, classement, validation.                        | ~1 s     |
| **N2 — E2E navigateur**     | `npm run test:e2e`        | Ce qui n'existe que dans un navigateur : Service Worker réel, isolation, cookies, cache. | ~1 min   |
| **N3 — intégration VM**     | `npm run test:integration`| Le protocole série complet contre une **vraie VM v86** sous Node : corps de 1 Mo, `ENV`/`RST`, montage base + application. | ~1 min (artefacts requis) |
| **N4 — recette en ligne**   | `npm run test:live`       | La sandbox **publiée**, à son URL réelle : chemins relatifs, absence de 404, aucune origine externe, aucun préflight, et une **écriture** réelle (billet créé, jeton CSRF compris). | ~2 min, réseau |

`npm run check` (= N1 + lint + format + typecheck sur trois cibles) est **la

`npm run check` inclut `npm run lint:shell` : shellcheck relit les scripts de
construction. Il utilise le binaire du système s'il est là, sinon Docker ; faute
des deux, il refuse au lieu de laisser croire que le contrôle a eu lieu. Ce
contrôle existe parce qu'un « 
 » littéral introduit par une fusion a fait
perdre à docker son argument de contexte, sans qu'aucun des tests le voie.
porte** : c'est exactement ce que joue la CI, et il doit être vert avant tout
commit.

Ce qu'il faut jouer, en pratique :

| Ce que vous touchez                                            | Jouez au minimum             |
| -------------------------------------------------------------- | ---------------------------- |
| `tools/detect/`, `classifier-echec.mjs`, `shared/*.js` (logique) | N1                           |
| `public/sw-proxy.js`, `public/main.js`, `public/index.html`      | N1 + N2, et N4 si vous le pouvez |
| `shared/serial-codec.js` ou `base/rib/serial-bridge.py`          | N1 + N3 (les deux bouts du protocole doivent rester d'accord) |
| `public/vm/v86-vm.js`, `shared/v86-config.js`, `vm-harness.mjs`  | N1 + N3                      |
| Les workflows, la chaîne de construction                          | N1, puis « Valider les variantes » à la demande |

Une remarque qui n'est pas une formalité : **N4 est le seul niveau qui ait
jamais trouvé les défauts de publication**. Référence absolue qui sort d'un
Pages de projet, CSP qui bloque l'origine de la base, préflight CORS refusé en
405, cookie qui ne circule plus et fait répondre 422 à toute écriture — aucun de
ces quatre défauts n'était visible en local, et la recette les a tous trouvés.

Contre une sandbox autre que la démonstration de référence :

```bash
RAILSBOX_SANDBOX_URL=https://compte.github.io/depot/ npm run test:live
```

Sur d'autres moteurs (Chromium seul par défaut) :

```bash
RAILSBOX_MOTEURS=tous            npm run test:live
RAILSBOX_MOTEURS=firefox,webkit  npm run test:e2e
```

Sur un autre port que 8091 — **indispensable si deux copies du dépôt (arbres de
travail git) testent en même temps** : `reuseExistingServer` brancherait sinon
la seconde suite sur le serveur de la première, qui lui servirait *son*
`sw-proxy.js`, en silence.

```bash
RAILSBOX_PORT=8097 npm run test:e2e
```

## Où vivent les décisions

Les choix d'architecture et leurs **mesures** vivent dans
[`docs/decisions/`](docs/decisions/) — quatre ADR à ce jour. Ils ne sont pas
décoratifs : ils portent les chiffres qui ont tranché, et
[`docs/architecture.md`](docs/architecture.md) y renvoie plutôt que de les
paraphraser.

Un changement qui **contredit** un ADR n'est pas interdit : il demande un
nouvel ADR, joint à la PR, qui cite celui qu'il remplace et porte les mesures
qui le justifient. C'est la forme qu'ont prise les existants — l'ADR 0003 annule
deux conséquences de l'ADR 0001, et le dit en tête de fichier.

Le modèle de menace vit à part, dans [`SECURITY.md`](SECURITY.md). Son tableau
« Ce qui est activement défendu » énumère les frontières ; **si votre changement
en déplace une, mettez le tableau à jour dans le même commit.** Une faille se
signale en privé (onglet Security du dépôt), jamais par une issue publique.

## Proposer une nouvelle variante du panel

Le panel de variantes est le filet anti-régression des chemins de construction
que la CI ordinaire ne peut pas exercer. Quatre variantes couvrent aujourd'hui
quatre chemins distincts :

| Variante        | Chemin couvert                                                    |
| --------------- | ------------------------------------------------------------------ |
| `demo`          | sqlite3, assets précompilés dans le guest i386                      |
| `demo-pg`       | cluster PostgreSQL embarqué dans le disque applicatif               |
| `demo-tailwind` | assets amd64, gem à variante « ruby » (`tailwindcss-ruby`)          |
| `demo-dartsass` | assets amd64, gem **sans aucun** binaire i386 (`sass-embedded`)     |

Une variante n'est **pas une seconde application** : c'est une **surcouche** de
`tools/demo-app/demo/`, réduite aux fichiers qui changent. Dupliquer les
cinquante fichiers d'un `rails new` pour en modifier quatre ferait diverger les
démos au premier correctif.

Pour en ajouter une :

1. `tools/demo-app/demo-<nom>/` — uniquement les fichiers qui diffèrent
   (`Gemfile`, `Gemfile.lock`, `config/database.yml`, `db/seeds.rb`,
   `package.json`… selon le chemin visé).
2. `tools/demo-app/preparer-demo-<nom>.sh` — sur le modèle de
   `preparer-demo-pg.sh` : il matérialise `demo/` puis la surcouche dans un
   dossier temporaire et **écrit le chemin sur la sortie standard**, le reste
   sur la sortie d'erreur.
3. Une entrée dans le tableau `PANEL` de `tests/panel-variantes.test.mjs`. Ce
   tableau **est le contrat** : le modifier doit être un acte délibéré. Le test
   final vérifie d'ailleurs que les variantes couvrent des chemins réellement
   **distincts** — une variante qui converge avec une autre ne prouve rien.
4. Un test d'intégration `tests/integration/vm-<nom>.it.mjs`, sur le modèle de
   `vm-tailwind.it.mjs`. Il doit vérifier un symbole qui n'existe **que si** le
   chemin visé a été emprunté, pas la simple présence d'un fichier.
5. Une entrée de matrice dans `.github/workflows/valider-variantes.yml`.

Justifiez le chemin couvert dans la PR : une cinquième variante qui refait ce
que fait `demo` coûte une heure de runner par semaine pour rien.

## Publier une base

La base est le rootfs mutualisé partagé par **toutes** les sandboxes. Un
artefact central, immuable et versionné (ADR 0004) : le runner de chaque
mainteneur en tire son disque applicatif, et des sandboxes déjà publiées
l'épinglent.

**Nommage.** `<série Ruby>` pour la première base d'une série, puis
`<série Ruby>-r<N>` pour ses révisions successives : `3.3` vaut donc r1, et la
révision courante est `3.3-r2` (celle qui a introduit PostgreSQL). Une révision
paraît dès que le **contenu** de la base change — paquet ajouté, script d'init
modifié.

**Immutabilité.** On ne réécrit jamais un tag déjà consommé. Le workflow
refuse explicitement de republier une version existante, sauf coche
`overwrite` — à ne cocher qu'en connaissance de cause, des sandboxes peuvent
déjà l'épingler.

**Publication additive.** Les artefacts partent sur la branche `gh-pages` du
dépôt d'assets : le workflow récupère l'état publié, y ajoute le répertoire de
**cette** version, puis écrase l'historique par un commit unique contenant
**tout**. Les versions coexistent — c'est la condition de l'immutabilité
promise — et l'historique ne grossit jamais. Une branche orpheline naïve
effacerait au contraire les versions précédentes et casserait les démonstrations
qui les épinglent.

**Comment.** Workflow « Publier la base »
([`publier-base.yml`](.github/workflows/publier-base.yml)), déclenché à la main,
~4 min sur un runner. Avant de publier, il vérifie — et refuse si l'un échoue :

- `RUBY_PLATFORM` vaut bien `i686-linux` et le binaire est de l'ELF32 / Intel
  80386 (sans la personnalité `linux32`, Ruby s'étiquette
  `x86_64-linux-x32`, une plateforme fantôme qui fausse la résolution de
  RubyGems) ;
- les scripts et fichiers attendus de `/opt/rib` sont présents ;
- **aucun cluster PostgreSQL ne subsiste dans le rootfs** — il pèserait sur tous
  les visiteurs, y compris ceux qui n'utilisent pas PostgreSQL ;
- le cycle de vie complet du cluster (`initdb`, démarrage, arrêt) se rejoue
  proprement dans la base ;
- les morceaux publiés se réassemblent exactement à la taille d'origine.

Cochez `push: false` pour construire et vérifier sans rien publier. Toute
proposition qui ajoute un paquet à la base doit dire ce qu'elle **coûte** :
le rootfs est téléchargé par chaque visiteur de chaque sandbox.

## Conventions

### Nommage

- **Identifiants de code** (variables, fonctions, constantes) : **anglais**.
- **Textes affichés, classes CSS, attributs `data-*`** : **français** (produit
  francophone). Les commentaires expliquent le _pourquoi_, en français.

### Style

- Prettier formate tout (`npm run format`) ; ESLint et `tsc --checkJs`
  doivent être verts (`npm run check`) avant tout commit.
- Les API publiques (fonctions exportées) portent une annotation JSDoc.
- Fichiers courts et cohésifs (≤ 400 lignes en cible, 800 max) ;
  pas d'imbrication au-delà de 4 niveaux ; retours précoces.
- Les erreurs sont gérées explicitement — jamais avalées en silence.
- **La logique pure sort du navigateur.** `sw-proxy.js` ne garde que le câblage
  événementiel ; tout ce qui se décide se décide dans `public/shared/`, où cela
  se teste sans navigateur. Un correctif qui ajoute une décision directement
  dans `sw-proxy.js` sera renvoyé vers `shared/`.

### Sécurité

- Tout ce qui entre dans la VM passe par `public/shared/request-codec.js`
  (frontière de validation). Ne jamais interpoler de contenu non échappé
  dans du HTML (voir `escapeHtml` de `sw-proxy.js`).
- Aucun secret en dur. Les valeurs factices générées doivent être
  visiblement factices ou aléatoires par session.
- Les entrées d'un workflow ne s'interpolent **jamais** dans un bloc `run` :
  elles transitent par l'environnement, où le shell les traite comme des
  données. Voir les commentaires de `construire-sandbox.yml`, qui explique
  pourquoi elles y sont aussi assainies au `tr -c`.

### Tests

- Toute nouvelle logique pure arrive avec ses tests (`tests/*.test.mjs`,
  AAA : Arrange, Act, Assert). Les correctifs de bug ajoutent d'abord le
  test qui échoue.
- Un test qui s'ignore faute d'artefacts est **normal en local** et **mortel en
  CI** : il ressemble trait pour trait à un test réussi. Un workflow qui exerce
  un chemin doit exiger la présence de sa condition d'exécution, comme le fait
  `valider-variantes.yml` avec `test -f …-split-config.json`.

### Commits

Format conventionnel : `<type>: <description>` avec
`feat, fix, refactor, docs, test, chore, perf, ci`.

## Ouvrir une issue, ouvrir une PR

- **Une sandbox publiée est cassée** → le gabarit dédié. Il demande ce qui
  permet de diagnostiquer : URL, version de base épinglée, moteur, journal de
  boot, sortie de la recette en ligne. Nous n'avons aucun journal serveur à
  consulter — tout est dans votre onglet.
- **Votre stack n'est pas prise en charge** → le gabarit dédié. Il demande le
  rapport de `node tools/detect/cli.mjs`, les extraits utiles du `Gemfile.lock`,
  l'adaptateur et la chaîne d'assets.
- **Tout le reste** — idée, question, défaut du dépôt — passe par une issue
  vierge : un formulaire n'y apporterait rien.
- **Une faille** → signalement privé (onglet Security), jamais une issue
  publique.

Le [gabarit de PR](.github/PULL_REQUEST_TEMPLATE.md) demande la porte de
qualité et le niveau de test joué. Laissez décoché ce que vous n'avez pas pu
lancer : une case honnêtement vide vaut mieux qu'une case cochée par principe.

## Structure du dépôt

Arborescence : section « Arborescence » du [README](README.md).
Carte de lecture : [`docs/architecture.md`](docs/architecture.md).
