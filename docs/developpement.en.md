# Developing and operating railsbox

Running the shell locally, republishing a base image, building by hand, and finding your way around the repository layout.

*Back to the [README](../README.en.md).*

---

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
