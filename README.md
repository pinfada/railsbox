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

Pendant l'attente, une barre nomme l'étape en cours et compte les secondes
(« Étape 5/5 · Rendu de la première page par la VM · 31 s »). Elle existe
parce que la mesure sous processeur bridé l'exigeait : la dernière phase, entre
badges tous verts et première page affichée, dure 1 s sur une machine de bureau
mais jusqu'à 14 s sur un appareil lent — sans rien qui distingue « ça arrive »
de « c'est bloqué ».

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
JWT](#recette--auto-connexion-dun-spa-qui-sauthentifie-par-jwt-devise-jwt)), et
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
| **Autres bibliothèques système** | installées en surcouche sur le disque applicatif — voir « [Bibliothèques système](#bibliothèques-système) » et [l'ADR 0006](docs/decisions/0006-bibliotheques-systeme.md) |

### Limites connues

| Limite | État |
| --- | --- |
| **PostgreSQL** | **branché** sur la voie découplée : le serveur vit dans la base (à partir de la révision `3.3-r2`), le répertoire de données sur le disque applicatif, et le cluster ne démarre qu'après le montage de celui-ci. Exige une base `3.3-r2` ou plus récente — la construction refuse explicitement une base antérieure. Voir « [PostgreSQL](#postgresql) ». |
| **Tailwind, dart-sass** | **pris en charge** : précompilés sur un étage amd64, puis copiés dans le disque i386 (le guest n'exécute jamais ces binaires). Tailwind est validé **de bout en bout** — variante `demo-tailwind`, boot d'une VM v86 réelle, feuille compilée servie par le guest — et rejoué par le workflow [`valider-variantes.yml`](.github/workflows/valider-variantes.yml). dart-sass a désormais son propre banc d'essai (`demo-dartsass`), plus strict encore : `sass-embedded` ne publie aucun binaire i386 là où `tailwindcss-ruby` offre une variante « ruby ». |
| **Chaînes npm** (esbuild, cssbundling) | **pris en charge** par le même étage (`npm ci` puis scripts de build). Un verrou yarn/pnpm/bun n'est pas relu : repli sur `npm install`, signalé. |
| **SPA côté client** (React, Vue, Svelte) | **demande une adaptation de votre code** — la seule que railsbox ne puisse pas faire à votre place. L'application est servie sous `/<depot>/app/` ; les helpers Rails suivent ce préfixe, votre JavaScript ne le devine pas. Patron recommandé, avec code copiable : « [Votre application embarque un SPA ?](#votre-application-embarque-un-spa--lisez-ceci-dabord) ». |
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

## Votre application embarque un SPA ? Lisez ceci d'abord

**C'est le seul point d'adaptation que railsbox ne peut pas régler pour vous, et
il touche toutes les applications à interface React, Vue ou Svelte.**

Une sandbox est publiée sur un GitHub Pages **de projet**, donc sous un
sous-chemin : `https://<compte>.github.io/<depot>/`. La coquille garde la racine
et l'application est montée sous `/<depot>/app/`, via `RAILS_RELATIVE_URL_ROOT`.
Rails suit ce préfixe partout — `link_to`, `form_with`, `stylesheet_link_tag`,
`url_for` — parce que ces helpers lisent le `SCRIPT_NAME` de Rack. **Rien de ce
qui est écrit en JavaScript ne le lit** : un `axios.create({ baseURL: '/api/v1'
})`, un `<BrowserRouter>` sans `basename` et un `base:` figé par Vite au build
sortent tous du périmètre servi, et le Service Worker — qui ne proxifie que
`/<depot>/app/` — laisse partir la requête vers GitHub Pages, qui répond 404.

Le remède tient en une idée : **le préfixe n'existe qu'à l'exécution, donc seul
Rails le connaît — il faut le lui faire dire à la page, puis le propager.**

### 1. Exposer le préfixe depuis Rails

Dans le contrôleur qui rend la page hôte du SPA :

```ruby
# app/controllers/pages_controller.rb
# Préfixe public de montage, sans barre finale — chaîne vide dans le cas normal,
# « /<depot>/app » sous railsbox. C'est la seule source de vérité.
def spa_url_root
  Rails.application.config.relative_url_root.to_s.chomp('/')
end
helper_method :spa_url_root
```

Puis dans la vue, avant le bundle :

```erb
<%# app/views/pages/react_app.html.erb %>
<script>
  window.railsData = {
    basePath: '<%= spa_url_root.presence || "/" %>'
  };
</script>
```

### 2. Le lire côté JavaScript, à un seul endroit

```js
// src/lib/railsData.js
/** Préfixe de montage sans barre finale, ou chaîne vide à la racine. */
export function getMountPrefix() {
  const basePath = window.railsData?.basePath
  if (!basePath || basePath === '/') return ''
  return basePath.replace(/\/+$/, '')
}

/** `basename` attendu par React Router : le préfixe, ou `/` à la racine. */
export function getRouterBasename() {
  return getMountPrefix() || '/'
}
```

Hors sandbox, `basePath` vaut `/`, `getMountPrefix()` rend `''` et **tout le
code ci-dessous se comporte exactement comme avant**. C'est ce qui rend
l'adaptation acceptable en production : elle est inerte quand le préfixe est
vide.

### 3. Propager à axios et au routeur

```js
// src/services/api.js
import axios from 'axios'
import { getMountPrefix } from '../lib/railsData'

const prefixe = getMountPrefix()
const api = axios.create({
  baseURL: prefixe ? `${prefixe}/api/v1` : '/api/v1',
})
```

```jsx
// src/main.jsx
import { BrowserRouter } from 'react-router-dom'
import { getRouterBasename } from './lib/railsData'

<BrowserRouter basename={getRouterBasename()}>
  <App />
</BrowserRouter>
```

Vue Router : `createWebHistory(getRouterBasename())`. SvelteKit : `paths.base`,
qui se fixe au build — même problème que Vite ci-dessous.

### 4. Le cas Vite : `base` est figé au build

`base` est résolu au moment du `vite build`, avant que quiconque sache sous quel
préfixe l'application sera servie. Un `base: '/dist/'` produit un
`public/dist/index.html` dont le `<script src>` et le `<link rel=stylesheet>`
pointent sur `/dist/assets/…` — hors périmètre — et **grave la chaîne dans le
bundle** : le module d'aide de Vite y contient littéralement
`function(t){return"/dist/"+t}`, utilisé pour les `modulepreload` des morceaux
chargés à la demande.

Deux gestes, complémentaires :

**a. Rails réécrit les URL d'entrée.** Rails rend lui-même la page hôte : c'est
donc à lui d'émettre les balises, en relisant l'`index.html` produit par Vite.

```ruby
# app/controllers/pages_controller.rb
def react_vite_assets
  index_html = File.read(Rails.root.join('public', 'dist', 'index.html'), mode: 'r:UTF-8')
  racine = spa_url_root # vide hors sandbox : les URL sont inchangées
  {
    stylesheets: index_html.scan(%r{<link[^>]+href=["'](?:/dist)?/assets/([^"']+\.css)["']})
                           .flatten.map { |nom| "#{racine}/dist/assets/#{nom}" },
    scripts: index_html.scan(%r{<script[^>]+src=["'](?:/dist)?/assets/([^"']+\.js)["']})
                       .flatten.map { |nom| "#{racine}/dist/assets/#{nom}" },
  }
end
```

```erb
<% @vite_assets.fetch(:stylesheets).each do |chemin| %>
  <link rel="stylesheet" crossorigin href="<%= chemin %>">
<% end %>
<% @vite_assets.fetch(:scripts).each do |chemin| %>
  <script type="module" crossorigin src="<%= chemin %>"></script>
<% end %>
```

**b. `base: './'` pour le reste.** Les morceaux se référencent déjà entre eux par
spécificateur relatif (`import … from "./react-CRZGu1RB.js"`), donc ils se
chargent quel que soit le préfixe. Ce qui reste absolu, ce sont les
`modulepreload` des morceaux différés. Un `base: './'` fait résoudre ces URL
contre celle du module importateur — donc contre le préfixe réel — au lieu d'une
chaîne figée :

```js
// vite.config.ts
export default defineConfig({
  base: './', // au lieu de '/dist/' : plus rien d'absolu dans le bundle
})
```

Si vous devez garder un `base` absolu, lisez `import.meta.env.BASE_URL` plutôt
que de réécrire un chemin en dur, et **préférez toujours un import relatif** à
une URL construite à la main.

### Comment vérifier

Ouvrez la sandbox publiée, onglet réseau : **toute requête dont le chemin ne
commence pas par `/<depot>/app/` est un appel à corriger**. C'est le test le
plus rapide — le Service Worker ne voit rien d'autre, et un 404 de GitHub Pages
ne ressemble pas à une erreur d'application.

Sous le capot, le détail de ce que `RAILS_RELATIVE_URL_ROOT` préfixe et ne
préfixe pas : « [`RAILS_RELATIVE_URL_ROOT` ne préfixe que les
assets](#rails_relative_url_root-ne-préfixe-que-les-assets) ».

---

## Configuration

Tout est auto-détecté (version de Ruby, adaptateur de base, chaîne d'assets,
gems natives, services). Vous ne configurez que ce que la détection ne peut pas
deviner.

### `railsbox.yml`

Un fichier à la racine de l'application complète ou corrige l'auto-détection :

```yaml
ruby: 3.3.12 # SÉRIE seulement — voir l'encadré ci-dessous
database: sqlite3 # sinon config/database.yml, puis la gem pg du lock
seed:
  command: "bin/rails db:seed" # exécuté au BUILD, avant la capture d'instantané
  auto_login: "demo@example.com" # le visiteur arrive connecté
env:
  APP_HOST: "http://localhost:8080" # variables exigées par vos initializers
assets:
  scripts: ["build", "build:css"] # scripts npm de build à déclencher
  output: ["public/dist"] # répertoires produits à remonter dans la sandbox
system_packages: [libmagickwand-dev] # paquets Debian que vos gems exigent
exclude: [doc, db/fixtures] # chemins à ne PAS embarquer dans la sandbox
```

Sept clés sont reconnues — `ruby`, `database`, `seed`, `env`, `assets`,
`system_packages`, `exclude` — et toute autre déclenche un diagnostic. Dans le bloc
`assets:`, deux clés sont lues, `scripts` et `output` : toute autre y est
ignorée avec un avertissement. `database` accepte `postgresql` ou `sqlite3`.
Les valeurs `env:` sont traitées comme des **données inertes**, jamais
évaluées au build (voir [`SECURITY.md`](SECURITY.md)).

`assets.output` n'accepte que des chemins **relatifs** à la racine de
l'application, sans `..`, sans chemin absolu et sans caractère qu'un shell
pourrait interpréter : ces valeurs viennent d'un dépôt tiers et finissent dans
des commandes de construction. Tout ce qui échoue à ce contrôle est refusé avec
un diagnostic nommant l'entrée fautive, jamais assaini en silence. La clé
**complète** l'auto-détection au lieu de la remplacer : `public/assets` et
`app/assets/builds` restent exportés quoi qu'il arrive.

#### Ce que le disque applicatif n'embarque pas

Le disque applicatif a une **géométrie fixe de 512 Mo** (ADR 0002). Y déverser
l'arbre du dépôt tel quel est ce qui fait déborder les applications réelles :
sur la première application tierce construite, l'arbre pesait 261 Mo **avant**
le `bundle install`, dont 143 Mo de `vendor/bundle` compilé pour un autre Ruby,
65 Mo de `public/assets` que la construction réémet, et 54 Mo de `.git`.

railsbox fabrique donc un **contexte de construction filtré** — il ne touche
jamais à votre dépôt — d'où sont écartés :

| Chemin                    | Pourquoi                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `.git`                    | la VM n'embarque pas git, et aucune requête Rails ne lit l'historique                                                          |
| `vendor/bundle`           | la construction réinstalle les gems sous `/app/vendor/bundle` **avant** la copie : un bundle versionné ne peut que s'écraser dessus — mort s'il vise un autre Ruby, **cassant** s'il vise le même (binaires x86_64 par-dessus des gems natives i386) |
| `node_modules`            | réinstallé par l'étage amd64 (`npm ci`) ; le guest i386 n'a aucun Node                                                          |
| `tmp`, `log`              | déjà effacés par la construction avant la fabrication de l'ext2                                                                |
| `coverage`                | rapports de couverture, jamais lus à l'exécution                                                                               |
| `.github`, `.idea`, `.vscode` | intégration continue et réglages d'éditeur                                                                                 |
| répertoires de sortie d'assets sous `public/` | **seulement** quand la construction les régénère (`public/assets`, `public/vite`, `public/packs`) |

Trois précautions valent d'être explicites, parce que l'inverse casserait des
applications.

- **`vendor/cache`, `vendor/javascript`, `vendor/assets` sont conservés.** Seul
  `vendor/bundle` part : c'est la sortie de `BUNDLE_PATH`, pas un mécanisme de
  fourniture de gems. Une gem introuvable sur rubygems se livre par
  `bundle package` (`vendor/cache`) ou par un chemin `path:` du Gemfile — deux
  choses que railsbox ne touche pas.
- **`app/assets/builds` n'est jamais écarté.** C'est un chemin de recherche du
  pipeline, donc une **source** : une application peut y versionner un CSS que
  rien ne reconstruit. Sous `public/`, un répertoire de sortie est un artefact ;
  sous `app/`, c'est une source.
- **`public/assets` n'est écarté que si la construction le réémet.** Si aucun
  pipeline n'est détecté, vos assets versionnés sont les **seuls** que la
  sandbox servira : ils restent intacts.

Un `.dockerignore` fourni par votre application est **conservé et appliqué**
par BuildKit, en plus de ce filtrage.

La clé `exclude:` **ajoute** vos propres chemins — un dossier de médias de
démonstration, un jeu de fixtures lourd. Comme `assets.output`, elle n'accepte
que des chemins **relatifs** à la racine, sans `..`, sans chemin absolu et sans
caractère qu'un shell pourrait interpréter : ces valeurs finissent dans une
commande de construction. Les chemins qui **portent l'application** (`app`,
`bin`, `config`, `db`, `lib`, `public`, `vendor`, `Gemfile`, `Gemfile.lock`,
`Rakefile`, `config.ru`) sont refusés avec un diagnostic — visez un sous-chemin
(`public/uploads` plutôt que `public`).

Le journal de construction dit ce qui a été retiré, avec le poids :

```
→ Filtrage du contenu applicatif…
    .git                              54 Mo écartés
    vendor/bundle                    143 Mo écartés
    public/assets                     65 Mo écartés
    (absents du dépôt : node_modules, tmp, coverage, .idea, .vscode)
  Arbre du dépôt 270 Mo → contexte livré au build 10 Mo (260 Mo écartés)
```

Et si la géométrie déborde quand même, le refus **nomme les coupables** au lieu
de se contenter d'un total :

```
✗ Le contenu applicatif (612 Mo) dépasse la géométrie fixe (512 Mo).

  Les plus gros répertoires du contenu livré :
       331 Mo  vendor/bundle/ruby
        94 Mo  opt/systeme/usr
        62 Mo  var/pg
```

#### `ruby:` ne choisit PAS la version de Ruby

L'interpréteur est **compilé dans l'image de base mutualisée** (ADR 0004), qui
est immuable : le disque applicatif ne peut pas en changer. La base `3.3-r2`
fournit **Ruby 3.3.12**, et c'est ce que votre application exécutera quoi que
vous écriviez ici. La clé `ruby:` — comme `.ruby-version` ou la directive
`ruby` du Gemfile — ne pilote que deux choses : la **série**, donc quelle base
est retenue, et l'image `ruby:X.Y.Z-slim` de l'étage amd64 de précompilation
des assets. Pour changer le Ruby du guest, il faut changer de base (entrée
`base:` du workflow).

Corollaire, et c'est le refus le plus utile de la détection : un Gemfile qui
épingle une **égalité stricte** incompatible est refusé **avant** la
construction, pas au milieu du `bundle install` neuf minutes plus tard.

```
- [ruby-version-incompatible] Le Gemfile exige Ruby « 3.3.10 » (source : Gemfile) ;
  la base 3.3-r2 fournit 3.3.12.
  Remède : Relâchez la contrainte du Gemfile (ruby "~> 3.3.10" plutôt que
  ruby "3.3.10"), ou épinglez une base qui fournit la version exigée.
```

Seul ce qui est **réellement** incompatible est refusé : `ruby "~> 3.3.10"`,
`ruby "~> 3.3"`, `ruby ">= 3.1", "< 3.5"` et un `.ruby-version` **seul**
(que Bundler ne fait pas respecter) passent tous. `ruby file: ".ruby-version"`,
lui, est bien une égalité stricte et suit la même règle que l'écriture
littérale.

#### `config.force_ssl` est neutralisé dans le guest

La sandbox n'a **aucune terminaison TLS** : Puma écoute en clair et le pont
série transporte des octets. Une application en `config.force_ssl` — le défaut
d'un `rails new` depuis Rails 7 — répondrait 301 vers https en boucle et
n'émettrait que des cookies `secure`. railsbox dépose donc dans votre arbre
applicatif un initialiseur (`config/initializers/zzz_railsbox_force_ssl.rb`,
généré, gardé par `RAILSBOX_SANDBOX`) qui remet `config.force_ssl` à faux —
comme il le fait déjà pour l'auto-connexion. **Vous n'avez rien à modifier.**

Le rapport d'analyse le mentionne en `[force-ssl-enabled]` (info, pas
avertissement : railsbox s'en charge). Pour observer le comportement d'origine,
désarmez la parade :

```yaml
env:
  RAILSBOX_KEEP_FORCE_SSL: "1"
```

#### `database: sqlite3` pose une vraie `DATABASE_URL`

La construction tourne en `RAILS_ENV=production`. Sans `DATABASE_URL`, une
application dont le bloc `production:` de `config/database.yml` est
PostgreSQL-only lirait ce fichier et ignorerait la clé `database: sqlite3`.
railsbox pose donc `DATABASE_URL=sqlite3:storage/production.sqlite3` — au build
comme au démarrage du guest — ce qui prime sur `database.yml` : l'override est
réel.

Reste une condition que la clé ne peut pas créer : la gem `sqlite3` doit être
**dans le bundle de production**. Le bundle de la VM est installé avec
`BUNDLE_WITHOUT="development:test"` ; une gem rangée dans `group :development`
— cas très courant d'une application déployée sur PostgreSQL — n'y sera pas, et
la détection refuse plutôt que de laisser l'application échouer sur un
`LoadError` dans le navigateur.

`ruby:` choisit une **série**, pas un patch : le patch exécuté dans la VM est
celui de la base. Ce que cela implique pour une contrainte stricte de
`Gemfile` : « [Épingler une version de
Ruby](#épingler-une-version-de-ruby--ce-que-base-permet-et-ce-quil-ne-permet-pas) ».

### Bibliothèques système

La base est mutualisée : son jeu de paquets est figé à sa construction, et
chaque paquet ajouté pèse sur **toutes** les sandboxes. Elle ne porte donc que
le dénominateur commun de Rails — dont `libvips`, processeur de variantes par
défaut de Rails 7+, et ImageMagick, depuis la révision `3.3-r3`.

Tout le reste passe par une **surcouche applicative** : les paquets sont
installés à la construction du disque applicatif (sur le runner, qui a le
réseau), relocalisés sous `/app/opt/systeme`, et remis dans le chemin de
recherche du guest au démarrage. Ils ne coûtent qu'à l'application qui les
demande, et n'exigent aucune nouvelle révision de la base.

La liste se remplit toute seule à partir des gems natives détectées ;
`system_packages:` sert à ce qu'aucune gem ne trahit — un exécutable appelé en
`system()`, un greffon chargé au vol. Ces noms partent dans un `apt-get` : ils
sont validés en liste blanche stricte (grammaire Debian), et une option, un
chemin ou une injection sont refusés avec un diagnostic. La politique complète,
les coûts mesurés et ce qui reste refusé sont dans
[l'ADR 0006](docs/decisions/0006-bibliotheques-systeme.md).

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

> **`auto_login` ouvre une session Warden — et rien d'autre.** Il pose
> l'utilisateur dans Warden et dans la session Rack, ce qui couvre Devise et les
> pages Rails classiques. Il **ne couvre pas l'authentification par jeton** :
> une interface qui lit un JWT dans `localStorage` (devise-jwt, Knock, JWT
> maison) démarre **déconnectée**, session Rails ouverte ou non — elle ne
> regarde pas le cookie. La promesse « le visiteur arrive connecté » vaut pour
> les sessions ; pour les jetons, il faut émettre le jeton et le donner à la
> page. C'est ce que fait la recette ci-dessous.

#### Recette : auto-connexion d'un SPA qui s'authentifie par JWT (devise-jwt)

Trois pièces. **Une** : le fragment émet le jeton et le dépose dans la session.

```yaml
# railsbox.yml
seed:
  command: "bin/rails db:seed"
  auto_login_code: |
    utilisateur = ::User.find_by(email: 'demo@example.com')
    return avertir("aucun utilisateur de démonstration") if utilisateur.nil?
    # Session Warden : couvre les pages Rails servies par des vues.
    connecter(env, utilisateur)
    # Jeton : c'est LUI que l'interface lira. UserEncoder#call(user, scope, aud)
    # renvoie [jeton, charge_utile] ; `aud` reste nil parce que le SPA n'envoie
    # que l'en-tête Authorization, jamais d'en-tête d'audience.
    jeton, _charge = ::Warden::JWTAuth::UserEncoder.new.call(utilisateur, :user, nil)
    # La session est le seul canal disponible : ce fragment s'exécute AVANT
    # l'application, il ne peut pas écrire dans la réponse.
    env['rack.session'][:railsbox_jwt] = jeton
```

**Deux** : la page hôte lit la session et transmet le jeton, une seule fois.

```erb
<%# app/views/pages/react_app.html.erb %>
<script>
  window.railsData = {
    basePath: '<%= spa_url_root.presence || "/" %>',
    jwt: <%= raw(session.delete(:railsbox_jwt).to_json) %>
  };
</script>
```

**Trois** : l'interface range le jeton là où elle le cherche déjà, avant de
monter.

```js
// src/main.jsx, avant createRoot(...)
const jeton = window.railsData?.jwt
if (jeton) localStorage.setItem('auth_token', jeton) // la clé que VOTRE code lit
```

Ce qu'il faut savoir pour l'adapter :

- **Les aides de la convention ne sont pas là.** Avec `auto_login_code`, le
  résolveur d'identifiant (`resoudre`) n'est pas généré : cherchez l'utilisateur
  vous-même en ActiveRecord. En revanche `connecter(env, utilisateur)` et
  `avertir(message)` restent disponibles, et `return` est légal — le fragment est
  recopié dans le corps d'une méthode.
- **Le fragment tourne dans un middleware, en fin de pile**, une seule fois par
  visiteur, avant l'appel à l'application : `env['rack.session']` est déjà en
  place, et toute exception est rattrapée et journalisée sans casser la page.
- **Stratégies de révocation.** Le jeton produit est accepté tel quel par
  `Denylist` (le `jti` n'est dans aucune table tant qu'il n'est pas révoqué) et
  par `JTIMatcher` (le `jti` émis est celui de l'enregistrement). Aucun crochet
  de dispatch supplémentaire n'est nécessaire.
- **`connecter` reste utile** même pour un SPA pur : les pages Devise, un
  ActiveAdmin ou un `/rails/info` embarqués continuent de fonctionner.
- **Autre brique d'authentification ?** Le principe ne change pas : émettez le
  jeton avec l'API de votre gem, déposez-le dans `env['rack.session']`, rendez-le
  dans la page, rangez-le côté client. Seule la première ligne change.

### Entrées du workflow

| Entrée | Défaut | Rôle |
| --- | --- | --- |
| `app-path` | `.` | chemin de l'application Rails dans le dépôt appelant |
| `name` | nom du dépôt | nom court de la sandbox (assaini dans tous les cas) |
| `base` | `3.3-r2` | version de la base railsbox (convient à SQLite comme à PostgreSQL) — **c'est elle qui fixe le Ruby du guest** : `3.3-r2` fournit 3.3.12 |
| `seed` | (détectée) | commande de seed, si vous voulez la forcer |
| `publish` | `true` | publier sur `gh-pages`, ou construire seulement |
| `target-repo` | (le dépôt appelant) | publier ailleurs — exige alors le secret `publish-key` |
| `assets-url` | `https://pinfada.github.io/railsbox-assets` | racine du dépôt d'artefacts |
| `base-image` | `ghcr.io/pinfada/railsbox-base` | image de construction (doit correspondre à `base`) |
| `railsbox-ref` | `main` | version de railsbox utilisée pour construire |
| `railsbox-repo` | `pinfada/railsbox` | dépôt railsbox à utiliser — **mettez-y votre fork** pour vérifier de bout en bout un changement de la coquille ou du proxy |

Secret `publish-key` : clé de déploiement en écriture, **obligatoire** dès que
`target-repo` est renseigné — le jeton du workflow ne vaut que pour le dépôt
courant.

Deux garde-fous refusent explicitement plutôt que de publier une démonstration
qui échouerait au chargement : la limite de **95 Mo par fichier** de GitHub
Pages, et une application dont l'étage amd64 ne produit **aucun** asset (une
application sans CSS est une panne que le visiteur découvrirait à l'affichage).

### Épingler une version de Ruby : ce que `base:` permet, et ce qu'il ne permet pas

`base:` désigne une **série plus une révision** (`3.3-r2`), jamais un patch.
Le patch réellement exécuté dans la VM est celui compilé dans la base au moment
où elle a été publiée (`ARG RUBY_VERSION` dans
`tools/build-v86-image/base/Dockerfile`) : la base `3.3-r2` embarque **Ruby
3.3.12**. Aucune entrée ne permet de demander 3.3.10 plutôt que 3.3.12.

La clé `ruby:` de `railsbox.yml` ne comble pas ce manque, et il vaut mieux
savoir précisément ce qu'elle fait :

| Où | Quel Ruby | Réglé par |
| --- | --- | --- |
| Étage amd64 de précompilation des assets | le patch exact demandé (`FROM ruby:<x.y.z>-slim`) | `ruby:` |
| Runtime i386, dans la VM du visiteur | le patch compilé dans la base | `base:` |

`ruby:` sert donc surtout à choisir la **série**, qui doit correspondre à celle
de la base. Concrètement : une contrainte `~> 3.3.10` dans votre `Gemfile` est
satisfaite par le 3.3.12 de la base ; un `ruby "3.3.10"` strict ne l'est pas, et
c'est `bundle install` qui vous le dira, à l'intérieur de la construction.
**Assouplissez la contrainte du `Gemfile` plutôt que de chercher à figer le
patch** — c'est le seul levier qui existe aujourd'hui.

**Pourquoi il n'y a pas de base par patch, et pourquoi ça ne changera pas.** Une
base n'est pas une étiquette, c'est un **artefact immuable de 1,45 Go**, découpé
en 363 morceaux compressés, plus un noyau, un initrd et un instantané mémoire,
hébergés en permanence sur un GitHub Pages. Publier une base par patch de Ruby
signifierait republier tout cela à chaque sortie de patch — quatre à six par an
et par série, pour deux séries maintenues — et **garder les anciennes pour
toujours**, puisqu'une sandbox déjà publiée pointe sur son artefact par nom.
Le stockage croîtrait sans borne, le cache d'artefacts des visiteurs cesserait
d'être mutualisé — c'est justement le partage d'un rootfs unique qui fait qu'un
visiteur ne télécharge que ~32 Mo — et la matrice de validation (quatre chemins
de construction, trois moteurs de navigateur) serait multipliée par le nombre de
patchs vivants.

Le compromis retenu est donc assumé : **une base par série et par révision,
jamais par patch.** Une démonstration n'est pas un environnement de production,
et un écart de patch dans une série stable n'y change rien d'observable. Si un
patch précis vous est indispensable — un correctif de sécurité que vous voulez
montrer, un bogue du runtime — la voie n'est pas une entrée de workflow, c'est
une **révision de base** : `base-build.sh --ruby <x.y.z>` produit une base
complète, publiée sous une nouvelle révision (`3.3-r3`), que `base:` sait
ensuite désigner. Voir « [Republier la base](#republier-la-base) ».

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

Sur un diagnostic bloquant (base MySQL, contrainte de Ruby incompatible avec la
base, gem `sqlite3` absente du bundle de production, dossier qui n'est pas une
application Rails), la construction s'arrête et affiche un **rapport
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
  construction. La granularité exacte est le navigateur, pas l'onglet : deux
  onglets d'un même navigateur partagent une sandbox, dont une seule instance
  tourne à la fois.
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

### Les chemins écrits en dur à la racine

Une application référence toujours quelques fichiers **à la racine du domaine**,
sans préfixe : `/favicon.ico`, `/site.webmanifest`, `/robots.txt`, parfois un
`/404.html` ou un fichier de données. Ces chemins échappent au proxy — ils ne
commencent pas par `/app` — et faisaient donc des **404 silencieux**.

La liste des noms à rattraper était écrite en dur dans le Service Worker. Elle
ne pouvait pas connaître ceux d'une application tierce : tout ce qui n'y
figurait pas restait un trou invisible. Elle ne l'est plus.
`tools/extract-assets.sh` relève **chaque fichier présent à la racine du
`public/` de l'image** — un ensemble petit et clos par construction, les
sous-répertoires (`assets/`, `images/`, `dist/`…) n'en font pas partie — les
dépose dans `disks/appstatic/` et écrit à côté un inventaire `index.json` de ce
qui a réellement été extrait. Le Service Worker lit cet inventaire une fois et
s'en sert d'allowlist ; il retombe sur sa liste historique quand l'inventaire
est absent (sandbox construite avant lui).

**Ce qui n'a pas été retenu : proxifier vers la VM les chemins racine
inconnus.** La racine du site est l'espace de la **coquille** — `index.html`,
`main.js`, `sw-proxy.js`, `disks/` — et, sur un Pages de projet, tout ce que le
dépôt publie par ailleurs. Un repli proxifié ferait revendiquer au proxy un
espace qui ne lui appartient pas, ferait voyager le cookie de session sur des
requêtes étrangères à l'application et multiplierait les allers-retours sur le
**tuyau étroit** — précisément sur des requêtes qui sont des 404. Il ne
marcherait même pas : ces fichiers sont demandés pendant le chargement de la
coquille, **avant** que la VM ait booté ; le repli répondrait 503 au lieu de
404. Un trou plus lent, pas un trou bouché.

La résolution retenue ne route donc rien vers la VM : elle ne fait que
rediriger un GET same-origin vers un autre chemin statique de la même origine,
sous `disks/appstatic/`, après un contrôle de **forme** (un seul segment, une
extension, aucun caractère qui puisse construire un autre chemin). Et les noms
que la coquille sert elle-même sont exclus en dur, quoi que dise l'inventaire :
une application qui embarquerait un `public/main.js` ne peut pas prendre la
place du chargeur qui pilote la VM.

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

### Ce que l'étage amd64 remonte dans la sandbox

L'étage n'exportait longtemps que `public/assets` et `app/assets/builds`. C'est
le compte exact pour sprockets/propshaft et pour `jsbundling-rails` — et pour
personne d'autre. `vite_rails` écrit dans `public/vite`, Shakapacker dans
`public/packs`, un `vite build` nu dans ce que dit sa configuration. Ces bundles
partaient à la poubelle **sans que rien n'échoue** : la construction
réussissait, la sandbox bootait, et le SPA manquait à l'affichage. Le garde-fou
« aucun asset produit → interruption » ne l'attrapait pas, puisque Tailwind,
lui, avait bien produit ses fichiers.

Trois dispositifs répondent à cette panne, du plus automatique au plus explicite.

**1. L'auto-détection**, qui couvre le cas courant sans que le mainteneur écrive
quoi que ce soit :

| Ce qu'elle trouve | Ce qu'elle ajoute à l'export |
| --- | --- |
| `vite_rails` / `vite_ruby` dans le Gemfile.lock | `public/vite` |
| `shakapacker` / `webpacker` | `public/packs` |
| `config/vite.json` (`publicOutputDir`) | le répertoire déclaré, tous environnements confondus |
| `config/shakapacker.yml` (`public_output_path`) | idem, ancres YAML comprises |

**2. `assets.output`**, l'échappatoire, pour ce que personne ne peut deviner —
un `vite build` appelé directement, un script maison :

```yaml
assets:
  scripts: ["build:css", "build:react"]
  output: ["public/dist"]
```

**3. L'avertissement de fin d'étage**, la garde qui rattrape les deux autres.
Juste avant de lancer les scripts, l'étage pose un repère temporel ; juste
après, il relève les répertoires qui ont été écrits et ne seront pas exportés,
et les nomme :

```
⚠ Répertoires produits par les builds mais NON exportés vers la sandbox :
    public/dist
  Leur contenu reste sur l'étage amd64 : la sandbox servira la version
  versionnée dans le dépôt, ou rien du tout. Déclarez-les dans railsbox.yml :
    assets:
      output: [public/dist]
```

C'est un **avertissement**, pas un refus : un répertoire produit et non exporté
est parfois exactement ce qu'on veut (un rapport de couverture, un cache de
build). La comparaison élague `node_modules`, `.git`, `tmp`, `log`,
`vendor/bundle`, `.bundle`, `storage` et `coverage` — sans quoi elle coûterait
plus cher que ce qu'elle rapporte.

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

Le bocal n'est pas la seule source : l'iframe étant same-origin, un
`document.cookie = "timezone=…"` posé par l'application crée un vrai cookie du
navigateur dont aucune réponse de la VM n'a parlé. Un Service Worker n'ayant
pas de DOM, il les **demande à la page hôte** (`cookies-document-request`) et
les ajoute à l'en-tête sans jamais supplanter les siens. Ce relais a remplacé
un premier essai fondé sur le Cookie Store API, qui n'existait que sur un
moteur sur trois.

Corollaire de sécurité, découvert en revue : ce magasin attache le cookie de
session à **toute** requête que le Service Worker relaie — or un SW prend en
charge les **navigations** vers sa portée quelle qu'en soit l'origine
initiatrice, pas seulement les sous-ressources de ses clients. Un formulaire
hébergé ailleurs pouvait donc écrire dans la VM du visiteur. Le proxy refuse
désormais en 403 — plus strict que le `SameSite=Lax` qu'un navigateur aurait
appliqué de lui-même.

Deuxième leçon, mesurée après coup : ce refus ne tenait d'abord que sur
**Chromium**, parce qu'il ne lisait que des en-têtes. Une navigation
interceptée par un Service Worker n'en porte AUCUN qui parle d'origine sur
Firefox et WebKit (`Sec-Fetch-*` est ajouté après l'interception, sur les trois
moteurs). La règle repose donc sur la **forme** de la requête — `destination`,
`referrer`, `mode` —, renseignée partout : une navigation de premier niveau
n'est jamais l'application, qui ne vit que dans l'iframe de la coquille. Le
relevé complet et la règle exacte sont dans [`SECURITY.md`](SECURITY.md).

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
