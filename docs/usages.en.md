# Who this is for

The profiles railsbox answers, and what it deliberately is not.

*Retour au [README](../README.en.md).*

---

**Ruby/Rails open source maintainers.** Your README shows code; it does not show
your application. The "Try with railsbox" badge gives anyone reading your project
a playable instance in one click — seeded with demo data, already signed in, with
nothing to install and no account to create. The link never goes down and costs
nothing, because there is no server behind it.

**B2B SaaS founders and product builders.** A permanent product demo with zero
infrastructure: you choose what the visitor sees (`seed`), they land already
authenticated (`auto_login` opens a session — a token-authenticated front end
needs [the JWT
recipe](spa.en.md)), and the
bill stays at zero on the day your link hits Hacker News. The non-negotiable trade-off: **nothing real may be shipped
inside** — no live Stripe key, no OAuth credentials, no dump containing customer
data. Everything that goes into a sandbox is public (see
[`SECURITY.md`](../SECURITY.md)).

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
  "[Known limits](compatibilite.en.md#known-limits)".

These refusals are **deliberate**. They are shortcomings if you compare railsbox
to a hosting provider, and properties once you accept the framing: a sandbox has
nothing to protect server-side, because there is no server.

---
