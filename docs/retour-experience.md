# Retour d'expérience : les défis résolus

Les problèmes rencontrés en construisant railsbox et la façon dont ils ont été tranchés. Rien ici n'est nécessaire pour l'utiliser — c'est la mémoire du projet.

*Retour au [README](../README.md).*

---

## Retour d'expérience : les défis résolus

Vingt-deux itérations de build ont été nécessaires. Les obstacles n'étaient
presque jamais où on les attend — voici ceux qui ont coûté le plus cher.

### Le loopback TCP n'existait pas sous le moteur historique

`bind()` sur `127.0.0.1` échoue avec un `EADDRINUSE` fantôme : toute la pile TCP
passe par Tailscale. Puma écoute donc sur un **socket Unix**, purement interne au
noyau émulé. C'est ce qui a motivé le passage à v86, dont le vrai noyau Linux
rend le loopback trivial.

### Le canal montant perd les gros POST

Le port série n'a **aucun contrôle de flux** dans le sens navigateur → invité.
Mesuré : un POST de 32 Ko passe, **128 Ko est perdu et bloque le canal
définitivement**. La correction est un protocole en tranches acquittées une par
une (fenêtre d'émission de 1 536 octets), ce qui borne les octets en vol quelle
que soit la taille du tampon.

| Corps du POST | Avant | Après |
| --- | --- | --- |
| 1–32 Ko | arrive | arrive |
| 128 Ko | **perdu**, canal mort | arrive |
| 1 Mo | perdu | **2,5 s** |

Effet de bord bénéfique : le corps n'étant plus embarqué dans le descripteur JSON
lui-même ré-encodé, la charge utile perd **77 %** de son gonflement.

### Le canal est semi-duplex, et ça se voit

Une grosse réponse en cours monopolise l'écriture de l'invité : l'acquittement
d'une tranche montante attend derrière. Le même POST de 4 Ko met **105 s**
pendant le chargement des assets, contre moins d'une seconde canal libre. Le
délai d'acquittement est donc aligné sur celui d'une requête complète — une
valeur courte faisait échouer à tort tout POST concurrent d'un téléchargement.

### Un seul écrivain sur le port série

Un `tail -F` ajouté pour la télémétrie écrivait en concurrence du démon : ses
lignes s'entrelaçaient avec les trames et **corrompaient les transferts
volumineux** (CSS de 270 Ko illisible). Les logs applicatifs sont désormais
relayés par le démon lui-même, sous son verrou.

### L'horloge invitée dérive en permanence

Attendu après restauration d'instantané (le noyau reprend à la date de la
capture), mais la mesure a montré pire : sous émulation chargée, l'invité prend
**jusqu'à 20 s de retard toutes les 5 s**. Sans recalage périodique, les cookies
de session et les jetons CSRF finissent par expirer d'eux-mêmes en cours
d'utilisation.

### `RAILS_RELATIVE_URL_ROOT` ne préfixe que les assets

| Helper | URL générée |
| --- | --- |
| `stylesheet_link_tag` | `/app/assets/tailwind-…` ✅ |
| `link_to`, `form_with` | `/gymhouses` ❌ échappe au proxy |

Les helpers de routes lisent le `SCRIPT_NAME` de Rack, vide quand Puma sert à la
racine. La correction est le déploiement sous-URI standard : un `config.ru`
fourni par l'image monte l'application via `Rack::URLMap`, **sans toucher au code
applicatif**. Défaut trouvé en cliquant sur un lien — pas en regardant la page
d'accueil s'afficher.

### Cinq pièges de l'instantané mémoire

