# Étude de faisabilité : sortir v86 du fil principal (issue #14)

**Étude seule — aucun code de production modifié.** Mesures faites le
23/08/2026 sur la démonstration publiée de woofed-crm, poste ~1,5× plus lent que
la référence du shell, après la fusion de #13 (récupération partagée du pont et
limiteur à deux requêtes).

## 1. Cartographie : qui vit sur quel fil

| Composant | Fichier | Fil actuel |
| --- | --- | --- |
| Émulateur v86 | `public/vm/v86-vm.js` | **page (fil principal)** |
| Façade VM (9 méthodes) | `public/vm/v86-vm.js` | **page** |
| Relais des requêtes vers la VM | `public/main.js` (`relayToVm`) | **page** |
| Codec du pont série | `public/shared/serial-codec.js` | **page** |
| Chargement de l'instantané | `public/shared/snapshot-parts.js` | **page** |
| Cache IndexedDB de l'instantané | `public/vm/v86-vm.js` | **page** |
| Coquille, journal, tiroir d'environnement | `public/main.js`, `env-drawer.js` | **page** |
| Proxy HTTP `/app/*` | `public/sw-proxy.js` | Service Worker |
| **Bocal à cookies** | `public/shared/cookie-jar.js` | **Service Worker** |
| **Cache des artefacts** | `public/shared/artifact-cache.js` | **Service Worker** |
| Réinjection COOP/COEP | `public/sw-proxy.js` | Service Worker |

Le premier point à vérifier est **confirmé** : `createCookieJar` et
`cacheNameFor` ne sont importés que par `sw-proxy.js`. Ils sont déjà hors du fil
principal et n'ont rien à faire dans la migration.

## 2. Matrice de déplacement

### Doit partir dans le Worker

- **v86 et sa façade.** Aucun couplage DOM : le constructeur est appelé sans
  `screen_container`, avec `disable_keyboard`, `disable_mouse` et
  `disable_speaker`. Le seul lien à la page est le chargement du script
  (`document.createElement("script")`) et quatre URL dérivées de
  `document.baseURI` — remplaçables par `importScripts()` et des URL passées au
  démarrage.
- **Le codec série et le relais.** Ils suivent la VM ; les laisser dans la page
  la maintiendrait dans le chemin de chaque requête.

### Doit rester dans la page

- La coquille, le journal, l'indicateur de démarrage, le tiroir d'environnement.
- L'**élection d'onglet** et le canal privé avec le Service Worker : la page
  détient l'enregistrement du worker, elle seule peut lui parler.
- Le courtage initial du port (voir §3).

### Déjà hors du fil principal

- Bocal à cookies, cache des artefacts, réinjection COOP/COEP, proxy `/app/*`.

### Incertain, à prototyper

- **Le chargement et le cache de l'instantané.** Techniquement déplaçable —
  `fetch` et IndexedDB existent dans un Worker — mais c'est là que se joue le
  risque mémoire (§4).

## 3. Le point décisif : transférer le port, ne plus relayer

Aujourd'hui la page **relaie** chaque requête. `main.js` crée un
`MessageChannel`, envoie `port2` au Service Worker et **garde `port1`** pour
appeler `vm.handleHttpRequest` à chaque message. Elle n'est pas courtier : elle
est sur le chemin de données.

Le dispositif visé tient debout :

1. la page crée le `MessageChannel` et envoie `port2` au Service Worker, comme
   aujourd'hui — elle seule peut lui parler ;
2. elle transfère `port1` au Worker (`worker.postMessage(msg, [port1])`) ;
3. Service Worker et Worker dialoguent **directement**. La page sort du chemin.

`MessagePort` est transférable, et le transfert est le mécanisme normal. Rien
dans le code actuel ne s'y oppose : le port n'est pas capturé ailleurs.

**Bénéfice de sûreté, non recherché mais réel.** `main.js` durcit ses appels à
`postMessage` par `Reflect.apply` sur des prototypes capturés, parce que ce port
voit passer chaque descripteur, **en-tête `cookie:` en clair**. Sorti de la page,
le descripteur ne traverse plus un contexte où un script tiers peut remplacer
`MessagePort.prototype.postMessage`.

