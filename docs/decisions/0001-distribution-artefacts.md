# ADR 0001 — Distribution des artefacts de sandbox (spike C0)

Date : 2026-08-16 · Statut : accepté, **partiellement remplacé par
[l'ADR 0003](0003-artefacts-en-fichiers-parties.md)**

> Le choix d'hébergement (Pages oui, Releases non) tient. En revanche les deux
> conséquences que cet ADR en tirait — réassemblage des chunks par la coquille,
> et rootfs de base hébergé hors GitHub — sont annulées : v86 lit nativement des
> fichiers-parties zstd, et la base compressée tient sur Pages.

## Question

Le plan v3 (badge « Try it » décentralisé, 0 €) prévoyait de servir les
artefacts de chaque application (disque applicatif, delta d'instantané)
depuis les **Releases GitHub** du dépôt du mainteneur, chargés par la
coquille hébergée sur un autre domaine. Cela exige, côté navigateur :
CORS (la coquille est cross-origin) et des requêtes Range (v86 lit le
disque par morceaux), le tout sous `COEP: require-corp`.

## Mesures (curl, 2026-08-16)

| Hébergement | CORS (`Access-Control-Allow-Origin`) | Range | OPTIONS |
|---|---|---|---|
| Release assets (`release-assets.githubusercontent.com`) | **absent**, même avec `Origin` | 206 OK (hors CORS) | **405** |
| GitHub Pages (`*.github.io`) | **`*` systématique** | **206 OK, CORS conservé** | 405 |

## Décision

- ❌ **Les Releases GitHub sont inutilisables** comme source d'artefacts
  pour un chargement navigateur cross-origin. (Elles restent utiles comme
  archivage/téléchargement humain.)
- ✔ **Les artefacts par application vivent sur la branche `gh-pages` du
  dépôt du mainteneur** (GitHub Pages) : CORS `*` et Range y fonctionnent.
  Contraintes intégrées au design : fichiers ≤ 95 Mo (limite git 100 Mo)
  → les artefacts sont **découpés en morceaux** ; site ≤ 1 Go (large).
  ~~Réassemblés par la coquille (le disque applicatif post-B2 fait
  ~100–300 Mo → 2–4 chunks, chargeables en mémoire, v86 accepte un
  buffer).~~ **Annulé par l'ADR 0003** : v86 lit les fichiers-parties
  nativement, morceau par morceau, sans réassemblage ni chargement complet.
- ~~Le **rootfs de base mutualisé** (~1 Go, trop gros pour Pages) est servi
  par l'hébergement de railsbox (Cloudflare Pages/R2 gratuit — scénario 2
  déjà acté), en cache navigateur partagé entre toutes les sandboxes.~~
  **Annulé par l'ADR 0003** : compressé en morceaux zstd, le rootfs tombe à
  333 Mo et tient sur Pages. Plus besoin de Cloudflare.

## Points de vigilance

- Le preflight OPTIONS répond 405 partout, mais un `Range: bytes=a-b`
  simple est **CORS-safelisted** (spec Fetch) : pas de preflight tant que
  la coquille n'ajoute aucun en-tête non listé sur ces requêtes.
  À verrouiller par un test E2E navigateur en phase C.
- Ce choix supprime toute dépendance à un compte de stockage par
  mainteneur : la chaîne reste « GitHub seulement » côté utilisateur.
