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

- **PostgreSQL dans le disque app** — **implémenté (2026-08-16)** : le cluster
  est initialisé au build du disque applicatif avec les binaires de la base
  (donc la même version), dans `PGDATA=/app/var/pg`, migré, seedé, puis
  **arrêté en mode `fast`** — c'est ce checkpoint qui rend le datadir cohérent
  avant le `mkfs` de l'ext2. L'init de la base ne démarre jamais PostgreSQL :
  le cluster est lancé par `start-app.sh`, après le montage de hdb. Un
  postmaster démarré à l'init serait figé par l'instantané de base avec des
  descripteurs ouverts sur un datadir inexistant, et se réveillerait chez tous
  les visiteurs — y compris ceux dont l'application n'utilise pas PostgreSQL.
  Le cycle de vie complet tient dans un seul script (`base/rib/postgres.sh`),
  appelé aux deux bouts : ce qui tourne dans la VM est exactement ce qui a été
  préparé au build. Le serveur entre dans la base à la révision `3.3-r2` ;
  aucun cluster n'y subsiste (celui que crée le postinst Debian est supprimé).
- **Instantané et hdb** — **tranché par spike (2026-08-16)** : v86 REFUSE de
  restaurer un état capturé sans hdb quand la configuration en attache un
  (`set_state` lève pendant `restore_state`, vérifié sur l'instantané
  jiyufit + hdb ext2 de 8 Mo). Le repli est donc la règle : l'instantané de
  base est capturé **avec un hdb vide de taille fixe** (ex. 512 Mo sparse) ;
  au boot d'une app, le fichier hdb est remplacé par le disque applicatif
  **padded à la même géométrie**. Le contenu du disque n'est pas embarqué
  dans l'état (comme hda), seule la géométrie doit correspondre — à
  confirmer par le spike suivant lors de l'implémentation B2.
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
