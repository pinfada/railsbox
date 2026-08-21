# Configuration

Everything you can declare: the `railsbox.yml` file at the root of your application, and the inputs of the reusable workflow.

*Back to the [README](../README.en.md).*

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
database_prepare: migrate # stopgap: replay migrations instead of loading schema
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

Nine keys are recognised — `ruby`, `database`, `database_prepare`, `seed`,
`env`, `assets`, `system_packages`, `exclude`, `env_assume_public` — and inside
the `assets:` block two keys are read, `scripts` and `output` (anything else
there is ignored with a warning); anything else raises a diagnostic. `database`
accepts `postgresql` or `sqlite3`, `database_prepare` accepts `schema` (default)
or `migrate`. `env:` values are treated as
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

#### Your credentials are replaced by a **throwaway** pair

Your repository versions `config/credentials.yml.enc` and **not**
`config/master.key` — that is what every `rails new` does, and it is the right
practice. railsbox therefore only ever receives the encrypted half of a pair. As
long as nothing reads the credentials, the missing key goes unnoticed; with
`config.require_master_key = true` in your `production.rb` it is fatal: Rails
refuses to boot and `assets:precompile` dies on *"Missing encryption key to
decrypt file with"*, in the middle of the build.

railsbox therefore substitutes — **in the build context only, never in your
repository** — a BRAND-NEW pair drawn at random: a throwaway key and the
`credentials.yml.enc` it decrypts, carrying a `secret_key_base` and
`active_record_encryption` keys invented for this build. **You have nothing to
change**, and you must certainly **not** hand us your real key: the application
disk is public (see [`SECURITY.md`](../SECURITY.md)), and detection refuses any
`…MASTER_KEY…` in the `env:` block anyway.

The trade-off is explicit: a **business** credential
(`Rails.application.credentials.stripe.secret`) will be `nil` inside the
sandbox. That is already the case today — the file is undecryptable there — and
it is the model: a sandbox is for trying out, not for operating a service.
Declare a dummy value in the `env:` block instead.

