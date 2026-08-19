# War stories: the problems that cost the most

Problems met while building railsbox and how they were settled. None of this is needed to USE it — it is the project's memory.

*Back to the [README](../README.en.md).*

---

## War stories: the problems that cost the most

Twenty-two build iterations were needed. The obstacles were almost never where
you would expect them.

**TCP loopback did not exist under the original engine.** `bind()` on
`127.0.0.1` failed with a phantom `EADDRINUSE` because the whole TCP stack went
through Tailscale. Puma therefore listened on a **Unix socket**, entirely
internal to the emulated kernel. That is what motivated the move to v86, whose
real Linux kernel makes loopback trivial.

**The upstream channel dropped large POSTs.** The serial port has **no flow
control** in the browser → guest direction. Measured: a 32 KB POST goes through,
**128 KB is lost and wedges the channel permanently**. The fix is a chunked
protocol with per-chunk acknowledgement (1,536-byte send window), which bounds
bytes in flight whatever the buffer size.

| POST body | Before | After |
| --- | --- | --- |
| 1–32 KB | arrives | arrives |
| 128 KB | **lost**, channel dead | arrives |
| 1 MB | lost | **2.5 s** |

A welcome side effect: since the body is no longer embedded in the JSON
descriptor that itself gets re-encoded, the payload loses **77%** of its bloat.

**The channel is half-duplex, and it shows.** A large response in flight
monopolises the guest's write side, so an upstream chunk acknowledgement queues
behind it. The same 4 KB POST takes **105 s** while assets load, versus under a
second on an idle channel. The acknowledgement timeout is therefore aligned with
a full request timeout — a short value wrongly failed every POST concurrent with
a download.

**Only one writer on the serial port.** A `tail -F` added for telemetry wrote
concurrently with the daemon: its lines interleaved with the frames and
**corrupted large transfers** (a 270 KB stylesheet arrived unreadable).
Application logs are now relayed by the daemon itself, under its lock.

**The guest clock drifts constantly.** Expected after a snapshot restore (the
kernel resumes at capture time), but measurement showed worse: under load, the
guest falls **up to 20 s behind every 5 s**. Without periodic resynchronisation,
session cookies and CSRF tokens expire on their own mid-session.

**`RAILS_RELATIVE_URL_ROOT` only prefixes assets.**

| Helper | Generated URL |
| --- | --- |
| `stylesheet_link_tag` | `/app/assets/tailwind-…` ✅ |
| `link_to`, `form_with` | `/gymhouses` ❌ escapes the proxy |

Route helpers read Rack's `SCRIPT_NAME`, which is empty when Puma serves at the
root. The fix is standard sub-URI deployment: a `config.ru` provided by the image
mounts the application through `Rack::URLMap`, **without touching application
code**. Found by clicking a link — not by watching the home page render.

**Five memory-snapshot traps.**

| Trap | Treatment |
| --- | --- |
| Clock freeze | `TIME` frame + `date -s` beyond 2 s of drift |
| Memory leak — `URL.createObjectURL` on 650 MB is never released | removed at the root: v86 accepts `initial_state: { buffer }` |
| 13-minute cold boot for the user | snapshot generated in CI, shipped compressed, downloaded when the local cache is empty |
| Published as one file, it hit Pages' 95 MB per-file limit | split into gzipped 4 MiB chunks, like the disks, and reassembled by the shell (see below) |
| v86 emits **one JS event per byte** (369,282 for the stylesheet) | pre-allocated `Uint8Array` assembler: **24 ns/byte**, 8.9 ms for 270 KB |

**Splitting the snapshot: before or after compression?** The disks have been
split since [ADR 0003](docs/decisions/0003-artefacts-en-fichiers-parties.md)
because **v86 can read chunks on its own**. The snapshot cannot: the shell
downloads it and hands v86 an `ArrayBuffer`. Splitting it meant writing the
reassembly ourselves — so the format was ours to choose. Two options, settled by
measurement on the demo's snapshot (273 MB raw):

| Strategy | Published | Ratio | Chunks |
| --- | --- | --- | --- |
| single gzip file (before) | 79,819,683 B | 27.86% | 1 |
| **split at 4 MiB, then gzip each chunk** | **79,843,531 B** | **27.87%** | **69** |
| split at 16 MiB, then gzip each chunk | 79,833,378 B | 27.86% | 18 |

