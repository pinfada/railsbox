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
| Downloaded to get there | ~32 MB from the artifact repository + the snapshot, in gzipped 4 MiB chunks (76 MB for the demo) |
| Navigation, forms, POSTs | normal, served by the VM |

While the visitor waits, a status bar names the current step and counts the
seconds ("Step 5/5 · First page rendered by the VM · 31 s"). It exists because
CPU-throttled measurement demanded it: the final phase — between all-green
badges and the first painted page — takes 1 s on a desktop but up to 14 s on a
slow device, with nothing to tell "almost there" from "stuck".

The 1.45 GB shared rootfs is never downloaded whole: v86 reads only the chunks
it touches, around thirty out of 363. And it reads them only once — the Service
Worker keeps them in Cache Storage, so a returning visitor downloads nothing
(see "[Artifact caching](docs/fonctionnement.en.md#artifact-caching)").

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
recipe](docs/spa.en.md)), and the
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
| **PostgreSQL** | **wired up** on the split path: the server lives in the base image (from revision `3.3-r2`), the data directory on the application disk, and the cluster only starts after that disk is mounted. Requires base `3.3-r2` or newer — the build explicitly refuses an older base. See "[PostgreSQL](docs/configuration.en.md#postgresql)". |
| **Tailwind, dart-sass** | **supported**: precompiled on an amd64 stage, then copied into the i386 disk (the guest never runs those binaries). Tailwind is validated **end to end** — `demo-tailwind` variant, real v86 VM boot, compiled stylesheet served by the guest — and replayed by the [`valider-variantes.yml`](.github/workflows/valider-variantes.yml) workflow. dart-sass now has its own test bench (`demo-dartsass`), stricter still: `sass-embedded` ships no i386 binary at all, where `tailwindcss-ruby` still offers a `ruby` variant. |
| **npm toolchains** (esbuild, cssbundling) | **supported** by the same stage (`npm ci` then build scripts). A yarn/pnpm/bun lockfile is not read: it falls back to `npm install`, with a warning. |
| **Client-side SPA** (React, Vue, Svelte) | **needs an adaptation in your code** — the one railsbox cannot make for you. The application is served under `/<repo>/app/`; Rails helpers follow that prefix, your JavaScript cannot guess it. Recommended pattern, with copy-pasteable code: "[Does your app ship a SPA?](docs/spa.en.md)". |
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

---

## Who uses it

**They use it, and said so** — this list is hand-kept, through pull requests.
It is the **only** way to appear here from a private repository: no automatic
detection will ever see one.

<!-- Add yourself: one line, alphabetical order. -->
<!-- - [Name](https://example.org) — what you showcase · [the demo](https://…) -->

_Nobody yet. If railsbox is useful to you, open a pull request: it is the only
feedback this project gets._

**Public** sandboxes are detected automatically and listed in
[docs/adoption.md](docs/adoption.md), regenerated weekly alongside traffic
figures *(French)*. That page also states, explicitly, what it cannot measure:
a private repository using railsbox is invisible — no server, no account, no
telemetry. That is the model, not a tooling gap.

---

## Going further

The rest of the documentation is split by topic — each page reads on its own.

| Page | What you'll find |
| --- | --- |
| **[Configuration](docs/configuration.en.md)** | `railsbox.yml`, workflow inputs, PostgreSQL, seeds, auto-login, system packages |
| **[SPA applications](docs/spa.en.md)** | React/Vue/Vite under a URL prefix, token auto-login |
| **[Assets](docs/assets.en.md)** | Tailwind, dart-sass, npm chains: why an amd64 stage |
| **[How it works](docs/fonctionnement.en.md)** | execution model, request path, artifact cache, repositories |
| **[Development](docs/developpement.en.md)** | testing locally, republishing the base, building by hand, layout |
| **[War stories](docs/retour-experience.en.md)** | the problems that cost the most — the project's memory |
| **[Code architecture](docs/architecture.md)** | where to start reading the 17,000 lines *(French)* |
| **[Decisions (ADR)](docs/decisions/)** | why the structural choices were made *(French)* |
| **[Threat model](SECURITY.md)** | what is protected, what is not *(French)* |
| **[Contributing](CONTRIBUTING.md)** · **[Open work](docs/chantiers.md)** | how to help *(French)* |

---

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