## 4. Risques de copie mémoire

**Les disques ne sont pas un risque.** `buildDiskImages` les déclare en
`async: true` avec une URL : v86 lit des blocs à la demande, rien n'est
téléchargé d'un bloc. Un Worker est contrôlé par le même Service Worker, ces
lectures continuent d'être proxifiées et mises en cache.

**L'instantané est le seul point sensible.** Il est passé en
`initial_state: { buffer }` — un `ArrayBuffer` unique de 200 à 414 Mo mesurés.
Il est déjà passé en buffer plutôt qu'en `Blob` URL, précisément pour ne pas
doubler la mémoire de l'onglet.

- **Transfert (`postMessage(msg, [buffer])`)** : coût nul, mais la page **perd**
  la propriété du buffer — il devient inutilisable côté page. Compatible avec
  l'usage actuel, qui le passe puis ne le relit pas.
- **Clone structuré** (oubli du tableau de transfert) : **double la mémoire**,
  jusqu'à 414 Mo de plus. C'est le piège à garder par une épreuve.
- **`SharedArrayBuffer`** : inutile ici — un seul lecteur, aucune écriture
  concurrente. L'isolation COI est déjà acquise, mais ce n'est pas une raison de
  s'en servir.
- Le plus simple reste de **charger l'instantané DANS le Worker** : il n'existe
  alors jamais dans la page, et la question du transfert disparaît.

Mémoire observée sur la session de mesure : **547 → 741 Mo** de tas JS.

## 5. Gain attendu — et ce que la mesure en dit

C'est ici que l'étude contredit la prémisse de l'issue.

**Sous charge réelle** — rechargement du pipeline, cinq frames paresseuses,
sonde de réactivité à 100 ms sur 60 s :

| Mesure | Valeur |
| --- | ---: |
| battements | 600 |
| retard maximum | **28 ms** |
| retards > 100 ms | **0** |
| tâches longues | 1, de 85 ms |

**Le fil principal n'est pas bloqué par v86.** L'émulateur rend la main
régulièrement.

**Sur le geste qui figeait l'onglet** — déplacement d'étape par l'interface :

| Mesure | Valeur |
| --- | ---: |
| retard maximum | **7 053 ms**, puis 6 982 ms |
| autres retards | < 61 ms |

Le blocage est réel, mais ponctuel. Et son origine est établie par
l'`attribution` de `PerformanceObserver` :

```
name: "same-origin-descendant"
attribution: unknown / iframe / /woofed-crm/app/
```

**La tâche de 7,3 s vient de l'IFRAME**, c'est-à-dire du JavaScript de
l'application — Turbo, Stimulus, `moment` —, pas de la page où tourne v86.

Sortir v86 du fil principal **ne supprimerait pas ce blocage** : l'iframe est
same-origin et partage le même fil.

## 6. Conclusion

**Faisable techniquement, avec prototype isolé** — aucun obstacle structurel :
pas de couplage DOM, port transférable, disques déjà paresseux, surface d'API
étroite (9 méthodes). Le seul vrai risque est la mémoire de l'instantané, et il
se traite en le chargeant dans le Worker.

**Mais le gain visé n'est pas celui qu'on croyait.** Sur le code actuel, v86 ne
bloque pas le fil principal ; le seul blocage mesuré vient de l'application. #14
tel qu'il est rédigé promet une réactivité que le déplacement n'apporterait pas.

Reste un bénéfice **de second ordre**, réel mais non mesuré : pendant un blocage
de 7 s côté application, v86 ne reçoit aucun temps CPU et toute requête en vol
stagne. Dans un Worker, la VM continuerait de servir. C'est un argument
défendable — il demande d'être chiffré avant d'engager le chantier, pas après.

**Recommandation : ne pas engager la refonte en l'état.** Réécrire #14 autour du
bénéfice réellement mesurable, ou le refermer au profit du constat que le
blocage observé appartient aux applications. La contention Rails/Puma et le
limiteur à deux restent hors promesse, comme prévu.
