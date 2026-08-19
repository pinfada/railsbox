# Configuration

Tout ce qui se déclare : le fichier `railsbox.yml` posé à la racine de votre application, et les entrées du workflow réutilisable.

*Retour au [README](../README.md).*

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
database_prepare: migrate # dépannage : rejoue les migrations au lieu du schéma
seed:
  command: "bin/rails db:seed" # exécuté au BUILD, avant la capture d'instantané
  auto_login: "demo@example.com" # le visiteur arrive connecté
env:
  APP_HOST: "http://localhost:8080" # variables exigées par vos initializers
env_assume_public: [DEMO_TOKEN] # clés de env: assumées publiques — voir plus bas
assets:
  scripts: ["build", "build:css"] # scripts npm de build à déclencher
  output: ["public/dist"] # répertoires produits à remonter dans la sandbox
system_packages: [libmagickwand-dev] # paquets Debian que vos gems exigent
exclude: [doc, db/fixtures] # chemins à ne PAS embarquer dans la sandbox
```

Neuf clés sont reconnues — `ruby`, `database`, `database_prepare`, `seed`,
`env`, `assets`, `system_packages`, `exclude`, `env_assume_public` — et toute
autre déclenche un diagnostic. Dans le bloc `assets:`, deux clés sont lues,
`scripts` et `output` : toute autre y est ignorée avec un avertissement.
`database` accepte `postgresql` ou `sqlite3`, `database_prepare` accepte
`schema` (défaut) ou `migrate`.
Les valeurs `env:` sont traitées comme des **données inertes**, jamais
évaluées au build (voir [`SECURITY.md`](SECURITY.md)).

Elles sont aussi **publiées**. Le bloc `env:` est écrit tel quel dans
`/app/.railsbox/app-env.sh`, à l'intérieur du disque applicatif — celui que le
navigateur de chaque visiteur télécharge et qu'un curieux monte hors ligne. Y
déclarer un `RAILS_MASTER_KEY`, un jeton d'API ou un mot de passe réel, ce
n'est pas le configurer, c'est le publier : le `chmod 600` du fichier n'y
change rien, le visiteur est root dans sa propre VM. La détection refuse donc
la construction (`[env-secret-published]`, bloquant) dès qu'un nom annonce un
secret (`…MASTER_KEY…`, `…SECRET…`, `…PASSWORD…`, `…TOKEN…`, `…API_KEY…`,
`…PRIVATE_KEY…`, `…CREDENTIALS…`, `…ACCESS_KEY…`) ou qu'une valeur porte le
préfixe d'un jeton connu (`ghp_`, `sk_live_`, `AKIA…`, `xoxb-`…). **Mettez une
valeur factice** : une sandbox sert à faire essayer, pas à opérer un service.
Si la valeur est déjà factice — une démonstration porte légitimement un faux
`DEMO_TOKEN` — nommez la clé dans `env_assume_public:`, une entrée par clé.
Il n'y a pas de dérogation globale : ce qu'on assume publier, on le nomme.

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

#### Vos credentials sont remplacés par une paire **jetable**

Votre dépôt versionne `config/credentials.yml.enc` et **pas**
`config/master.key` — c'est ce que fait tout `rails new`, et c'est la bonne
pratique. railsbox ne reçoit donc que la moitié chiffrée d'une paire. Tant que
rien ne lit les credentials, l'absence de clé passe inaperçue ; avec
`config.require_master_key = true` dans votre `production.rb`, elle est fatale :
Rails refuse de démarrer et `assets:precompile` meurt sur *« Missing encryption
key to decrypt file with »*, au milieu du build.

railsbox substitue donc, **dans le contexte de construction seulement et jamais
dans votre dépôt**, une paire NEUVE tirée au hasard : une clé jetable et le
`credentials.yml.enc` qu'elle déchiffre, portant un `secret_key_base` et des
clés `active_record_encryption` inventées pour cette construction.
**Vous n'avez rien à modifier**, et vous ne devez surtout **pas** nous confier
votre vraie clé : le disque applicatif est public (voir
[`SECURITY.md`](../SECURITY.md)), la détection refuse d'ailleurs tout
`…MASTER_KEY…` dans le bloc `env:`.

La contrepartie est explicite : un credential **métier**
(`Rails.application.credentials.stripe.secret`) vaudra `nil` dans la sandbox.
C'est déjà le cas aujourd'hui — le fichier y est indéchiffrable — et c'est le
modèle : une sandbox sert à faire essayer, pas à opérer un service. Une valeur
factice se déclare dans le bloc `env:`.

Deux cas où railsbox ne touche à rien : votre dépôt versionne sa clé (celle-ci
est alors conservée telle quelle, comme pour l'application de démonstration de
railsbox), ou vous avez déclaré `RAILS_MASTER_KEY` dans `env:` — donc nommé dans
`env_assume_public:`, donc assumé de le publier. Pour observer le comportement
d'origine, désarmez la substitution :

```yaml
env:
  RAILSBOX_KEEP_CREDENTIALS: "1"
