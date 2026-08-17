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
| Requêtes inter-origine → VM | refusées en **403** par le Service Worker (`crossOriginRefusal`) : un `Origin` étranger, ou un `Sec-Fetch-Site` `cross-site`/`same-site`, n'atteint jamais le pont |
| Commandes du proxy (pont VM, identité des artefacts, cookies du document) | acceptées du **seul document coquille** (`isShellClient`) : un client servi sous `/app/` — la surface d'un XSS applicatif — ne peut ni détourner le pont, ni empoisonner le cache, ni dicter au proxy des cookies que le navigateur ne lui montre pas |
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
  le pont vers la VM et la déclaration d'artefacts ne sont acceptés que du
  **document coquille** (`isShellClient` — sans quoi un XSS posait son propre
  `MessagePort` et lisait chaque descripteur de requête, `cookie:` en clair), et
  aucune requête inter-origine n'atteint le pont.
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
  API des applications visées. Le proxy **refuse désormais en 403** toute
  requête `/app/*` dont l'`Origin` est présent et étranger, ou dont le
  `Sec-Fetch-Site` vaut `cross-site` ou `same-site` (`crossOriginRefusal`).
  Ce refus est strictement plus fort que `SameSite=Lax` — qui laisserait encore
  passer une navigation GET inter-site avec ses cookies — et c'est pourquoi le
  bocal n'a pas besoin d'apparier `SameSite`. Restent légitimes, et préservées :
  les requêtes de la coquille et de l'iframe (`Sec-Fetch-Site: same-origin`),
  et l'ouverture directe par le visiteur (`none`).
- **Les cookies que l'application pose en JavaScript sont rapportés par la
  coquille, jamais par l'application.** Le bocal n'apprend que par
  `Set-Cookie` ; or l'iframe est same-origin, donc `document.cookie = "timezone=…"`
  (fuseau, locale, consentement, js-cookie) crée un vrai cookie du navigateur
  dont aucune réponse de la VM n'a parlé. Un Service Worker n'a pas de DOM et
  ne voit pas non plus l'en-tête `Cookie` des requêtes qu'il intercepte : il
  DEMANDE donc ces cookies à ses clients (`cookies-document-request`), et
  n'interroge que ceux qui passent `isShellClient` — jamais un document servi
  sous `/app/`, qui pourrait sinon dicter des cookies que le navigateur ne lui
  montre pas. Trois gardes encadrent ce qui revient : le **bocal reste
  autoritaire** (un nom qu'il porte n'est ni doublé ni remplacé, la session et
  les `HttpOnly` sont donc hors d'atteinte de ce chemin), le rapport passe par
  les **mêmes validations que l'ingestion** (`isTransmissibleCookie` : ni CR/LF,
  ni `;`, ni codepoint hors latin-1, longueurs bornées), et rien ne circule
  dans l'autre sens — la demande est vide, la réponse ne peut porter que ce que
  le navigateur expose déjà à la page. L'implémentation précédente s'appuyait
  sur le **Cookie Store API**, absent de WebKit et tardif dans Firefox : la
  fusion n'avait pas lieu sur deux moteurs sur trois. Limite subsistante,
  mesurée et assumée : un cookie posé **sans `Path` explicite** depuis une page
  `/app/…` prend `<base>/app` pour chemin, reste invisible du document coquille
  et n'est donc pas récupéré — c'était déjà la portée exacte du Cookie Store
  API. Les trois moteurs se comportent ici à l'identique
  (`tests/e2e/cookies-proxy.e2e.spec.mjs`).

## Hors périmètre (assumé)

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
