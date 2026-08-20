# Modèle de menace

railsbox exécute une application Rails **entièrement côté client** : Puma,
PostgreSQL et Redis tournent dans une VM émulée à l'intérieur de l'onglet du
visiteur. Ce modèle inverse les hypothèses habituelles d'une application web —
ce document explicite ce qui est protégé, ce qui ne l'est pas, et ce qu'il ne
faut jamais faire.

Le cadrage vaut pour tout ce qui suit : railsbox sert à **montrer et faire
essayer**, jamais à opérer un service — ni paiements live, ni base partagée
entre clients, ni données qui doivent survivre à l'onglet (voir « Ce que
railsbox n'est PAS » dans le [README](README.md)).

## Principe fondamental : il n'y a pas de serveur à protéger

Tout ce qui est embarqué dans les artefacts (image disque, instantané mémoire)
est **lisible par quiconque visite la sandbox** : le disque est téléchargé
par le navigateur, la RAM restaurée est inspectable, l'utilisateur est root
dans sa propre VM. En conséquence :

- **N'embarquez jamais de vrais secrets de production** dans une image ou un
  instantané : clés Stripe réelles, identifiants OAuth, clés de chiffrement
  de données réelles, dumps de bases contenant des données personnelles.
- Les secrets générés au build (`SECRET_KEY_BASE`, clés de chiffrement) sont
  des **valeurs jetables propres à la sandbox** : ils ne protègent rien et ne
  doivent être réutilisés nulle part.
- Depuis le découpage base / application (ADR 0002), ces clés sont figées dans
  l'**image de base mutualisée**, pas par application : toutes les sandboxes
  bâties sur une même base partagent la même `SECRET_KEY_BASE` et les mêmes
  clés ActiveRecord Encryption, et cette base est un artefact public
  téléchargeable. C'est sans effet ici — la session d'un visiteur n'a de sens
  que dans sa propre VM, dont il est déjà root — mais l'hypothèse tombe dès
  qu'une sandbox cesse d'être publique et jetable (previews privées de la
  phase 2) : ce jour-là, les clés devront redescendre au niveau du disque
  applicatif.
