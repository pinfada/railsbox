# ADR 0005 — L'application garde son espace de noms `/<depot>/app/`

Date : 2026-08-17 · Statut : accepté · Précise la topologie retenue par
[l'ADR 0004](0004-topologie-de-distribution.md)

> Question posée par le premier intégrateur tiers (`pinfada/tchopmygrinds`,
> Rails + React/Vite + devise-jwt) après avoir publié sa sandbox : servir
> l'application à `/<depot>/` plutôt qu'à `/<depot>/app/` réduirait-il la casse
> pour un SPA ? Réponse mesurée : **non, et le coût serait élevé.**

## Question

Une sandbox est publiée sur un GitHub Pages **de projet**. La coquille occupe
`/<depot>/` et l'application est montée sous `/<depot>/app/`
(`RAILS_RELATIVE_URL_ROOT`, composé par `appPrefix()` dans
`public/shared/proxy-logic.js:19-31`). Le Service Worker n'intercepte que ce
préfixe (`public/sw-proxy.js:460`).

Un SPA écrit ses URL en dur dans du JavaScript — `axios baseURL: '/api/v1'`,
`<BrowserRouter>` sans `basename`, `base:` figé par Vite au build. Ces URL sont
**absolues depuis la racine du domaine** et sortent donc du périmètre servi :
GitHub Pages répond 404. La proposition : supprimer le segment `app` pour que
`/api/...` retombe dans la portée du proxy.

## Ce que la coquille occupe réellement à la racine

Relevé sur `public/` et `.github/workflows/construire-sandbox.yml:318-319`
(`rsync -a --exclude 'disks/' public/ publication/`).

| Chemin publié | Peut-il déménager ? |
|---|---|
| `index.html` | **Non** — GitHub Pages sert `/<depot>/` depuis ce fichier, il n'y a pas d'autre notion d'index |
| `sw-proxy.js` | **Non** — la portée maximale d'un Service Worker est le répertoire de son script, et l'élargir exige l'en-tête `Service-Worker-Allowed`, que Pages ne permet pas de poser |
| `badge.svg` | **Non en pratique** — l'URL est documentée et déjà collée dans des README tiers |
| `main.js`, `env-drawer.js`, `env-drawer.css`, `types.d.ts` | Oui (référencés par `index.html`) |
| `shared/`, `vendor/`, `vm/` | Oui |
| `disks/` | Oui, au prix d'une reconstruction (chemin lu par `main.js:27`) |
| `.nojekyll` | Non, mais sans conséquence |

Soit **huit fichiers et quatre répertoires** pris à la racine, dont trois
irréductibles par contrainte de l'hébergeur ou du navigateur.

## Le facteur déterminant

**Le changement ne résout pas le problème qui le motive.** L'URL qui casse chez
l'intégrateur est `/api/v1/...`, absolue depuis la racine du **domaine**, donc
`https://<compte>.github.io/api/v1/...`. Elle est hors périmètre à cause du
segment `<depot>`, pas du segment `app` — et `<depot>` est imposé par GitHub
Pages de projet (`construire-sandbox.yml:155-158`, `SB_PREFIXE=/<depot>`).
Déplacer l'application à `/<depot>/` retirerait un segment sur deux et
laisserait la requête exactement aussi hors périmètre.

Autrement dit : **tout SPA doit de toute façon apprendre son préfixe de montage
à l'exécution.** C'est vrai avec `/<depot>/app/`, ce serait vrai avec
`/<depot>/`. Le patron est désormais documenté (README, « Votre application
embarque un SPA ? ») et il est celui que l'intégrateur a effectivement mis en
œuvre : `window.railsData.basePath` rendu par Rails, lu une fois côté JS,
propagé à `baseURL` et à `basename`.

## Options examinées

- ❌ **B — application à `/<depot>/`, coquille déplacée sous
  `/<depot>/_railsbox/`.** Structurellement impossible : `index.html` et
  `sw-proxy.js` sont épinglés à la racine par l'hébergeur et par la règle de
  portée des Service Workers. La coquille ne peut pas céder la racine.
- ❌ **C — application à `/<depot>/`, coquille à la racine avec une liste de
  noms réservés.** Confisque silencieusement douze chemins à l'espace d'URL de
  l'application, et **collisionne frontalement sur `/`** : `root "posts#index"`
  et le document de chargement de la sandbox veulent la même URL. Une
  application dont la page d'accueil est inatteignable n'est pas une
  démonstration.
- ❌ **D — inverser : coquille sous `/<depot>/app/`, application à la racine.**
  Même blocage que B sur la portée du Service Worker, plus l'invalidation du
  badge.
- ✔ **A — statu quo `/<depot>/app/`, complété par de la documentation.**
  Retenu.

## Décision

**L'application reste montée sous `/<depot>/app/`.** Trois raisons, par ordre
de force :

1. **Le gain est nul** — voir « Le facteur déterminant ». Le segment coûteux
   est `<depot>`, et il n'est pas négociable.
2. **Le préfixe est une frontière de privilège, pas seulement du routage.**
   `isShellClient()` (`proxy-logic.js`) décide quels documents peuvent seulement
   PROPOSER le canal de commande du worker. Sans préfixe applicatif, un document
   servi par l'application deviendrait indiscernable de la coquille.

   > Mise à jour du 20/08/2026 — ce point disait à l'origine que ce critère
   > décidait « qui a le droit de poster `bridge-port` et `artifact-config` ».
   > Ce n'est plus vrai, et ce n'était déjà pas suffisant : les commandes ne
   > voyagent plus que sur un `MessagePort` privé, parce qu'un XSS applicatif
   > s'exécute dans la coquille elle-même et qu'aucun critère d'adresse ne l'en
   > distingue ([ADR 0008](0008-separation-origine-de-l-application.md)). Le
   > préfixe reste une frontière — de routage, de CSP, et de qui peut proposer
   > un canal — mais il n'est plus ce qui garde le pont.
   `appRequestRefusal()` (l. 193-224) repose sur la même frontière.
3. **`/` est déjà pris, et ne peut pas être partagé.** Le document de chargement
   de la sandbox et la route racine de l'application se disputeraient la même
   URL, sans arbitrage possible.

## Ce que le changement aurait coûté

| Poste | Détail |
|---|---|
| Réécriture du proxy | `APP_PREFIX`, `appPrefix`, `staticAssetPath`, `rootStaticPath`, `isShellClient`, `rewriteLocation` — et la refonte du critère de privilège, sans candidat de remplacement évident |
| Reconstruction de **toutes** les sandboxes | `RAILS_RELATIVE_URL_ROOT` est figé dans l'ext2 (`base/app.Dockerfile:188`), les URL d'assets sont figées dans le CSS et le manifeste précompilés (`assets-amd64.Dockerfile:52-62`), et l'instantané mémoire est capturé Puma déjà monté sur ce chemin (`construire-sandbox.yml:274`) |
| Tests | `tests/proxy-logic.test.mjs` (l. 328-413), `tests/live/sandbox-publiee.live.spec.mjs`, `tests/e2e/cookies-proxy.e2e.spec.mjs` (~25 assertions), `tests/bridage/` |
| Espace d'URL de l'application | douze chemins racine confisqués, dont `/` |

À noter, en atténuation : les sandboxes **déjà publiées** ne seraient pas
cassées par un tel changement, la coquille et les artefacts étant force-pushés
ensemble en un seul jeu (`construire-sandbox.yml:377-385`). Le risque n'est pas
la désynchronisation mais le volume de reconstruction.

## Conséquences

- Le patron d'adaptation d'un SPA devient **de la documentation de premier
  plan**, pas une note sous le capot : README FR et EN, section « Votre
  application embarque un SPA ? », avec le code de bout en bout (vue Rails →
  `railsData.basePath` → axios → React Router → cas Vite).
- La ligne « SPA côté client » des limites connues nomme désormais cette
  adaptation comme **la seule que railsbox ne puisse pas faire à la place du
  mainteneur**. C'est une limite assumée, pas un défaut à corriger plus tard.
- Le refus est réutilisable : la question reviendra, elle a maintenant une
  réponse chiffrée à citer.

## Points de vigilance

- **Le diagnostic manque encore.** Rien ne dit au mainteneur qu'une requête est
  partie hors périmètre : le Service Worker laisse filer, GitHub Pages répond
  404, et l'erreur ne ressemble pas à une erreur d'application. Le README donne
  la recette manuelle (onglet réseau, tout chemin ne commençant pas par
  `/<depot>/app/`) ; un signalement automatique — la coquille comptant les 404
  same-origin hors préfixe et les nommant dans le panneau — vaudrait mieux que
  cette recette.
- **Réduire l'empreinte de la coquille à la racine reste souhaitable**, et c'est
  indépendant de cette décision. `main.js`, `env-drawer.*`, `types.d.ts`,
  `shared/`, `vendor/`, `vm/` pourraient tenir sous un unique répertoire
  (`.nojekyll` est déjà publié, donc un nom préfixé par `_` passerait). On
  descendrait de huit fichiers et quatre répertoires à trois fichiers et deux
  répertoires. Gain de propreté, pas de correction de bogue — à faire quand la
  coquille sera touchée pour une autre raison.
- **`rootStaticPath()` est un précédent** (`proxy-logic.js:61-88`) : douze noms
  nus à la racine du site (`favicon.ico`, `robots.txt`, `site.webmanifest`…)
  sont déjà détournés vers `disks/appstatic/`, **sans** préfixe applicatif.
  C'est la bonne granularité quand une exception est nécessaire : une liste
  explicite et testée, pas la suppression de la frontière.
- **Le cas d'un GitHub Pages d'utilisateur** (`<compte>.github.io`) n'a pas été
  mesuré. Le préfixe y resterait dérivé du nom du dépôt
  (`construire-sandbox.yml:155-158`), donc la conclusion ne change pas ; mais
  personne n'a publié de sandbox dans cette configuration.
