# Compatibility

What railsbox supports, what it refuses explicitly, and the limits that follow from its model.

*Retour au [README](../README.en.md).*

---

## What is supported

| | Status |
| --- | --- |
| **SQLite** | validated end to end: `rails new` + Propshaft + importmap, published and booting online |
| **PostgreSQL** | supported on the split base/app path, from base `3.3-r2` onward (the workflow default) |
| **MySQL / MariaDB** | not supported: the build stops with an explicit report |
| **importmap, Propshaft, Sprockets** | precompiled inside the i386 disk |
| **Tailwind, dart-sass** | precompiled on an amd64 stage, copied into the i386 disk |
| **npm toolchains** (esbuild, cssbundling, jsbundling) | same amd64 stage: install, then your build scripts |
| **pnpm** | supported through Corepack, provided `package.json` declares `packageManager` — Corepack reads the version itself; railsbox only extracts a validated identifier |
| **Redis, Sidekiq** | detected from `Gemfile.lock`, present in the base image |

## Known limits

| Limit | Status |
| --- | --- |
| **PostgreSQL** | **wired up** on the split path: the server lives in the base image (from revision `3.3-r2`), the data directory on the application disk, and the cluster only starts after that disk is mounted. Requires base `3.3-r2` or newer — the build explicitly refuses an older base. See "[PostgreSQL](configuration.en.md#postgresql)". |
| **Tailwind, dart-sass** | **supported**: precompiled on an amd64 stage, then copied into the i386 disk (the guest never runs those binaries). Tailwind is validated **end to end** — `demo-tailwind` variant, real v86 VM boot, compiled stylesheet served by the guest — and replayed by the [`valider-variantes.yml`](../.github/workflows/valider-variantes.yml) workflow. dart-sass now has its own test bench (`demo-dartsass`), stricter still: `sass-embedded` ships no i386 binary at all, where `tailwindcss-ruby` still offers a `ruby` variant. |
| **npm toolchains** (esbuild, cssbundling) | **supported** by the same stage (`npm ci` then build scripts). **pnpm** is recognised when `packageManager` declares it; a pnpm lockfile WITHOUT that key falls back to npm, with a warning. yarn and bun are **reported, not executed**: two contradictory lockfiles stop the build. |
| **Client-side SPA** (React, Vue, Svelte) | **needs an adaptation in your code** — the one railsbox cannot make for you. The application is served under `/<repo>/app/`; Rails helpers follow that prefix, your JavaScript cannot guess it. Recommended pattern, with copy-pasteable code: "[Does your app ship a SPA?](spa.en.md)". |
| **ActionCable / WebSockets** | out of scope: incompatible with a request/response bridge. Possible route: long-polling or a dedicated stream. |
| **Outbound networking** | nonexistent. That is also a property of the demo model — see [`SECURITY.md`](../SECURITY.md). |
| **Bridge throughput** | a narrow, shared pipe; fine for Turbo/HTML. Precompiled assets do not use it: extracted from the image, they are served statically by the Service Worker. |
| **Persistence** | none, by design. Every visitor writes to their own copy, which disappears with the tab. |