```

> **Si votre `.dockerignore` exclut la clé, conservez cette ligne.** Rails en
> génère une depuis 7.1 (`/config/master.key`), railsbox conserve le
> `.dockerignore` de votre application, et la paire jetable qu'il écrit y serait
> écartée : les négations nécessaires sont donc ajoutées à la **copie** du
> fichier, jamais à la vôtre.

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

#### Les données amorcées par une **migration** n'arriveront pas

railsbox prépare la base avec `rails db:prepare`. Sur une base **vierge** — le
cas de toute construction — cette tâche charge `db/schema.rb`, c'est-à-dire la
**structure**, puis marque toutes les migrations comme appliquées **sans en
jouer une seule**. Une migration qui insère des données de référence (devises,
rôles, catégories, pays, réglages) ne s'exécute donc jamais, la table reste
vide, et la panne n'éclate que bien plus loin — dans les seeds, sous la forme
d'une validation incompréhensible :

```
Validation failed: Currency XAF non supporté (attendu : )   ← la liste est VIDE
```

L'analyse le dit maintenant **avant** la construction, en nommant les
fichiers :

```
- [data-bearing-migration] 1 migration écrit des données (execute d'un INSERT SQL) :
  db/migrate/20260514210000_create_currencies.rb. railsbox prépare la base avec
  `rails db:prepare`, qui sur une base VIERGE charge db/schema.rb — la structure,
  pas les données — […]
  Remède : Déplacez l'amorçage de ces données dans db/seeds.rb […]
```

**Ce n'est pas une limite de railsbox, c'est un défaut de l'application**, et
c'est pour cela que railsbox ne le corrige pas tout seul : `db/schema.rb` ne
porte pas ces lignes, donc **tout** environnement recréé depuis le schéma
obtient la même table vide — un `rails db:setup` sur un poste neuf, une base de
CI, une review app. railsbox part toujours d'une base vierge : il ne crée pas la
panne, il la **révèle**. La correction durable tient en un déplacement : les
données de référence vont dans `db/seeds.rb`, pas dans une migration.

Reste le cas du mainteneur qui veut publier sa démonstration **maintenant**,
sans toucher à son application. Une clé, en opt-in explicite :

```yaml
database_prepare: migrate # au lieu de db:prepare : db:create db:migrate
```

Elle rejoue **tout** l'historique des migrations à chaque construction. Ce que
cela coûte, et que l'analyse répète en avertissement : c'est plus lent, cela
peut échouer sur une vieille migration qui ne tourne plus sous Rails récent
(sans repli — un choix explicite doit échouer bruyamment), et cela ne répare
**que la sandbox** : l'application reste cassée partout ailleurs.

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

#### Amorcer une vitrine en une commande

Le workflow **ne crée rien** : il pousse. Son jeton n'a de droits que sur le
dépôt courant, il ne peut donc ni créer le dépôt vitrine, ni y poser une clé,
ni s'écrire un secret. Ces gestes vous reviennent — et deux d'entre eux
échouent **en silence** :

- un dépôt vitrine créé **avec** un README garde `main` comme branche par
  défaut, et la page du dépôt restera vide aux yeux des visiteurs : c'est le
  README de la branche par défaut qu'elle affiche, jamais celui de `gh-pages` ;
- GitHub Pages configuré sur `main` (vide) sert un **404 sans aucun message**,
  ni dans Actions, ni dans les réglages.

Un script les enchaîne, depuis votre machine, avec votre authentification
`gh` — aucun jeton supplémentaire à créer, et la clé privée générée est
effacée en fin d'exécution. Il n'exige pas d'avoir cloné railsbox :

```sh
curl -fsSL -o amorcer-vitrine.sh https://raw.githubusercontent.com/pinfada/railsbox/main/tools/amorcer-vitrine.sh
sh amorcer-vitrine.sh <proprietaire/depot-source> <proprietaire/depot-vitrine>
```

(Depuis un clone du dépôt, `sh tools/amorcer-vitrine.sh …` fait exactement la
même chose.) Pas de `curl … | sh` en revanche : le script lit une confirmation
sur l'entrée standard, que le tube occupe déjà — et exécuter un script distant
sans l'avoir sous les yeux serait un mauvais réflexe à installer ici.

Il crée la vitrine vide, génère une paire de clés dédiée, pose la publique en
clé de déploiement écriture, la privée en secret `PUBLISH_KEY`, pousse une
branche `gh-pages` d'attente et **active GitHub Pages dessus** — il n'y a donc
rien à activer après la première construction — puis imprime le workflow à
coller. Il **refuse plutôt que de deviner**, et il refuse **avant** de créer
quoi que ce soit : `gh` non authentifié, dépôt source inaccessible ou dont vous
n'êtes pas administrateur, vitrine visée chez un autre compte personnel,
organisation qui interdit les dépôts publics, vitrine existante que vous
n'administrez pas ou qui n'est pas publique. Une vitrine **déjà amorcée**, elle,
ne l'arrête pas : il reprend là où il faut, et laisse intacte une branche
`gh-pages` existante — y pousser la page d'attente effacerait une démonstration
en ligne.

Un amorçage déjà fait se contrôle sans rien modifier, avec le mode
`--verifier <depot-source> <depot-vitrine>` : il relit la clé de déploiement, le
secret, la branche par défaut et l'état de Pages, et signale ce qui manque.

Les artefacts publiés par la construction — disque applicatif et instantané —
portent l'**empreinte de leur contenu** dans leur nom
(`disks/mon-app-a1b2c3d4e5f6.ext2.zst`,
[ADR 0007](docs/decisions/0007-versionnement-des-artefacts-par-empreinte.md)).
Une URL ne désigne donc jamais deux contenus, et aucun cache — navigateur, CDN,
Service Worker — ne peut resservir le morceau d'une autre construction. Le
rootfs de base, lui, reste nommé par sa révision : il est mutualisé entre toutes
les sandboxes, et l'empreinte casserait ce partage.

Trois garde-fous refusent explicitement plutôt que de publier une démonstration
qui échouerait au chargement : l'absence d'un **inventaire de morceaux**
(`-parts.json`) pour le disque applicatif ou l'instantané, signe qu'une étape de
découpage a été sautée ; un fichier au-delà de la limite de **95 Mo par fichier**
de GitHub Pages ; et une application dont l'étage amd64 ne produit **aucun**
asset (une application sans CSS est une panne que le visiteur découvrirait à
l'affichage).

Le second ne peut plus concerner un artefact de la VM : rootfs, disque
applicatif **et instantané mémoire** sont découpés en morceaux de 4 Mio
([ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)). Un fichier
encore trop gros vient donc de l'application, et le message le dit — il n'y a
rien à découper, il y a quelque chose à alléger.

Ce troisième découpage est récent, et il a une histoire. L'instantané était
publié d'un seul tenant parce que rien n'obligeait à faire autrement : gzippé,
celui de la démonstration pèse 76 Mo. La limite de l'hébergeur était donc
devenue, sans que rien ne le dise, **un plafond de mémoire utilisable** — une
application plus lourde (PostgreSQL, Rails 7.1, un back-office) produit 118 Mo
d'instantané et la construction échouait à la dernière minute des vingt.

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
ensuite désigner. Voir « [Republier la base](developpement.md#republier-la-base) ».

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
