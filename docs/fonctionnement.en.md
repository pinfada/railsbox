# How railsbox works

The execution model, the path of a request, artifact caching and the repository map. For the CODE map, see [architecture.md](architecture.md).

*Back to the [README](../README.en.md).*

---

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
| What is cached | the part-files of the split disks **and of the snapshot**, the kernel, the initrd — **and nothing beyond what the v86 configuration names** |
| What is not | a snapshot published as a single file (a sandbox built before the split), which the page caches in IndexedDB anyway; a disk read via `Range` requests, whose 206 responses Cache Storage rejects; any request carrying a `Range` header |
| Cache name | derived from the whole configuration, `builtAt` included. A configuration change switches to a fresh cache and deletes the old one. The rule came from application disk URLs being **stable across builds**; since [ADR 0007](docs/decisions/0007-versionnement-des-artefacts-par-empreinte.md) they carry a content fingerprint, but it still protects sandboxes published before it. |
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
