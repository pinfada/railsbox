# Applications à SPA

Une application Rails qui sert un SPA (React, Vue, Svelte…) demande une précaution : la sandbox vit sous un préfixe d'URL, et un SPA figé sur `/` n'y survit pas. Cette page dit quoi changer, et comment vérifier.

*Retour au [README](../README.md).*

---

## Votre application embarque un SPA ? Lisez ceci d'abord

**C'est le seul point d'adaptation que railsbox ne peut pas régler pour vous, et
il touche toutes les applications à interface React, Vue ou Svelte.**

Une sandbox est publiée sur un GitHub Pages **de projet**, donc sous un
sous-chemin : `https://<compte>.github.io/<depot>/`. La coquille garde la racine
et l'application est montée sous `/<depot>/app/`, via `RAILS_RELATIVE_URL_ROOT`.
Rails suit ce préfixe partout — `link_to`, `form_with`, `stylesheet_link_tag`,
`url_for` — parce que ces helpers lisent le `SCRIPT_NAME` de Rack. **Rien de ce
qui est écrit en JavaScript ne le lit** : un `axios.create({ baseURL: '/api/v1'
})`, un `<BrowserRouter>` sans `basename` et un `base:` figé par Vite au build
sortent tous du périmètre servi, et le Service Worker — qui ne proxifie que
`/<depot>/app/` — laisse partir la requête vers GitHub Pages, qui répond 404.

Le remède tient en une idée : **le préfixe n'existe qu'à l'exécution, donc seul
Rails le connaît — il faut le lui faire dire à la page, puis le propager.**

### 1. Exposer le préfixe depuis Rails

Dans le contrôleur qui rend la page hôte du SPA :

```ruby
# app/controllers/pages_controller.rb
# Préfixe public de montage, sans barre finale — chaîne vide dans le cas normal,
# « /<depot>/app » sous railsbox. C'est la seule source de vérité.
def spa_url_root
  Rails.application.config.relative_url_root.to_s.chomp('/')
end
helper_method :spa_url_root
```

Puis dans la vue, avant le bundle :

```erb
<%# app/views/pages/react_app.html.erb %>
<script>
  window.railsData = {
    basePath: '<%= spa_url_root.presence || "/" %>'
  };
</script>
```

### 2. Le lire côté JavaScript, à un seul endroit

```js
// src/lib/railsData.js
/** Préfixe de montage sans barre finale, ou chaîne vide à la racine. */
export function getMountPrefix() {
  const basePath = window.railsData?.basePath
  if (!basePath || basePath === '/') return ''
  return basePath.replace(/\/+$/, '')
}

/** `basename` attendu par React Router : le préfixe, ou `/` à la racine. */
export function getRouterBasename() {
  return getMountPrefix() || '/'
}
```

Hors sandbox, `basePath` vaut `/`, `getMountPrefix()` rend `''` et **tout le
code ci-dessous se comporte exactement comme avant**. C'est ce qui rend
l'adaptation acceptable en production : elle est inerte quand le préfixe est
vide.

### 3. Propager à axios et au routeur

```js
// src/services/api.js
import axios from 'axios'
import { getMountPrefix } from '../lib/railsData'

const prefixe = getMountPrefix()
const api = axios.create({
  baseURL: prefixe ? `${prefixe}/api/v1` : '/api/v1',
})
```

```jsx
// src/main.jsx
import { BrowserRouter } from 'react-router-dom'
import { getRouterBasename } from './lib/railsData'

<BrowserRouter basename={getRouterBasename()}>
  <App />
</BrowserRouter>
```

Vue Router : `createWebHistory(getRouterBasename())`. SvelteKit : `paths.base`,
qui se fixe au build — même problème que Vite ci-dessous.

### 4. Le cas Vite : `base` est figé au build

`base` est résolu au moment du `vite build`, avant que quiconque sache sous quel
préfixe l'application sera servie. Un `base: '/dist/'` produit un
`public/dist/index.html` dont le `<script src>` et le `<link rel=stylesheet>`
pointent sur `/dist/assets/…` — hors périmètre — et **grave la chaîne dans le
bundle** : le module d'aide de Vite y contient littéralement
`function(t){return"/dist/"+t}`, utilisé pour les `modulepreload` des morceaux
chargés à la demande.

Deux gestes, complémentaires :

**a. Rails réécrit les URL d'entrée.** Rails rend lui-même la page hôte : c'est
donc à lui d'émettre les balises, en relisant l'`index.html` produit par Vite.

```ruby
# app/controllers/pages_controller.rb
def react_vite_assets
  index_html = File.read(Rails.root.join('public', 'dist', 'index.html'), mode: 'r:UTF-8')
  racine = spa_url_root # vide hors sandbox : les URL sont inchangées
  {
    stylesheets: index_html.scan(%r{<link[^>]+href=["'](?:/dist)?/assets/([^"']+\.css)["']})
                           .flatten.map { |nom| "#{racine}/dist/assets/#{nom}" },
    scripts: index_html.scan(%r{<script[^>]+src=["'](?:/dist)?/assets/([^"']+\.js)["']})
                       .flatten.map { |nom| "#{racine}/dist/assets/#{nom}" },
  }
end
```

```erb
<% @vite_assets.fetch(:stylesheets).each do |chemin| %>
  <link rel="stylesheet" crossorigin href="<%= chemin %>">
<% end %>
<% @vite_assets.fetch(:scripts).each do |chemin| %>
  <script type="module" crossorigin src="<%= chemin %>"></script>
<% end %>
```

**b. `base: './'` pour le reste.** Les morceaux se référencent déjà entre eux par
spécificateur relatif (`import … from "./react-CRZGu1RB.js"`), donc ils se
chargent quel que soit le préfixe. Ce qui reste absolu, ce sont les
`modulepreload` des morceaux différés. Un `base: './'` fait résoudre ces URL
contre celle du module importateur — donc contre le préfixe réel — au lieu d'une
chaîne figée :

```js
// vite.config.ts
export default defineConfig({
  base: './', // au lieu de '/dist/' : plus rien d'absolu dans le bundle
})
```

Si vous devez garder un `base` absolu, lisez `import.meta.env.BASE_URL` plutôt
que de réécrire un chemin en dur, et **préférez toujours un import relatif** à
une URL construite à la main.

### Comment vérifier

Ouvrez la sandbox publiée, onglet réseau : **toute requête dont le chemin ne
commence pas par `/<depot>/app/` est un appel à corriger**. C'est le test le
plus rapide — le Service Worker ne voit rien d'autre, et un 404 de GitHub Pages
ne ressemble pas à une erreur d'application.

Sous le capot, le détail de ce que `RAILS_RELATIVE_URL_ROOT` préfixe et ne
préfixe pas : « [`RAILS_RELATIVE_URL_ROOT` ne préfixe que les
assets](retour-experience.md#rails_relative_url_root-ne-préfixe-que-les-assets) ».

---
