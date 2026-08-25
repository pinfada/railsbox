# Compatibilité

Ce que railsbox prend en charge, ce qu'il refuse explicitement, et les limites qui tiennent à son modèle.

*Retour au [README](../README.md).*

---

## Ce qui est pris en charge

| | État |
| --- | --- |
| **Ruby** | base publique `3.3-r2` : Ruby 3.3.12. Ruby 3.4.3 et 4.0.3 sont qualifiés localement sur des bases complètes, mais ne deviennent utilisables par le workflow public qu'après publication et référencement de ces bases. |
| **SQLite** | validé de bout en bout : `rails new` + Propshaft + importmap, publié et bootant en ligne |
| **PostgreSQL** | pris en charge sur la voie découplée, à partir de la base `3.3-r2` (la valeur par défaut du workflow) |
| **MySQL / MariaDB** | non supporté : la construction s'arrête avec un rapport explicite |
| **importmap, Propshaft, Sprockets** | précompilés dans le disque i386, ou sur l'étage amd64 quand Terser/ExecJS exige un moteur JavaScript |
| **Tailwind, dart-sass** | précompilés sur un étage amd64, copiés dans le disque i386 |
| **Chaînes npm** (esbuild, cssbundling, jsbundling) | même étage amd64 : installation puis vos scripts de build. Node 22 reste le défaut ; Node 24 est sélectionné quand `package.json#engines.node` l'exige. |
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

## Ce que la campagne d'applications réelles a validé

RailsBox ne considère pas un simple boot comme une preuve suffisante. RailSmart,
Ember Vault, Hackatime, if-me, Human Essentials et CASA ont servi de candidats de
qualification sans modification de leur dépôt. Ensemble, ils ont exercé Rails
8, Ruby 4.0, Node 24, Warden/Devise, SQLite et PostgreSQL multi-base, Sprockets/importmap,
Active Storage, Terser/ExecJS, les routes sous préfixe et des jeux de seeds
volumineux.

Le cas le plus lourd à ce jour, Human Essentials, a produit 167 assets et
16 017 enregistrements sur deux bases PostgreSQL. Son disque applicatif occupe
306 Mo sur 512 Mo, avec 199 Mo réellement libres. Le premier boot v86 a pris
266 s ; la restauration du delta validé a répondu en 22 s avec un HTTP 200 sous
le préfixe public réel.

CASA a validé Rails 8.0.5.1 sur Ruby 4.0.3, une chaîne npm/Tailwind sous
Node 24 et PostgreSQL. Son disque contient 1 164 enregistrements et 367 Mo de
données sur 512 Mo. Après un premier boot de 262 s, son delta se restaure et
répond dans Chromium en 20,2 s ; rendu, navigation et assets passent les quatre
contrôles de bout en bout.

Redmine `849a116` a également servi de test négatif utile : son build PostgreSQL
aboutit (184 enregistrements, disque de 230 Mo), mais son serveur n'écoutait
toujours pas après dix minutes dans v86. Il n'est donc pas compté comme validé.
Ce passage a néanmoins généralisé la détection des licences `.txt`, des Gemfile
multi-base, des plages Ruby et la fourniture de Puma par RailsBox.

Cette campagne prouve une compatibilité large avec les monolithes Rails
conventionnels ; elle ne prouve pas statistiquement « toutes » ou « la plupart »
des applications Rails. Restent hors de l'enveloppe garantie : MySQL/MariaDB,
WebSockets, réseau sortant indispensable, SPA figée sur `/`, version Ruby sans
base publiée et application qui ne tient pas sur le disque avec sa marge
d'exécution.
