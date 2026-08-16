# ADR 0004 — Topologie de distribution : une origine par démonstration

Date : 2026-08-16 · Statut : accepté · Succède à [l'ADR 0001](0001-distribution-artefacts.md), s'appuie sur [l'ADR 0003](0003-artefacts-en-fichiers-parties.md)

## Question

Le plan v3 vise un badge « Try it » posé sur le README d'une application Rails
open source. Reste à décider **où vit la coquille** — la page hôte qui charge
v86, installe le Service Worker et affiche l'application. Trois topologies
étaient possibles, et le choix engage la sécurité bien plus que l'hébergement.

## Mesures (2026-08-16)

| Question | Réponse mesurée |
|---|---|
| En-têtes de GitHub Pages | `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes`, **aucun `Cross-Origin-Resource-Policy`** |
| Un artefact cross-origin sans CORP passe-t-il sous `COEP: require-corp` ? | **Oui** — v86 émet ses requêtes en mode CORS, et une requête CORS réussie satisfait `require-corp` sans CORP. Boot vérifié dans Chromium avec `crossOriginIsolated: true` |
| v86 a-t-il besoin de `SharedArrayBuffer` ? | **Non** — 0 occurrence dans les trois builds livrés. L'exigence COOP/COEP de la page hôte est un héritage de CheerpX |
| Le cache HTTP est-il partagé entre deux démonstrations ? | **Non**, sauf même site de premier niveau : les navigateurs partitionnent le cache, et `github.io` étant sur la Public Suffix List, deux gh-pages sont deux sites |

Un premier essai a échoué sur `net::ERR_FAILED` : c'était la vérification
« Local Network Access » de Chromium sur un trajet localhost → localhost, un
artefact de banc de test sans rapport avec CORS.

### Validation contre un vrai GitHub Pages

Les 364 morceaux de la base, le noyau et l'initrd ont été publiés sur le dépôt
jetable `pinfada/railsbox-spike-pages` (branche `gh-pages` orpheline), puis une
coquille cross-origin isolée servie depuis une autre origine a booté dessus.

| Observation | Résultat |
|---|---|
| Déploiement de 364 fichiers | `built`, sans erreur |
| Type MIME d'un `.zst` | `application/octet-stream` — aucune altération |
| En-têtes | `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes` |
| Boot à froid, coquille en `crossOriginIsolated: true` | **succès en 80 s**, init atteint, Redis démarré, pont série actif |
| Trafic | 54 requêtes, **toutes en 200**, 91 Mo (dont 31 Mo de noyau + initrd) |

La topologie est donc vérifiée de bout en bout sur l'hébergement réel, pas
seulement sur un simulateur.

## Le facteur déterminant

`SECURITY.md` documente que l'iframe `/app` est **same-origin** : une
application compromise peut lire le `localStorage` de la page hôte. Tant qu'une
coquille sert une seule application, c'est un canal résiduel assumé.

Une **coquille centrale partagée** en change la nature : toutes les
démonstrations vivent sur la même origine, donc le même `localStorage` et le
même IndexedDB. Le code de la démonstration B lirait les variables saisies par
un visiteur dans la démonstration A. Or railsbox construit ses images à partir
de **dépôts tiers arbitraires** : ce n'est plus un canal résiduel, c'est une
fuite entre locataires, et rien dans notre code ne pourrait l'empêcher.

## Décision — topologie D

- ✔ **Une origine par démonstration.** La coquille et le disque applicatif sont
  publiés **ensemble** par l'action GitHub sur la branche `gh-pages` du
  mainteneur. Chaque démonstration est donc son propre site : l'isolation entre
  démonstrations est celle du navigateur, pas une promesse de notre part.
- ✔ **Le rootfs de base est cross-origin, immuable et versionné.** Il vit une
  seule fois sur le gh-pages du projet railsbox, référencé par une URL figée
  **au moment du build** par l'action. Le mainteneur n'héberge que son
  application (~48 Mo) au lieu de dupliquer 333 Mo.
- ✔ **Aucun sélecteur de configuration dynamique.** La coquille lit un chemin
  fixe same-origin ; l'URL de la base est écrite dans la configuration par
  l'action. Aucune URL fournie par l'utilisateur n'est jamais chargée : la
  surface « fetch d'une URL tierce » n'existe pas, donc il n'y a ni allowlist,
  ni registre, ni validation d'URL à écrire.
- ✔ **La base est épinglée par version** (`base-3.3` et suivantes) et n'est
  jamais réécrite en place : une base publiée est immuable, une correction
  produit une nouvelle version. Une démonstration déjà publiée ne peut donc pas
  casser du fait d'une mise à jour centrale.
- ✔ **L'auto-hébergement de la base reste possible** : un mainteneur qui refuse
  toute dépendance au gh-pages de railsbox peut publier la base chez lui et le
  déclarer à l'action. La dépendance centrale est un défaut, pas une contrainte.

Conséquence pour le plan v3 : **plus aucun tiers payant, ni même de nom de
domaine nécessaire**. Toute la chaîne tient sur GitHub.

## Ce que la topologie coûte

- **Pas de cache partagé entre démonstrations** : chaque visiteur retélécharge
  les ~48 Mo de morceaux de base effectivement lus sur chaque site. Le
  partitionnement du cache rend ce coût inévitable dès lors qu'on refuse
  l'origine partagée — la topologie « coquille chez chaque mainteneur » le paie
  aussi, en dupliquant en plus les 333 Mo.
- **La coquille se met à jour au rebuild**, pas instantanément : un correctif
  n'atteint une démonstration que lorsque son action est relancée. C'est le
  fonctionnement normal d'une action versionnée.
- **Un point central subsiste** : l'artefact de base. Il est statique, immuable
  et hébergé par GitHub ; son indisponibilité casserait les démonstrations qui
  n'auto-hébergent pas. Épinglage par version et auto-hébergement optionnel
  sont les deux garde-fous.

## Points de vigilance

- L'isolation cross-origin (COOP/COEP) est **conservée** : elle ne coûte rien
  et reste une défense en profondeur. Mais elle n'est plus une nécessité
  technique — le jour où elle gêne, elle peut tomber sans casser v86.
- La branche `gh-pages` doit être **orpheline et poussée en force** : sans
  cela, chaque reconstruction y empile une copie complète des artefacts.
- **GitHub Pages plafonne le cache à `max-age=600`** alors que nos artefacts
  sont immuables. **Traité** : le Service Worker met les morceaux, le noyau et
  l'initrd en Cache Storage, « cache d'abord », sous un nom de cache dérivé de
  la configuration complète — une reconstruction invalide l'ancien cache (voir
  « Le cache des artefacts » du README et `public/shared/artifact-cache.js`).
- **La CSP de la coquille doit s'ouvrir à l'origine de la base.** Chez un
  mainteneur tiers, la base est cross-origin et le `connect-src 'self'` de la
  coquille bloquerait les XHR de v86 avant même le CORS — un défaut invisible
  sur la démonstration de référence, dont la base est same-origin. **Traité** :
  l'assemblage réécrit la CSP publiée quand l'origine de la base diffère du
  site cible (`tools/build-v86-image/autoriser-origine-base.mjs`), et rien
  d'autre ne s'ouvre.
- Reste non mesuré : les navigateurs autres que Chromium.
