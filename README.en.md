# railsbox

*Version française → [README.md](README.md)*

[![Try with railsbox](https://pinfada.github.io/railsbox-demo/badge.svg)](https://pinfada.github.io/railsbox-demo/)

**railsbox turns a Rails application into a playable in-browser demo.** You drop
a GitHub Actions workflow into your repository and get a public URL where Puma,
your database and your native C gems run inside an emulated x86 Linux VM — no
server, no container, no bill.

**See it right now → [pinfada.github.io/railsbox-demo](https://pinfada.github.io/railsbox-demo/)**

---

## Get started in 5 minutes

### 1. Add the workflow

In your Rails repository, create `.github/workflows/sandbox.yml`:

```yaml
name: Sandbox railsbox
on:
  push:
    branches: [main, master] # ← your default branch
  workflow_dispatch:

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
```

> **Check the `branches:` line.** A filter that does not name your default
> branch never triggers anything, and **GitHub does not tell you**: no error, no
> run, nothing in the Actions tab — the workflow simply looks absent. Both names
> are listed above so the copy-paste works on a `main` repository and on a
> `master` one alike; keep yours and drop the other if you prefer. When in
> doubt, trigger a first build by hand (`workflow_dispatch`, the *Run workflow*
> button): if that works and a `push` does nothing, the filter is the culprit.

The railsbox repository is public, so any repository can reference this workflow
directly. Pin a tag or a SHA instead of `@main` if you would rather freeze the
version.

### 2. Enable GitHub Pages on the `gh-pages` branch

Push to `main` first: the first build is what **creates** the `gh-pages`
branch — before that, GitHub will not offer it in the menu.

*Settings → Pages → Source: Deploy from a branch → `gh-pages` / `(root)`.*
Every build republishes your demo at `https://<account>.github.io/<repo>/`.

> **`gh-pages` is fully replaced on every build** (force-push, history reset:
> the sandbox is regenerated from scratch, so keeping history would only pile
> up dead binaries). If you already publish something else there — YARD docs, a
> project site — **publish the sandbox elsewhere** using the `target-repo`
> input (see "Workflow inputs").

### 3. Paste the badge

```markdown
[![Try with railsbox](https://<account>.github.io/<repo>/badge.svg)](https://<account>.github.io/<repo>/)
```

The workflow prints this badge ready to paste, with your URLs, in every build
summary. It is served by your own sandbox rather than by a third-party badge
generator: nothing to maintain, and nothing that can go down without your demo
going down too.

> **The click opens the current tab.** GitHub strips `target="_blank"` from
> READMEs whatever syntax you use — verified against its rendering API. No badge
> in the ecosystem escapes this. Your readers still have middle-click.

> **Public repo, or a separate showcase repo.** On a public repository
> everything is free: Actions and Pages both are. On a **private** repository,
> GitHub Pages requires a paid plan and Actions minutes are billed. That case is
> covered: keep the code private and publish the sandbox to a dedicated public
> repository with `target-repo` + the `publish-key` secret (see "Workflow
> inputs").

### What the workflow does, in ~9 minutes

It reassembles the shared rootfs from the railsbox artifact repository, builds
your application disk from the base image, runs your seeds, captures a
post-boot memory snapshot, splits everything into compressed chunks and
publishes the shell alongside it. **Your repository hosts about 130 MB** for the demo application — expect
~150–350 MB for yours; the
1.45 GB rootfs stays on the railsbox side.

Tailwind, dart-sass and npm toolchains need no declaration: detection spots them
and switches asset precompilation to an amd64 stage on its own. The build
summary reports the stage it picked, the Ruby version and the detected database.

### What your visitors get

| What the visitor does | Measured |
| --- | --- |
| Application on screen | **~20–25 s** (snapshot restored) |
| Downloaded to get there | ~32 MB from the artifact repository + the gzipped snapshot |
| Navigation, forms, POSTs | normal, served by the VM |

While the visitor waits, a status bar names the current step and counts the
seconds ("Step 5/5 · First page rendered by the VM · 31 s"). It exists because
CPU-throttled measurement demanded it: the final phase — between all-green
badges and the first painted page — takes 1 s on a desktop but up to 14 s on a
slow device, with nothing to tell "almost there" from "stuck".

The 1.45 GB shared rootfs is never downloaded whole: v86 reads only the chunks
it touches, around thirty out of 363. And it reads them only once — the Service
Worker keeps them in Cache Storage, so a returning visitor downloads nothing
(see "[Artifact caching](#artifact-caching)").

**Browsers** — measured by the `npm run test:live` recipe against the published
demo and a faithful local replica of the publication:

| Engine | Shell | Service Worker | COI isolation | VM boot | App served | Artifact cache |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 151 | ok | ok | ok | 18–24 s | ok | ok |
| Firefox 153 | ok | ok | ok | 21 s | ok | ok |
| WebKit 26.5 | ok | ok | ok | 20 s | ok | ok |

Only measured difference: the first request through the serial bridge costs
about 6 s on Firefox versus 1 s elsewhere.

**Mobile**: the shell is phone-ready — layout verified at 320, 390 and 393 px
(`tests/e2e/coquille-mobile.e2e.spec.mjs`). The CPU is now measured for real.
Playwright's mobile emulation only changes the viewport and the user agent;
`npm run test:bridage` (`tests/bridage/`) **actually** slows the browser's
execution thread through Chrome DevTools Protocol and replays the published
sandbox boot at every rate. Two boots per rate, fresh context each time:

| CPU throttling | App announced | App **visible** | 1st scaffold page | Next page |
| --- | --- | --- | --- | --- |
| 1× — desktop | 23.7 / 24.4 s | 24.7 / 25.5 s | 1.3 s | 0.3 s |
| 4× — mid-range phone | 26.8 / 26.8 s | 30.4 / 31.2 s | 7.2 / 7.7 s | 1.6 / 2.2 s |
| 6× — entry-level | 31.7 / 31.8 s | 39.0 / 39.4 s | 13.5 / 13.9 s | 3.1 / 4.4 s |
| 8× — old device | 37.1 / 39.6 s | 49.7 / 54.0 s | 24.2 / 25.8 s | 5.3 / 8.0 s |

**Boot does not break, it stretches**: never a failure, always two internal
probes, and the slowest probe (1.3 s) stays eight times under the budget the
shell gives it. Its growth (+60 % from 1× to 8×) barely comes from emulation
either — the snapshot already did that work, and the "VM ready → app ready"
phase only moves from 14.9 to 17.1 s — but from the loading path, snapshot
decompression and caching included, which also runs on the throttled thread.

**What really degrades is usage.** Every page served crosses Rails and then the
serial bridge, both on the tab's CPU: the first scaffold page goes from 1.3 s to
25 s, and later ones from 0.3 s to 5–8 s — slightly worse than proportional to
the throttling. The practical threshold therefore sits **between 6× and 8×**: at
4× the sandbox stays comfortable, at 6× it is slow but usable, at 8× expect a
minute before the application shows up and a handful of seconds per click — good
enough to show an application, not to work in it. That is also why the shell now
displays the current boot step and elapsed time, all the way to the first
**rendered** page: that last wait (1 s at 1×, but 12 to 15 s at 8×) happened
under a row of already-green badges, with nothing to tell "it is coming" from
"it is stuck".

**What stays out of reach**: a **real**, physical phone. CDP throttling slows the
execution thread; it reproduces neither a smaller CPU cache, nor mobile tab
memory — reclaimed far sooner by the OS — nor thermal throttling after a few
minutes of continuous emulation. Treat mobile as measured and workable, not
guaranteed. Recipes run Chromium by default; `RAILSBOX_MOTEURS=tous` (or a list:
`firefox,webkit`) widens `npm run test:live` and `npm run test:e2e` to all three
— CPU throttling stays Chromium-only, for lack of a CDP equivalent elsewhere.
Webviews that block Service Workers cannot work, by construction — the shell now
tells the visitor so instead of failing silently.

**Visitor CPU**: emulation runs on the tab's processor — that is the "server"
each visitor brings. A tab hidden for more than 15 s suspends the VM and gives
the CPU back; returning resumes it with the guest clock resynced. **Only one
sandbox runs at a time per browser**: an exclusive lock (Web Locks) designates
the active tab, and a second tab opened on the same sandbox boots no VM at all —
it shows "already open in another tab" plus a button to take over here, at which
point the other tab releases its own VM.

**What the host must provide** — and GitHub Pages does: CORS `*`, `Range`
requests, and nothing else. The `COOP`/`COEP` isolation headers that static
hosting does not set are re-injected by the Service Worker.

---

## Who this is for

**Ruby/Rails open source maintainers.** Your README shows code; it does not show
your application. The "Try with railsbox" badge gives anyone reading your project
a playable instance in one click — seeded with demo data, already signed in, with
nothing to install and no account to create. The link never goes down and costs
nothing, because there is no server behind it.

**B2B SaaS founders and product builders.** A permanent product demo with zero
infrastructure: you choose what the visitor sees (`seed`), they land already
authenticated (`auto_login` opens a session — a token-authenticated front end
needs [the JWT
recipe](#recipe-auto-login-for-a-jwt-authenticated-spa-devise-jwt)), and the
bill stays at zero on the day your link hits Hacker News. The non-negotiable trade-off: **nothing real may be shipped
inside** — no live Stripe key, no OAuth credentials, no dump containing customer
data. Everything that goes into a sandbox is public (see
[`SECURITY.md`](SECURITY.md)).

**Freelancers, job candidates, portfolios.** A recruiter clicks and sees the
application running, not a screenshot. No paid cold start, no free tier that
sleeps, no invoice arriving because the link worked too well.

**Instructors, bootcamps, tutorial authors.** Thirty learners means thirty
isolated environments: every learner is root in *their own* copy, nobody's
mistakes leak into anybody else's, and there is nothing to install before
starting. The isolation is the browser's, so it separates **visitors**, not
tabs: two tabs of the same browser share one sandbox, and only one of them runs
it at a time — the second one offers to take over. A refresh
resets everything, and `?fresh=1` at the end of the URL ignores the snapshot
and starts from a cold boot.

Two more uses fall out of the same properties: **disposable pull request
previews** (one sandbox per branch, published then forgotten) and **bug
reproduction in an issue** (the exact broken state, attachable as a URL).

---

## What railsbox is NOT

- **Not a production host.** railsbox exists to *show and let people try*, never
  to *operate*. No live card payments, no database shared between your customers,
  no state that outlives the tab: every visitor gets their own disposable copy.
  An application that must take money, call third-party APIs or retain data does
  not belong here.
- **Not a VS Code replacement.** It is not a day-to-day development IDE, nor a
  remote workspace: it is a **universal demo player**. You develop locally, as
  before; railsbox publishes the result.
- **Not a full Rails emulator.** ActionCable and WebSockets are out of scope,
  outbound networking does not exist, and the speed is emulation speed — see
  "[Known limits](#known-limits)".

These refusals are **deliberate**. They are shortcomings if you compare railsbox
to a hosting provider, and properties once you accept the framing: a sandbox has
nothing to protect server-side, because there is no server.

---

## What is supported

| | Status |
| --- | --- |
| **SQLite** | validated end to end: `rails new` + Propshaft + importmap, published and booting online |
| **PostgreSQL** | supported on the split base/app path, from base `3.3-r2` onward (the workflow default) |
| **MySQL / MariaDB** | not supported: the build stops with an explicit report |
| **importmap, Propshaft, Sprockets** | precompiled inside the i386 disk |
| **Tailwind, dart-sass** | precompiled on an amd64 stage, copied into the i386 disk |
| **npm toolchains** (esbuild, cssbundling, jsbundling) | same amd64 stage: `npm ci` then your build scripts |
| **Redis, Sidekiq** | detected from `Gemfile.lock`, present in the base image |

### Known limits

| Limit | Status |
| --- | --- |
| **PostgreSQL** | **wired up** on the split path: the server lives in the base image (from revision `3.3-r2`), the data directory on the application disk, and the cluster only starts after that disk is mounted. Requires base `3.3-r2` or newer — the build explicitly refuses an older base. See "[PostgreSQL](#postgresql)". |
| **Tailwind, dart-sass** | **supported**: precompiled on an amd64 stage, then copied into the i386 disk (the guest never runs those binaries). Tailwind is validated **end to end** — `demo-tailwind` variant, real v86 VM boot, compiled stylesheet served by the guest — and replayed by the [`valider-variantes.yml`](.github/workflows/valider-variantes.yml) workflow. dart-sass now has its own test bench (`demo-dartsass`), stricter still: `sass-embedded` ships no i386 binary at all, where `tailwindcss-ruby` still offers a `ruby` variant. |
| **npm toolchains** (esbuild, cssbundling) | **supported** by the same stage (`npm ci` then build scripts). A yarn/pnpm/bun lockfile is not read: it falls back to `npm install`, with a warning. |
| **Client-side SPA** (React, Vue, Svelte) | **needs an adaptation in your code** — the one railsbox cannot make for you. The application is served under `/<repo>/app/`; Rails helpers follow that prefix, your JavaScript cannot guess it. Recommended pattern, with copy-pasteable code: "[Does your app ship a SPA?](#does-your-app-ship-a-spa-read-this-first)". |
| **ActionCable / WebSockets** | out of scope: incompatible with a request/response bridge. Possible route: long-polling or a dedicated stream. |
| **Outbound networking** | nonexistent. That is also a property of the demo model — see [`SECURITY.md`](SECURITY.md). |
| **Bridge throughput** | a narrow, shared pipe; fine for Turbo/HTML. Precompiled assets do not use it: extracted from the image, they are served statically by the Service Worker. |
| **Persistence** | none, by design. Every visitor writes to their own copy, which disappears with the tab. |

### Security, in one line

Everything runs client-side: the disk image and the memory snapshot are
**downloadable by anyone**, and the visitor is root inside their VM. Never ship
real secrets or real data. What is defended, what is not, and why:
[`SECURITY.md`](SECURITY.md).

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
your code — is in "[War stories](#war-stories-the-problems-that-cost-the-most)".

---

## Configuration

Everything is auto-detected (Ruby version, database adapter, asset pipeline,
native gems, background services). You only configure what detection cannot
guess.

### `railsbox.yml`

A file at the root of the application completes or corrects auto-detection:

```yaml
ruby: 3.3.12 # SERIES only — see the box below
database: sqlite3 # otherwise config/database.yml, then the pg gem in the lock
seed:
  command: "bin/rails db:seed" # runs at BUILD time, before the snapshot
  auto_login: "demo@example.com" # the visitor arrives signed in
env:
  APP_HOST: "http://localhost:8080" # variables your initializers require
assets:
  scripts: ["build", "build:css"] # npm build scripts to trigger
  output: ["public/dist"] # produced directories to ship into the sandbox
system_packages: [libmagickwand-dev] # Debian packages your gems require
exclude: [doc, db/fixtures] # paths NOT to ship into the sandbox
```

Seven keys are recognised — `ruby`, `database`, `seed`, `env`, `assets`,
`system_packages`, `exclude` — and
inside the `assets:` block two keys are read, `scripts` and `output` (anything
else there is ignored with a warning); anything else raises a diagnostic.
`database` accepts `postgresql` or `sqlite3`. `env:` values are treated as
**inert data**, never evaluated at build time (see [`SECURITY.md`](SECURITY.md)).

`assets.output` accepts only paths **relative** to the application root, with no
`..`, no absolute path and no character a shell could interpret: these values
come from a third-party repository and end up in build commands. Anything that
fails that check is rejected with a diagnostic naming the offending entry, never
silently sanitised. The key **completes** auto-detection rather than replacing
it: `public/assets` and `app/assets/builds` stay exported no matter what.

#### What the application disk does not ship

The application disk has a **fixed 512 MB geometry** (ADR 0002). Dumping the
repository tree into it as-is is what makes real applications overflow: on the
first third-party application built, the tree weighed 261 MB **before**
`bundle install` — 143 MB of `vendor/bundle` compiled for another Ruby, 65 MB of
`public/assets` the build re-emits, and 54 MB of `.git`.

railsbox therefore builds a **filtered build context** — it never touches your
repository — from which the following are dropped:

| Path                          | Why                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.git`                        | the VM has no git, and no Rails request reads the history                                                                                                                                    |
| `vendor/bundle`               | the build reinstalls gems under `/app/vendor/bundle` **before** the copy: a vendored bundle can only land on top of it — dead if it targets another Ruby, **breaking** if it targets the same one (x86_64 binaries over native i386 gems) |
| `node_modules`                | reinstalled by the amd64 stage (`npm ci`); the i386 guest has no Node                                                                                                                        |
| `tmp`, `log`                  | already wiped by the build before the ext2 is made                                                                                                                                           |
| `coverage`                    | coverage reports, never read at runtime                                                                                                                                                      |
| `.github`, `.idea`, `.vscode` | continuous integration and editor settings                                                                                                                                                   |
| asset output directories under `public/` | **only** when the build regenerates them (`public/assets`, `public/vite`, `public/packs`)                                                                          |

Three precautions are worth spelling out, because the opposite would break
applications.

- **`vendor/cache`, `vendor/javascript` and `vendor/assets` are kept.** Only
  `vendor/bundle` goes: it is `BUNDLE_PATH` output, not a gem delivery
  mechanism. A gem missing from rubygems ships via `bundle package`
  (`vendor/cache`) or a Gemfile `path:` — neither of which railsbox touches.
- **`app/assets/builds` is never dropped.** It is a pipeline load path, hence a
  **source**: an application may version a CSS file there that nothing rebuilds.
  Under `public/` an output directory is an artefact; under `app/` it is a
  source.
- **`public/assets` is dropped only if the build re-emits it.** If no pipeline is
  detected, your versioned assets are the **only** ones the sandbox will serve:
  they stay untouched.

A `.dockerignore` supplied by your application is **kept and applied** by
BuildKit, on top of this filtering.

The `exclude:` key **adds** your own paths — a demo media folder, a heavy
fixture set. Like `assets.output`, it accepts only paths **relative** to the
root, with no `..`, no absolute path and no character a shell could interpret:
these values end up in a build command. Paths that **carry the application**
(`app`, `bin`, `config`, `db`, `lib`, `public`, `vendor`, `Gemfile`,
`Gemfile.lock`, `Rakefile`, `config.ru`) are refused with a diagnostic — aim at
a sub-path (`public/uploads` rather than `public`).

The build log states what was removed, with its weight:

```
→ Filtrage du contenu applicatif…
    .git                              54 Mo écartés
    vendor/bundle                    143 Mo écartés
    public/assets                     65 Mo écartés
    (absents du dépôt : node_modules, tmp, coverage, .idea, .vscode)
  Arbre du dépôt 270 Mo → contexte livré au build 10 Mo (260 Mo écartés)
```

And should the geometry still overflow, the refusal **names the culprits**
rather than reporting a bare total:

```
✗ Le contenu applicatif (612 Mo) dépasse la géométrie fixe (512 Mo).

  Les plus gros répertoires du contenu livré :
       331 Mo  vendor/bundle/ruby
        94 Mo  opt/systeme/usr
        62 Mo  var/pg
```

#### `ruby:` does NOT pick the Ruby version

The interpreter is **compiled into the shared base image** (ADR 0004), which is
immutable: the application disk cannot change it. Base `3.3-r2` ships **Ruby
3.3.12**, and that is what your application will run whatever you write here.
The `ruby:` key — like `.ruby-version` or the Gemfile's `ruby` directive — only
drives two things: the **series**, hence which base is selected, and the
`ruby:X.Y.Z-slim` image of the amd64 asset precompilation stage. To change the
guest's Ruby you must change base (the workflow's `base:` input).

The corollary is detection's most useful refusal: a Gemfile pinning an
incompatible **strict equality** is rejected **before** the build, not halfway
through `bundle install` nine minutes later.

```
- [ruby-version-incompatible] Le Gemfile exige Ruby « 3.3.10 » (source : Gemfile) ;
  la base 3.3-r2 fournit 3.3.12.
```

Only what is **actually** incompatible is refused: `ruby "~> 3.3.10"`,
`ruby "~> 3.3"`, `ruby ">= 3.1", "< 3.5"` and a `.ruby-version` file **on its
own** (which Bundler does not enforce) all pass. `ruby file: ".ruby-version"`,
however, is a strict equality and follows the same rule as the literal form.

#### `config.force_ssl` is neutralised inside the guest

The sandbox has **no TLS termination**: Puma listens in the clear and the serial
bridge carries bytes. An application with `config.force_ssl` — the default of a
`rails new` since Rails 7 — would answer 301 to https in a loop and only emit
`secure` cookies. railsbox therefore drops an initializer into your application
tree (`config/initializers/zzz_railsbox_force_ssl.rb`, generated, guarded by
`RAILSBOX_SANDBOX`) that resets `config.force_ssl` to false — exactly as it
already does for auto-login. **You have nothing to change.**

The analysis report mentions it as `[force-ssl-enabled]` (info, not a warning:
railsbox handles it). To observe the original behaviour, disarm the workaround:

```yaml
env:
  RAILSBOX_KEEP_FORCE_SSL: "1"
```

#### `database: sqlite3` sets a real `DATABASE_URL`

The build runs with `RAILS_ENV=production`. Without `DATABASE_URL`, an
application whose `production:` block in `config/database.yml` is
PostgreSQL-only would read that file and ignore the `database: sqlite3` key.
railsbox therefore sets `DATABASE_URL=sqlite3:storage/production.sqlite3` — at
build time and at guest startup — which takes precedence over `database.yml`:
the override is real.

One condition the key cannot create remains: the `sqlite3` gem must be **in the
production bundle**. The VM's bundle is installed with
`BUNDLE_WITHOUT="development:test"`; a gem confined to `group :development` —
very common on an application deployed against PostgreSQL — will not be there,
and detection refuses rather than letting the application fail with a
`LoadError` in the browser.

`ruby:` selects a **series**, not a patch: the patch running in the VM is the
base's. What that means for a strict `Gemfile` constraint: "[Pinning a Ruby
version](#pinning-a-ruby-version-what-base-allows-and-what-it-does-not)".

### Demo data and auto-login

`seed.command` runs **at build time**, before the snapshot is captured, so the
visitor finds the database already populated with no wait.

`seed.auto_login` accepts an identifier — an **email address** or a **numeric
id**, looked up on the **`User`** model, resolved strictly with no silent
fallback — or `true` for the first user (`User.first`). If your user model is
not called `User`, or the identifier is neither an email nor an id, use
`seed.auto_login_code`: a Ruby fragment (a `|` block scalar) with `env` in
scope. Auto-login runs **on the visitor's side**, on first load: it depends on
their session, which no snapshot can contain.

> **`auto_login` opens a Warden session — and nothing else.** It puts the user
> into Warden and into the Rack session, which covers Devise and ordinary Rails
> pages. It does **not** cover token authentication: a front end that reads a
> JWT from `localStorage` (devise-jwt, Knock, a hand-rolled JWT) boots
> **signed out**, whether or not a Rails session is open — it never looks at the
> cookie. The "visitor arrives signed in" promise holds for sessions; for
> tokens you must mint the token and hand it to the page. That is what the
> recipe below does.

#### Recipe: auto-login for a JWT-authenticated SPA (devise-jwt)

Three pieces. **One**: the fragment mints the token and drops it in the session.

```yaml
# railsbox.yml
seed:
  command: "bin/rails db:seed"
  auto_login_code: |
    user = ::User.find_by(email: 'demo@example.com')
    return avertir("no demo user") if user.nil?
    # Warden session: covers Rails pages rendered from views.
    connecter(env, user)
    # Token: this is what the front end will read. UserEncoder#call(user, scope,
    # aud) returns [token, payload]; `aud` stays nil because the SPA only sends
    # the Authorization header, never an audience header.
    token, _payload = ::Warden::JWTAuth::UserEncoder.new.call(user, :user, nil)
    # The session is the only channel available: this fragment runs BEFORE the
    # application, so it cannot write to the response.
    env['rack.session'][:railsbox_jwt] = token
```

**Two**: the host page reads the session and hands the token over, once.

```erb
<%# app/views/pages/react_app.html.erb %>
<script>
  window.railsData = {
    basePath: '<%= spa_url_root.presence || "/" %>',
    jwt: <%= raw(session.delete(:railsbox_jwt).to_json) %>
  };
</script>
```

**Three**: the front end stores the token where it already looks for it, before
mounting.

```js
// src/main.jsx, before createRoot(...)
const token = window.railsData?.jwt
if (token) localStorage.setItem('auth_token', token) // the key YOUR code reads
```

What you need to know to adapt it:

- **The convention's helpers are not there.** With `auto_login_code` the
  identifier resolver (`resoudre`) is not generated: look the user up yourself
  in ActiveRecord. `connecter(env, user)` and `avertir(message)` do remain
  available, and `return` is legal — the fragment is spliced into a method body.
- **The fragment runs inside a middleware, last in the stack**, once per
  visitor, before the application is called: `env['rack.session']` is already in
  place, and any exception is caught and logged without breaking the page.
- **Revocation strategies.** The token as minted is accepted as-is by
  `Denylist` (the `jti` is in no table until it is revoked) and by `JTIMatcher`
  (the emitted `jti` is the record's own). No extra dispatch hook is needed.
- **`connecter` is still worth keeping** even for a pure SPA: embedded Devise
  pages, an ActiveAdmin or a `/rails/info` keep working.
- **A different auth gem?** The principle does not change: mint the token with
  your gem's API, drop it in `env['rack.session']`, render it into the page,
  store it client-side. Only the first line differs.

### Workflow inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `app-path` | `.` | path to the Rails application inside the calling repository |
| `name` | repository name | short sandbox name (sanitised in all cases) |
| `base` | `3.3-r2` | railsbox base version (suits SQLite and PostgreSQL alike) — **this is what fixes the guest's Ruby**: `3.3-r2` ships 3.3.12 |
| `seed` | (detected) | seed command, if you want to force one |
| `publish` | `true` | publish to `gh-pages`, or build only |
| `target-repo` | (the calling repository) | publish elsewhere — then requires the `publish-key` secret |
| `assets-url` | `https://pinfada.github.io/railsbox-assets` | artifact repository root |
| `base-image` | `ghcr.io/pinfada/railsbox-base` | build image (must match `base`) |
| `railsbox-ref` | `main` | railsbox version used to build |
| `railsbox-repo` | `pinfada/railsbox` | which railsbox repository to use — **point it at your fork** to verify a shell or proxy change end to end |

The `publish-key` secret — a write deploy key — is **required** as soon as
`target-repo` is set: the workflow token is only valid for the current
repository.

Two guardrails refuse outright rather than publish a demo that would fail to
load: GitHub Pages' **95 MB per-file limit**, and an application whose amd64
stage produces **no** assets at all (an application with no CSS is a failure the
visitor would discover when the page renders).

### Pinning a Ruby version: what `base:` allows, and what it does not

`base:` names a **series plus a revision** (`3.3-r2`), never a patch. The patch
actually running inside the VM is the one compiled into the base when it was
published (`ARG RUBY_VERSION` in `tools/build-v86-image/base/Dockerfile`): base
`3.3-r2` ships **Ruby 3.3.12**. No input lets you ask for 3.3.10 rather than
3.3.12.

The `ruby:` key in `railsbox.yml` does not fill that gap, and it is worth
knowing exactly what it does:

| Where | Which Ruby | Set by |
| --- | --- | --- |
| amd64 asset precompilation stage | the exact patch requested (`FROM ruby:<x.y.z>-slim`) | `ruby:` |
| i386 runtime, in the visitor's VM | the patch compiled into the base | `base:` |

So `ruby:` mostly selects the **series**, which must match the base's. In
practice: a `~> 3.3.10` constraint in your `Gemfile` is satisfied by the base's
3.3.12; a strict `ruby "3.3.10"` is not, and `bundle install` will tell you so
from inside the build. **Relax the `Gemfile` constraint rather than trying to
pin the patch** — that is the only lever that exists today.

**Why there is no per-patch base, and why that will not change.** A base is not
a tag, it is an **immutable 1.45 GB artifact** split into 363 compressed chunks,
plus a kernel, an initrd and a memory snapshot, hosted permanently on a GitHub
Pages site. Publishing one base per Ruby patch would mean republishing all of
that on every patch release — four to six a year per series, for two maintained
series — and **keeping the old ones forever**, since an already-published
sandbox references its artifact by name. Storage would grow without bound, the
visitors' artifact cache would stop being shared — it is precisely the single
shared rootfs that keeps a visitor's download at ~32 MB — and the validation
matrix (four build paths, three browser engines) would be multiplied by the
number of live patches.

The trade-off is therefore deliberate: **one base per series and revision,
never per patch.** A demo is not a production environment, and a patch-level
difference within a stable series changes nothing observable there. If a
specific patch really is essential — a security fix you want to demonstrate, a
runtime bug — the route is not a workflow input but a **base revision**:
`base-build.sh --ruby <x.y.z>` produces a complete base, published under a new
revision (`3.3-r3`), which `base:` can then name. See "[Republishing the base
image](#republishing-the-base-image)".

### PostgreSQL

Nothing to declare: the default base (`3.3-r2`) ships the server, and detection
recognises an `adapter: postgresql` — failing that, the mere presence of the `pg`
gem in `Gemfile.lock`, which covers applications whose `database.yml` is just
`url: <%= ENV["DATABASE_URL"] %>`. If you pin an older base (`base: "3.3"`), the
build stops with a message pointing you at `3.3-r2`.

What railsbox does, and why:

| Item | Choice | Reason |
| --- | --- | --- |
| Server | in the base rootfs, **with no cluster at all** | shared across sandboxes; a datadir in the base would weigh on every visitor, including sqlite3 ones |
| Data directory | `/app/var/pg`, on the **application disk** | it travels with the application: the state migrated and seeded at build time ships as is, with no first-boot migration |
| Cluster startup | in `start-app.sh`, **after** the disk is mounted | the base snapshot freezes processes; a postmaster started at init would be frozen on a datadir that does not exist yet |
| Connection | `DATABASE_URL` written on the application disk | overrides host, role and database without touching the application's `config/database.yml` |
| Durability | `fsync = off`, minimal WAL | the database is rebuilt on every build and the visitor's copy is disposable; under emulation, `fsync` dominates migration cost |

The role password (`postgres`) is not a secret: the VM has no outbound network
and the cluster only listens on the emulated loopback (see
[`SECURITY.md`](SECURITY.md)). Never ship real data.

A PostgreSQL variant of the demo application serves as a test bench. It is not a
second application but a four-file overlay:

```bash
APP="$(bash tools/demo-app/preparer-demo-pg.sh)"
wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP"   --name demo-pg --base ghcr.io/pinfada/railsbox-base:3.3-r2
node tools/build-v86-image/make-delta-snapshot.mjs --name demo-pg --base base-3.3-r2
```

### Repairing an incomplete configuration

A serious Rails application refuses to boot when a key is missing. The
**Environment** panel (top right of the sandbox) detects those variables in the
boot logs, generates internal secrets in the right format in one click, offers a
field for third-party service credentials, then **injects everything into the VM
and hot-restarts the application** — without rebuilding the image.

On a blocking diagnostic (MySQL database, a Ruby constraint incompatible with
the base, the `sqlite3` gem missing from the production bundle, a directory that
is not a Rails application), the build stops and prints an **incompatibility
report with a remedy per item**, right in the workflow summary.

---

### When the build fails

An **upstream** refusal (before building) was already readable: code, message
and remedy in the job summary. A **downstream** failure — `bundle install`,
assets, migration, snapshot capture, publication — now is too. The workflow
captures the failing step's log and publishes a **"Why the build failed"**
block in the summary: category, stable code, the log excerpt that proves the
diagnosis, and an actionable remedy. The full log stays in the runner traces.

The taxonomy lives in
[`tools/build-v86-image/classifier-echec.mjs`](tools/build-v86-image/classifier-echec.mjs)
(pure, tested module). It names what the log does not: the **Debian package**
to add to the base behind a missing `libpq-fe.h`, the amd64 stage behind an
"Exec format error", the exact ActiveRecord error behind a failing migration.
With no known pattern, it honestly returns the last thirty useful lines,
stripped of Docker progress noise, **redacted** before publication (the
captured log never went through the runner's secret masking).

## Testing locally

```bash
npm install
npm start                 # http://localhost:8080 — COOP/COEP, Range and gzip included
npm test                  # unit tests (node --test, no network, no artifacts)
npm run check             # lint + format + typecheck + tests — the CI gate
npm run test:integration  # full protocol against a REAL v86 VM under Node
                          # (requires public/disks/; ~1 min thanks to the snapshot)
```

| URL | What runs |
| --- | --- |
| `http://localhost:8080` | your Rails application, restored from the snapshot |
| `http://localhost:8080/?fresh=1` | the same, ignoring the snapshot (cold boot) |

The host page reads `public/disks/v86-config.json`: with no built artifacts, it
says so and stops there.

After an image build, extract the precompiled assets so they are served
statically instead of crossing the serial bridge (performance lever number one):

```bash
wsl -e sh tools/extract-assets.sh   # → public/disks/assets/ + appstatic/
```

### Three offline test levels, all required before a commit

| Command | Scope | Dependencies |
| --- | --- | --- |
| `npm test` | pure modules (codecs, detector, buildpack, config) | none |
| `npm run test:integration` | full serial protocol against a **real v86 VM** under Node — 1 MB POST, ENV/RST, base + application mount | `public/disks/` |
| `npm run test:e2e` | full browser boot in Chromium (Playwright): host page, isolation, application rendered in the iframe, navigation | Chromium; VM in `public/disks/` |

`npm run check` chains lint (ESLint), format (Prettier), typecheck
(`tsc --checkJs` across three targets: browser, Service Worker, Node) and unit
tests — exactly what CI runs ([`ci.yml`](.github/workflows/ci.yml)).

The **variant panel** covers what a single app cannot: `demo` (sqlite3, assets
in the guest), `demo-pg` (embedded PostgreSQL cluster), `demo-tailwind` and
`demo-dartsass` (assets on an amd64 stage, via two gems with different
constraints). `npm test` pins their auto-detection manifests; the
[`valider-variantes.yml`](.github/workflows/valider-variantes.yml) workflow
replays the whole chain — overlay, app disk, snapshot, real VM boot — on demand
and every Wednesday, publishing nothing. It also checks the classification of
two real open-source apps (rubygems.org, mastodon), shallow-cloned: those tests
skip themselves outside CI, since `npm test` must depend on neither network nor
GitHub.

### Verifying a published sandbox

The three levels above test the **code**. A fourth tests the **finished
product**, at its real URL:

```bash
npm run test:live                                   # the reference demo
RAILSBOX_SANDBOX_URL=https://account.github.io/repo/ npm run test:live
```

This suite opens the published sandbox in Chromium, waits for the VM to boot
(25–80 s), loads a scaffold page through the proxy and watches all network
traffic. It checks that the shell references **only relative paths** (a project
Pages site serves under `/<repo>/`: one absolute reference and nothing loads —
this defect happened four times, always invisible locally), that no request ends
in a 404, that **no external origin** is contacted, and that no artifact request
carries a non-safelisted header or triggers an OPTIONS preflight (the concern
raised in [ADR 0001](docs/decisions/0001-distribution-artefacts.md): GitHub Pages
answers 405 to preflights).

It also **writes**: a post is created through the scaffold form, CSRF token
included. That scenario was added after the fact, and it is not decorative —
the recipe was eight-for-eight green while the demo could not save anything at
all (see "A Service Worker cannot set a cookie"). A read-only suite validates a
half-dead sandbox.

It depends on the network and on a deployment, so it lives **outside `npm test`
and CI**. The [`verifier-sandbox.yml`](.github/workflows/verifier-sandbox.yml)
workflow runs it on demand — useful right after publishing — and every Monday,
because a live demo can break without a single commit touching it.

---

# Under the hood

*Everything below is for understanding or contributing, not for publishing a
sandbox.*

## The model

The idea behind railsbox is an **economic inversion**: a full-stack application —
server, database, cache — stops being a *service you operate* and becomes a *file
you distribute*. Once built, running it costs nobody anything: **each visitor
brings their own server** — their CPU, their memory, their tab. The build runs in
the maintainer's GitHub Actions, the artifacts live on their GitHub Pages, the
shell is a static page: free, with no paid third-party dependency.

Two consequences that define the project:

- **Per-visitor isolation is a feature, not a limitation.** Everyone gets their
  own copy; their data never leaves their browser. Nobody can pollute anybody
  else's trial, and the model is GDPR-compatible by construction. The exact
  granularity is the browser, not the tab: two tabs of the same browser share
  one sandbox, of which a single instance runs at a time.
- **The defensible value is the recipe, not the engine.** v86 is open source and
  anyone can reuse it. What compounds is the buildpack — the twenty-two
  iterations, the i386 traps, the auto-detection, the base image library — the
  path from a GitHub URL to a sandbox that boots.

railsbox is validated against a real production application —
[jiyufit](https://github.com/pinfada) (Rails 7.2.3, Ruby 3.3.10, PostgreSQL 15,
Redis, Sidekiq, Devise, Stripe, 70 initializers) — which renders its pages,
follows its links and handles its POSTs, and against a `rails new` demo
application (sqlite3 + importmap) built, published and booted automatically.

Architecture decisions and their measured limits are recorded in
[`docs/decisions/`](docs/decisions/) (in French).

## The repositories

| Repository | Role |
| --- | --- |
| **railsbox** (this one) | the buildpack, the shell, the workflows |
| [**railsbox-assets**](https://github.com/pinfada/railsbox-assets) | static hosting of the base rootfs images, versioned and immutable |
| [**railsbox-demo**](https://github.com/pinfada/railsbox-demo) | the demo application and its published sandbox |

**One origin per demo**: every sandbox lives on its own repository's domain, so
isolation between demos is the browser's, not a promise of ours (see
[ADR 0004](docs/decisions/0004-topologie-de-distribution.md)).

## Flow diagram

```
┌─────────────────────────── BROWSER ───────────────────────────────┐
│  APPLICATION IFRAME            HOST PAGE (main thread)            │
│  fetch("/app/gymhouses")       ├─ main.js: orchestration, logs    │
│        │                       ├─ vm/v86-vm.js: boot + bridge     │
│        ▼                       └─ env-drawer.js: repair panel     │
│  SERVICE WORKER (sw-proxy.js)          ▲                          │
│  ├─ intercepts /app/*                  │ MessageChannel           │
│  ├─ re-injects COOP/COEP               │ (renewed if it dies)     │
│  └─ rewrites absolute Locations ───────┘                          │
├───────────────────────── LINUX i386 VM (v86) ─────────────────────┤
│  ttyS0 ◄── REQ / BOD+ACK / FIN ─── @RIB1 frames ──► RSB/DAT/END   │
│    │                                                              │
│    ▼                                                              │
│  serial-bridge.py  ──HTTP──►  Puma 127.0.0.1:3000                 │
│  (daemon, survives an    (Rack::URLMap mounts the app under /app) │
│   application crash)          │                                   │
│                               ├─ PostgreSQL 15                    │
│                               └─ Redis                            │
└───────────────────────────────────────────────────────────────────┘
```

The `/app` prefix is preserved end to end: the Service Worker intercepts only it,
and the application generates it natively because `Rack::URLMap` mounts the app
underneath.

### Paths hardcoded at the domain root

Every application references a few files **at the domain root**, with no prefix:
`/favicon.ico`, `/site.webmanifest`, `/robots.txt`, sometimes a `/404.html` or a
data file. Those paths escape the proxy — they do not start with `/app` — and so
produced **silent 404s**.

The list of names to catch used to be hardcoded in the Service Worker. It could
not know a third-party application's own: anything missing from it stayed an
invisible hole. It no longer is. `tools/extract-assets.sh` now enumerates
**every file at the root of the image's `public/`** — a small, closed-by-
construction set; subdirectories (`assets/`, `images/`, `dist/`…) are not part of
it — drops them into `disks/appstatic/` and writes an `index.json` inventory of
what was actually extracted next to them. The Service Worker reads that
inventory once and uses it as its allowlist, falling back to the historical list
when the inventory is absent (sandbox built before it).

**What was rejected: proxying unknown root paths to the VM.** The site root is
the **shell's** space — `index.html`, `main.js`, `sw-proxy.js`, `disks/` — and,
on a project Pages, everything else the repository publishes. A proxied fallback
would have the proxy claim a namespace it does not own, would send the session
cookie on requests unrelated to the application, and would multiply round trips
over the **narrow pipe** — on requests that are precisely 404s. It would not even
work: those files are requested while the shell loads, **before** the VM has
booted; the fallback would answer 503 instead of 404. A slower hole, not a
plugged one.

The retained resolution therefore routes nothing to the VM: it only redirects a
same-origin GET to another static path on the same origin, under
`disks/appstatic/`, after a **shape** check (a single segment, an extension, no
character that could build another path). And the names the shell serves itself
are excluded in code, whatever the inventory says: an application shipping a
`public/main.js` cannot take the place of the loader that drives the VM.

## Where assets are precompiled

The guest is **i386**, and two families of asset tools publish no binary for that
architecture: gems with a precompiled executable (`tailwindcss-ruby`, which
tailwindcss-rails depends on, and `dartsass-ruby`) and npm toolchains (esbuild,
sass). Yet they produce **ordinary** CSS and JS, independent of the architecture
— so they run on an **amd64 stage**, and the i386 disk receives only
`public/assets`. The guest never executes those binaries.

Auto-detection classifies each application on its own:

| What it finds | Stage picked | What runs |
| --- | --- | --- |
| propshaft/sprockets + importmap | `i386` | `assets:precompile` inside the application disk |
| tailwindcss-rails, dartsass-rails | `amd64` | `assets:precompile` on the host, then `public/assets` is copied |
| `package.json` (jsbundling/cssbundling) | `amd64` | `npm ci` + build scripts, then `assets:precompile` |
| no pipeline | `aucun` (none) | nothing |

The amd64 stage sets exactly the same `RAILS_RELATIVE_URL_ROOT` as the
application disk, so URLs baked into CSS carry the **full public prefix**
(`/repo/app/assets/…`), under the site and not at the domain root — otherwise the
Service Worker could not even catch them.

A Tailwind variant of the demo application serves as the test bench — a
seven-file overlay on `demo/`, like `demo-pg`:

```bash
APP="$(bash tools/demo-app/preparer-demo-tailwind.sh)"
wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP"     --name demo-tailwind --base ghcr.io/pinfada/railsbox-base:3.3-r2
node tools/build-v86-image/make-delta-snapshot.mjs --name demo-tailwind --base base-3.3-r2
node --test tests/integration/vm-tailwind.it.mjs
```

The integration test does not settle for checking that a stylesheet exists: it
looks inside the CSS **served by the VM** for an arbitrary-value utility
(`tracking-[0.35em]`) that no pre-built stylesheet could contain. Its presence
proves the `tailwindcss` binary scanned the views during this very build — on
the amd64 host, never in the guest.

Two warnings rather than a refusal: without a `package-lock.json` (or with a
yarn/pnpm/bun lockfile, which railsbox does not read), installation falls back to
`npm install` and the build is no longer reproducible — the analysis report says
so. And if the amd64 stage produces **no** asset at all, the build stops there.

### What the amd64 stage ships back into the sandbox

For a long time the stage exported only `public/assets` and `app/assets/builds`.
That is exactly right for sprockets/propshaft and for `jsbundling-rails` — and
for nobody else. `vite_rails` writes to `public/vite`, Shakapacker to
`public/packs`, a bare `vite build` to whatever its config says. Those bundles
were thrown away **without anything failing**: the build succeeded, the sandbox
booted, and the SPA was missing on screen. The "no asset produced → stop" guard
did not catch it, because Tailwind had produced its files just fine.

Three mechanisms answer that failure, from the most automatic to the most
explicit.

**1. Auto-detection**, which covers the common case with nothing to write:

| What it finds | What it adds to the export |
| --- | --- |
| `vite_rails` / `vite_ruby` in Gemfile.lock | `public/vite` |
| `shakapacker` / `webpacker` | `public/packs` |
| `config/vite.json` (`publicOutputDir`) | the declared directory, across all environments |
| `config/shakapacker.yml` (`public_output_path`) | same, YAML anchors included |

**2. `assets.output`**, the escape hatch, for what nobody can guess — a `vite
build` invoked directly, a bespoke script:

```yaml
assets:
  scripts: ["build:css", "build:react"]
  output: ["public/dist"]
```

**3. The end-of-stage warning**, the guard that backs up the other two. Right
before running the scripts the stage drops a timestamp marker; right after, it
lists the directories that were written and will *not* be exported, and names
them:

```
⚠ Répertoires produits par les builds mais NON exportés vers la sandbox :
    public/dist
```

It is a **warning**, not a refusal: a produced-but-unexported directory is
sometimes exactly what you want (a coverage report, a build cache). The
comparison prunes `node_modules`, `.git`, `tmp`, `log`, `vendor/bundle`,
`.bundle`, `storage` and `coverage` — otherwise it would cost more than it is
worth.

## Artifact caching

GitHub Pages caps its responses at `Cache-Control: max-age=600` and is not
configurable. Yet our artifacts are **immutable by construction**: a published
base is never rewritten
([ADR 0004](docs/decisions/0004-topologie-de-distribution.md)), and a part-file is
a frozen slice of a frozen disk
([ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)). Left alone, a
visitor returning the next day would re-download the ~32 MB of the first load
— and up to ~48 MB after browsing around — that they had already read.

Since the Service Worker already intercepts everything, it keeps an **application
cache in Cache Storage**, cache-first:

| Point | Choice |
| --- | --- |
| What is cached | the part-files of the split disks, the kernel, the initrd — **and nothing beyond what the v86 configuration names** |
| What is not | the memory snapshot, already cached by the page in IndexedDB; a disk read via `Range` requests, whose 206 responses Cache Storage rejects; any request carrying a `Range` header |
| Cache name | derived from the whole configuration, `builtAt` included. Since the application disk URL is stable across builds, a cache keyed by URL alone would blend chunks from two images after a rebuild — that is, corrupt the filesystem. A configuration change switches to a fresh cache and deletes the old one. |
| Headers | **none are added.** Requests to Pages must stay "simple" in the CORS sense, otherwise they trigger a preflight the host cannot honour ([ADR 0001](docs/decisions/0001-distribution-artefacts.md)). The request is replayed as is, the response returned as is. |
| Quota | `StorageManager.estimate` before writing, with a 10% margin; a write failure is logged once and has no effect — **the request always completes**, cache or no cache. |

The decision logic (which URLs, which cache name, which invalidation) is isolated
in `public/shared/artifact-cache.js` and tested without a browser. The fact that
a reload asks the network for nothing is verified in a real Chromium
(`tests/e2e/artifact-cache.e2e.spec.mjs`): the file is deleted from the server
between the two reads, and the second one still succeeds.

What this cache does not change: it lives in the demo's own origin, so **two
demos still do not share it** — the accepted cost of the "one origin per demo"
topology. It saves repeat visits by the same visitor to the same sandbox, not the
first one.

## Republishing the base image

The base is an **immutable, versioned artifact**
([ADR 0004](docs/decisions/0004-topologie-de-distribution.md)): we never
overwrite a version that sandboxes may be pinning. Any change to its content — a
package added, an init script tweaked — produces a new **revision**, named
`<Ruby series>-r<N>` (`3.3` counts as r1; the PostgreSQL revision is `3.3-r2`).

1. Run the **Publier la base** workflow (`workflow_dispatch`) with
   `tag: 3.3-r2`, `ruby: 3.3.12`, `push: true`. It builds the i386 image, checks
   it (declared architecture, expected content, absence of a cluster in the
   rootfs, full cluster lifecycle), pushes to GHCR, then publishes the split
   rootfs, kernel, initrd and base snapshot into a `base-3.3-r2/` directory of
   the artifact repository — **next to** the previous versions.
2. Check the workflow summary: the published URLs are listed there.
3. Move the sandboxes that need it to `base: "3.3-r2"`. Those staying on `3.3`
   keep working unchanged.

## Building by hand (legacy monolithic path)

Predating the base/application split, this path produces a single image. It is no
longer the only option: PostgreSQL, Tailwind, dart-sass and npm toolchains are
now covered on both paths.

The base rootfs / application disk split
([ADR 0002](docs/decisions/0002-decoupage-base-application.md)) is what brings
snapshot capture down from ~12 min to ~2–3 min, and per-sandbox weight from ~4 GB
to ~150–350 MB: one generic rootfs per Ruby version, shared and cached once for
all sandboxes, plus a small application disk per app. That is the path
`construire-sandbox.yml` takes.

The monolithic path is still **driven by auto-detection**: `build.sh` inspects
the application (Ruby version via `.ruby-version`/Gemfile, database adapter via
`config/database.yml`, asset toolchain via `package.json`, native gems needing
system libraries, services) and derives the arguments of the parameterised
Dockerfile. Under **WSL2 or Linux, as root** (Docker and `e2fsprogs` required):

```bash
wsl -u root -e bash tools/build-v86-image/build.sh /path/to/your-app
node tools/build-v86-image/make-snapshot.mjs   # captures the memory snapshot
```

The Dockerfile stays two-stage — assets precompiled on x86_64 (tailwind, esbuild
and dartsass have no i386 binary, and an empty stage is selected when nothing
requires it), i386 rootfs with Ruby, prepared database, kernel extracted for a
direct boot. Every i386 trap (see "War stories") is preserved; the package
installation layer is ordered so images share the cache.

`make-snapshot.mjs` boots the image **under Node**, waits for the application to
answer, captures the memory state and writes it gzipped. That is what spares the
end user the thirteen-minute cold boot.

## War stories: the problems that cost the most

Twenty-two build iterations were needed. The obstacles were almost never where
you would expect them.

**TCP loopback did not exist under the original engine.** `bind()` on
`127.0.0.1` failed with a phantom `EADDRINUSE` because the whole TCP stack went
through Tailscale. Puma therefore listened on a **Unix socket**, entirely
internal to the emulated kernel. That is what motivated the move to v86, whose
real Linux kernel makes loopback trivial.

**The upstream channel dropped large POSTs.** The serial port has **no flow
control** in the browser → guest direction. Measured: a 32 KB POST goes through,
**128 KB is lost and wedges the channel permanently**. The fix is a chunked
protocol with per-chunk acknowledgement (1,536-byte send window), which bounds
bytes in flight whatever the buffer size.

| POST body | Before | After |
| --- | --- | --- |
| 1–32 KB | arrives | arrives |
| 128 KB | **lost**, channel dead | arrives |
| 1 MB | lost | **2.5 s** |

A welcome side effect: since the body is no longer embedded in the JSON
descriptor that itself gets re-encoded, the payload loses **77%** of its bloat.

**The channel is half-duplex, and it shows.** A large response in flight
monopolises the guest's write side, so an upstream chunk acknowledgement queues
behind it. The same 4 KB POST takes **105 s** while assets load, versus under a
second on an idle channel. The acknowledgement timeout is therefore aligned with
a full request timeout — a short value wrongly failed every POST concurrent with
a download.

**Only one writer on the serial port.** A `tail -F` added for telemetry wrote
concurrently with the daemon: its lines interleaved with the frames and
**corrupted large transfers** (a 270 KB stylesheet arrived unreadable).
Application logs are now relayed by the daemon itself, under its lock.

**The guest clock drifts constantly.** Expected after a snapshot restore (the
kernel resumes at capture time), but measurement showed worse: under load, the
guest falls **up to 20 s behind every 5 s**. Without periodic resynchronisation,
session cookies and CSRF tokens expire on their own mid-session.

**`RAILS_RELATIVE_URL_ROOT` only prefixes assets.**

| Helper | Generated URL |
| --- | --- |
| `stylesheet_link_tag` | `/app/assets/tailwind-…` ✅ |
| `link_to`, `form_with` | `/gymhouses` ❌ escapes the proxy |

Route helpers read Rack's `SCRIPT_NAME`, which is empty when Puma serves at the
root. The fix is standard sub-URI deployment: a `config.ru` provided by the image
mounts the application through `Rack::URLMap`, **without touching application
code**. Found by clicking a link — not by watching the home page render.

**Four memory-snapshot traps.**

| Trap | Treatment |
| --- | --- |
| Clock freeze | `TIME` frame + `date -s` beyond 2 s of drift |
| Memory leak — `URL.createObjectURL` on 650 MB is never released | removed at the root: v86 accepts `initial_state: { buffer }` |
| 13-minute cold boot for the user | snapshot generated in CI, shipped gzipped, downloaded when the local cache is empty |
| v86 emits **one JS event per byte** (369,282 for the stylesheet) | pre-allocated `Uint8Array` assembler: **24 ns/byte**, 8.9 ms for 270 KB |

**A Service Worker cannot set a cookie.** `Set-Cookie` is a *forbidden*
response header on a constructed `Response`: the Fetch API drops it silently.
The proxy was relaying Rails' responses without the browser ever storing the
session cookie — the one carrying the CSRF token seed. Every request therefore
opened a fresh session, and **every POST answered 422
`InvalidAuthenticityToken`**. The demo promised "create, edit, delete a post"
and could only display.

So the proxy keeps the jar itself (`shared/cookie-jar.js`): it harvests
`Set-Cookie` from the VM's responses, stores them, and puts the `Cookie` header
back on every relayed request. The jar is persisted in IndexedDB — a Service
Worker is killed as soon as it goes idle, and losing the jar mid-visit would
sign the visitor out. `document.cookie` stays empty on the page, which is *not*
the same as putting cookies out of a script's reach: see
[`SECURITY.md`](SECURITY.md).

The jar is not the only source: the iframe being same-origin, a
`document.cookie = "timezone=…"` set by the application creates a real browser
cookie no VM response ever mentioned. A Service Worker has no DOM, so it *asks
the host page* for them (`cookies-document-request`) and appends them to the
header without ever overriding its own. That relay replaced a first attempt
built on the Cookie Store API, which existed on only one engine out of three.

A security corollary, found in review: that jar attaches the session cookie to
**every** request the Service Worker relays — and a SW handles *navigations*
into its scope whatever their initiator, not just its own clients'
subresources. A form hosted elsewhere could therefore write into the visitor's
VM. The proxy now refuses such requests with 403 — stricter than the
`SameSite=Lax` a browser would have applied on its own.

A second lesson, measured afterwards: that refusal only held on **Chromium**,
because it read headers only. A navigation intercepted by a Service Worker
carries no origin-bearing header at all on Firefox and WebKit (`Sec-Fetch-*` is
added after interception, on all three engines). The rule therefore rests on the
**shape** of the request — `destination`, `referrer`, `mode` — which every
engine populates: a top-level navigation is never the application, which only
ever lives inside the shell's iframe. The full measurement table and the exact
rule are in [`SECURITY.md`](SECURITY.md).

**The lesson outlives the cookie**: the live recipe was 8/8 green against a
demo that could not write, because it only issued GETs — and Rails needs no
session to serve a GET. A full POST scenario was added, and the defect was
found by actually clicking in the published page, not by reading a test report.

**Detecting a missing variable without picking the wrong word.** A pattern like
`(VARIABLE).{0,40}(keyword)` captures the **first** uppercase token on the line —
on `{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}` it seriously
suggested `FATAL` as the variable to fill in. Replaced by a windowed search
around the keyword, stripping log labels (`[DEVISE]`, `[STRIPE]`) and requiring
an underscore in the name. Another nuance: "blocking" is judged on the
**severity of the message**, not on the family of the variable. A `WARN` still
lets the application boot; only the affected feature stays inactive.

**Assorted image-build traps.** `docker export` loses `/etc/hosts` and uids
unless extraction runs as root; a hand-rolled init must mount `/dev/shm`
(PostgreSQL 15); `BUNDLE_WITHOUT` and `BUNDLE_FORCE_RUBY_PLATFORM` must exist
**at runtime**, not only at build time; BuildKit does not apply the 32-bit
personality, so `uname -m` lies and Bundler installs unloadable x86_64 gems;
nokogiri will not compile its vendored libxml2 on i386 (system libraries are
mandatory); `tmp/`, `log/` and `storage/` are often excluded by `.dockerignore`
while Puma requires `tmp/pids`; the serial tty must be in `raw -echo`, since
canonical mode truncates at 4,096 characters.

## Repository layout

```
serve.mjs                          dev server: COOP/COEP, Range, gzip, caching
public/
├── index.html · main.js           host page: orchestration, badges, CSP, sandbox
├── sw-proxy.js                    the single SW: /app/* proxy, cookie jar,
│                                  static assets, COI,
│                                  immutable artifact cache
├── env-drawer.js · .css           environment inspector (session-only secrets)
├── shared/
│   ├── request-codec.js           HTTP validation (security boundary)
│   ├── serial-codec.js            @RIB1 frames, upstream flow control
│   ├── proxy-logic.js             pure SW logic (rewriting, CSP, assets)
│   ├── artifact-cache.js          pure cache logic (cacheable URLs, name, purge)
│   ├── cookie-jar.js              the proxy's cookie jar (a SW cannot set
│   │                              cookies: without it, no Rails session)
│   ├── prerequis-demarrage.js     browser capabilities, reload recovery
│   ├── veille.js                  VM suspension when the tab is hidden
│   ├── election-onglet.js         Web Locks: a single VM per browser
│   ├── env-detector.js            missing-variable detection
│   └── v86-config.js              v86 config: single disk, or base + application
└── vm/
    └── v86-vm.js                  v86 boot, snapshot, clock, serial bridge
tests/                             408 unit tests + integration (real VM) + E2E
├── integration/                   serial protocol against a real v86 VM (Node)
├── e2e/                           full browser boot (Playwright)
└── live/                          suite for the PUBLISHED sandbox (network, out of CI)
tools/
├── detect/                        Rails app auto-detection → manifest
│                                  (incl. assets.mjs: precompilation stage)
├── build-v86-image/               parameterised Dockerfile, build.sh, make-snapshot,
│                                  manifest-to-args, validate-boot, env/,
│                                  assets-amd64.Dockerfile (asset stage),
│                                  classifier-echec.mjs (failure diagnosis),
│                                  base/ (shared rootfs + application disk)
├── vm-harness.mjs                 boots a v86 VM under Node (config-driven)
├── extract-assets.sh              extracts assets from the image (debugfs)
├── demo-app/                      `rails new` validation application (demo/)
│                                  + its PostgreSQL overlay (demo-pg/) and Tailwind (demo-tailwind/)
└── bench-serial.mjs               measures the cost of the serial hot path
docs/
├── architecture.md                code map: a request's full trip, where to start
├── chantiers.md                   open work items, each with a success criterion
└── decisions/                     ADRs: artifact distribution, base/app split
SECURITY.md · CONTRIBUTING.md      threat model · conventions
```

## Third-party licences

railsbox is MIT licensed ([`LICENSE`](LICENSE)). It vendors the
[v86](https://github.com/copy/v86) emulator (BSD 2-Clause,
[`public/vendor/v86/LICENSE`](public/vendor/v86/LICENSE)) and the firmware it
embeds: SeaBIOS (`seabios.bin`, LGPLv3) and the Bochs VGABIOS (`vgabios.bin`,
LGPL). The rootfs images published in `railsbox-assets` contain free software
(Linux, Ruby, Rails…) under their respective licences.

## Contributing

railsbox has a single maintainer. Three doors exist to change that — read them
in this order:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setting up an environment (three tiers,
  from lightest to costliest), which tests to run for what you touch, where the
  decisions live, conventions and process.
- [`docs/architecture.md`](docs/architecture.md) — the code map: the six files
  that carry the substance, and an HTTP request's full trip from the visitor's
  click to Puma and back.
- [`docs/chantiers.md`](docs/chantiers.md) — eight open work items, each with
  its context, the files involved and a verifiable success criterion.

All three are **in French**, as are the ADRs, the code comments and the commit
messages. This is a deliberate choice, not an oversight: most of this
repository's reasoning lives in its comments, and a translation diverges at the
first fix. Code identifiers are in English. **Issue templates and pull requests
accept English** — answer in English if you prefer. Making the entry practicable
without reading French is [work item 7](docs/chantiers.md).

To report something, the issue templates ask for what makes a diagnosis
possible: a sandbox runs entirely in the visitor's tab, there is no server log
to consult. Report a vulnerability privately (the repository's Security tab),
never through a public issue — see [`SECURITY.md`](SECURITY.md) (in French).
