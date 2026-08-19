# Carte du code

Ce document sert une seule question : **par où commencer à lire ?** Le
[README](../README.md) décrit le produit et son arborescence ; les
[ADR](decisions/) portent les décisions et leurs mesures. Ici, on suit le
chemin — celui d'une requête HTTP, du clic du visiteur jusqu'à Puma et retour —
puis on nomme les fichiers qui le portent.

Rien de ce qui suit ne reformule un ADR : quand une décision explique un
détail, elle est citée, pas paraphrasée. Une paraphrase diverge ; un renvoi
non.

## Les six fichiers qui portent l'essentiel

Le dépôt fait ~17 000 lignes de JavaScript, tests compris. Six fichiers en
concentrent la substance ; le reste est de la logique pure extraite pour être
testable, ou de l'outillage de construction.

| Fichier                                       | Rôle                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public/main.js`                              | Orchestrateur de la page hôte. Enregistre le Service Worker, obtient l'isolation cross-origin, lit la configuration, boote la VM, tient le pont entre le worker et l'émulateur. |
| `public/sw-proxy.js`                          | Le Service Worker unique. Proxy `/app/*`, bocal à cookies, cache des artefacts immuables, réinjection COOP/COEP, frontière d'origine.                    |
| `public/vm/v86-vm.js`                         | Façade de l'émulateur. Instantané mémoire, montage base + application, recalage d'horloge, sonde de démarrage, veille d'onglet.                          |
| `public/shared/serial-codec.js`               | Le protocole `@RIB1` : trames, contrôle de flux montant acquitté, réassemblage des réponses, assembleur de lignes du chemin chaud.                       |
| `tools/detect/`                               | Auto-détection d'une application Rails → manifeste de construction + diagnostics à code stable. Pur, sans E/S hors `detect.mjs` et `cli.mjs`.            |
| `tools/build-v86-image/`                      | La chaîne qui fabrique les artefacts : base mutualisée, disque applicatif, instantanés, découpage, classifieur d'échecs.                                 |

Un septième fichier n'est pas du JavaScript et se lit pourtant tôt :
`tools/build-v86-image/base/rib/serial-bridge.py`, le démon qui tient l'autre
bout du port série, à l'intérieur de la VM. Le protocole `@RIB1` n'a que deux
implémentations — celle-là et `serial-codec.js` — et elles doivent rester
d'accord.

## Le trajet d'une requête

### Étage 0 — le démarrage de la coquille

Le visiteur ouvre `https://compte.github.io/depot/`. Tout ce qui suit se passe
dans son onglet ; il n'y a **pas de serveur** (voir « Principe fondamental »
dans [`SECURITY.md`](../SECURITY.md)).

1. `index.html` charge `main.js`, qui relève d'abord les capacités du
   navigateur (`shared/prerequis-demarrage.js`). Un navigateur qui ne peut pas
   faire tourner la sandbox se le voit dire tout de suite, plutôt que d'échouer
   trois étages plus loin sur un `navigator.serviceWorker is undefined`.
2. Enregistrement de `sw-proxy.js`, puis `ensureControlled()` : au tout premier
   passage la page n'est pas encore contrôlée par le worker. Prendre le
   contrôle est une **course** — `serviceWorker.ready` se résout dès qu'un
   worker est actif, alors que le `clients.claim()` qui donne son `controller`
   à la page se propage juste après. La coquille laisse donc 2 s à
   `controllerchange`, puis recharge une fois ; ce rechargement fait partie du
   démarrage normal. S'il n'a pas suffi, elle **ne parle pas de panne** : le
   panneau passe au ton informatif et offre un bouton « Recharger la page », le
   remède connu. Deux rechargements au total (`MAX_REPRISES_CONTROLE`) — un
   automatique, un demandé au visiteur — après quoi seulement le message
   devient terminal et nomme ce qu'il reste à essayer (navigation privée,
   extension de blocage, navigateur non supporté). Toute la décision vit dans
   `shared/prerequis-demarrage.js` (`repriseControle`), testée sans navigateur.
3. `ensureCrossOriginIsolated()` : le worker réinjecte COOP/COEP sur les
   navigations qu'il intercepte, mais celle qui l'a installé est déjà partie
   sans. Second rechargement sur un hébergeur statique ; en local, `serve.mjs`
   pose les en-têtes et l'étape passe du premier coup.
4. Lecture de `disks/v86-config.json` — **relative à `document.baseURI`**, et
   c'est structurel : sur un Pages de projet le site vit sous `/depot/`, où un
   chemin absolu sort du site (ADR 0004). La configuration est aussitôt
   déclarée au worker (`artifact-config`) : il en dérive le nom du cache
   d'artefacts, et il doit la connaître **avant** que v86 ne demande son premier
   morceau.
5. `bootVm()` cherche un instantané mémoire : d'abord le cache IndexedDB de ce
   navigateur (`rib-v86-snapshots`), sinon l'instantané pré-calculé livré avec
   la sandbox, téléchargé et décompressé au vol. `?fresh=1` purge et force un
   boot à froid.
6. v86 démarre avec deux disques : `hda` = le rootfs mutualisé (URL **absolue
   cross-origin** vers le dépôt d'artefacts, morceaux zstd) et `hdb` = le disque
   applicatif (chemin **relatif**, publié à côté de la coquille). Cette
   asymétrie est la topologie de l'ADR 0004, et le format de morceaux celui de
   l'[ADR 0003](decisions/0003-artefacts-en-fichiers-parties.md).
7. Dans la VM, le noyau boote sur `init=/opt/rib/guest-init.sh` : pseudo-fs,
   loopback, Redis, puis `exec python3 /opt/rib/serial-bridge.py` branché sur
   `ttyS0` en mode `raw -echo`. Aucune application n'est lancée à cet étage —
   c'est la condition de l'[ADR 0002](decisions/0002-decoupage-base-application.md).
8. `main.js` crée un `MessageChannel`, garde `port1` et transfère `port2` au
   worker. Le worker n'accepte ce message **que du document coquille**
   (`isShellClient`) : l'iframe applicative est un client same-origin comme un
   autre, et sans ce filtre un XSS y posait son propre pont.
9. `waitUntilReady()` sonde `GET /app/` toutes les 5 s, en recalant l'horloge
   invitée à chaque tour (trame `TIME`). Puma, lui, est déjà vivant : le delta
   d'instantané a été capturé après le démarrage applicatif, il restaure donc un
   serveur en marche.
10. Puma répond → `frameElement.src = "app/"`. Le visiteur voit son application.

### Étage 1 — l'iframe demande une page

L'iframe demande `/depot/app/posts`. Le worker intercepte (`fetch`), et tranche
dans cet ordre :

1. **Est-ce un artefact immuable ?** (`isArtifactCandidate` : GET, sans `Range`,
   nom de fichier-partie ou noyau/initrd) → stratégie « cache d'abord », **sans
   ajouter le moindre en-tête**. Ajouter quoi que ce soit déclencherait un
   préflight CORS que GitHub Pages refuse en 405 — point de vigilance de
   l'[ADR 0001](decisions/0001-distribution-artefacts.md).
2. **Est-ce cross-origin, ou sous `/disks/` ?** → laissé au navigateur.
3. **Est-ce un asset fingerprinté ?** (`/depot/app/assets/…`) → servi
   statiquement depuis `/depot/disks/assets/…`, extrait de l'image par
   `tools/extract-assets.sh`. Ces fichiers **ne traversent jamais le pont** :
   c'est le levier de performance n°1, ~90 % du trafic d'un chargement de page.
4. **Est-ce un fichier racine écrit en dur par l'application ?**
   (`rootStaticCandidate` : un seul segment, une extension, pas un nom que la
   coquille sert elle-même) → servi depuis `/depot/disks/appstatic/…` si
   l'inventaire `index.json` — écrit à l'extraction avec ce que l'image
   contenait à la racine de son `public/` — le connaît. Sinon la requête
   retombe exactement où elle tombait avant (étape 5, ou `proxyToVm` sous
   `/app`). Rien n'est routé vers la VM par cette étape.
5. **Est-ce sous `/depot/app` ?** → `proxyToVm`, la suite de ce parcours.
6. Sinon, GET → la réponse du réseau, augmentée de COOP/COEP.

### Étage 2 — le proxy fabrique un descripteur

`proxyToVm` (dans `sw-proxy.js`) :

1. `appRequestRefusal` **avant tout le reste** : une navigation initiée par un
   site tiers arrive bel et bien ici — un Service Worker n'intercepte pas que
   ses propres clients — et le bocal y attacherait la session. Partent en 403 :
   tout signal d'origine étranger (`Origin`, `Sec-Fetch-Site` inter-site,
   référent), **toute navigation de premier niveau** (`destination:
   "document"` : l'application ne vit que dans l'iframe de la coquille) et
   toute navigation qui écrit sans origine attribuable. La forme de la requête
   est décisive parce que les en-têtes, eux, sont absents sur Firefox et
   WebKit — mesuré, voir `SECURITY.md`.
2. `ensureBridgePort()` : le navigateur tue les workers dès qu'ils sont
   inactifs. Quand le port manque, le worker le **redemande** à la page plutôt
   que d'échouer en 503.
3. `ensureCookiesRestored()` : le bocal est relu depuis IndexedDB
   (`railsbox-cookies`), une fois par vie du worker.
4. Construction du descripteur : méthode, `pathname + search` **préfixe de
   publication compris** (l'application est montée sur son chemin public
   complet, sans quoi Rails génère ses liens à la racine du domaine),
   en-têtes + `x-forwarded-proto: https`, et un canal dédié `cookie` alimenté
   par le bocal fusionné aux vrais cookies du navigateur.
5. `postMessage` sur le port, corps transféré.

### Étage 3 — la page relaie, le codec encode

`main.js#relayToVm` → `v86-vm.js#handleHttpRequest` →
`serial-codec.js#buildRequestFrames`, qui fait passer le descripteur par la
frontière de validation `shared/request-codec.js` : méthodes en liste blanche,
chemin sans caractère de contrôle, en-têtes hop-by-hop retirés, `cookie` et
`origin` retirés de la liste générale (le premier a son canal dédié, le second
est délibérément supprimé — voir « Cookies et protection CSRF » dans
`SECURITY.md`).

Puis les trames partent sur `ttyS0` :

```
@RIB1 REQ <id> <base64(json du descripteur)>
@RIB1 BOD <id> <base64 d'une tranche de 1536 octets>   ← acquittée une par une
@RIB1 FIN <id>
```

Le découpage du corps n'est pas une élégance : le canal montant perd des octets
bien avant 32 Ko d'un seul tenant. Chaque tranche attend son `ACK` avant que la
suivante parte.

### Étage 4 — dans la VM

`serial-bridge.py` lit ses lignes sur `stdin` (`ttyS0`), reconstitue la requête,
puis ouvre une connexion vers `127.0.0.1:3000` dans un thread. Puma y sert
`/opt/rib/config.ru`, qui monte l'application par `Rack::URLMap` sur
`ENV["RAILS_RELATIVE_URL_ROOT"]` — `RAILS_RELATIVE_URL_ROOT` seul ne préfixe que
les assets, les helpers de routes s'appuient sur le `SCRIPT_NAME` de Rack.
L'application, elle, n'est pas modifiée d'une ligne.

### Étage 5 — le retour

```
@RIB1 RSB <id> <taille brute>
@RIB1 DAT <id> <8000 caractères base64>   ← autant de fois que nécessaire
@RIB1 END <id>
```

Toute ligne sans le magic `@RIB1` est du journal (noyau, Puma, PostgreSQL) et
remonte telle quelle dans le panneau de la coquille. Le démon n'a **qu'un seul
écrivain** sur le port, sous verrou : un `tail -F` concurrent entrelaçait ses
lignes avec les trames et les corrompait.

Côté hôte, `createLineAssembler` reçoit **un appel JavaScript par octet** — v86
n'émet rien par bloc. Le chemin chaud est donc strictement O(1) sans allocation
(tampon pré-alloué à croissance géométrique) ; `tools/bench-serial.mjs` mesure
ce coût. `createResponseAssembler` alloue une fois à la taille annoncée par
`RSB` et décode chaque tranche directement dans ce tampon.

Puis `splitHttpResponse` sépare tête et corps, `parseCurlHeaders` lit le statut,
et la réponse remonte le port jusqu'au worker, qui :

- **retire les `Set-Cookie`** et les range dans le bocal (`shared/cookie-jar.js`)
  — un Service Worker ne peut pas faire poser de cookie, `Set-Cookie` est un
  en-tête interdit sur une `Response` construite ; sans ce bocal, Rails répond
  422 `InvalidAuthenticityToken` à toute écriture ;
- réécrit les `Location` same-origin sous `/app` (`rewriteLocation`) ;
- pose COOP/COEP/CORP, et **ajoute** la CSP applicative à tout document HTML
  (ajout, jamais substitution : les deux politiques s'intersectent).

## Ce que la chaîne de construction fabrique

Le trajet ci-dessus suppose des artefacts. Ils sortent de deux moitiés.

**`tools/detect/` — classer sans exécuter.** Lit `Gemfile.lock`,
`.ruby-version`, `config/database.yml`, `package.json` et l'éventuel
`railsbox.yml`, et produit un manifeste gelé plus une liste de diagnostics à
**code stable** (`unsupported-database`, `missing-pg-gem`,
`assets-amd64-stage`…). Le module le plus structurant est `assets.mjs` : il
décide où précompiler les assets, et cette décision découle d'un fait
d'architecture — le guest est un i386, et ni `tailwindcss-ruby` ni
`sass-embedded` ne publient de binaire pour cette architecture. Ces outils
produisent du CSS ordinaire : on les exécute donc sur un étage amd64, et seul
`public/assets` entre dans le disque i386.

**`tools/build-v86-image/` — fabriquer.** Deux voies coexistent :

- la voie **base + application** (ADR 0002), celle des workflows : `base/`
  construit le rootfs mutualisé, `build-app-disk.sh` le disque applicatif de
  512 Mo à géométrie fixe, `make-delta-snapshot.mjs` capture l'état mémoire
  après démarrage de Puma, `split-artifact.mjs` découpe **les trois** en
  fichiers-parties de 4 Mio — zstd pour les disques, que v86 décompresse
  lui-même, gzip pour l'instantané, que la coquille décompresse avec
  `DecompressionStream` (ADR 0003) ;
- la voie **monolithique** héritée (`build.sh` + `make-snapshot.mjs`), qui
  produit une image unique. Elle n'a plus d'exclusivité fonctionnelle.

`classifier-echec.mjs` est le pendant aval de `detect/` : il classe les pannes
de construction (bundle, assets, base de données, instantané, publication) et
rend une catégorie, un code, un remède et l'extrait de journal qui le prouve.
C'est lui qui écrit le bloc « Pourquoi la construction a échoué » dans le résumé
de job.

## Ce qu'aucun étage ne fait

Quatre absences valent d'être connues avant de proposer un correctif — chacune
est un choix, pas un oubli :

- **Le guest ne connaît pas l'origine publique.** Il ne peut donc rien vérifier
  d'inter-origine ; le contrôle appartient au worker, qui la connaît. C'est
  pourquoi `request-codec.js` **retire** `Origin` et `proxy-logic.js`
  **contrôle** la provenance — non pas sur des en-têtes, absents des
  navigations sur Firefox et WebKit, mais sur la forme de la requête
  (`destination`, `referrer`). Voir `SECURITY.md`.
- **La coquille ne charge aucune URL fournie par l'utilisateur.** Le chemin de
  configuration est fixe et same-origin ; il n'y a donc ni allowlist, ni
  registre, ni validation d'URL à écrire (ADR 0004).
- **Le Service Worker ne met en cache ni l'instantané ni les lectures `Range`.**
  L'instantané vit en IndexedDB, côté page ; une réponse 206 est refusée par
  Cache Storage. Seuls les morceaux lus d'un bloc passent par le cache.
- **Rien ne survit à l'onglet.** Aucune persistance n'est promise au visiteur,
  et c'est une propriété du cadrage, pas une lacune.

## Où sont les décisions

| Question                                                          | Décision                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pourquoi GitHub Pages, et pas les Releases ?                       | [ADR 0001](decisions/0001-distribution-artefacts.md)                                   |
| Pourquoi deux disques au lieu d'un ?                               | [ADR 0002](decisions/0002-decoupage-base-application.md)                               |
| Pourquoi des morceaux zstd, et pas un réassemblage par la coquille ? | [ADR 0003](decisions/0003-artefacts-en-fichiers-parties.md)                          |
| Pourquoi une origine par démonstration, et pas une coquille centrale ? | [ADR 0004](decisions/0004-topologie-de-distribution.md)                            |
| Qu'est-ce qui est défendu, et qu'est-ce qui ne l'est pas ?          | [`SECURITY.md`](../SECURITY.md)                                                        |

Un changement qui contredit un ADR n'est pas interdit : il demande un nouvel
ADR, qui cite celui qu'il remplace et porte les mesures qui le justifient.
C'est la forme qu'ont pris les quatre existants — l'ADR 0003 annule deux
conséquences de l'ADR 0001, et le dit.

## Par où commencer, selon ce qu'on veut changer

| Si vous voulez…                                    | Lisez d'abord                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Prendre en charge une gem, un adaptateur, un outil d'assets | `tools/detect/detect.mjs`, `tools/detect/assets.mjs`, `tests/panel-variantes.test.mjs` |
| Améliorer un message d'échec de construction        | `tools/build-v86-image/classifier-echec.mjs`, `tests/classifier-echec.test.mjs`             |
| Toucher au protocole série                          | `public/shared/serial-codec.js` **et** `tools/build-v86-image/base/rib/serial-bridge.py`   |
| Toucher au proxy, aux cookies, au cache             | `public/shared/proxy-logic.js`, `cookie-jar.js`, `artifact-cache.js` (logique pure, testée) puis `public/sw-proxy.js` (câblage seul) |
| Toucher au boot ou à l'instantané                   | `public/vm/v86-vm.js`, `public/shared/v86-config.js`, `tools/vm-harness.mjs`                |
| Ajouter une variante au panel                       | `tools/demo-app/`, `tests/panel-variantes.test.mjs`, `.github/workflows/valider-variantes.yml` |

La discipline est constante dans le dépôt : **la logique pure sort du
navigateur**. `sw-proxy.js` ne garde que le câblage événementiel, intestable
hors navigateur ; tout ce qui se décide se décide dans `shared/`, et s'y teste.
Un correctif qui ajoute une décision dans `sw-proxy.js` sera renvoyé vers
`shared/`.

---

Conventions, niveaux de test et processus : [`CONTRIBUTING.md`](../CONTRIBUTING.md).
Chantiers ouverts : [`chantiers.md`](chantiers.md).
