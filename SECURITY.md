# Modèle de menace

railsbox exécute une application Rails **entièrement côté client** : Puma,
PostgreSQL et Redis tournent dans une VM émulée à l'intérieur de l'onglet du
visiteur. Ce modèle inverse les hypothèses habituelles d'une application web —
ce document explicite ce qui est protégé, ce qui ne l'est pas, et ce qu'il ne
faut jamais faire.

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
- Chaque visiteur a **sa propre copie isolée** : personne ne peut lire ou
  polluer les données d'un autre visiteur. C'est une propriété du design.

## Ce qui est activement défendu

| Frontière | Défense |
|---|---|
| Contenu VM → HTML de la page hôte | échappement systématique (`escapeHtml`, pages d'erreur) |
| Requêtes iframe → VM | validation stricte (`request-codec.js`) : méthodes en liste blanche, chemins filtrés, en-têtes hop-by-hop retirés, aucune interpolation shell |
| Application ↔ page hôte | iframe `sandbox` (pas de navigation du parent, pas de popups) |
| XSS dans l'application → exfiltration réseau | CSP injectée sur les documents `/app` proxifiés (`connect-src 'self'`, `form-action 'self'`) — fetch/XHR/beacon et formulaires vers des tiers sont bloqués. **Canal résiduel assumé** : `img-src` reste large (fonds de carte) — un pixel-beacon image reste possible depuis une app compromise ; l'iframe étant same-origin, une telle app peut aussi lire le `localStorage` de la page (d'où l'option « session seulement » de l'inspecteur) |
| Page hôte | Content-Security-Policy (`index.html`), `X-Content-Type-Options: nosniff` |
| Serveur de dev | anti-traversée de répertoire (`resolveSafePath`, testée) |
| Redirections | réécrites sous `/app` uniquement si same-origin ; les externes ne sont pas suivies par le proxy |

## Hors périmètre (assumé)

- **Confidentialité des artefacts** : une sandbox publiée est publique par
  nature. Une URL non listée n'est pas une protection.
- **Réseau sortant** : la VM n'a pas d'accès réseau externe — les appels
  d'API tiers n'aboutissent jamais (c'est une propriété, pas un défaut).
- **Déni de service local** : l'application peut consommer le CPU/RAM de
  l'onglet du visiteur ; c'est son navigateur qui arbitre.

## Signaler une vulnérabilité

Ouvrez une issue (ou un courriel privé au mainteneur pour un problème
sensible). Les défauts qui traversent une frontière du tableau ci-dessus
sont traités en priorité.
