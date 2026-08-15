# Contribuer à railsbox

Merci de votre intérêt ! Ce document décrit les conventions du projet.

## Démarrage

```bash
npm install
npm start        # serveur de dev sur http://localhost:8080
npm test         # tests unitaires (node --test, zéro dépendance)
npm run check    # lint + format + typecheck + tests — ce que la CI exécute
```

## Conventions

### Nommage

- **Identifiants de code** (variables, fonctions, constantes) : **anglais**.
- **Textes affichés, classes CSS, attributs `data-*`** : **français** (produit
  francophone). Les commentaires expliquent le *pourquoi*, en français.

### Style

- Prettier formate tout (`npm run format`) ; ESLint et `tsc --checkJs`
  doivent être verts (`npm run check`) avant tout commit.
- Les API publiques (fonctions exportées) portent une annotation JSDoc.
- Fichiers courts et cohésifs (≤ 400 lignes en cible, 800 max) ;
  pas d'imbrication au-delà de 4 niveaux ; retours précoces.
- Les erreurs sont gérées explicitement — jamais avalées en silence.

### Sécurité

- Tout ce qui entre dans la VM passe par `public/shared/request-codec.js`
  (frontière de validation). Ne jamais interpoler de contenu non échappé
  dans du HTML (voir `escapeHtml` de `sw-proxy.js`).
- Aucun secret en dur. Les valeurs factices générées doivent être
  visiblement factices ou aléatoires par session.

### Tests

- Toute nouvelle logique pure arrive avec ses tests (`tests/*.test.mjs`,
  AAA : Arrange, Act, Assert). Les correctifs de bug ajoutent d'abord le
  test qui échoue.

### Commits

Format conventionnel : `<type>: <description>` avec
`feat, fix, refactor, docs, test, chore, perf, ci`.

## Structure du dépôt

Voir la section « Arborescence » du [README](README.md).
