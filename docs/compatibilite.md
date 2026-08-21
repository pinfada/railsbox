# Compatibilité

Ce que railsbox prend en charge, ce qu'il refuse explicitement, et les limites qui tiennent à son modèle.

*Retour au [README](../README.md).*

---

## Ce qui est pris en charge

| | État |
| --- | --- |
| **SQLite** | validé de bout en bout : `rails new` + Propshaft + importmap, publié et bootant en ligne |
| **PostgreSQL** | pris en charge sur la voie découplée, à partir de la base `3.3-r2` (la valeur par défaut du workflow) |
| **MySQL / MariaDB** | non supporté : la construction s'arrête avec un rapport explicite |
| **importmap, Propshaft, Sprockets** | précompilés dans le disque i386 |
| **Tailwind, dart-sass** | précompilés sur un étage amd64, copiés dans le disque i386 |
| **Chaînes npm** (esbuild, cssbundling, jsbundling) | même étage amd64 : installation puis vos scripts de build |
| **pnpm** | pris en charge via Corepack, à condition que `package.json` déclare `packageManager` — c'est Corepack qui en lit la version, railsbox n'en extrait qu'un identifiant validé |
| **Redis, Sidekiq** | détectés depuis le `Gemfile.lock`, présents dans la base |
| **Active Storage, traitement d'images** | `libvips` (défaut de Rails 7+), ImageMagick et les aperçus PDF sont dans la base à partir de `3.3-r3` |
| **Autres bibliothèques système** | installées en surcouche sur le disque applicatif — voir « [Bibliothèques système](configuration.md#bibliothèques-système) » et [l'ADR 0006](decisions/0006-bibliotheques-systeme.md) |

## Limites connues

| Limite | État |
| --- | --- |
| **PostgreSQL** | **branché** sur la voie découplée : le serveur vit dans la base (à partir de la révision `3.3-r2`), le répertoire de données sur le disque applicatif, et le cluster ne démarre qu'après le montage de celui-ci. Exige une base `3.3-r2` ou plus récente — la construction refuse explicitement une base antérieure. Voir « [PostgreSQL](configuration.md#postgresql) ». |
| **Tailwind, dart-sass** | **pris en charge** : précompilés sur un étage amd64, puis copiés dans le disque i386 (le guest n'exécute jamais ces binaires). Tailwind est validé **de bout en bout** — variante `demo-tailwind`, boot d'une VM v86 réelle, feuille compilée servie par le guest — et rejoué par le workflow [`valider-variantes.yml`](../.github/workflows/valider-variantes.yml). dart-sass a désormais son propre banc d'essai (`demo-dartsass`), plus strict encore : `sass-embedded` ne publie aucun binaire i386 là où `tailwindcss-ruby` offre une variante « ruby ». |
| **Chaînes npm** (esbuild, cssbundling) | **pris en charge** par le même étage (`npm ci` puis scripts de build). **pnpm** est reconnu quand `packageManager` le déclare ; un verrou pnpm SANS cette clé retombe sur npm, avec un avertissement. yarn et bun sont **signalés, pas exécutés** : deux verrous contradictoires arrêtent la construction. |
| **SPA côté client** (React, Vue, Svelte) | **demande une adaptation de votre code** — la seule que railsbox ne puisse pas faire à votre place. L'application est servie sous `/<depot>/app/` ; les helpers Rails suivent ce préfixe, votre JavaScript ne le devine pas. Patron recommandé, avec code copiable : « [Votre application embarque un SPA ?](spa.md) ». |
| **ActionCable / WebSockets** | hors périmètre : incompatibles avec un pont requête/réponse. Piste : long-polling ou flux dédié. |
| **Réseau sortant** | inexistant. C'est aussi une propriété du modèle de démonstration — voir [`SECURITY.md`](../SECURITY.md). |
| **Débit du pont** | tuyau étroit et partagé, suffisant pour du Turbo/HTML. Les assets précompilés ne l'empruntent pas : extraits de l'image, ils sont servis statiquement par le Service Worker. |
| **Persistance** | aucune, par conception. Chaque visiteur écrit dans sa copie, qui disparaît avec l'onglet. |
