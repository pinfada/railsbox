# ADR 0007 — Les artefacts par application sont nommés par empreinte de contenu

Date : 2026-08-19 · Statut : accepté · Complète
[ADR 0003](0003-artefacts-en-fichiers-parties.md) et
[ADR 0004](0004-topologie-de-distribution.md)

## Le fait

Le 19/08/2026, une sandbox republiée ne bootait plus : dix-huit sondes HTTP en
échec, 337 s, aucun message ni pour le visiteur ni dans la console. Cause
trouvée par élimination :

```
depuis le cache : builtAt 2026-08-19T06:47:19Z   (construction précédente)
forcé réseau    : builtAt 2026-08-19T08:09:20Z   (construction réelle)
```

Le navigateur avait servi un `v86-config.json` périmé. Or cette configuration
nomme le cache d'artefacts et **désigne l'instantané** : la VM restaurait donc
l'instantané mémoire d'une construction sur le disque applicatif d'une autre.
Un état mémoire et un système de fichiers qui ne se connaissent pas — Puma ne
répond jamais.

Un premier correctif est en place (commit `730f22a` : la configuration est lue
avec `cache: "reload"`). Il fonctionne, et il reste utile. Mais il **repose sur
un comportement de CDN que nous ne contrôlons pas**, et il ne traite qu'un des
deux chemins par lesquels le panachage peut arriver.

## La cause racine est un nom

`genealogyapp-app-0-4194304.ext2.zst` désigne un **contenu différent d'une
construction à l'autre**. La même URL, deux octets. Tout cache — cache HTTP du
navigateur, CDN de GitHub Pages, Cache Storage du Service Worker, cache d'un
proxy d'entreprise — a alors parfaitement le droit de resservir le morceau
d'une construction précédente : rien ne dit qu'il a changé.

Le cache applicatif se protégeait déjà de cela en dérivant son NOM de la
configuration entière, `builtAt` compris (ADR 0003). C'était un contournement :
il rendait le cache que *nous* tenons cohérent, et laissait ceux que nous ne
tenons pas incohérents. La propriété manquante est plus simple à énoncer —
**une URL, un contenu, pour toujours** — et c'est celle de tout hébergement
d'immuables : la base est déjà nommée par sa révision (ADR 0004), les assets
Rails par leur digest.

## Décision

- ✔ **Le disque applicatif et l'instantané sont publiés sous un nom qui porte
  l'empreinte de leur contenu** : `disks/x-app-<empreinte>.ext2.zst`,
  `disks/x-split-state-<empreinte>.bin.gz`, et l'inventaire qui va avec.
- ✔ **L'empreinte est un SHA-256 du contenu, tronqué à 12 caractères
  hexadécimaux** (48 bits). Elle est calculée par le découpeur, pendant la
  lecture qui découpe : l'artefact n'est lu qu'une fois, le versionnement ne
  coûte donc rien.
- ✔ **Ni le rootfs de base, ni le noyau, ni l'initrd ne sont versionnés ainsi.**
- ✔ **La configuration est accordée par le découpeur** (`--config`), seul à
  connaître l'empreinte. Il échoue si aucun champ ne nomme l'artefact qu'il
  publie.

## Pourquoi une empreinte de CONTENU, et pas un horodatage

Un horodatage ou un numéro de construction règlerait le panachage tout aussi
bien, et serait trivial à produire. Il coûterait le cache du visiteur : chaque
reconstruction, **même sans changement**, renommerait les 128 morceaux du disque
applicatif et les 69 de l'instantané, que le visiteur retéléchargerait
intégralement. Avec une empreinte de contenu, une reconstruction qui ne change
rien produit exactement les mêmes noms — le visiteur ne retélécharge rien. Le
coût de la propriété est nul, et il est même négatif : republier redevient bon
marché.

Douze caractères, enfin, parce que l'empreinte ne sert pas à authentifier un
contenu mais à le distinguer de celui d'une autre construction de la même
sandbox. À 48 bits, la probabilité d'une collision reste sous 10⁻⁷ pour 10 000
constructions, alors qu'un SHA-256 complet allongerait de 52 caractères chacun
des 197 noms de fichiers publiés.

## Pourquoi la base reste hors du périmètre

