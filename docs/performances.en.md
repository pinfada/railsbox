# Performance

What the build costs, what a visitor downloads, and how the sandbox behaves under a throttled CPU.

*Retour au [README](../README.en.md).*

---

## What the workflow does, in ~9 minutes

It reassembles the shared rootfs from the railsbox artifact repository, builds
your application disk from the base image, runs your seeds, captures a
post-boot memory snapshot, splits everything into compressed chunks and
publishes the shell alongside it. **Your repository hosts about 130 MB** for the demo application — expect
~150–350 MB for yours; the
1.45 GB rootfs stays on the railsbox side.

Tailwind, dart-sass and npm toolchains need no declaration: detection spots them
and switches asset precompilation to an amd64 stage on its own. The build
summary reports the stage it picked, the Ruby version and the detected database.

## What your visitors get

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
(see "[Artifact caching](fonctionnement.en.md#artifact-caching)").

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
