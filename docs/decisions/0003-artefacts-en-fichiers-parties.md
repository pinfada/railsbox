# ADR 0003 — Artefacts servis en fichiers-parties (spike C1)

Date : 2026-08-16, étendu le 2026-08-17 · Statut : accepté · Complète et corrige
[ADR 0001](0001-distribution-artefacts.md)

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

---

## Extension du 2026-08-17 — l'instantané mémoire rejoint les disques

### Pourquoi il n'était pas découpé

La décision ci-dessus tient à une propriété de v86 : **il sait lire un disque en
morceaux tout seul**. C'est ce qui rendait le découpage gratuit — aucune ligne à
écrire dans la coquille, et le visiteur ne paie que les blocs lus.

L'instantané mémoire n'a pas cette propriété. Personne ne le lit à notre place :
la coquille le télécharge d'un bloc et le passe à v86 en `ArrayBuffer`. Le
découper supposait donc d'écrire nous-mêmes le réassemblage — exactement la
« conséquence n° 1 de l'ADR 0001 » que cette ADR se félicitait d'annuler. Gzippé,
l'instantané de la démonstration pesait 76 Mo, sous la limite. On s'en est tenu
là.

### Ce que ça coûtait

**La limite de l'hébergeur était devenue un plafond de mémoire utilisable.** Sur
la première application tierce réelle — PostgreSQL, Rails 7.1, un back-office —
l'instantané gzippé faisait **118 Mo**, et la construction échouait au garde-fou
final, après vingt minutes. Le plafond n'était écrit nulle part, ne se voyait
qu'à la dernière étape, et croissait avec l'application.

### Mesures (2026-08-17, instantané de la démo, 273 Mo bruts)

Deux façons de découper. Le choix se joue sur la compression et sur la mémoire
du navigateur, pas sur la taille des fichiers — les deux passent largement.

| Stratégie | Publié | Ratio | Morceaux |
|---|---|---|---|
| gzip d'un seul tenant (avant) | 79 819 683 o | 27,86 % | 1 |
| **découpe 4 Mio puis gzip par morceau** | **79 843 531 o** | **27,87 %** | **69** |
| découpe 16 Mio puis gzip par morceau | 79 833 378 o | 27,86 % | 18 |

**Découper avant de compresser coûte 0,03 %** — 23 848 octets sur 76 Mo. Une
image mémoire n'a pas de redondance à longue portée : la fenêtre de gzip
n'exploitait déjà rien au-delà de quelques centaines de kilo-octets. L'argument
qui aurait plaidé pour l'inverse (compresser d'abord, découper le `.gz`) ne pèse
donc rien, alors qu'il coûterait cher :

- les bornes des morceaux seraient des offsets **dans un flux compressé**, sans
  rapport avec l'artefact — la convention de nommage de v86 ne voudrait plus rien
  dire, et l'inventaire deviendrait le seul moyen de l'interpréter ;
- aucun morceau ne serait lisible seul : un morceau manqué invaliderait tout le
  téléchargement, au lieu d'être réessayé seul ;
- le réassemblage devrait faire transiter un flux unique de plusieurs centaines
  de Mo, là où l'autre écrit chaque morceau à sa place dans un tampon
  pré-alloué.

### Décision

- ✔ **L'instantané est publié en fichiers-parties gzip**, découpés AVANT
  compression, avec la convention de nommage et l'inventaire `-parts.json` des
  disques. Même outil (`split-artifact.mjs --gzip`), même taille de morceau
  (4 Mio).
- ✔ **gzip et non zstd**, seule divergence avec les disques, et pour une raison
  précise : les disques sont décompressés par v86, qui embarque son décodeur
  zstd ; l'instantané est décompressé par NOUS, avec `DecompressionStream`, qui
  couvre gzip sur les trois moteurs et zstd sur un seul.
- ✔ **Le réassemblage n'alloue qu'un seul tampon**, à la taille annoncée par
  l'inventaire, et y écrit chaque morceau à sa place
  (`public/shared/snapshot-parts.js`). Le dépassement est d'un morceau, pas d'un
  instantané. Le chemin d'avant, lui, matérialisait le flux décompressé puis le
  recopiait dans un `ArrayBuffer` neuf.
- ✔ **C'est la présence de l'inventaire qui décide du format**, pas un champ de
  configuration. Une sandbox publiée avant cette date n'a pas de `-parts.json` :
  la coquille retombe sur le fichier d'un seul tenant, et rien n'est à
  reconstruire. Les deux chemins sont couverts par
  `tests/snapshot-transport.test.mjs`.
- ✔ **Le garde-fou de publication change de sens.** Il refusait un fichier trop
  gros ; il vérifie désormais d'abord que les inventaires sont là (donc que le
  découpage a bien eu lieu), et ne refuse un fichier qu'en nommant ce qu'il ne
  peut pas être — un artefact de la VM — pour renvoyer vers ce qu'il est : un
  fichier de l'application.

### Points de vigilance

- **Le plafond a changé de nature, il n'a pas disparu.** Ce n'est plus 95 Mo par
  fichier mais **1 Go par site** (ADR 0001), partagé entre le disque applicatif
  (~48 Mo), l'instantané (~76 Mo pour la démo, ~118 Mo pour une application
  lourde) et les assets extraits. On en est à moins de 20 %.
- **gzip peut faire grossir un morceau incompressible**, comme zstd : le plus
  gros morceau de l'instantané de la démo fait 4 195 607 octets pour 4 194 304 en
  entrée. Sans conséquence à 4 Mio, à ne pas oublier si la taille de morceau se
  rapprochait un jour de la limite.
- **La décompression est désormais requise du navigateur.** Un moteur sans
  `DecompressionStream` ne peut plus restaurer un instantané découpé et repart en
  boot à froid, avec un message explicite. Les trois moteurs visés le portent
  depuis 2023, et l'isolation cross-origin qu'exige déjà la coquille est une
  contrainte bien plus dure.
- Le cache d'artefacts du Service Worker couvre ces morceaux comme ceux des
  disques. Il retient l'instantané **sans condition**, sans champ de
  configuration qui dirait qu'il est découpé : un instantané d'un seul tenant
  n'engendre aucune URL de la forme « fichier-partie », donc rien à mettre en
  cache par erreur.