Two cases where railsbox touches nothing: your repository versions its key (it
is then kept as is, as for railsbox's own demo application), or you declared
`RAILS_MASTER_KEY` in `env:` — hence named it in `env_assume_public:`, hence
accepted publishing it. To observe the original behaviour, disarm the
substitution:

```yaml
env:
  RAILSBOX_KEEP_CREDENTIALS: "1"
```

> **If your `.dockerignore` excludes the key, keep that line.** Rails has
> generated one since 7.1 (`/config/master.key`), railsbox keeps your
> application's `.dockerignore`, and the throwaway pair it writes would be
> filtered out by it: the required negations are therefore appended to the
> **copy** of the file, never to yours.

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

#### Data seeded by a **migration** will not arrive

railsbox prepares the database by LOADING ITS SCHEMA (`db:create db:schema:load
db:migrate`), then seeds in a **separate process**. On an **empty**
database — every build — that task loads `db/schema.rb`, i.e. the
**structure**, then marks every migration as applied **without running a single
one**. A migration that inserts reference data (currencies, roles, categories,
countries, settings) therefore never runs, the table stays empty, and the
failure only surfaces much later — in the seeds, as an incomprehensible
validation error:

```
Validation failed: Currency XAF non supporté (attendu : )   ← the list is EMPTY
```

Analysis now says so **before** the build, naming the files:

```
- [data-bearing-migration] 1 migration écrit des données (execute d'un INSERT SQL) :
  db/migrate/20260514210000_create_currencies.rb. […]
```

**This is not a railsbox limitation, it is an application defect**, and that is
why railsbox does not silently paper over it: `db/schema.rb` does not carry
those rows, so **any** environment rebuilt from the schema gets the same empty
table — a `rails db:setup` on a fresh machine, a CI database, a review app.
railsbox always starts from an empty database: it does not create the failure,
it **reveals** it. The lasting fix is a move: reference data belongs in
`db/seeds.rb`, not in a migration.

That leaves the maintainer who wants to publish a demo **now**, without touching
the application. One key, explicit opt-in:

```yaml
database_prepare: migrate # instead of loading the schema: db:create db:migrate
```

It replays the **whole** migration history on every build. What it costs, and
what analysis restates as a warning: it is slower, it can fail on an old
migration that no longer runs under a recent Rails (with no fallback — an
explicit choice must fail loudly), and it fixes **the sandbox only**: the
application stays broken everywhere else.

#### Several declared databases: the fallback is **automatic**

An application may declare several databases under one environment key. That is
the shape `solid_cache` and `solid_cable` produce, hence the shape of many
Rails 8 applications:

```yaml
production:
  primary: &primary_production
    <<: *default
  cache:
    <<: *primary_production
  cable:
    <<: *primary_production
```

`db:schema:load` then demands one schema file **per database**: `db/schema.rb`
for `primary`, then `db/cache_schema.rb` and `db/cable_schema.rb`. Those schemas
are almost never versioned — migrations are what create those tables. So the
build used to stop on a Rails message that never names railsbox, and that reads
like a defect in the application:

```
/app/db/cache_schema.rb doesn't exist yet. Run `bin/rails db:migrate` to create it, then try again.
```

railsbox now records the missing schemas and takes, by itself, the route Rails
recommends — naming it:

```
- [prepare-schemas-incomplets] config/database.yml declares several databases, and
  one versioned schema is missing (db/cache_schema.rb, db/cable_schema.rb): […]
```

Nothing to write in `railsbox.yml`. A database carrying `schema_dump: false` is
not counted — Rails expects no file for it. And when every secondary schema is
versioned, loading the schema stays the normal route: this fallback only costs
build time to those who need it.

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

#### The three mechanisms auto-login can open

`auto_login` does not guess: it writes the session where the application will
read it, and it knows only three places.

| Mechanism | Recognised by | What railsbox writes |
| --- | --- | --- |
| **Warden (Devise)** | the `devise` or `warden` gem | `warden.set_user`, in the right scope |
| **Database session + signed cookie** | a `Session` model **and** a read of `cookies.signed[:session_id]` | a `Session` record, then the signed cookie |
| **Rack session** | a `session[:user_id]` write in the controllers | `env["rack.session"][:user_id]` |

The second is what `bin/rails generate authentication` produces — Rails 8's
**built-in** authentication, hence that of most new applications. It is
recognised by the **cookie read**, never by the model name alone: `Session` is a
common domain name (a class, a coaching slot), and creating a stray record in a
demo's database would be worse than doing nothing.

**Outside those three cases, the analysis warns you** — the
`[auto-login-mecanisme-inconnu]` diagnostic, non-blocking. That is the important
part: without it, auto-login ran, found the user, wrote a session the
application never read, and the visitor arrived signed out **with no error
raised at all** — no red build, no line in the log. That silence cost far more
than the missing mechanism.

The analysis report now states the mechanism it settled on as soon as auto-login
is requested:

```
Auto-login        : demo@example.com
Authentification  : session en base + cookie signé (générateur Rails 8)
```

For everything else — tokens, Rodauth, a hand-rolled stack — `auto_login_code`
remains the way out: the fragment receives `env` and does whatever your
application expects. Declaring it silences the diagnostic, since you then know
better than railsbox where the session belongs.

> **If you iterate locally, clear the cookie jar between attempts.** Auto-login
> is attempted **only once per visitor** — otherwise it would sign back in
> anyone who just signed out, and the demo could never show its own sign-in
> screen. The marker is a cookie, and the proxy keeps it in an origin-scoped
> `railsbox-cookies` IndexedDB database. Rebuilding the sandbox does not clear
> it: your new configuration will look ineffective when in fact it was never
> tried. From the browser console:
>
> ```js
> indexedDB.deleteDatabase("railsbox-cookies");
> ```
>
> A visitor discovering a published sandbox is never affected — they arrive
> without a marker. The trap is reserved for whoever tests several builds at
> the same address.

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

#### Bootstrapping a showcase repository in one command

The workflow **creates nothing**: it pushes. Its token only has rights on the
current repository, so it can neither create the showcase repository, nor add a
key to it, nor write itself a secret. Those steps are yours — and two of them
fail **silently**:

- a showcase repository created **with** a README keeps `main` as its default
  branch, and the repository page will stay blank to visitors: what it renders
  is the README of the default branch, never the one on `gh-pages`;
- GitHub Pages pointed at `main` (empty) serves a **404 with no message at
  all**, neither in Actions nor in the settings.

A script chains them, from your machine, with your `gh` authentication — no
extra token to create, and the private key it generates is wiped when it exits.
It does not require a railsbox clone:

```sh
curl -fsSL -o amorcer-vitrine.sh https://raw.githubusercontent.com/pinfada/railsbox/main/tools/amorcer-vitrine.sh
sh amorcer-vitrine.sh <owner/source-repo> <owner/showcase-repo>
```

(From a clone of the repository, `sh tools/amorcer-vitrine.sh …` does exactly
the same thing.) No `curl … | sh` though: the script reads a confirmation on
standard input, which the pipe has already taken — and running a remote script
sight unseen is not a reflex worth installing here.

It creates the showcase empty, generates a dedicated key pair, installs the
public one as a write deploy key and the private one as the `PUBLISH_KEY`
secret, pushes a placeholder `gh-pages` branch and **turns GitHub Pages on for
it** — so there is nothing to enable after the first build — then prints the
workflow to paste. It **refuses rather than guesses**, and it refuses **before**
creating anything: unauthenticated `gh`, a source repository that is unreachable
or that you do not administer, a showcase aimed at someone else's personal
account, an organisation that forbids public repositories, an existing showcase
you do not administer or that is not public. An **already-bootstrapped**
showcase does not stop it: it resumes where it left off, and leaves an existing
`gh-pages` branch untouched — pushing the placeholder there would wipe a live
demo.

An existing bootstrap can be checked without changing anything, with the
`--verifier <source-repo> <showcase-repo>` mode: it reads back the deploy key,
the secret, the default branch and the state of Pages, and reports what is
missing.

The artifacts the build publishes — application disk and memory snapshot — carry
the **fingerprint of their content** in their name
(`disks/my-app-a1b2c3d4e5f6.ext2.zst`,
[ADR 0007](docs/decisions/0007-versionnement-des-artefacts-par-empreinte.md)).
A URL therefore never designates two different contents, and no cache — browser,
CDN, Service Worker — can serve back a chunk from another build. The base rootfs
keeps its revision-based name: it is shared across every sandbox, and a
fingerprint would break that sharing.

Three guardrails refuse outright rather than publish a demo that would fail to
load: a missing **chunk inventory** (`-parts.json`) for the application disk or
the snapshot, which means a splitting step was skipped; a file beyond GitHub
Pages' **95 MB per-file limit**; and an application whose amd64 stage produces
**no** assets at all (an application with no CSS is a failure the visitor would
discover when the page renders).

The second can no longer be a VM artifact: rootfs, application disk **and memory
snapshot** are all split into 4 MiB chunks
([ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)). A file still
over the limit therefore comes from the application, and the message says so —
there is nothing to split, there is something to trim.

That third split is recent, and it has a history. The snapshot was published as a
single file because nothing forced otherwise: gzipped, the demo's weighs 76 MB.
The host's limit had therefore quietly become **a ceiling on usable memory** — a
heavier application (PostgreSQL, Rails 7.1, an admin back end) produces a 118 MB
snapshot, and the build failed on the last minute of twenty.

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
image](developpement.en.md#republishing-the-base-image)".

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