Le rootfs de base, son noyau et son initrd sont **déjà versionnés par leur
révision** (`base-3.3-r2`), **mutualisés entre toutes les sandboxes** et
immuables par convention : la publication est additive, et une modification de
contenu donne une nouvelle révision (ADR 0004). Ils ont donc déjà la propriété.

Leur ajouter une empreinte la casserait : deux sandboxes construites contre la
même révision publieraient des URL différentes pour les mêmes octets, et le
partage du rootfs — 1,45 Go, ~32 Mo réellement lus au premier chargement —
disparaîtrait. C'est ce partage qui rend railsbox tenable ; on ne l'échange pas
contre une propriété qu'on a déjà.

## Le point dur : la configuration est écrite avant le découpage

La configuration est produite par la capture du delta (`make-delta-snapshot`),
donc **avant** le découpage — et c'est le découpage qui connaît l'empreinte.
Trois voies :

| Voie | Verdict |
| --- | --- |
| Le découpeur émet l'empreinte, le workflow la repasse à la génération de configuration | Il faudrait capturer une sortie, la porter jusqu'à un troisième script, et lui apprendre quel champ toucher — connaissance qui vit déjà dans `split-config.mjs`. |
| La génération de configuration calcule elle-même l'empreinte | Elle relirait 512 Mo + l'instantané, que le découpeur va relire juste après. |
| **Le découpeur accorde la configuration après coup** | **Retenue.** |

Le découpeur ne décide de rien sur la forme de la configuration : il fournit
deux noms — celui qu'il aurait publié, celui qu'il a publié — à
`replacePublishedArtifact()`, qui vit avec le reste de la connaissance du
format. Il **échoue** si aucun champ ne nomme cet artefact : publier des
morceaux versionnés en laissant la configuration désigner les anciens serait
exactement l'incident qu'on répare.

Conséquence de mise en œuvre : le nom des morceaux dépend de l'empreinte, qui
n'est complète qu'après le dernier octet lu. Les morceaux sont donc écrits sous
un nom provisoire, puis renommés dans le même dossier — une opération atomique
et gratuite, là où une seconde passe de lecture coûterait 512 Mo.

## Ce qui n'a pas eu à changer

- **Le chargeur v86** : il dérive lui-même les noms de morceaux de l'URL de
  l'artefact (`<base>-<début>-<fin><extension>`). Versionner la base versionne
  les 128 morceaux.
- **`public/shared/snapshot-parts.js`** : il dérive de même l'inventaire et les
  morceaux de l'instantané depuis `config.state`. Pas une ligne modifiée.
- **`public/shared/artifact-cache.js`** : `artifactUrlOfPart()` remonte du
  morceau à l'artefact en retirant les deux dernières bornes numériques ;
  l'empreinte s'intercale avant elles sans ambiguïté, y compris quand elle est
  elle-même entièrement numérique.
- **Les sandboxes déjà publiées** : leurs URL sont dans LEUR configuration, qui
  reste cohérente avec leurs propres artefacts. Rien à reconstruire.
- **L'accumulation de fichiers** : `gh-pages` est entièrement remise à plat à
  chaque construction (`git init` puis `git push -f`). Les morceaux de la
  construction précédente disparaissent ; il n'y a donc pas de nettoyage à
  prévoir.

## Ce que cela ne règle pas

**Le cache applicatif du Service Worker repart quand même de zéro** à chaque
reconstruction : son nom dérive de la configuration entière, `builtAt` compris
(ADR 0003), et `builtAt` change toujours. Le gain de l'empreinte de contenu
s'exerce donc pour l'instant sur les caches HTTP — navigateur, CDN, proxy — pas
sur celui-là. Retirer `builtAt` de l'identité du cache est devenu possible,
puisque deux contenus différents ne peuvent plus partager une URL ; c'est une
décision distincte, qui n'a d'intérêt qu'une fois qu'aucune sandbox publiée
avant cet ADR — noms stables, donc panachage possible — n'est plus en ligne.

Le `v86-config.json` lui-même **ne peut pas** être versionné : c'est le point
d'entrée, celui dont l'URL doit être connue d'avance. Il reste donc lu avec
`cache: "reload"` (commit `730f22a`). La différence est qu'une configuration
périmée ne peut plus faire panacher deux constructions : elle nomme des
artefacts qui, eux, sont cohérents entre eux — au pire, la sandbox d'hier.
