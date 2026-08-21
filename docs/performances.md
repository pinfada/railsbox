# Performances

Ce que la construction coûte, ce que le visiteur télécharge, et comment la sandbox se comporte sous processeur bridé.

*Retour au [README](../README.md).*

---

## Ce que fait le workflow, en ~9 minutes

Il réassemble le rootfs mutualisé depuis le dépôt d'artefacts railsbox,
construit le disque de votre application depuis l'image de base, exécute vos
seeds, capture un instantané mémoire post-démarrage, découpe le tout en
morceaux compressés et publie la coquille avec. **Votre dépôt héberge environ
130 Mo** pour l'application de démonstration — comptez ~150–350 Mo selon la
vôtre ; le rootfs de 1,45 Go reste chez railsbox.

Tailwind, dart-sass et les chaînes npm n'ont rien à déclarer : la détection les
repère et bascule seule la précompilation sur un étage amd64. Le résumé de la
construction affiche l'étage retenu, la version de Ruby et la base détectée.

## Ce que verront vos visiteurs

| Ce que fait le visiteur | Mesuré |
| --- | --- |
| Application affichée | **~20–25 s** (instantané restauré) |
| Téléchargé pour cela | ~32 Mo depuis le dépôt d'artefacts + l'instantané, en morceaux de 4 Mio gzippés (76 Mo pour la démonstration) |
| Navigation, formulaires, POST | normaux, servis par la VM |

Pendant l'attente, une barre nomme l'étape en cours et compte les secondes
(« Étape 5/5 · Rendu de la première page par la VM · 31 s »). Elle existe
parce que la mesure sous processeur bridé l'exigeait : la dernière phase, entre
badges tous verts et première page affichée, dure 1 s sur une machine de bureau
mais jusqu'à 14 s sur un appareil lent — sans rien qui distingue « ça arrive »
de « c'est bloqué ».

Le rootfs mutualisé de 1,45 Go n'est jamais téléchargé en entier : v86 en lit
les morceaux qu'il touche, une trentaine sur 363. Et il ne les lit qu'une fois :
le Service Worker les garde en Cache Storage, si bien qu'un visiteur qui revient
ne retélécharge rien (voir « [Le cache des artefacts](fonctionnement.md#le-cache-des-artefacts) »).

**Navigateurs** — mesuré par la recette `npm run test:live` (voir
« [Vérifier une sandbox publiée](developpement.md) ») sur la
démonstration publiée et sur une réplique locale de la publication :

| Moteur | Coquille | Service Worker | Isolation COI | Boot VM | Application servie | Cache d'artefacts |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 151 | ok | ok | ok | 18–24 s | ok | ok |
| Firefox 153 | ok | ok | ok | 21 s | ok | ok |
| WebKit 26.5 | ok | ok | ok | 20 s | ok | ok |

Seule différence mesurée : la première requête traversant le pont série coûte
environ 6 s sous Firefox, contre 1 s ailleurs.

**Mobile** : la coquille est adaptée aux téléphones — mise en page vérifiée à
320, 390 et 393 px (`tests/e2e/coquille-mobile.e2e.spec.mjs`). Le processeur,
lui, est maintenant mesuré pour de bon. L'émulation mobile de Playwright ne
change que la fenêtre et l'agent utilisateur ; `npm run test:bridage`
(`tests/bridage/`) ralentit **réellement** le fil d'exécution du navigateur par
Chrome DevTools Protocol et rejoue le démarrage de la sandbox publiée à chaque
taux. Deux boots par taux, contexte neuf à chaque fois :

| Bridage processeur | Application annoncée | Application **visible** | 1re page du scaffold | Page suivante |
| --- | --- | --- | --- | --- |
| 1× — poste de bureau | 23,7 / 24,4 s | 24,7 / 25,5 s | 1,3 s | 0,3 s |
| 4× — téléphone milieu de gamme | 26,8 / 26,8 s | 30,4 / 31,2 s | 7,2 / 7,7 s | 1,6 / 2,2 s |
| 6× — entrée de gamme | 31,7 / 31,8 s | 39,0 / 39,4 s | 13,5 / 13,9 s | 3,1 / 4,4 s |
| 8× — vieil appareil | 37,1 / 39,6 s | 49,7 / 54,0 s | 24,2 / 25,8 s | 5,3 / 8,0 s |

**Le démarrage ne casse pas, il s'allonge** : jamais d'échec, toujours deux
sondes internes, et la sonde la plus lente (1,3 s) reste huit fois sous le délai
que la coquille lui accorde. Sa croissance (+60 % de 1× à 8×) ne vient d'ailleurs
presque pas de l'émulation — l'instantané a déjà fait ce travail, et la phase
« VM prête → application prête » ne bouge que de 14,9 à 17,1 s — mais du chemin
de chargement, décompression et mise en cache de l'instantané comprises, qui
s'exécute lui aussi sur le fil bridé.

**Ce qui se dégrade vraiment, c'est l'usage.** Chaque page servie traverse Rails
puis le pont série, tous deux sur le processeur de l'onglet : la première page du
scaffold passe de 1,3 s à 25 s, et les suivantes de 0,3 s à 5–8 s — soit un peu
plus que proportionnel au bridage. Le seuil pratique est donc **entre 6× et 8×** :
à 4× la sandbox reste confortable, à 6× elle est lente mais utilisable, à 8× il
faut compter une minute avant de voir l'application et une poignée de secondes
par clic — de quoi montrer une application, pas y travailler. C'est aussi
pourquoi la coquille affiche désormais l'étape de démarrage en cours et le temps
écoulé, jusqu'à la première page **rendue** : la dernière attente (1 s à 1×, mais
12 à 15 s à 8×) se déroulait sous une rangée de badges déjà tous verts, sans rien
qui distingue « ça arrive » de « c'est bloqué ».

**Ce qui reste hors de portée** : un **vrai** téléphone, physique. Le bridage CDP
ralentit le fil d'exécution ; il ne reproduit ni un cache processeur plus petit,
ni la mémoire d'un onglet mobile — bien plus vite arbitrée par le système — ni la
limitation thermique après quelques minutes d'émulation continue. Comptez le
mobile comme mesuré et praticable, pas comme garanti. Les recettes jouent
Chromium par défaut ; `RAILSBOX_MOTEURS=tous` (ou une liste : `firefox,webkit`)
élargit `npm run test:live` et `npm run test:e2e` aux trois moteurs — le bridage,
lui, reste Chromium seul, faute d'équivalent CDP ailleurs. Les webviews qui
bloquent les Service Workers ne peuvent pas fonctionner, par construction — la
coquille l'explique alors au visiteur au lieu d'échouer en silence.

**Processeur du visiteur** : l'émulation utilise le CPU de l'onglet — c'est le
« serveur » que chaque visiteur apporte. Un onglet masqué plus de 15 s met la
VM en veille et rend le processeur ; le retour la reprend, horloge recalée.
**Une seule sandbox tourne à la fois par navigateur** : un verrou exclusif
(Web Locks) désigne l'onglet actif, et un second onglet ouvert sur la même
sandbox ne démarre aucune VM — il affiche « déjà ouverte dans un autre
onglet » et un bouton pour reprendre la main ici, auquel cas l'autre onglet
libère la sienne.

**Ce que l'hébergeur doit fournir** — et GitHub Pages le fournit : CORS `*`,
requêtes `Range`, et rien d'autre. Les en-têtes d'isolation `COOP`/`COEP`, qu'un
hébergement statique ne pose pas, sont réinjectés par le Service Worker.

---