| Piège | Traitement |
| --- | --- |
| Gel d'horloge | trame `TIME` + `date -s` au-delà de 2 s de dérive |
| Fuite mémoire — `URL.createObjectURL` sur 650 Mo n'est jamais libéré | supprimé à la racine : v86 accepte `initial_state: { buffer }` |
| Boot à froid de 13 min chez l'utilisateur | instantané généré en CI, livré compressé, téléchargé si le cache local est vide |
| Publié d'un seul tenant, il butait sur les 95 Mo par fichier de Pages | découpé en morceaux de 4 Mio gzippés, comme les disques, et réassemblé par la coquille (voir ci-dessous) |
| v86 émet **un événement JS par octet** (369 282 pour le CSS) | assembleur `Uint8Array` pré-alloué : **24 ns/octet**, 8,9 ms pour 270 Ko |

### L'instantané en morceaux : découper avant ou après la compression ?

Les disques sont découpés depuis l'[ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)
parce que **v86 sait lire des morceaux tout seul**. L'instantané, non : c'est la
coquille qui le télécharge et le passe à v86 en `ArrayBuffer`. Le découper
supposait donc d'écrire le réassemblage — et le format restait libre. Deux
options, tranchées à la mesure sur l'instantané de la démonstration (273 Mo
bruts) :

| Stratégie | Publié | Ratio | Morceaux |
| --- | --- | --- | --- |
| gzip d'un seul tenant (avant) | 79 819 683 o | 27,86 % | 1 |
| **découpe 4 Mio puis gzip par morceau** | **79 843 531 o** | **27,87 %** | **69** |
| découpe 16 Mio puis gzip par morceau | 79 833 378 o | 27,86 % | 18 |

**Découper avant de compresser coûte 0,03 %** — 23 848 octets sur 76 Mo. Une
image mémoire n'a pas de redondance à longue portée, et la fenêtre de gzip
n'exploitait déjà rien au-delà de quelques centaines de kilo-octets. Le seul
argument en faveur de « compresser d'abord, découper le `.gz` » ne pèse donc
rien, alors qu'il coûterait trois choses : des bornes de morceaux exprimées dans
un flux compressé (donc sans rapport avec l'artefact, et la convention de nommage
de v86 ne voudrait plus rien dire), l'impossibilité de réessayer un morceau seul,
et un flux unique de plusieurs centaines de Mo à faire transiter au
réassemblage.

Trois conséquences pratiques :

- **gzip et non zstd**, seule divergence avec les disques. Ceux-là sont
  décompressés par v86, qui embarque son décodeur zstd ; l'instantané l'est par
  nous, avec `DecompressionStream` — gzip sur les trois moteurs, zstd sur un
  seul.
