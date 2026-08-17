# ADR 0006 — Bibliothèques système : base mutualisée ou surcouche applicative

Date : 2026-08-17 · Statut : accepté

## Problème

Le premier intégrateur tiers (`pinfada/tchopmygrinds`) s'est vu refuser :

```
✗ La base ne fournit pas les bibliothèques système : libvips-dev libvips42
```

`libvips` est la dépendance d'`image_processing`, le processeur de variantes
**par défaut** de Rails 7+ (`config.active_storage.variant_processor = :vips`).
Autrement dit, railsbox refusait toute application Rails moderne qui
redimensionne une image.

Le correctif évident — ajouter libvips à la base — soulève l'objection de fond :
*« si nous faisons du spécifique à chaque fois, les modifications seront sans
fin »*. Elle est juste. La question « quelle bibliothèque système la base
doit-elle contenir ? » n'a pas de réponse stable : après libvips viendraient
ImageMagick, puis ffmpeg, puis libsodium, puis libmagic. Et chaque paquet ajouté
pèse sur **toutes** les sandboxes, y compris celles qui ne s'en servent pas : le
rootfs est mutualisé, publié une fois, et téléchargé par tous les visiteurs.

Il fallait donc trancher deux choses à la fois : le cas libvips, et le mécanisme
qui empêche le cas suivant de se reposer.

## Ce que la mesure dit

Coûts mesurés sur `i386/debian:bookworm-slim`, par-dessus le jeu de paquets de
la base `3.3-r2`. « Base » = taille installée marginale dans le rootfs
mutualisé ; « surcouche » = taille réellement relocalisée sur le disque
applicatif, documentation et manuels retirés.

| Paquet | Base | Surcouche | Gems concernées |
|---|---:|---:|---|
| `libvips42` + `libvips-tools` | +100 Mo | 85 Mo | `ruby-vips`, `image_processing` |
| `imagemagick` | +3 Mo¹ | 41 Mo | `mini_magick`, `image_processing` |
| `poppler-utils` | +0 Mo¹ | — | aperçus PDF d'Active Storage |
| `libsodium-dev` | +1 Mo | — | `rbnacl` |
| `libcurl4-openssl-dev` | +1 Mo | — | `curb`, `patron` |
| `libicu-dev` | +0 Mo¹ | — | `charlock_holmes` |
| `libmagic-dev` | +8 Mo | 8 Mo | `ruby-filemagic` |
| `libmagickwand-dev` | +80 Mo | — | `rmagick` |
| `libvips-dev` | +170 Mo | — | *aucune* (voir ci-dessous) |
| `ffmpeg` | +297 Mo | **623 Mo** | aperçus vidéo d'Active Storage |

¹ marginal une fois `libvips42` présent : ses dépendances (poppler, pango,
cairo, librsvg, ICU) sont déjà tirées.

Deux mesures commandent tout le reste.

**`libvips-dev` ne sert à rien.** `ruby-vips` est une liaison FFI : elle ne
compile aucune extension, elle `dlopen` `libvips.so.42` au premier appel. Les
170 Mo d'en-têtes de toute la pile GLib/GTK n'achèteraient rien. Vérifié : sur
une base sans `libvips-dev`, `gem install ruby-vips` puis `require "vips"`,
redimensionnement et écriture PNG aboutissent (i686-linux, libvips 8.14.1).

**`ffmpeg` ne tient nulle part.** 297 Mo dans un rootfs que tout le monde
télécharge, ou 623 Mo relocalisés sur un disque applicatif dont la géométrie est
figée à 512 Mo (ADR 0002), application et bundle compris. Ce n'est pas un
arbitrage : c'est une impossibilité, et elle est mesurée.

## Décision

### 1. Une surcouche système sur le disque applicatif

`base/app.Dockerfile` construit `FROM ${BASE_IMAGE}` **sur le runner de CI, avec
le réseau** — contrairement au guest, qui n'en a aucun. Un `apt-get install` y
est donc possible. Le seul obstacle était l'emplacement : apt écrit dans `/usr`,
qui vit sur le rootfs de base — disque séparé, immuable, mutualisé — alors que
seul `/app` voyage avec l'application.

D'où la manœuvre, en trois temps :

1. **Installer** normalement, avant `bundle install` : les gems natives
   compilent alors contre les en-têtes fraîchement posées, dans ce conteneur.
