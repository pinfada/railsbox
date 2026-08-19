# Applications shipping a SPA

A Rails app serving a SPA (React, Vue, Svelte…) needs one precaution: the sandbox lives under a URL prefix, and a SPA hardcoded on `/` will not survive it. This page says what to change, and how to check.

*Back to the [README](../README.en.md).*

---

## Does your app ship a SPA? Read this first

**This is the one adaptation railsbox cannot make for you, and it affects every
application with a React, Vue or Svelte front end.**

A sandbox is published on a **project** GitHub Pages site, so under a
sub-path: `https://<account>.github.io/<repo>/`. The shell keeps the root and
the application is mounted under `/<repo>/app/`, via `RAILS_RELATIVE_URL_ROOT`.
Rails follows that prefix everywhere — `link_to`, `form_with`,
`stylesheet_link_tag`, `url_for` — because those helpers read Rack's
`SCRIPT_NAME`. **Nothing written in JavaScript reads it**: an
`axios.create({ baseURL: '/api/v1' })`, a `<BrowserRouter>` with no `basename`
and a Vite `base` frozen at build time all fall outside the served scope, and
the Service Worker — which only proxies `/<repo>/app/` — lets the request go
through to GitHub Pages, which answers 404.

The fix is one idea: **the prefix only exists at runtime, so only Rails knows
it — make Rails tell the page, then propagate it.**

### 1. Expose the prefix from Rails

In the controller that renders the SPA host page:

```ruby
# app/controllers/pages_controller.rb
# Public mount prefix, no trailing slash — empty in the normal case,
# "/<repo>/app" under railsbox. This is the single source of truth.
def spa_url_root
  Rails.application.config.relative_url_root.to_s.chomp('/')
end
helper_method :spa_url_root
```

Then in the view, before the bundle:

```erb
<%# app/views/pages/react_app.html.erb %>
<script>
  window.railsData = {
    basePath: '<%= spa_url_root.presence || "/" %>'
  };
</script>
```

### 2. Read it on the JavaScript side, in exactly one place

```js
// src/lib/railsData.js
/** Mount prefix without trailing slash, or empty string at the root. */
export function getMountPrefix() {
  const basePath = window.railsData?.basePath
  if (!basePath || basePath === '/') return ''
  return basePath.replace(/\/+$/, '')
}

/** The `basename` React Router expects: the prefix, or `/` at the root. */
export function getRouterBasename() {
  return getMountPrefix() || '/'
}
```

Outside a sandbox `basePath` is `/`, `getMountPrefix()` returns `''`, and
**everything below behaves exactly as before**. That is what makes the
adaptation acceptable in production: it is inert when the prefix is empty.

### 3. Propagate to axios and to the router

```js
// src/services/api.js
import axios from 'axios'
import { getMountPrefix } from '../lib/railsData'

const prefix = getMountPrefix()
const api = axios.create({
  baseURL: prefix ? `${prefix}/api/v1` : '/api/v1',
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

Vue Router: `createWebHistory(getRouterBasename())`. SvelteKit: `paths.base`,
which is fixed at build time — the same problem as Vite below.

### 4. The Vite case: `base` is frozen at build time

`base` is resolved when `vite build` runs, long before anyone knows the prefix
the application will be served under. A `base: '/dist/'` produces a
`public/dist/index.html` whose `<script src>` and `<link rel=stylesheet>` point
at `/dist/assets/…` — out of scope — and **bakes the string into the bundle**:
Vite's preload helper literally contains `function(t){return"/dist/"+t}`, used
for the `modulepreload` hints of lazily loaded chunks.

Two complementary moves:

**a. Let Rails rewrite the entry URLs.** Rails renders the host page itself, so
it is Rails that should emit those tags, by re-reading the `index.html` Vite
produced.

```ruby
# app/controllers/pages_controller.rb
def react_vite_assets
  index_html = File.read(Rails.root.join('public', 'dist', 'index.html'), mode: 'r:UTF-8')
  root = spa_url_root # empty outside a sandbox: URLs are unchanged
  {
    stylesheets: index_html.scan(%r{<link[^>]+href=["'](?:/dist)?/assets/([^"']+\.css)["']})
                           .flatten.map { |name| "#{root}/dist/assets/#{name}" },
    scripts: index_html.scan(%r{<script[^>]+src=["'](?:/dist)?/assets/([^"']+\.js)["']})
                       .flatten.map { |name| "#{root}/dist/assets/#{name}" },
  }
end
```

```erb
<% @vite_assets.fetch(:stylesheets).each do |path| %>
  <link rel="stylesheet" crossorigin href="<%= path %>">
<% end %>
<% @vite_assets.fetch(:scripts).each do |path| %>
  <script type="module" crossorigin src="<%= path %>"></script>
<% end %>
```

**b. `base: './'` for the rest.** Chunks already reference each other with
relative specifiers (`import … from "./react-CRZGu1RB.js"`), so they load under
any prefix. What stays absolute is the `modulepreload` hints for deferred
chunks. A `base: './'` makes those URLs resolve against the importing module's
URL — hence against the real prefix — instead of a frozen string:

```js
// vite.config.ts
export default defineConfig({
  base: './', // instead of '/dist/': nothing absolute left in the bundle
})
```

If you must keep an absolute `base`, read `import.meta.env.BASE_URL` rather than
hard-coding a path, and **always prefer a relative import** to a hand-built URL.

### How to check

Open the published sandbox and watch the network tab: **any request whose path
does not start with `/<repo>/app/` is a call to fix**. It is the fastest test —
the Service Worker sees nothing else, and a GitHub Pages 404 does not look like
an application error.

Under the hood, what `RAILS_RELATIVE_URL_ROOT` does and does not prefix — and
why a `config.ru` shipped by the image fixes the Rails half without touching
your code — is in "[War stories](retour-experience.en.md)".

---
