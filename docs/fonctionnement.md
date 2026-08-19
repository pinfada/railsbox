# Comment railsbox fonctionne

Le modèle d'exécution, le trajet d'une requête, le cache des artefacts et la carte des dépôts. Pour la carte du CODE, voir [architecture.md](architecture.md).

*Retour au [README](../README.md).*

---

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
| Ce qui est mis en cache | les fichiers-parties des disques découpés **et de l'instantané**, le noyau, l'initrd — **et rien d'autre que ce qui est nommé dans la configuration v86** |
| Ce qui ne l'est pas | un instantané publié d'un seul tenant (sandbox d'avant le découpage), qui est de toute façon mis en cache par la page dans IndexedDB ; un disque lu par requêtes `Range`, dont les réponses 206 sont refusées par Cache Storage ; toute requête portant un en-tête `Range` |
| Nom du cache | dérivé de la configuration entière, `builtAt` compris. Un changement de configuration bascule sur un cache neuf et supprime l'ancien. La règle est née d'URL de disque applicatif **stables d'une construction à l'autre** ; depuis l'[ADR 0007](docs/decisions/0007-versionnement-des-artefacts-par-empreinte.md) elles portent l'empreinte du contenu, mais elle protège encore les sandboxes publiées avant. |
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