2. **Relocaliser** les fichiers des paquets *nouvellement installés* (diff
   `dpkg-query -W` avant/après, puis `dpkg -L`) sous `/app/opt/systeme`, en
   écartant documentation, manuels et traductions.
3. **Activer** dans le guest : `/app/.railsbox/systeme.sh` pose
   `LD_LIBRARY_PATH` et `PATH`, et il est sourcé par `app-env.sh` — que
   `start-app.sh` lit déjà après le montage de `/app`.

Les gems compilées vivent déjà sur le disque applicatif
(`BUNDLE_PATH=/app/vendor/bundle`) et ne réclament que le SONAME à l'exécution :
`LD_LIBRARY_PATH` suffit.

**Conséquence notable : la base n'est pas touchée.** L'activation vit
entièrement sur le disque applicatif, donc la surcouche fonctionne aussi sur les
bases **déjà publiées** — `3.3-r2` comme `3.3`.

Preuve, exécutée de bout en bout avec le vrai `app.Dockerfile` :

| Étape | Résultat |
|---|---|
| Base `3.3-r2` (sans libvips), `require "vips"` | `LoadError: Could not open library 'libvips.so.42'` |
| Disque applicatif construit avec `SYSTEM_PACKAGES="libvips42 libvips-tools"` | 75 paquets, 85 Mo relocalisés, +35 s de construction |
| Même base, **sans réseau**, séquence de `start-app.sh` | `vips-8.14.1`, redimensionnement 64→16 px, PNG écrit, greffons JPEG/PNG/WEBP présents |

### 2. La politique, sous forme de règle et non de liste

La question « faut-il ajouter X à la base ? » a désormais une réponse
déterministe.

**Un paquet entre dans la base mutualisée si et seulement si les deux
conditions sont vraies :**

- **(a) Chemin par défaut.** Une application Rails supportée qui n'a *rien
  configuré de particulier* en a besoin. Le critère n'est pas la popularité mais
  le défaut : `variant_processor = :vips` est le réglage d'usine de Rails 7+,
  donc `libvips` y est ; `rmagick` demande un choix explicite, donc non.
- **(b) Coût marginal mesuré ≤ 100 Mo installés** dans l'image i386, mesuré
  par-dessus la révision précédente.

**Tout le reste passe par la surcouche applicative** : le paquet existe en i386
mais ne sert qu'à cette application. Il ne coûte qu'à elle.

**Est refusé, et seulement cela :**

- un paquet qui n'existe pas dans Debian bookworm i386 (`apt-get` échoue ;
  diagnostic `surcouche-paquet-inconnu`) ;
- une surcouche qui dépasse ce qu'un disque applicatif de 512 Mo peut céder
  sans étouffer l'application (diagnostic `surcouche-trop-lourde`).

Un paquet qui satisfait (a) mais pas (b) — ffmpeg par exemple — reste hors de la
base ET hors de la surcouche : c'est un refus assumé, chiffré, pas un oubli.

### 3. Application de la règle à la révision `3.3-r3`

Entrent dans la base : `libvips42`, `libvips-tools`, `imagemagick`,
`poppler-utils`, `libsodium-dev`, `libcurl4-openssl-dev`, `libicu-dev`.
Total mesuré : **+106 Mo installés, +32 Mo de `.deb`**.

- `libvips42` + `libvips-tools` : (a) oui — défaut de Rails 7+ ; (b) 100 Mo.
  `libvips-tools` apporte `vips`, qui rend la présence vérifiable, pour 0 Mo.
- `imagemagick` : (a) oui — `:mini_magick` est l'autre processeur de variantes
  d'Active Storage, et `image_processing` tire `mini_magick` par construction ;
  (b) 3 Mo.
- `poppler-utils` : (a) oui — aperçus PDF d'Active Storage ; (b) 0 Mo.
- `libsodium-dev`, `libcurl4-openssl-dev`, `libicu-dev` : (b) ≤ 1 Mo chacun.
  (a) est discutable ; à ce prix, l'inclusion est plus honnête que le refus, et
  elle évite trois surcouches de 1 Mo à répétition.

Restent dehors : `libvips-dev` (inutile), `libmagickwand-dev` (80 Mo, `rmagick`
n'est pas un défaut), `libmagic-dev` (8 Mo, Rails détecte les types MIME avec
Marcel, en Ruby pur), `ffmpeg` (impossible, cf. plus haut).

