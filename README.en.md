# railsbox

*Version française → [README.md](README.md)*

[![Try with railsbox](https://pinfada.github.io/railsbox-demo/badge.svg)](https://pinfada.github.io/railsbox-demo/)

**railsbox turns a Rails application into a playable in-browser demo.** You drop
a GitHub Actions workflow into your repository and get a public URL where Puma,
the database and your native C gems run inside an emulated x86 Linux VM — no
server, no container, no bill.

**Try it now → [pinfada.github.io/railsbox-demo](https://pinfada.github.io/railsbox-demo/)**

Real-world example: [Zealot 6.2.2 running in railsbox](https://pinfada.github.io/zealot/) —
unofficial demonstration, application source unchanged.

|                          |                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Real Rails**           | your unmodified application: Puma, PostgreSQL or SQLite, your native gems, migrations and seeds        |
| **In the browser**       | everything runs in the visitor's tab, and each visitor gets their own disposable instance              |
| **No permanent server**  | static hosting is enough; the link never goes down and costs nothing                                   |

---

## I want to…

| I want to…                                     | Go to                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Try railsbox                                   | **[the demo](https://pinfada.github.io/railsbox-demo/)**                                                       |
| Publish my open-source application             | **[Get started in 5 minutes](#get-started-in-5-minutes)** below                                                |
| Publish from a private repository              | **[Private repository guide](docs/depot-prive.en.md)**                                                         |
| Check whether my application is compatible     | **[Compatibility](docs/compatibilite.en.md)**                                                                  |
| Configure PostgreSQL, seeds or assets          | **[Configuration](docs/configuration.en.md)**                                                                  |
| Understand the limits and the security model   | **[Threat model](SECURITY.md)**                                                                                |
| Know what loading costs                        | **[Performance](docs/performances.en.md)**                                                                     |
| Ask a question                                 | **[Discussions · Q&A](https://github.com/pinfada/railsbox/discussions/categories/q-a)**                        |
| Show my sandbox                                | **[Discussions · Show and tell](https://github.com/pinfada/railsbox/discussions/categories/show-and-tell)**    |
| Contribute                                     | **[Contributing guide](CONTRIBUTING.md)**                                                                      |

---

## Get started in 5 minutes

### 1. Add the workflow

In your Rails repository, create `.github/workflows/sandbox.yml`:

```yaml
name: railsbox sandbox
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

The railsbox repository is public: any repository can reference this workflow.

> **Check the `branches:` line.** A filter that does not name your default
> branch never triggers anything, and **GitHub does not tell you** — the workflow
> simply looks absent. When in doubt, run the first build manually (_Run
> workflow_ button).

> **`@main` moves.** For a demo you show to other people, pin a release:
> `…/construire-sandbox.yml@v2.3.0`
> ([all releases](https://github.com/pinfada/railsbox/releases)). The version in use is printed on the first
> line of every sandbox boot log — it is the first thing you will be asked for if
> you report a problem.

> **Is your repository private?** On a free account, GitHub Pages does not serve
> private repositories. The workflow warns you and offers publication to a public
> showcase repository — see the **[private repository
> guide](docs/depot-prive.en.md)**.

### 2. Enable GitHub Pages on the `gh-pages` branch

Push first: the initial build is what **creates** `gh-pages`.

_Settings → Pages → Source: Deploy from a branch → `gh-pages` / `(root)`._
Every build republishes your demo at `https://<account>.github.io/<repo>/`.

> **`gh-pages` is entirely replaced on every build.** If you already publish
> something else there, publish the sandbox elsewhere with the `target-repo`
> input (see "[Workflow inputs](docs/configuration.en.md)").

### 3. Paste the badge

```markdown
[![Try with railsbox](https://<account>.github.io/<repo>/badge.svg)](https://<account>.github.io/<repo>/)
```

The workflow prints this badge, filled in with your URLs, in the summary of
every build. It is served by your own sandbox, not by a third-party generator.

> **You paste it yourself, and that is deliberate.** railsbox NEVER writes to
> your default branch: it only pushes to `gh-pages`.

Budget **~9 minutes** per build and **~150–350 MB** hosted in your repository,
depending on your application. Details in
"[Performance](docs/performances.en.md)".

---

## Compatibility at a glance

|                        |                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| **Ruby**               | 3.3.12 (provided by base `3.3-r2`, not configurable)                                                |
| **Databases**          | SQLite and PostgreSQL; MySQL/MariaDB refused with an explicit report                                |
| **Front-end managers** | npm, pnpm and yarn through Corepack; bun is reported, not executed                                  |
| **Assets**             | importmap, Propshaft, Sprockets, Tailwind, dart-sass, npm chains (esbuild, cssbundling, jsbundling) |
| **Not supported**      | outbound network, ActionCable and WebSockets                                                        |

The details, the base revisions, and what requires a change on your side:
"[Compatibility](docs/compatibilite.en.md)".

---

## Essential limits

- **The whole artefact is public.** The disk image and the memory snapshot are
  downloadable by anyone, and the visitor is root inside their VM. Never ship
  real secrets or real data ([`SECURITY.md`](SECURITY.md)).
- **Startup time varies.** Around 20–25 s for the reference demo; up to 78 s
  measured on the Zealot application, depending on snapshot size, network and
  CPU. Startup does not break, it stretches.
- **No outbound network.** A gem that calls a remote service at boot will fail;
  the analysis reports it before the build.
- **No shared persistence.** Every visitor writes to their own copy, which
  disappears with the tab. `F5` resets everything.
- **This is not production hosting.** railsbox exists to _show and let people
  try_, never to _operate_.

---

## Documentation and community

| Page                                                                                | What you will find                                                             |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **[Configuration](docs/configuration.en.md)**                                          | `railsbox.yml`, workflow inputs, PostgreSQL, seeds, auto-login, system packages   |
| **[Compatibility](docs/compatibilite.en.md)**                                          | what works, what is refused, the limits of the model                              |
| **[Performance](docs/performances.en.md)**                                             | what a visitor downloads, per-engine and throttled-CPU measurements               |
| **[Private repository](docs/depot-prive.en.md)**                                       | showcase repository, deploy key, cost of Actions minutes                          |
| **[Who this is for](docs/usages.en.md)**                                               | the profiles railsbox answers, and what it is not                                 |
| **[SPA applications](docs/spa.en.md)**                                                 | React/Vue/Vite under a URL prefix, token-based auto-login                          |
| **[Assets](docs/assets.en.md)**                                                        | Tailwind, dart-sass, npm chains: why an amd64 stage                               |
| **[How it works](docs/fonctionnement.en.md)**                                          | execution model, the path of a request, the artefact cache                        |
| **[Development](docs/developpement.en.md)**                                            | testing locally, republishing the base, building by hand                          |
| **[Field notes](docs/retour-experience.en.md)**                                        | the challenges solved — the project's memory                                      |
| **[Decisions (ADR)](docs/decisions/)**                                                 | why the structural choices were made                                              |
| **[Threat model](SECURITY.md)**                                                        | what is protected, what is not                                                    |
| **[Contributing](CONTRIBUTING.md)**                                                    | how to help
| **[Code of Conduct](CODE_OF_CONDUCT.en.md)**                                            | what is expected of everyone in the project's spaces                                                                       |

**[Q&A](https://github.com/pinfada/railsbox/discussions/categories/q-a)** for a
question,
**[Show and tell](https://github.com/pinfada/railsbox/discussions/categories/show-and-tell)**
to show a sandbox. Report a vulnerability privately (Security tab), never
through a public issue — see [`SECURITY.md`](SECURITY.md).

---

## Third-party licences

railsbox is MIT-licensed ([`LICENSE`](LICENSE)). It vendors the
[v86](https://github.com/copy/v86) emulator (BSD 2-Clause,
[`public/vendor/v86/LICENSE`](public/vendor/v86/LICENSE)) and the firmware it
ships: SeaBIOS (`seabios.bin`, LGPLv3) and the Bochs VGABIOS (`vgabios.bin`,
LGPL). The rootfs images published in `railsbox-assets` contain free software
(Linux, Ruby, Rails…) under their respective licences.
