# Where assets are precompiled

Why some build chains go through an amd64 stage, and what that means for your application.

*Back to the [README](../README.en.md).*

---

## Where assets are precompiled

The guest is **i386**, and several families of asset tools have no usable binary
or runtime there: gems with a precompiled executable (`tailwindcss-ruby`, which
tailwindcss-rails depends on, and `dartsass-ruby`), ExecJS wrappers such as
`terser`, and npm toolchains (esbuild, sass). Yet they produce **ordinary** CSS
and JS, independent of the architecture
— so they run on an **amd64 stage**, and the i386 disk receives only
`public/assets`. The guest never executes those binaries.

Auto-detection classifies each application on its own:

| What it finds | Stage picked | What runs |
| --- | --- | --- |
| propshaft/sprockets + importmap | `i386` | `assets:precompile` inside the application disk |
| tailwindcss-rails, dartsass-rails, terser | `amd64` | `assets:precompile` on the host with Node, then `public/assets` is copied |
| `package.json` (jsbundling/cssbundling) | `amd64` | locked npm, pnpm, Yarn or Bun install + build scripts, then `assets:precompile` |
| no pipeline | `aucun` (none) | nothing |

The amd64 stage sets exactly the same `RAILS_RELATIVE_URL_ROOT` as the
application disk, so URLs baked into CSS carry the **full public prefix**
(`/repo/app/assets/…`), under the site and not at the domain root — otherwise the
Service Worker could not even catch them.

The amd64 stage explicitly selects Node for ExecJS. It also carries an inert
`bun` placeholder so the Docker stage keeps a stable shape when Bun is unused;
without the explicit runtime, ExecJS could mistake that placeholder for a valid
engine and fail during minification without a useful message.

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

Two warnings rather than a refusal: without a recognised lockfile, installation
falls back to `npm install` and the build is no longer reproducible — the
analysis report says so. `bun.lock` and `bun.lockb` select Bun 1.4 with
`--frozen-lockfile`; pnpm and Yarn keep the version rules documented on the
compatibility page. And if the amd64 stage produces **no** asset at all, the
build stops there.

Front-end sources supplied by a gem are generated before the bundler runs.
RailsBox notably recognises `js_from_routes` and invokes its standard task with
`JS_FROM_ROUTES_FORCE=true`; no arbitrary repository command is interpolated.

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