- **Un seul tampon alloué**, à la taille annoncée par l'inventaire, où chaque
  morceau est écrit à sa place. Mesuré dans un vrai Chromium sur l'instantané de
  la démonstration : pic de l'onglet **834 Mo** avec l'ancien chemin (qui
  matérialisait le flux décompressé avant de le recopier), **680 à 734 Mo** avec
  le nouveau — soit **100 à 155 Mo de moins**, pour un temps de boot inchangé
  (19,1 s contre 19,2 s jusqu'au badge HTTP vert).
- **C'est la présence de l'inventaire `-parts.json` qui décide du format**, pas
  un champ de configuration. Une sandbox publiée avant le découpage n'en a pas :
  la coquille retombe sur le fichier d'un seul tenant, et il n'y a rien à
  reconstruire. Les deux chemins sont exécutés par `npm test`
  (`tests/snapshot-transport.test.mjs`), avec de vrais octets gzippés.

### Un Service Worker ne peut pas poser de cookie

`Set-Cookie` est un en-tête **interdit** sur une `Response` construite : l'API
Fetch le filtre en silence. Le proxy relayait donc les réponses de Rails sans
que le navigateur n'enregistre jamais le cookie de session — celui qui porte la
graine du jeton CSRF. Conséquence : chaque requête ouvrait une session vierge,
et **tout POST répondait 422 `InvalidAuthenticityToken`**. La démonstration
promettait « créez, modifiez, supprimez un billet » et ne savait qu'afficher.

Le proxy tient donc lui-même le magasin (`shared/cookie-jar.js`) : il moissonne
les `Set-Cookie` des réponses de la VM, les range, et repose l'en-tête `Cookie`
sur chaque requête relayée. Le bocal est persisté en IndexedDB — un Service
Worker est tué dès qu'il est inactif, et perdre le bocal en cours de parcours
reviendrait à déconnecter le visiteur. `document.cookie` reste vide côté page,
ce qui n'est PAS une mise hors de portée du script : voir
[`SECURITY.md`](SECURITY.md).

Le bocal n'est pas la seule source : l'iframe étant same-origin, un
`document.cookie = "timezone=…"` posé par l'application crée un vrai cookie du
navigateur dont aucune réponse de la VM n'a parlé. Un Service Worker n'ayant
pas de DOM, il les **demande à la page hôte** (`cookies-document-request`) et
les ajoute à l'en-tête sans jamais supplanter les siens. Ce relais a remplacé
un premier essai fondé sur le Cookie Store API, qui n'existait que sur un
moteur sur trois.

Corollaire de sécurité, découvert en revue : ce magasin attache le cookie de
session à **toute** requête que le Service Worker relaie — or un SW prend en
charge les **navigations** vers sa portée quelle qu'en soit l'origine
initiatrice, pas seulement les sous-ressources de ses clients. Un formulaire
hébergé ailleurs pouvait donc écrire dans la VM du visiteur. Le proxy refuse
désormais en 403 — plus strict que le `SameSite=Lax` qu'un navigateur aurait
appliqué de lui-même.

Deuxième leçon, mesurée après coup : ce refus ne tenait d'abord que sur
**Chromium**, parce qu'il ne lisait que des en-têtes. Une navigation
interceptée par un Service Worker n'en porte AUCUN qui parle d'origine sur
Firefox et WebKit (`Sec-Fetch-*` est ajouté après l'interception, sur les trois
moteurs). La règle repose donc sur la **forme** de la requête — `destination`,
`referrer`, `mode` —, renseignée partout : une navigation de premier niveau
n'est jamais l'application, qui ne vit que dans l'iframe de la coquille. Le
relevé complet et la règle exacte sont dans [`SECURITY.md`](SECURITY.md).

**La leçon, elle, dépasse le cookie** : la recette en ligne était verte à 8/8
sur une démonstration incapable d'écrire, parce qu'elle ne faisait que des GET
— et Rails n'a besoin d'aucune session pour servir un GET. Un scénario POST
complet y a été ajouté, et le défaut a été trouvé en cliquant réellement dans
la page publiée, pas en lisant un rapport de tests.

### Détecter une variable manquante sans se tromper de mot

Une expression du type `(VARIABLE).{0,40}(mot-clé)` capture le **premier** jeton
majuscule de la ligne — sur
`{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}` elle proposait
sérieusement `FATAL` comme variable à renseigner. Remplacée par une recherche par
fenêtre autour du mot-clé, avec retrait des étiquettes de journal (`[DEVISE]`,
`[STRIPE]`) et exigence d'un souligné dans le nom.

Autre nuance : « bloquant » se juge sur la **gravité du message**, pas sur la
famille de la variable. Un `WARN` laisse l'application démarrer, seule la
fonctionnalité concernée reste inactive.

### Pièges de construction d'image, en vrac

`docker export` perd `/etc/hosts` et les uid si l'extraction n'est pas faite en
root ; un init maison doit monter `/dev/shm` (PostgreSQL 15) ; `BUNDLE_WITHOUT`
et `BUNDLE_FORCE_RUBY_PLATFORM` doivent exister **au runtime** et pas seulement
au build ; BuildKit n'applique pas la personnalité 32 bits, donc `uname -m` ment
et Bundler installe des gems x86_64 inchargeables ; nokogiri ne compile pas son
libxml2 embarqué en i386 (bibliothèques système obligatoires) ; `tmp/`, `log/` et
`storage/` sont souvent exclus par le `.dockerignore` alors que Puma exige
`tmp/pids` ; le tty série doit être en `raw -echo`, le mode canonique tronquant à
4 096 caractères.