**Splitting before compressing costs 0.03%** — 23,848 bytes out of 76 MB. A
memory image has no long-range redundancy, and gzip's window was already
exploiting nothing beyond a few hundred kilobytes. The one argument for
"compress first, split the `.gz`" therefore weighs nothing, while it would cost
three things: chunk boundaries expressed in a *compressed* stream (unrelated to
the artifact, making v86's naming convention meaningless), no way to retry a
single chunk, and a single several-hundred-MB stream to pipe through at
reassembly.

Three practical consequences:

- **gzip, not zstd** — the only divergence from the disks. Those are decompressed
  by v86, which ships its own zstd decoder; the snapshot is decompressed by us,
  with `DecompressionStream`: gzip on all three engines, zstd on one.
- **One buffer, allocated once** at the size the inventory announces, with each
  chunk written at its offset. Measured in a real Chromium on the demo's
  snapshot: tab peak **834 MB** on the old path (which materialised the
  decompressed stream before copying it), **680–734 MB** on the new one — **100
  to 155 MB less**, for an unchanged boot time (19.1 s vs 19.2 s to a green HTTP
  badge).
- **The presence of the `-parts.json` inventory decides the format**, not a
  configuration field. A sandbox published before the split has none: the shell
  falls back to the single file, and nothing needs rebuilding. Both paths run
  under `npm test` (`tests/snapshot-transport.test.mjs`), on real gzipped bytes.

**A Service Worker cannot set a cookie.** `Set-Cookie` is a *forbidden*
response header on a constructed `Response`: the Fetch API drops it silently.
The proxy was relaying Rails' responses without the browser ever storing the
session cookie — the one carrying the CSRF token seed. Every request therefore
opened a fresh session, and **every POST answered 422
`InvalidAuthenticityToken`**. The demo promised "create, edit, delete a post"
and could only display.

So the proxy keeps the jar itself (`shared/cookie-jar.js`): it harvests
`Set-Cookie` from the VM's responses, stores them, and puts the `Cookie` header
back on every relayed request. The jar is persisted in IndexedDB — a Service
Worker is killed as soon as it goes idle, and losing the jar mid-visit would
sign the visitor out. `document.cookie` stays empty on the page, which is *not*
the same as putting cookies out of a script's reach: see
[`SECURITY.md`](SECURITY.md).

The jar is not the only source: the iframe being same-origin, a
`document.cookie = "timezone=…"` set by the application creates a real browser
cookie no VM response ever mentioned. A Service Worker has no DOM, so it *asks
the host page* for them (`cookies-document-request`) and appends them to the
header without ever overriding its own. That relay replaced a first attempt
built on the Cookie Store API, which existed on only one engine out of three.

A security corollary, found in review: that jar attaches the session cookie to
**every** request the Service Worker relays — and a SW handles *navigations*
into its scope whatever their initiator, not just its own clients'
subresources. A form hosted elsewhere could therefore write into the visitor's
VM. The proxy now refuses such requests with 403 — stricter than the
`SameSite=Lax` a browser would have applied on its own.

A second lesson, measured afterwards: that refusal only held on **Chromium**,
because it read headers only. A navigation intercepted by a Service Worker
carries no origin-bearing header at all on Firefox and WebKit (`Sec-Fetch-*` is
added after interception, on all three engines). The rule therefore rests on the
**shape** of the request — `destination`, `referrer`, `mode` — which every
engine populates: a top-level navigation is never the application, which only
ever lives inside the shell's iframe. The full measurement table and the exact
rule are in [`SECURITY.md`](SECURITY.md).

**The lesson outlives the cookie**: the live recipe was 8/8 green against a
demo that could not write, because it only issued GETs — and Rails needs no
session to serve a GET. A full POST scenario was added, and the defect was
found by actually clicking in the published page, not by reading a test report.

**Detecting a missing variable without picking the wrong word.** A pattern like
`(VARIABLE).{0,40}(keyword)` captures the **first** uppercase token on the line —
on `{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}` it seriously
suggested `FATAL` as the variable to fill in. Replaced by a windowed search
around the keyword, stripping log labels (`[DEVISE]`, `[STRIPE]`) and requiring
an underscore in the name. Another nuance: "blocking" is judged on the
**severity of the message**, not on the family of the variable. A `WARN` still
lets the application boot; only the affected feature stays inactive.

**Assorted image-build traps.** `docker export` loses `/etc/hosts` and uids
unless extraction runs as root; a hand-rolled init must mount `/dev/shm`
(PostgreSQL 15); `BUNDLE_WITHOUT` and `BUNDLE_FORCE_RUBY_PLATFORM` must exist
**at runtime**, not only at build time; BuildKit does not apply the 32-bit
personality, so `uname -m` lies and Bundler installs unloadable x86_64 gems;
nokogiri will not compile its vendored libxml2 on i386 (system libraries are
mandatory); `tmp/`, `log/` and `storage/` are often excluded by `.dockerignore`
while Puma requires `tmp/pids`; the serial tty must be in `raw -echo`, since
canonical mode truncates at 4,096 characters.
