# Publishing from a private repository

Pages does not serve a private repository on a free account, and says so nowhere. The two ways out, seeding a showcase repository, and what it costs.

*Retour au [README](../README.en.md).*

---


On a public repository the three steps above are enough and everything is free:
Actions and Pages both are. On a private repository they are not enough — and
the failure is the kind you spend an evening on: the build passes, `gh-pages` is
pushed, the Actions tab stays green, and **there is no page**. GitHub Pages does
not serve a private repository on a free account, and it says so nowhere. That
is exactly what happened to the first private repository installed with the
public workflow: never a page, never a message.

Two ways out, only one of them free:

- **Pro, Team or Enterprise plan**: Pages does work from a private repository,
  and the public workflow above works as is. Note what it publishes: **the site
  itself is public** — only the code stays private. Actions minutes are still
  billed.
- **Any plan, free included**: the code stays private and the sandbox is
  published to a dedicated **public showcase repository**. This is the
  recommended path, and the only free one.

The rest of this section describes the second one.

## 1. Bootstrap the showcase

The workflow **creates nothing**: it pushes. Its token only has rights on the
current repository, so it can neither create the showcase repository, nor add a
key to it, nor write itself a secret. A script performs those steps from your
machine, with your `gh` authentication — no extra token to create, and the
private key it generates is wiped when it exits:

```sh
curl -fsSL -o amorcer-vitrine.sh https://raw.githubusercontent.com/pinfada/railsbox/main/tools/amorcer-vitrine.sh
sh amorcer-vitrine.sh <account>/<source-repo> <account>/<showcase-repo>
```

Two lines, and no `curl … | sh`: the script asks you to confirm **on standard
input**, which the pipe has already taken — it would either run without waiting
for you or refuse to read. And on a project that spells out what it does not
protect, swallowing a remote script sight unseen would be a poor signal on top.
Download it, read it if you like, then run it.

It creates the showcase **empty** (ticking "Add a README" at creation time would
be enough to keep `main` as the default branch, and the repository page would
stay blank to visitors), generates a dedicated key pair, installs the public one
as a write deploy key on the showcase and the private one as the `PUBLISH_KEY`
secret on your repository, pushes a placeholder `gh-pages` branch and **turns
GitHub Pages on for it right away** — so there is nothing to enable after the
first build. It **refuses rather than guesses**, and it refuses **before**
creating anything: unauthenticated `gh`, a source repository that is unreachable
or that you do not administer, a showcase aimed at someone else's personal
account, an organisation that forbids public repositories, an existing showcase
you do not administer or that is not public. An **already-bootstrapped**
showcase, on the other hand, does not stop it: it resumes where it left off, and
never touches an existing `gh-pages` branch — that would wipe a live demo.

An existing bootstrap can be checked without changing anything:
`sh amorcer-vitrine.sh --verifier <account>/<source-repo> <account>/<showcase-repo>`.

## 2. Paste this workflow

```yaml
name: Sandbox railsbox

on:
  workflow_dispatch: # ← on demand: see "The cost" below
  # push:
  #   branches: [main]

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
    with:
      target-repo: <account>/<showcase-repo>
    secrets:
      publish-key: ${{ secrets.PUBLISH_KEY }}
```

`target-repo` says where to publish, `publish-key` is the write key the script
installed: the workflow token is only valid for the current repository, it
cannot write anywhere else. Without that secret, the build stops when it comes
time to publish. The demo will be served at
`https://<account>.github.io/<showcase-repo>/`, and that is the URL your badge
points to.

## The cost

On a private repository, Actions minutes are **billed**, and one railsbox build
burns about **9** of them. With `on: push` that is nine minutes on every push to
your default branch — including the commits that change nothing about what the
demo shows. Hence the bare `workflow_dispatch` above: on a private repository,
republish when you have something new to show, not on every `git push`.
Uncomment the `push:` knowing what it costs.
