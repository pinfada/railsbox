# ADR 0003 — Artefacts servis en fichiers-parties zstd (spike C1)

Date : 2026-08-16 · Statut : accepté · Complète et corrige [ADR 0001](0001-distribution-artefacts.md)

## Question

L'ADR 0001 a établi que les artefacts par application vivent sur la branche
`gh-pages` du mainteneur (CORS `*`, Range 206), avec deux contraintes : aucun
fichier au-delà de 95 Mo, et un site sous 1 Go. Il en tirait deux conséquences
qui coûtaient cher :

1. les artefacts seraient **découpés en chunks et réassemblés en mémoire par la
   coquille** — code à écrire, et le disque entier chargé en RAM ;
2. le **rootfs de base** (1,45 Go) ne tenant pas sous la limite du site, il
   faudrait l'héberger ailleurs — Cloudflare Pages/R2, donc un second tiers et
   un nom de domaine.

Or v86 sait déjà lire un disque servi en morceaux (`use_parts`), et décompresser
du zstd à la volée. Restait à vérifier que ça marche sur nos artefacts réels.

## Mesures (2026-08-16, artefacts de la démo)

Découpage en morceaux de 4 Mio par `tools/build-v86-image/split-artifact.mjs`,
convention de nommage de v86 : `<base>-<début>-<fin><extension>`.

| Artefact | Taille | Morceaux | Publié (zstd) | Ratio |
|---|---|---|---|---|
| `demo-app.ext2` (disque applicatif) | 512 Mo | 128 | **48 Mo** | 9 % |
| `base-3.3.ext2` (rootfs mutualisé) | 1 454 Mo | 364 | **333 Mo** | 23 % |

Boots vérifiés :

| Scénario | Résultat |
|---|---|
| hdb en morceaux non compressés, restauration du delta (Node) | HTTP 200, prêt en 21 s |
| hdb en morceaux zstd, restauration du delta (Node) | HTTP 200, prêt en 21 s |
| hda en morceaux zstd, **boot à froid dans Chromium** | init atteint, Redis démarré, pont série actif |

Dans le boot à froid navigateur, **48 morceaux sur 364 ont été demandés** :
le noyau ne lit que ce dont il a besoin. Le visiteur télécharge ~48 Mo, pas
1,45 Go — et une restauration d'instantané en lit encore moins.

## Décision

- ✔ **Les artefacts sont publiés en fichiers-parties zstd**, lus nativement par
  v86 (`use_parts`, `fixed_chunk_size`). **Aucun réassemblage dans la
  coquille** : la conséquence n° 1 de l'ADR 0001 est annulée, le code
  correspondant n'a pas à exister.
- ✔ **Le rootfs de base tient sur GitHub Pages** : 333 Mo publiés, très en deçà
  de la limite de 1 Go. La conséquence n° 2 de l'ADR 0001 est annulée :
  **Cloudflare n'est plus nécessaire**, et railsbox n'a plus qu'une seule
  dépendance tierce — GitHub. Le nom de domaine redevient un confort, pas une
  condition.
- ✔ Taille de morceau par défaut : **4 Mio**. Elle divise exactement les
  géométries en jeu, garde le nombre de fichiers gérable (128 pour un disque
  applicatif, 364 pour la base) et reste loin sous 95 Mo.
- ✔ La configuration porte `diskChunkSize` / `appDiskChunkSize` ; leur absence
  signifie « disque d'un seul tenant », le comportement historique.

## Points de vigilance

- **zstd peut faire grossir un morceau incompressible** : le plus gros morceau
  de la base fait 4 194 409 octets pour 4 194 304 en entrée. Sans conséquence
  ici (la marge jusqu'à 95 Mo est énorme), mais un morceau proche de la limite
  ne doit pas être dimensionné au ras.
- **Le harnais Node ne peut pas valider un hda zstd** : v86 passe par un Web
  Worker pour la décompression sur ce chemin, et `Worker` n'existe pas sous
  Node (`ReferenceError`). C'est une limite du harnais, pas du produit — le
  chemin est prouvé dans Chromium. Toute validation d'un hda compressé doit
  donc passer par un test navigateur.
- Le nombre de fichiers (364 pour la base) reste à surveiller côté git : ce sont
  autant d'objets dans la branche `gh-pages`.
- Le dernier morceau d'un artefact non multiple de la taille de morceau est
  complété de zéros : v86 lit toujours un morceau entier.