### 4. La clé `system_packages:`

```yaml
system_packages: [libmagickwand-dev, libmagic-dev]
```

Deux sources alimentent la surcouche :

- la table gem → bibliothèques (`tools/detect/gems.mjs`), qui produisait le refus
  et produit désormais la liste à installer ;
- cette clé, pour ce qu'aucune gem ne trahit — un exécutable appelé en
  `system()`, un greffon chargé au vol.

Les deux s'**additionnent** ; aucune n'écrase l'autre.

## Frontière de sécurité

Ces noms viennent d'un dépôt tiers et finissent en arguments d'un `apt-get
install` exécuté sur le runner de CI d'un mainteneur. C'est le seul endroit du
projet où une donnée tierce atteint une commande privilégiée. La validation
(`tools/detect/paquets-systeme.mjs`) est en liste blanche stricte — grammaire de
la charte Debian, premier caractère alphanumérique — et refuse :

| Tentative | Pourquoi elle échoue |
|---|---|
| `-o APT::Get::AllowUnauthenticated=true`, `--force-yes` | le premier caractère doit être alphanumérique : aucune option apt ne peut se déguiser en paquet |
| `libvips42; rm -rf /`, `$(id)`, `` `id` ``, `x\|tee …` | aucun métacaractère de shell n'est admis |
| `/tmp/mechant.deb`, `../../etc/passwd`, `http://…` | aucun chemin ni URL |
| `libvips42=8.0.0-1`, `libvips42/experimental` | ni épingle de version, ni sélection de suite |
| liste de plus de 32 entrées, nom de plus de 100 caractères | bornes dures |

Trois défenses en profondeur s'ajoutent : `extraPackages` revalide (il est
appelable avec un manifeste de provenance quelconque), `app.Dockerfile` refait le
contrôle en shell avant l'appel, et l'`apt-get install` porte un `--` qui ferme
définitivement la lecture d'options. Ce que la validation **ne** garantit pas, et
qu'on assume : un nom valide désigne un paquet quelconque de l'archive Debian
bookworm i386 — archive signée, servie en HTTPS, installée dans un conteneur de
construction jetable.

## Conséquences

- La base ne grossit plus qu'en réponse à un changement du **défaut de Rails**,
  pas en réponse à une application. La révision `3.3-r3` est la dernière du cycle
  « traitement d'images » ; la suivante n'a pas de raison connue d'exister.
- Une application non prise en charge cesse d'être un refus : elle devient une
  surcouche, sans intervention du mainteneur de railsbox.
- La surcouche est plus chère que la base pour un même paquet — 85 Mo sur le
  disque applicatif de *cette* sandbox contre 100 Mo de rootfs mutualisé lu par
  morceaux. Quand une base plus récente fournit ce qui allait en surcouche, la
  construction le dit et conseille l'épingle (`SYSTEM_PACKAGES_HINT`).
- Le disque applicatif de 512 Mo devient la ressource contrainte. Une surcouche
  au-delà de 3/5 de cette taille est refusée à la construction, avec le chiffre.

## Alternatives écartées

- **Ajouter chaque paquet demandé à la base.** C'est l'objection initiale : sans
  fin, et payée par toutes les sandboxes. `ffmpeg` seul aurait triplé le poids
  ajouté par `3.3-r3`.
- **Une base par famille d'applications** (`3.3-images`, `3.3-video`…).
  L'explosion combinatoire est immédiate et détruit le cache mutualisé, qui est
  la raison d'être de l'ADR 0002.
- **`apt-get` dans le guest, au boot.** Impossible : la sandbox n'a aucun réseau
  sortant, et le rootfs y est en lecture seule (les écritures ne vivent que dans
  le cache de blocs en mémoire de v86).
- **Miroir de liens symboliques** vers les emplacements absolus d'origine, au
  lieu de `LD_LIBRARY_PATH`. Éprouvé et fonctionnel (662 ms pour 752 fichiers),
  mais inutile : `LD_LIBRARY_PATH` et `PATH` suffisent pour libvips *et* pour
  ImageMagick, qui lit pourtant `/etc/ImageMagick-6/*.xml` par chemin absolu.
  La variante reste la porte de sortie si un paquet futur exigeait ses fichiers
  de données à leur emplacement d'origine.
