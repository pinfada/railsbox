<!--
Merci ! Ce gabarit est court exprès : il ne demande que ce qu'un relecteur ne
peut pas déduire du diff. English is welcome — answer in English if you prefer.
-->

## Ce que ça change, et pourquoi

<!-- Deux ou trois phrases. Le « pourquoi » compte plus que le « quoi » : le
diff dit déjà ce qui change, il ne dit jamais ce qui n'allait pas. -->

## Porte de qualité

- [ ] `npm run check` est vert en local (lint + format + typecheck + 370 tests unitaires).
- [ ] Toute logique pure ajoutée arrive avec ses tests ; un correctif de bug commence par le test qui échouait.
- [ ] Les commits suivent `<type>: <description>` en français (`feat, fix, refactor, docs, test, chore, perf, ci`).

## Niveaux de test joués

Cochez ce que vous avez réellement lancé, et **laissez décoché ce que vous
n'avez pas pu lancer** — une case honnêtement vide vaut mieux qu'une case
cochée par principe. Les quatre niveaux et leur coût sont décrits dans
[`CONTRIBUTING.md`](https://github.com/pinfada/railsbox/blob/main/CONTRIBUTING.md#quels-tests-jouer-selon-ce-quon-touche).

- [ ] **N1 — unitaires** : `npm test` (aucun artefact, ~1 s).
- [ ] **N2 — E2E navigateur** : `npm run test:e2e` (Chromium contre `serve.mjs` ; les specs VM s'ignorent sans artefacts).
- [ ] **N3 — intégration VM** : `npm run test:integration` (exige `public/disks/` — Docker, WSL2/Linux root).
- [ ] **N4 — recette en ligne** : `npm run test:live` (sandbox publiée, réseau).
- [ ] Aucun au-delà de N1 n'était pertinent ici.

## Si vous touchez la coquille, le proxy ou le pont

Concerne `public/index.html`, `public/main.js`, `public/sw-proxy.js`,
`public/shared/*`, `public/vm/v86-vm.js` et le démon
`tools/build-v86-image/base/rib/serial-bridge.py`.

Ces fichiers portent des défauts qui **n'existent qu'une fois publiés** :
référence absolue qui sort d'un Pages de projet, CSP qui bloque l'origine de la
base, préflight CORS que GitHub Pages refuse en 405, cookie qui ne circule plus
et fait répondre 422 à toute écriture. Aucun test local ne les voit ; la recette
en ligne les a tous trouvés.

- [ ] `npm run test:e2e` est vert (il exerce le **vrai** `sw-proxy.js`, sans VM : bocal à cookies, cache d'artefacts, page hôte).
- [ ] `npm run test:live` a été joué, et contre quelle URL : <!-- URL, ou « pas pu — voir ci-dessous » -->

> **Comment vérifier votre changement de bout en bout depuis votre fork.**
> `construire-sandbox.yml` accepte une entrée `railsbox-repo` : pointez-la sur
> votre fork et sa branche, publiez la sandbox dans un dépôt public à vous,
> puis jouez la recette en ligne dessus.
>
> ```yaml
> uses: VOTRE-COMPTE/railsbox/.github/workflows/construire-sandbox.yml@VOTRE-BRANCHE
> with:
>   railsbox-repo: VOTRE-COMPTE/railsbox
>   railsbox-ref: VOTRE-BRANCHE
> ```
>
> ```bash
> RAILSBOX_SANDBOX_URL=https://VOTRE-COMPTE.github.io/VOTRE-DEPOT/ npm run test:live
> ```
>
> Si vous n'avez pas pu, dites-le simplement : le mainteneur joue
> `verifier-sandbox.yml` avant la fusion.

## Décisions et frontières

- [ ] Ce changement ne contredit aucun ADR de [`docs/decisions/`](https://github.com/pinfada/railsbox/tree/main/docs/decisions) — ou il en propose un nouveau, joint à la PR.
- [ ] Il ne déplace aucune frontière du tableau de [`SECURITY.md`](https://github.com/pinfada/railsbox/blob/main/SECURITY.md) — ou il met ce tableau à jour dans le même commit.
