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
| **Bun** | pris en charge en série 1.4 quand `bun.lock` ou `bun.lockb` est présent, avec installation gelée par `--frozen-lockfile` |
| **Redis, Sidekiq** | détectés depuis le `Gemfile.lock`, présents dans la base |
| **Active Storage, traitement d'images** | `libvips`, ImageMagick et les aperçus PDF sont installés à la demande. Dans la sandbox sans réseau, Active Storage utilise un service Disk local généré par RailsBox ; `RAILSBOX_KEEP_ACTIVE_STORAGE_SERVICE=1` restaure la configuration d'origine pour le diagnostic. |
| **Autres bibliothèques système** | installées en surcouche sur le disque applicatif — voir « [Bibliothèques système](configuration.md#bibliothèques-système) » et [l'ADR 0006](decisions/0006-bibliotheques-systeme.md) |

## Limites connues

| Limite | État |
| --- | --- |
| **PostgreSQL** | **branché** sur la voie découplée : le serveur vit dans la base (à partir de la révision `3.3-r2`), le répertoire de données sur le disque applicatif, et le cluster ne démarre qu'après le montage de celui-ci. Exige une base `3.3-r2` ou plus récente — la construction refuse explicitement une base antérieure. Voir « [PostgreSQL](configuration.md#postgresql) ». |
| **Tailwind, dart-sass** | **pris en charge** : précompilés sur un étage amd64, puis copiés dans le disque i386 (le guest n'exécute jamais ces binaires). Tailwind est validé **de bout en bout** — variante `demo-tailwind`, boot d'une VM v86 réelle, feuille compilée servie par le guest — et rejoué par le workflow [`valider-variantes.yml`](../.github/workflows/valider-variantes.yml). dart-sass a désormais son propre banc d'essai (`demo-dartsass`), plus strict encore : `sass-embedded` ne publie aucun binaire i386 là où `tailwindcss-ruby` offre une variante « ruby ». |
| **Chaînes front** (esbuild, cssbundling) | **prises en charge** sur l'étage amd64. npm relit son verrou ; **pnpm** est reconnu quand `packageManager` le déclare ; **yarn** distingue Classic (`--frozen-lockfile`) de Berry (`--immutable`) ; **Bun 1.4** relit `bun.lock` et `bun.lockb` avec `--frozen-lockfile`. Deux familles de verrous contradictoires arrêtent la construction. |
| **SPA côté client** (React, Vue, Svelte) | **demande une adaptation de votre code** — la seule que railsbox ne puisse pas faire à votre place. L'application est servie sous `/<depot>/app/` ; les helpers Rails suivent ce préfixe, votre JavaScript ne le devine pas. Patron recommandé, avec code copiable : « [Votre application embarque un SPA ?](spa.md) ». |
| **ActionCable / WebSockets** | hors périmètre : incompatibles avec un pont requête/réponse. Piste : long-polling ou flux dédié. |
| **Réseau sortant** | inexistant. C'est aussi une propriété du modèle de démonstration — voir [`SECURITY.md`](../SECURITY.md). |
| **Débit du pont** | tuyau étroit et partagé, suffisant pour du Turbo/HTML. Les assets précompilés ne l'empruntent pas : extraits de l'image, ils sont servis statiquement par le Service Worker. |
| **Persistance** | aucune, par conception. Chaque visiteur écrit dans sa copie, qui disparaît avec l'onglet. |