- Les valeurs saisies dans l'inspecteur d'environnement sont stockées dans le
  navigateur du visiteur (localStorage, et l'instantané IndexedDB capture
  l'état de la VM). Elles ne quittent jamais sa machine — mais quiconque a
  accès à ce navigateur peut les lire. L'option « conserver sur ce
  navigateur » peut être décochée pour un usage en session seule.
- **Le bocal à cookies du proxy est persisté en IndexedDB** (base
  `railsbox-cookies`, une entrée par racine de publication) : sans cela, la
  mort du Service Worker — que le navigateur provoque dès qu'il est inactif —
  ferait perdre au visiteur sa session Rails en plein parcours. Ce stockage vit
  dans l'origine, exactement comme le localStorage de l'inspecteur ci-dessus :
  il est donc lisible par tout script same-origin, y compris par un XSS dans
  l'application émulée. Voir « Cookies et protection CSRF » plus bas pour ce
  que le dispositif protège réellement.
- Chaque visiteur a **sa propre copie isolée** : personne ne peut lire ou
  polluer les données d'un autre visiteur. C'est une propriété du design.

## Ce qui est activement défendu

| Frontière | Défense |
|---|---|
| Contenu VM → HTML de la page hôte | échappement systématique (`escapeHtml`, pages d'erreur) |
| Requêtes iframe → VM | validation stricte (`request-codec.js`) : méthodes en liste blanche, chemins filtrés, en-têtes hop-by-hop retirés, aucune interpolation shell |
| Application ↔ page hôte | iframe `sandbox` (pas de navigation du parent, pas de popups) |
| XSS dans l'application → exfiltration réseau | CSP **toujours** ajoutée aux documents `/app` proxifiés (`connect-src 'self'`, `form-action 'self'`) — fetch/XHR/beacon et formulaires vers des tiers sont bloqués. Une politique posée par l'application n'y substitue pas la nôtre : les deux s'appliquent conjointement. **Canal résiduel assumé** : `img-src` reste large (fonds de carte) — un pixel-beacon image reste possible depuis une app compromise ; l'iframe étant same-origin, une telle app peut aussi lire le `localStorage` de la page et l'IndexedDB de l'origine (d'où l'option « session seulement » de l'inspecteur) |
| Encadrement de l'application par un tiers | la CSP injectée impose `frame-ancestors 'self'` à tout document proxifié. railsbox **lève** l'interdiction que l'application pose elle-même (`X-Frame-Options: DENY`, `frame-ancestors 'none'`) — il impose l'iframe, il doit donc en assumer la conséquence — mais la remplace par la sienne : l'encadrement reste limité à notre origine, jamais ouvert |
| Requêtes forgées par un tiers → VM | refusées en **403** par le Service Worker (`appRequestRefusal`) : navigation de premier niveau, signal d'origine étranger (`Origin`, référent, `Sec-Fetch-Site`) ou écriture non attribuable n'atteignent jamais le pont — voir la règle exacte ci-dessous |
| Commandes du proxy (pont VM, identité des artefacts, cookies du document, reprise de session) | **capacité non forgeable** : elles ne voyagent que sur un `MessagePort` privé, gardé dans la fermeture du module de la coquille. Le canal public ne porte plus aucune commande — un canal ne s'y **propose** pas, il **répond** à un tour que le worker seul ouvre, avec un nonce à usage unique, périssable et adressé à un client donné ; et le worker n'ouvre de tour que s'il n'a pas de canal utilisable. Les deux messages restants sont en outre filtrés par `isShellClient` (liste d'admission : `<base>/` et `<base>/index.html`). Ce que cela ferme, et que le filtre d'URL ne pouvait pas fermer : un XSS applicatif qui injecte un `<script src="/app/…">` dans le DOM du parent s'exécute DANS la coquille, avec son URL — il ne détient pourtant pas le port, ne peut pas obtenir de tour, et perd celui qui s'ouvre (la coquille a inscrit son écouteur avant lui). Éprouvé de bout en bout : `tests/e2e/frontiere-coquille.e2e.spec.mjs`, `tests/e2e/relais-onglets.e2e.spec.mjs` et, avec le vrai `main.js`, `tests/e2e/relais-onglets-reel.e2e.spec.mjs`, [ADR 0008](docs/decisions/0008-separation-origine-de-l-application.md) |
| Deux onglets sur la même sandbox | un verrou exclusif Web Locks (`shared/election-onglet.js`) élit l'onglet actif : un seul boote une VM, le second l'annonce au visiteur et propose de reprendre la main. L'isolation entre sandboxes est celle des **visiteurs**, pas des onglets — le Service Worker ne retient qu'un pont, si bien que deux VM concurrentes faisaient partir les écritures d'un onglet dans la VM de l'autre |
| Page hôte | Content-Security-Policy (`index.html`), `X-Content-Type-Options: nosniff` |
| Serveur de dev | anti-traversée de répertoire (`resolveSafePath`, testée) |
| Redirections | réécrites sous `/app` uniquement si same-origin ; les externes ne sont pas suivies par le proxy |
| Cookies de l'application | tenus par le Service Worker (`shared/cookie-jar.js`), jamais rendus au document : `document.cookie` reste vide et Rails retrouve sa session. Ce n'est PAS une mise hors de portée du script — voir ci-dessous |

### Cookies et protection CSRF

Un Service Worker ne peut pas faire poser de cookie : `Set-Cookie` est un
en-tête interdit sur une `Response` construite, silencieusement filtré. Le
proxy tient donc lui-même le magasin — sans quoi la session Rails n'existe
pas, et **toute écriture est refusée en 422 `InvalidAuthenticityToken`**.

Quatre conséquences côté sécurité, dont deux corrigent des affirmations qui ont
figuré ici et qui étaient fausses.

- **Ce que l'isolation gagne, exactement.** `document.cookie` reste vide : la
  session ne se lit pas par le chemin habituel, et un `HttpOnly` posé par Rails
  n'est pas rendu au document. Ce n'est PAS « hors de portée de tout script » —
  cette formulation a figuré ici, elle est fausse. L'iframe applicative est
  same-origin ; un XSS dans l'application peut ouvrir l'IndexedDB
  `railsbox-cookies` de l'origine, tout comme il peut lire le `localStorage` de
  l'inspecteur. Deux gardes bornent la portée de ce défaut, sans le supprimer :
  aucune requête inter-origine n'atteint le pont, et **le pont lui-même n'est
  plus joignable sans la capacité** — les commandes du proxy ne voyagent que
  sur le `MessagePort` privé de la coquille. Un XSS applicatif atteint bien le
  realm de la coquille (l'iframe porte `allow-same-origin`, et un
  `<script src="/app/…">` injecté dans le DOM du parent s'y exécute avec
  l'URL de la coquille) : aucun critère d'émetteur ne l'en distingue, et c'est
  pourquoi le filtre d'URL ne suffisait pas. Ce qui l'arrête est qu'il ne
  détient pas le port, et ne peut pas le fabriquer. Ce qui reste ouvert est
  décrit par
  [l'ADR 0008](docs/decisions/0008-separation-origine-de-l-application.md).
- **L'en-tête `Origin` n'est plus relayé au guest** (`request-codec.js`).
  Rails le compare à `request.base_url` (`forgery_protection_origin_check`) ;
  or le guest ne peut pas connaître de façon fiable l'origine publique
  (schéma forcé à `https` pour les applications en `force_ssl`, port de
  développement, sous-répertoire de publication), et le moindre écart produit
  un 422 opaque sur une application **non modifiée**. Rails traite une origine
  absente comme valide, et la protection CSRF reste portée par le jeton de
  session.
- **Le Service Worker CONTRÔLE l'origine au lieu de s'en remettre au retrait.**
  On a écrit ici qu'un Service Worker « n'intercepte que les requêtes de ses
  propres clients same-origin ». C'est faux, et le corriger était indispensable :
  dans l'algorithme *Handle Fetch*, une requête de **navigation** est routée par
  *Match Service Worker Registration* sur l'URL de la requête, sans considérer
  le client initiateur. Un formulaire posté depuis un site tiers vers
  `https://<hôte>/<depot>/app/…` traversait donc le proxy, qui y attachait le
  cookie de session du bocal — lequel n'applique pas `SameSite`. Le seul jeton
  d'authenticité ne suffisait pas : il ne couvre pas les routes en
  `skip_forgery_protection` ou `null_session`, fréquentes sur les contrôleurs
  API des applications visées. Le proxy **refuse en 403** ; la règle exacte est
  détaillée ci-dessous.

- **Les cookies que l'application pose en JavaScript sont rapportés par la
  coquille, jamais par l'application.** Le bocal n'apprend que par
  `Set-Cookie` ; or l'iframe est same-origin, donc `document.cookie = "timezone=…"`
  (fuseau, locale, consentement, js-cookie) crée un vrai cookie du navigateur
  dont aucune réponse de la VM n'a parlé. Un Service Worker n'a pas de DOM et
  ne voit pas non plus l'en-tête `Cookie` des requêtes qu'il intercepte : il
  DEMANDE donc ces cookies à la coquille (`cookies-document-request`) — sur le
  canal privé, et sur lui seul, si bien qu'aucun document servi sous `/app/` ni
  aucun script injecté ne peut dicter des cookies que le navigateur ne lui
  montre pas. Trois gardes encadrent ce qui revient : le **bocal reste
  autoritaire** (un nom qu'il porte n'est ni doublé ni remplacé, la session et
  les `HttpOnly` sont donc hors d'atteinte de ce chemin), le rapport passe par
  les **mêmes validations que l'ingestion** (`isTransmissibleCookie` : ni CR/LF,
  ni `;`, ni codepoint hors latin-1, longueurs bornées), et rien ne circule
  dans l'autre sens — la demande est vide, la réponse ne peut porter que ce que
  le navigateur expose déjà à la page. L'implémentation précédente s'appuyait
  sur le **Cookie Store API**, absent de WebKit et tardif dans Firefox : la
  fusion n'avait pas lieu sur deux moteurs sur trois. Quand la coquille tarde à
  répondre, le proxy repart sur son **dernier rapport connu** plutôt que sur
  rien : un cookie que l'application vient d'effacer peut donc l'accompagner
  une requête de plus — sans effet sur ce que le bocal, lui, tient. Limite
  subsistante,
  mesurée et assumée : un cookie posé **sans `Path` explicite** depuis une page
  `/app/…` prend `<base>/app` pour chemin, reste invisible du document coquille
  et n'est donc pas récupéré — c'était déjà la portée exacte du Cookie Store
  API. Les trois moteurs se comportent ici à l'identique
  (`tests/e2e/cookies-proxy.e2e.spec.mjs`).

### La règle de refus, et pourquoi elle ne repose pas sur les en-têtes

Le premier correctif ne lisait que les en-têtes `Origin` et `Sec-Fetch-Site`.
**Il ne fonctionnait que sur Chromium.** Un relevé complet de la `Request`
d'une navigation interceptée, moteur par moteur, le montre :

| Signal | Chromium | Firefox | WebKit |
|---|---|---|---|
| en-tête `Origin` | navigations non-GET seulement | **jamais** | **jamais** |
| en-tête `Sec-Fetch-Site` / `Sec-Fetch-Dest` | **jamais** | **jamais** | **jamais** |
| `Request.mode` (`navigate`) | oui | oui | oui |
| `Request.destination` (`document` / `iframe`) | oui | oui | oui |
| `Request.referrer` | oui | oui | oui |
| `FetchEvent.clientId` sur une navigation | vide | vide | vide |

`Sec-Fetch-*` est ajouté **après** l'interception, à l'étage réseau : aucun
Service Worker ne le voit, sur aucun moteur. Une défense qui n'a que ces deux
en-têtes est donc aveugle sur deux moteurs sur trois — un POST forgé y
atteignait réellement la VM, ce qu'une épreuve de bout en bout mesure
désormais sur les trois (`tests/e2e/cookies-proxy.e2e.spec.mjs`).

La règle appliquée à toute requête `/app/*` (`appRequestRefusal`,
`shared/proxy-logic.js`) est donc bâtie sur la **forme** de la requête :

1. **Signal d'origine contradictoire → 403.** `Origin` présent et différent du
   nôtre (y compris l'origine opaque `null`), `Sec-Fetch-Site`
   `cross-site`/`same-site`, ou référent d'une autre origine.
2. **Navigation de premier niveau (`destination: "document"`) → 403.**
   L'application n'est jamais une navigation de premier niveau : la coquille ne
   l'ouvre que dans son iframe. Un formulaire forgé par un tiers, lui, en est
   toujours une. C'est le seul signal qui ferme l'attaque classique sur les
   trois moteurs. Rien de légitime n'y est perdu : un lien entrant vers
   `/app/…` tombe de toute façon sur une VM qui n'a pas booté.
3. **Navigation qui écrit sans origine attribuable → 403.** Une navigation
   d'iframe de méthode autre que `GET`/`HEAD` doit porter un `Origin` ou un
   référent *de notre origine*. Sans cela, un attaquant qui met notre `/app/`
   dans **son** iframe et supprime son référent ne laisserait, sur Firefox,
   aucun signal — et `frame-ancestors 'self'` ne l'empêche que de **rendre** la
   réponse, la requête ayant déjà écrit dans la VM.
4. **Le reste n'est pas contrôlé, et c'est un théorème.** Une sous-ressource
   (`fetch`, XHR, image…) n'est interceptée que si son client est **contrôlé**
   par le worker, donc same-origin par construction : mesuré, un `fetch()`
   inter-origine vers `/app/*` n'atteint le worker sur aucun des trois moteurs.
   Les `fetch()` de la coquille et de l'application passent donc sans condition.

Ce refus est strictement plus fort que `SameSite=Lax` — qui laisserait encore
passer une navigation GET inter-site avec ses cookies — et c'est pourquoi le
bocal n'a pas besoin d'apparier `SameSite`.

**Ce qui reste hors de portée de cette règle :**

- Une **lecture** (`GET`/`HEAD`) déclenchée depuis l'iframe d'un attaquant qui
  supprime son référent : elle ne laisse aucun signal sur Firefox, et n'est
  refusée que si elle porte un référent ou un `Origin` étranger. L'attaquant ne
  peut pas lire la réponse (`Cross-Origin-Resource-Policy: same-origin`,
  `frame-ancestors 'self'`), mais une application qui écrit sur un `GET` reste
  exposée à une écriture aveugle. WebKit, qui partitionne les Service Workers
  par site de premier niveau, ne route même pas cette requête jusqu'à nous.
- Une application qui **supprime son propre référent** (`Referrer-Policy:
  no-referrer`, `<meta name="referrer">`) perd, sur Firefox et WebKit, le seul
  signal qui atteste ses écritures : ses soumissions de formulaire tombent
  alors en 403 (message explicite dans la page d'erreur du proxy). Rails pose
  par défaut `strict-origin-when-cross-origin`, qui conserve le référent
  complet en same-origin.
- Un **XSS dans l'application** reste, lui, un client same-origin : cette règle
  ne le concerne pas (voir les deux points précédents de cette section).

## Hors périmètre (assumé)

- **XSS dans l'application émulée ⇒ exécution dans la coquille.** L'iframe
  applicative porte `sandbox="allow-scripts allow-same-origin"` : les deux
  ensemble laissent le contenu sortir de son bac-à-sable, et Chromium le dit
  dans la console à chaque chargement. `allow-same-origin` n'est pas une
  facilité — sans lui l'iframe reçoit une origine opaque, qui n'est cliente
  d'aucun Service Worker : il n'y aurait plus de proxy, donc plus de produit.
  Un XSS applicatif atteint donc le realm de la coquille, y exécute du code,
  et peut lire tout ce que l'origine expose (IndexedDB, localStorage).
  Ce qu'il n'obtient PAS, depuis la capacité : le pont vers la VM, la
  configuration des artefacts, les cookies du document, la reprise de session —
  y compris après un redémarrage du worker, puisqu'un canal ne s'obtient plus
  qu'en répondant à un tour, et que la coquille y répond avant lui. Ce qui
  reste : cet avantage tient à un ORDRE (notre écouteur est inscrit le premier)
  et à une LISTE d'intrinsèques capturés avant toute exécution étrangère —
  `MessageChannel`, les accesseurs `port1`/`port2`, `postMessage`, `start`, le
  setter `onmessage`, le getter `MessageEvent.data`, `addEventListener`,
  `Reflect.apply` et les accès au contrôleur. Chacun est un piège
  possible : remplacé, il recevrait le port privé en `this` au moment où la
  coquille s'en sert. Une énumération n'est pas une preuve. C'est du
  durcissement, pas une frontière — l'analyse et la seule issue réelle vivent
  dans [l'ADR 0008](docs/decisions/0008-separation-origine-de-l-application.md).
- **Confidentialité des artefacts** : une sandbox publiée est publique par
  nature. Une URL non listée n'est pas une protection.
- **Réseau sortant** : la VM n'a pas d'accès réseau externe — les appels
  d'API tiers n'aboutissent jamais (c'est une propriété, pas un défaut).
- **Déni de service local** : l'application peut consommer le CPU/RAM de
  l'onglet du visiteur ; c'est son navigateur qui arbitre.
- **Identifiants des services de la VM** : le cluster PostgreSQL d'une sandbox
  utilise le rôle `postgres` avec le mot de passe `postgres` et une
  authentification `trust` sur le loopback émulé. Ce n'en est pas un secret :
  le cluster n'écoute que `127.0.0.1` à l'intérieur de la VM, celle-ci n'a
  aucun réseau sortant, et chaque visiteur travaille sur sa propre copie
  jetable. Le corollaire est le même que pour tout le reste : **n'embarquez
  jamais de vraies données** dans une sandbox.

## Signaler une vulnérabilité

Pour un problème sensible, utilisez le signalement privé de GitHub
(« Report a vulnerability », onglet Security du dépôt) — jamais une issue
publique. Pour le reste, ouvrez une issue. Les défauts qui traversent une
frontière du tableau ci-dessus sont traités en priorité.
