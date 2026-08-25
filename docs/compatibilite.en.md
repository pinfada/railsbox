# Compatibility

What railsbox supports, what it refuses explicitly, and the limits that follow from its model.

*Retour au [README](../README.en.md).*

---

## What is supported

| | Status |
| --- | --- |
| **Ruby** | public base `3.3-r2`: Ruby 3.3.12. Ruby 3.4.3 and 4.0.3 are qualified locally on complete bases, but become usable by the public workflow only after those bases are published and registered. |
| **SQLite** | validated end to end: `rails new` + Propshaft + importmap, published and booting online |
| **PostgreSQL** | supported on the split base/app path, from base `3.3-r2` onward (the workflow default) |
| **MySQL / MariaDB** | not supported: the build stops with an explicit report |
| **importmap, Propshaft, Sprockets** | precompiled inside the i386 disk, or on the amd64 stage when Terser/ExecJS needs a JavaScript runtime |
| **Tailwind, dart-sass** | precompiled on an amd64 stage, copied into the i386 disk |
| **npm toolchains** (esbuild, cssbundling, jsbundling) | same amd64 stage: install, then your build scripts. Node 22 remains the default; Node 24 is selected when required by `package.json#engines.node`. |
| **pnpm** | supported through Corepack, provided `package.json` declares `packageManager` — Corepack reads the version itself; railsbox only extracts a validated identifier |
| **Bun** | supported on the 1.4 series when `bun.lock` or `bun.lockb` is present, with a frozen lockfile install |
| **Redis, Sidekiq** | detected from `Gemfile.lock`, present in the base image |
| **Active Storage** | uses a generated local Disk service inside the networkless sandbox; `RAILSBOX_KEEP_ACTIVE_STORAGE_SERVICE=1` restores the original service for diagnostics |

## Known limits

| Limit | Status |
| --- | --- |
| **PostgreSQL** | **wired up** on the split path: the server lives in the base image (from revision `3.3-r2`), the data directory on the application disk, and the cluster only starts after that disk is mounted. Requires base `3.3-r2` or newer — the build explicitly refuses an older base. See "[PostgreSQL](configuration.en.md#postgresql)". |
| **Tailwind, dart-sass** | **supported**: precompiled on an amd64 stage, then copied into the i386 disk (the guest never runs those binaries). Tailwind is validated **end to end** — `demo-tailwind` variant, real v86 VM boot, compiled stylesheet served by the guest — and replayed by the [`valider-variantes.yml`](../.github/workflows/valider-variantes.yml) workflow. dart-sass now has its own test bench (`demo-dartsass`), stricter still: `sass-embedded` ships no i386 binary at all, where `tailwindcss-ruby` still offers a `ruby` variant. |
| **Front-end toolchains** (esbuild, cssbundling) | **supported** on the amd64 stage. npm reads its lockfile; **pnpm** is recognised when `packageManager` declares it; **Yarn** distinguishes Classic (`--frozen-lockfile`) from Berry (`--immutable`); **Bun 1.4** reads `bun.lock` and `bun.lockb` with `--frozen-lockfile`. Two contradictory lockfile families stop the build. |
| **Client-side SPA** (React, Vue, Svelte) | **needs an adaptation in your code** — the one railsbox cannot make for you. The application is served under `/<repo>/app/`; Rails helpers follow that prefix, your JavaScript cannot guess it. Recommended pattern, with copy-pasteable code: "[Does your app ship a SPA?](spa.en.md)". |
| **ActionCable / WebSockets** | out of scope: incompatible with a request/response bridge. Possible route: long-polling or a dedicated stream. |
| **Outbound networking** | nonexistent. That is also a property of the demo model — see [`SECURITY.md`](../SECURITY.md). |
| **Bridge throughput** | a narrow, shared pipe; fine for Turbo/HTML. Precompiled assets do not use it: extracted from the image, they are served statically by the Service Worker. |
| **Persistence** | none, by design. Every visitor writes to their own copy, which disappears with the tab. |

## What the real-application qualification campaign proved

RailsBox does not treat a successful boot as sufficient evidence. RailSmart,
Ember Vault, Hackatime, if-me, Human Essentials and CASA were used as qualification
candidates without modifying their repositories. Together they exercised Rails
8, Ruby 4.0, Node 24, Warden/Devise, SQLite and multi-database PostgreSQL, Sprockets/importmap,
Active Storage, Terser/ExecJS, prefixed routes and large seed datasets.

The largest case so far, Human Essentials, produced 167 assets and 16,017
records across two PostgreSQL databases. Its application disk uses 306 MB out
of 512 MB, leaving 199 MB of actual free space. The first v86 boot took 266 s;
restoring the validated delta returned HTTP 200 under the real public prefix in
22 s.

CASA validated Rails 8.0.5.1 on Ruby 4.0.3, an npm/Tailwind toolchain on Node
24, and PostgreSQL. Its disk contains 1,164 records and 367 MB of data out of
512 MB. After a 262 s cold boot, its delta restores and responds in Chromium in
20.2 s; rendering, navigation and assets pass all four end-to-end checks.

Redmine `849a116` was also a useful negative test: its PostgreSQL build succeeds
(184 records, 230 MB application disk), but its server was still not listening
after ten minutes in v86. It is therefore not counted as validated. The attempt
did generalise `.txt` licence detection, multi-database Gemfiles, Ruby ranges,
and RailsBox-provided Puma.

This campaign demonstrates broad compatibility with conventional Rails
monoliths; it is not statistical proof of “all” or “most” Rails applications.
The guaranteed envelope still excludes MySQL/MariaDB, WebSockets, mandatory
outbound networking, SPAs pinned to `/`, Ruby versions without a published base,
and applications that cannot fit on the disk with the runtime safety margin.
