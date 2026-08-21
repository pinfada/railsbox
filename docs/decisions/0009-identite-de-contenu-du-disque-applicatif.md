# ADR 0009 — L'instantané est lié au disque applicatif par une empreinte de contenu

Date : 2026-08-21 · Statut : accepté · Complète
[ADR 0007](0007-versionnement-des-artefacts-par-empreinte.md) · Clôt
[issue #4](https://github.com/pinfada/railsbox/issues/4)

## Le fait

En construisant zealot à la main sur le chemin découplé, deux captures
successives sur un disque applicatif **inchangé** :

```
capture n°1 : builtAt 2026-08-21T10:20:09Z
capture n°2 : builtAt 2026-08-21T10:34:15Z
```

La valeur a bougé de quatorze minutes sans qu'un seul octet du disque ne change.
Elle ne dit donc rien du contenu — et c'est pourtant elle qui portait, seule, le
lien entre un instantané mémoire et le système de fichiers qu'il a figé.

## Ce que le garde faisait, exactement

`verifierInstantane` comparait `stateFor` à `builtAt`. **Les deux valeurs sont
produites par la configuration ; aucune n'est lue sur les octets du disque.** Le
verdict garantissait une cohérence de construction *déclarée*.

Il attrapait deux cas réels, et continue de les attraper :

- une configuration réécrite, ou servie périmée par un cache d'hébergeur, face à
  un instantané qui n'est plus le sien — l'incident du 19/08 de l'ADR 0007 ;
- une reconstruction **monolithique**, `build.sh` réécrivant la configuration à
  chaque passage donc `builtAt`, alors que `stateFor` garde l'ancienne valeur.

Il n'attrapait pas un disque applicatif reconstruit sans que la configuration
soit régénérée. Sur le chemin découplé, `buildSplitConfig` date `builtAt` **à la
capture** : les deux valeurs sont égales par construction, et un
`<nom>-app.ext2` remplacé sous une configuration inchangée passait sans un mot.

## Pourquoi propager `builtAt` ne suffisait pas

Estampiller `builtAt` dans `<nom>-app.json` et le reprendre à la capture
améliorerait le chemin normal, mais resterait contournable dès que le disque
change sans régénération de sa carte. Ce serait une garantie **plus forte en
apparence qu'en réalité** — le pire état possible pour un garde, puisqu'il
dispense de se poser la question qu'il ne tranche pas.

## Décision

Deux champs de configuration, écrits par **deux acteurs distincts, à deux
moments distincts, chacun depuis les octets du disque** :

| Champ | Écrit par | Lu sur |
| --- | --- | --- |
| `stateForAppDiskSha256` | la capture (`make-delta-snapshot.mjs`) | le disque qu'elle **attache** à la VM |
| `appDiskSha256` | le découpage (`split-artifact.mjs`) | le disque qu'il **publie** |
| `builtAt` | la configuration | rien — date de diagnostic et invalidation de cache |

`verifierInstantane` compare **prioritairement** les deux empreintes, et retombe
sur `stateFor`/`builtAt` sinon.

**C'est l'indépendance des deux lectures qui fait la garantie**, pas le fait de
hacher. Si le même acteur écrivait les deux valeurs, elles seraient égales par
construction — exactement le défaut qu'on corrige. Un disque échangé entre la
capture et la publication les fait diverger ; rien, dans la séquence, ne peut
les rendre égales autrement qu'en étant le même disque.

## Trois arbitrages

**(a) Les deux empreintes ne font autorité qu'ensemble.** Une seule présente, ou
une valeur mal formée, renvoie au lien par date — jamais un désaccord. Une
configuration à cheval sur deux versions de la chaîne est saine ; la refuser sur
cette seule asymétrie ferait booter à froid, plusieurs minutes durant, une
sandbox parfaitement valide. Mais dès que les deux sont là, la comparaison est
**stricte** : une valeur tronquée face à une valeur complète n'est pas une
correspondance partielle, c'est une chaîne incohérente.

**(b) SHA-256 complet, 64 caractères, dans les champs.** Les noms d'artefacts en
gardent douze (ADR 0007) parce qu'une URL doit rester courte ; un champ de
configuration n'a pas cette contrainte, et un champ nommé `…Sha256` qui ne
contiendrait pas un SHA-256 est un piège. Le lecteur accepte de 12 à 64
caractères pour ne pas se lier à ce choix ; l'écriture, elle, n'a qu'une forme.

**(c) Le disque applicatif du chemin delta, et lui seul.** Pas le rootfs de base
— 1,45 Go, mutualisé, immuable, déjà désigné par sa révision. Pas le chemin
monolithique — `build.sh` y réécrit la configuration à chaque passage, donc le
lien par date y fonctionne déjà, et l'empreinte coûterait une lecture de 1,4 Go
pour fermer un trou qui n'existe pas.

## Ce que cela ne fait pas, et qu'il faut dire net

**Personne ne vérifie au boot que les octets servis valent l'empreinte
déclarée.** La coquille ne hache pas 512 Mo : elle les lit paresseusement, par
morceaux, à mesure que la VM les réclame. Le lien reste une cohérence de chaîne
de construction. Ce qui change est qu'il devient une cohérence **que le contenu
peut démentir**, au lieu d'une que la date ne pouvait que confirmer.

Le cas qui reste ouvert : un `<nom>-app.ext2` remplacé à la main sans que rien
ne soit régénéré. Aucun champ ne bouge, donc rien ne se voit. Sur le chemin
publié, l'ADR 0007 le couvre autrement — le nom de l'artefact porte son
empreinte, un contenu changé change l'URL, et une URL absente échoue bruyamment.

## Coût mesuré

Hachage en flux du disque applicatif, avant le boot de capture :

| Mesure | Valeur |
| --- | --- |
| Disque | 512 Mo (géométrie figée, ADR 0002) |
| Banc, trois passes sur `demo-app.ext2` | 0,96 s · 0,94 s · 0,91 s → médiane **0,94 s** (546 Mo/s) |
| Capture réelle de `partage-app.ext2` | **1,0 s** |
| Capture réelle de `demo-app.ext2` | **1,0 s** |
| Capture delta complète | 150 à 167 s mesurées (cible ~3 min, ADR 0002) |
| Part du hachage | **0,6 %** |

Mesuré sur la machine de développement, cache de pages chaud ; une première
lecture depuis un disque froid est plus lente, sans changer l'ordre de grandeur.
Le hachage est fait **avant** le boot : v86 attache le disque par URL de fichier
et garde ses écritures en mémoire, donc le fichier ne bouge pas de la capture —
hacher d'abord ne change rien au résultat et fait échouer tôt.

Aucun coût côté visiteur : deux champs de 64 caractères dans une configuration
qui en pèse quelques centaines.

## Vérifié de bout en bout, pas seulement en test unitaire

Les tests unitaires ne peuvent pas démontrer ce qui fait la garantie : que deux
lectures **indépendantes** s'accordent. La chaîne réelle a donc été rejouée le
21/08/2026 sur deux applications — capture puis découpage, sur des VM réelles.

| Ce qui devait être vrai | Constat |
| --- | --- |
| La capture écrit `stateForAppDiskSha256` | `fb55d8eb…518936` (partage), `caae86a1…174bec` (témoin) |
| Le découpage écrit `appDiskSha256` | la même valeur, par sa propre lecture |
| Les deux empreintes complètes sont identiques | oui, et égales à un `sha256sum` calculé hors de la chaîne |
| La sandbox publiée démarre depuis l'instantané | badges sw/coi/vm/http au vert, application montée en 17,6 s |
| L'application répond vraiment | `GET app/posts` → 200 ; `POST app/posts` → 302 vers le billet créé |

Deux contre-épreuves, sans lesquelles l'accord ne prouverait rien :

- **Disque échangé après la capture** : verdict `desaccorde` — *pendant que
  `stateFor` et `builtAt` restent parfaitement d'accord*. C'est le trou de
  l'issue #4, vu se refermer.
- **Coquille ANTÉRIEURE au changement, servie une configuration portant les
  nouveaux champs** : boot en 17,5 s. La rétrocompatibilité de l'arbitrage (a)
  est donc vérifiée dans un navigateur, pas seulement en test unitaire.

## Conséquences

- `verifierInstantane` a deux chemins ; les sandboxes déjà publiées, qui n'ont
  ni l'un ni l'autre champ, gardent exactement leurs verdicts d'avant.
- `scellerInstantane` refuse une empreinte mal formée plutôt que de l'écrire :
  le lecteur l'écarterait en silence, et le garde disparaîtrait là où on croit
  l'avoir posé.
- Le découpage n'inscrit l'empreinte que lorsqu'il réécrit le champ `appDisk`.
  Le même outil découpe ensuite l'instantané, avec la même ligne de commande à
  un nom près ; y inscrire l'empreinte remplacerait celle du disque par celle de
  l'état, et le garde prononcerait un désaccord sur une sandbox saine.
- L'inventaire `-parts.json` porte désormais `sha256` en plus de `digest`. Le
  second reste les douze premiers caractères du premier.
