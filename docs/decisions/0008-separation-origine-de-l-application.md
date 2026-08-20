# ADR 0008 — La frontière coquille / application n'est pas une frontière d'origine

Date : 2026-08-20 · Statut : accepté — capacité **en service**, séparation
d'origine non décidée · Complète [ADR 0004](0004-topologie-de-distribution.md)
et [ADR 0005](0005-espace-de-noms-de-l-application.md)

## Le fait

Un audit du 20/08/2026 a relevé que l'iframe applicative porte
`sandbox="allow-scripts allow-same-origin …"` (`public/index.html`). Chromium
le dit lui-même à chaque chargement, dans la console :

```
An iframe which has both allow-scripts and allow-same-origin for its sandbox
attribute can escape its sandboxing.
```

Vérifié : le contenu de l'iframe lit le titre du document hôte et modifie son
élément racine. Il atteint donc `parent`, et par lui
`navigator.serviceWorker.controller` — celui de la COQUILLE.

## Ce que cela coûte

Le Service Worker n'accepte ses commandes privilégiées — pont vers la VM,
identité des artefacts, cookies du document, libération des lectures retenues —
que du document coquille (`isShellClient`). Le critère décide à partir de
`event.source.url` : l'URL du client émetteur.

Un XSS applicatif n'a pas besoin d'émettre depuis l'iframe. Il exécute dans le
realm du parent, et son message part avec **l'URL de la coquille**. Le filtre
le laisse alors passer par construction — il ne ment pas, il répond à une autre
question. Ce qui est à portée derrière ce message :

- remplacer le port du pont, donc recevoir chaque descripteur HTTP, `cookie:`
  EN CLAIR — les cookies `HttpOnly` de la session Rails compris ;
- réécrire la configuration des artefacts, donc le cache ;
- libérer des lectures retenues après expiration de session.

## Décision — une capacité, pas un critère

