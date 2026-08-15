# ADR 0002 — Découpage rootfs de base / disque applicatif (B2)

Date : 2026-08-16 · Statut : proposé (implémentation en phase B2)

## Problème

Aujourd'hui une sandbox = une image ext2 monolithique (~4,2 Go pour jiyufit)
contenant Debian, le noyau, PostgreSQL, Redis, Ruby compilé ET l'application.
Conséquences : capture d'instantané mono-cœur de ~12 min par application,
artefact énorme à héberger et télécharger par sandbox, aucun partage entre
sandboxes, incompatible avec les limites GitHub Pages (ADR 0001).

## Décision

Deux disques v86 :

1. **`base-<ruby>.ext2`** (~1–1,5 Go après retrait de la toolchain) : Debian
   i386, noyau, PostgreSQL, Redis, Ruby binaire précompilé, démon du pont
   série, init générique. Construit UNE FOIS par version mineure de Ruby
   (3.2/3.3/3.4), publié par le dépôt railsbox (hébergement mutualisé,
   cache navigateur partagé entre toutes les sandboxes).
   Un **instantané de base** est capturé une fois : noyau booté, services
   démarrés, AUCUNE application lancée.

2. **`app.ext2`** (~100–300 Mo) monté en `hdb` sur `/app` : l'arbre de
   l'application, ses gems (`BUNDLE_PATH=/app/vendor/bundle` — les gems
   natives i386 vivent avec l'app, pas dans la base), ses assets, sa base
   de données **pré-seedée** (cluster PostgreSQL dans `/app/var/pg` ou
   fichier sqlite3), le `config.ru` Rack::URLMap et le manifeste des
   variables d'environnement.

## Cycle de build par application (cible < 5 min)

1. Docker : étage app uniquement (bundle install avec cache, assets,
   db:prepare + `seed.command` du railsbox.yml) → mkfs du petit `app.ext2`.
2. Restaurer l'instantané de base sous Node (secondes), attacher
   `app.ext2`, monter, lancer Puma, attendre la sonde, capturer le
   **delta d'instantané** (~2–3 min au lieu de 12).
3. Chunker `app.ext2` + delta en fichiers ≤ 95 Mo pour gh-pages (ADR 0001).

## Points durs identifiés d'avance

- **PostgreSQL dans le disque app** : le cluster doit être initialisé au
  build avec la même version binaire que la base ; chemin de données fixé
  par variable (`PGDATA=/app/var/pg`). L'init de la base ne démarre
  PostgreSQL qu'après montage de hdb.
- **Instantané et hdb** : v86 doit accepter la restauration d'un état
  capturé SANS hdb puis l'attachement du disque — à vérifier tôt ; repli :
  capturer l'état de base AVEC un hdb vide de taille fixe, remplacé par le
  disque applicatif (même géométrie).
- **Compatibilité** : le format `v86-config.json` gagne des champs
  (`baseDisk`, `appDisk`, `baseState`) ; `v86-vm.js` et `vm-harness.mjs`
  suivent. L'ancienne forme mono-disque reste supportée (jiyufit).
- **UID/permissions** : l'app tourne root dans la VM (déjà le cas) ;
  pas de mapping à gérer.

## Conséquences

- Temps de build par app : ~35–40 min → **< 5 min** (avec caches B3).
- Poids par sandbox : ~4,4 Go → **~150–350 Mo** + base mutualisée en cache.
- La base devient la « stdlib » de railsbox : versionnée, publiée, testée
  indépendamment des applications.