Le filtre a d'abord été resserré : `isShellClient` était écrit à l'envers
(« tout ce qui n'est pas sous `/app` est la coquille ») et donnait le privilège
à **tout document same-origin** ouvert ailleurs sur l'origine — les fichiers
racine extraits de l'image applicative (`tools/extract-assets.sh`) compris,
`404.html` en tête. Il est devenu une liste d'admission : `<base>/` et
`<base>/index.html`, rien d'autre.

Nécessaire, et pas suffisant : aucune précision du prédicat ne distingue un
script injecté dans la coquille du code légitime de la coquille. **La parade ne
peut donc pas porter sur l'émetteur ; elle porte sur ce que l'attaquant ne
détient pas.**

Les commandes du proxy ne voyagent plus que sur un `MessagePort` privé :

- la coquille le crée AU DÉMARRAGE, avant qu'aucun contenu applicatif n'existe,
  et transfère l'autre extrémité au worker (message `coquille-canal`) ;
- elle garde son extrémité dans la fermeture de son module — aucune propriété
  de `window`, aucun objet joignable ne la porte ;
- elle poste toujours par `Reflect.apply` sur la référence de
  `MessagePort.prototype.postMessage` capturée à l'évaluation du module. Sans
  cela la capacité fuirait au premier envoi suivant l'injection : un
  `postMessage` remplacé recevrait le port en `this`. Le pont vers la VM est
  protégé de même — c'est lui qui voit les `cookie:` en clair ;
- le worker refuse tout message privilégié sur le canal public, quel qu'en soit
  l'émetteur ;
- **un canal ne se PROPOSE pas : il se RÉPOND.** Le worker n'adopte un port
  qu'en réponse à un tour qu'il a lui-même ouvert, avec un nonce à usage unique,
  périssable, adressé à un client donné. Aucune proposition spontanée n'est
  acceptée — c'était la fenêtre du redémarrage, et elle est fermée ;
- il n'ouvre un tour que s'il n'a pas de canal utilisable : tant que le porteur
  vit, un script injecté ne peut même pas en obtenir un.

L'épreuve `tests/e2e/frontiere-coquille.e2e.spec.mjs` exécute l'attaque en
entier — iframe applicative, `<script src="/app/…">` injecté dans le DOM du
parent, exécution dans le realm de la coquille, quatre commandes, usurpation de
canal, et réclamation d'un tour — et vérifie d'abord que **l'injection
réussit**, sans quoi tout le reste serait creux.

### Ce qui départage la coquille d'un script injecté dans la coquille

Le nonce ne les distingue pas : ils vivent dans le même client, et le worker ne
sait pas viser plus fin qu'un client. Tous deux voient donc le même nonce.

Ce qui les départage est **l'ordre d'inscription des écouteurs**. La coquille
inscrit le sien à l'ÉVALUATION DE SON MODULE, avant que le moindre code
étranger n'existe ; les écouteurs sont appelés dans cet ordre ; elle répond donc
la première, synchroniquement, et le nonce est déjà consommé quand l'intrus
répond. `tests/e2e/relais-onglets.e2e.spec.mjs` le mesure de bout en bout :
l'intrus a bien vu le nonce, et son canal ne reçoit rien.

Cet argument ne tient que si rien de ce dont la coquille se sert entre-temps
n'a été remplacé — et la première version de ce document sous-estimait la
surface. Se méfier de `postMessage` ne suffit pas :

```js
MessagePort.prototype.start = function () { voler(this); … };
```

posé avant le tour, ce piège reçoit le port privé en `this` **au moment où la
coquille le démarre elle-même**. L'ordre des écouteurs n'y change rien : c'est
notre propre code qui appelle la fonction piégée.

Sont donc capturés à l'évaluation du module, et rappelés par `Reflect.apply` :
`Reflect.apply`, `Object.getOwnPropertyDescriptor`, `MessageChannel`, les
accesseurs `port1`/`port2` de `MessageChannel.prototype`, `postMessage`,
`start` et le setter `onmessage` de `MessagePort.prototype`,
le getter `data` de `MessageEvent.prototype`,
`EventTarget.prototype.addEventListener`, le conteneur `serviceWorker`, le
getter `controller` et les constructeurs employés pour distinguer le vrai
contexte navigateur des doubles de test. Cette distinction est elle aussi
figée au démarrage : aucun `instanceof` ne relit une globale après l'injection.
Le port privé n'apparaît dans aucun `this` observable, et le pont vers la VM est
construit par le même chemin.

`realmIntact()` relit ces mêmes références à chaque tour et JOURNALISE toute
divergence. Ce n'est délibérément pas une garde : les opérations passent déjà
par les références capturées, donc un remplacement est inerte ; refuser
d'établir le canal ne protégerait rien de plus et casserait la sandbox chez un
visiteur dont une extension instrumente ces objets. Recharger la coquille
n'aiderait pas non plus — l'iframe applicative se recharge avec elle et peut
réinjecter.

`tests/e2e/relais-onglets-reel.e2e.spec.mjs` arme ces pièges dans la VRAIE
coquille, après chargement, provoque un vrai passage de rôle (élection Web
Locks, bouton « Reprendre la sandbox », rechargement de l'onglet sortant), puis
rejoue les commandes privilégiées sur chaque port capté. Un témoin positif
vérifie que les pièges fonctionnent, sans quoi les compteurs à zéro ne
prouveraient rien.

## Le passage de relais entre onglets

« Un seul canal à la fois » a un revers : le second onglet est refusé tant que
le premier tient. Si le premier disparaît — fermé, rechargé, ou muet parce
qu'il ne pilote plus la VM — le proxy resterait muet avec lui. Trois mécanismes
l'évitent, et une épreuve les couvre (`tests/e2e/relais-onglets.e2e.spec.mjs`) :

- **vérification, pas supposition** : avant d'ouvrir un tour, le worker demande
  au navigateur si le porteur du canal existe encore (`clients.get`). Un onglet
  fermé laisse sinon un port mort sur lequel il parlerait dans le vide ;
- **accusé de réception** : le worker répond `coquille-canal-ok` sur le canal
  qu'il vient d'adopter. Une coquille sait donc si elle commande, relâche ce
  qu'elle avait mis de côté, et peut redemander sinon ;
- **abandon sur silence** : si le porteur ne fournit pas le pont dans le délai
  de récupération, le canal est abandonné. Un onglet qui ne pilote plus ne tient
  pas le proxy en otage.

## Ce que la capacité ne ferme pas

**Le même client, si la coquille perd la course.** L'argument d'ordre ci-dessus
est solide mais il n'est pas une frontière : il tient à ce que notre code
s'exécute en premier et à ce que la LISTE des intrinsèques capturés soit
complète. Elle l'est pour les surfaces énumérées ci-dessus, éprouvées une à
une ; elle relève d'une énumération, pas d'une preuve. C'est du durcissement,
pas de l'isolation — et c'est pourquoi la séparation d'origine reste la seule
issue de fond.

**Le reste de l'origine.** Un XSS applicatif lit toujours l'IndexedDB du bocal
à cookies et le `localStorage` de l'inspecteur : ce sont des risques distincts,
décrits dans `SECURITY.md`, que cette capacité ne prétend pas couvrir.

Ces deux points ont la même racine, et une seule issue : la séparation
d'origine décrite ci-dessous, qui n'est pas décidée.

## Pourquoi `allow-same-origin` est là

Ce n'est pas une facilité. Sans lui, l'iframe reçoit une **origine opaque**, et
une origine opaque n'est cliente d'aucun Service Worker. Or tout RailsBox tient
à ce que le worker intercepte les requêtes de l'application : c'est le proxy.
Retirer `allow-same-origin` sans rien changer d'autre ne durcit pas la
sandbox — il supprime le produit.

Le même raisonnement écarte `srcdoc` et les URL `blob:` : origines opaques
elles aussi.

## Ce qu'une vraie séparation demanderait

Une frontière réelle suppose que le document applicatif vive sur une **autre
origine**, servie par son propre Service Worker, et parle à la coquille par
`postMessage` inter-origine. Conséquences relevées :

| Point d'impact | Effet |
|---|---|
| Hébergement | GitHub Pages ne donne qu'une origine par compte (`<compte>.github.io`), quel que soit le nombre de dépôts. Deux origines exigent un **domaine propre** (`app.example.com`) ou un **second compte/organisation** |
| Isolation cross-origin | La coquille exige COOP/COEP pour `SharedArrayBuffer` (v86). Une iframe cross-origin sous `require-corp` doit servir `CORP: cross-origin` **et** porter COEP ; à défaut, `credentialless` change la donne pour les cookies |
| Cookies | Le bocal vit déjà dans le worker, pas dans le document : c'est le point le moins coûteux. Mais chaque origine a son worker, donc son bocal — il faut décider laquelle des deux le tient |
| Pont série | La VM tourne dans la coquille. Le `MessagePort` devra franchir la frontière d'origine, avec une vérification d'`event.origin` là où `isShellClient` suffisait |
| Artefacts | L'origine applicative n'a aucune raison de servir les artefacts : la distribution (ADR 0004) reste inchangée |
| Démonstrations publiées | Chaque sandbox publiée devient **deux** publications, ou une publication et un sous-domaine. Cela touche la doctrine de distribution, pas seulement le code |

Le coût n'est donc pas dans le navigateur : il est dans l'hébergement et dans
la promesse « une sandbox, une URL ». C'est une décision de produit, et elle
n'est pas prise ici.

## Une objection qu'il a fallu lever

La première rédaction de cette note écartait la capacité, au motif qu'un jeton
gardé en fermeture fuirait au prochain envoi : il suffirait de remplacer
`postMessage` pour le capter. L'objection est juste pour un JETON transmis dans
les messages ; elle ne l'est pas pour un PORT dont on ne se sert que par la
référence originale de `postMessage`, capturée avant toute exécution
étrangère. La fonction remplacée n'est jamais appelée, et le port n'apparaît
dans aucun `this` observable. C'est ce que vérifie l'épreuve « le port privé ne
fuit pas par un postMessage remplacé ».

## Conséquence sur ce qui est écrit ailleurs

Quatre textes présentaient `isShellClient` comme la garde qui protège le pont
d'un XSS applicatif — `SECURITY.md`, `docs/architecture.md`, l'ADR 0005 et les
commentaires de `public/sw-proxy.js` et `public/main.js`. Tous sont corrigés :
le filtre d'URL borne les documents VOISINS, la capacité borne le même realm,
et ce qui reste ouvert est nommé ci-dessus.
