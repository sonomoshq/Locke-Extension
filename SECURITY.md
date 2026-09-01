# Security Policy

## Reporting a vulnerability

Please **do not** file public GitHub issues for security vulnerabilities.

- Email `security@sonomos.ai` (PGP optional — key and canonical contact in
  [`docs/security/security.txt`](docs/security/security.txt), deployed to
  <https://sonomos.ai/.well-known/security.txt>)
- Or use GitHub's private security advisory system on
  [this repository](https://github.com/sonomoshq/Locke-Extension/security/advisories/new)

Corrected 2026-08-21: both channels above used to point at a repository
that is now archived. Email is the channel that works for a reporter with
no GitHub access.

We acknowledge reports within 48 hours and aim to ship fixes within 30 days
for high-severity issues.

## Threat model

The extension is a **hold-and-enforce capture surface**: it holds a bodied
request the page is about to send to an AI surface, ships it to the local
Locke desktop app for screening, and applies the verdict it gets back.
Detection and redaction happen in the desktop app, never in the extension.
`docs/architecture/DATA-FLOW.md` draws the whole path.

**Corrected 2026-08-21.** A1, A2, A3, A4 and A6 below previously described
a retired architecture — a loopback HTTP daemon reached over an
authenticated handshake. None of that exists. Worse, the port those
sections named was never in `manifest.json`, so the published constraint was
falsifiable by anyone who opened the file. What follows is the live
architecture. Where a risk has no mitigation today, it says so.

### A1 — Hostile remote endpoint (LLM provider, network attacker)

**What the extension itself puts on the network.** Exactly one call, and it
is not page data: `POST http://127.0.0.1:18795/heartbeat` carrying
`{ "browser": "<family>", "version": "<manifest version>" }`
(`background/service-worker.js::sendPresenceBeacon`). That is the presence
beacon the Locke desktop app listens for on port 18795, so it can show
install state per browser. There is no other `fetch` in the extension.

**Held page data never touches a network socket at all.** It leaves the
browser over OS native messaging (4-byte-LE-framed JSON on stdio) to the
same-user native messaging host, which relays it to the Locke desktop app
over a user-only (`0600`) Unix domain socket. No port, no HTTP, nothing a
remote endpoint or an off-box network attacker can reach.

**What the manifest actually grants, precisely.** `host_permissions` is
`["http://127.0.0.1/*"]` — **all loopback ports**, not one. A match pattern
cannot express a port: Firefox treats a pattern carrying an explicit port as
matching nothing (Bugzilla 1362809), so the port-free spelling is
deliberate. The grant is therefore strictly wider than the single origin the
extension uses, and anyone auditing this repo should expect to see that.

**What actually bounds it** is the extension-pages CSP, which pins
`connect-src` to `http://127.0.0.1:18795` — the same wording
`docs/security/PERMISSIONS.md` uses. That, plus the fact that
`sendPresenceBeacon` is the only call site in the source, is the real
constraint. `tests/manifest.test.js` pins both halves; `tests/constants.test.js`
pins `PRESENCE_URL`.

**What the tripwires actually check.** `scripts/store-build.mjs::validate`
rejects any `host_permissions` entry that is not loopback, applied to the
*staged* manifest by `npm run validate`, by `scripts/package.mjs` before it
will emit a zip, and by `scripts/preflight.mjs` in the pre-push hook.
`.github/workflows/ci.yml::Host permissions are loopback-only` re-asserts it
but is dispatch-only. Neither check asserts a **port** — they assert
loopback. A doc that promises a port bound is promising something no
tripwire enforces.

**Masking is one-way.** What the desktop app substitutes for detected PII is
a token, not a ciphertext: no cipher, no key, no mapping store, so a hostile
endpoint receives placeholders nobody — including us — can resolve back.
Tokens are deterministic, so the same value reads as the same token and the
model still gets a stable placeholder.

### A2 — Hostile local process (port-squatter)

**The port that exists is 18795, and the only thing on it is the presence
beacon.** A malicious local process that binds `127.0.0.1:18795` before the
Locke desktop app does will receive the extension's heartbeats.

**What a squatter gets:** the two fields in the body — the browser family
(`chrome`, `firefox`, …) and the extension's version string. No page data,
no prompt text, no PII, no user or machine identifier. Captured requests do
not travel this way (A1), so there is no plaintext payload on this port to
intercept.

**What a squatter can do back:** nothing. The beacon is fire-and-forget —
`fetch(...).catch(() => {})`, the response object is never read, never
parsed, never stored. There is no reply a squatter can craft that changes
the badge, the connection state, or whether anything is screened. The
extension's health answer comes from the native-messaging round trip
(`shared/health-client.js`), a channel a port-squatter is not on.

**Mitigation: none, and none is warranted.** The per-install HMAC handshake
that used to be documented here was authenticating a PII-bearing HTTP
channel that no longer exists; it retired with that architecture.
Authenticating a two-field liveness ping would protect nothing.

**Residual risk, unmitigated and accepted:** a local process that squats
18795 learns that a Locke extension is installed, in which browser family,
at which version. We do not detect or prevent this. It is accepted because a
process running as this user can already read the browser profile and
enumerate installed extensions directly — the beacon tells it nothing it
could not have looked up — and because the squatter cannot escalate from
that to page data or to influencing the extension.

### A3 — Tampered native-messaging manifest

If an attacker with write access to the user's browser-config directories
rewrites `~/.config/google-chrome/NativeMessagingHosts/ai.sonomos.desktop.json`
(or the equivalent path on macOS / Windows) to point its `path` field at a
malicious binary, the browser will launch that binary instead of the native
messaging host, and every held request would be handed to it. Widening the
same file's `allowed_origins` would additionally let a hostile extension
speak to whatever is on the other end.

**What does hold:** `allowed_origins` in that manifest bounds which
extension IDs the browser will let connect, and an attacker cannot forge an
ID to get past it — Chromium derives a packed extension's ID from its
signing key and an unpacked one from its absolute load path. This is
enforced by the browser, not by us, and it is why an unpacked development
load has to have its ID added to that manifest's `allowed_origins` before
the host will start for it at all. A hostile extension therefore cannot
reach our host by guessing. The set of IDs authorised that way is recorded
in a per-user file written user-only — mode `600` under `umask 077` on
Linux/macOS, and on Windows a DACL with inheritance removed carrying only
the invoking user and SYSTEM. That file decides what may start the host,
and it is capped at 16 entries with the cap enforced as an error rather
than a silent eviction.

The manifest, the file, and the installer that writes both belong to the
Locke desktop app and are not published in this repository, so a reader of
this repository cannot verify any of the paragraph above by reading the
source here.

**Mitigation for a tampered manifest: none today.** Previous versions of
this document credited a self-check module and a doctor command in the
retired architecture. Neither exists today. The desktop app's installer
writes the manifest mode `644` and its launcher mode `755` under `$HOME`,
and nothing re-verifies either afterwards. Nothing in the extension can: it sees a native-messaging
channel, not the file that configured it.

We name it rather than dress it up. Note that the ordering here has
inverted since the old text: A3 used to be filed as "strictly weaker than
A2" because A2 was priced as a plaintext-PII leak. With A2 correctly rated
down to a two-field liveness ping, **A3 is now the more serious of the
two** — it is the one adversary in this model that reaches held page data
and has no mitigation. What still bounds it is the prerequisite, not a
control of ours: the attacker needs write access to the user's own home
directory, which is past several other defenses and is the same access
level A6 treats as out of scope. "Bounded by prerequisite" is not
"handled", and no tooling closes it today. Tracked as
`docs/security/RISK-REGISTER.md` R-05.

### A4 — Compromised dependency (supply chain)

The extension itself has zero JavaScript runtime dependencies —
`package.json` declares empty `dependencies` and `devDependencies`, and
anyone can confirm that by opening the file. Everything this repository
ships is first-party source with no third-party runtime code in it.

The native messaging host is a different matter, and it is **not part of
this repository**: it is installed by the Locke desktop app, it is written
in Rust, and it carries a dependency graph of its own. That graph is a real
supply-chain surface, larger than "stdlib only", and it is not published
here — a reader of this repository cannot audit it. It is named rather than
left implied.

**Mitigations:**

- All third-party GitHub Actions are pinned by SHA, with the human-readable
  version number in a comment. Renovating an action requires a deliberate
  PR; an upstream tag move cannot silently change CI behaviour.
- `gitleaks` and `semgrep` are pinned to specific release versions
  (`semgrep:1.124.0`, `gitleaks 8.30.1`) rather than `latest` or `master`.
- `dependency-review-action` (`.github/workflows/dependency-review.yml`)
  fails any PR that introduces a vulnerable transitive dep, before review.
- Trivy filesystem scan (`ci.yml::trivy`) fails on HIGH or CRITICAL
  findings, and a CycloneDX + SPDX SBOM (`.github/workflows/sbom.yml`) is
  emitted alongside releases — **when those workflows run**. They are
  dispatch-only. `[corrected 2026-08-21]` — this bullet used to end
  "have never run", carrying over a 2026-08-12 correction that was itself
  wrong. Both ran, on `push` and `pull_request`, until 2026-06-18: Trivy
  succeeded on all 15 CI runs and `sbom.yml` succeeded on all 13 of its
  own, uploading CycloneDX and SPDX artifacts each time. So the tree was
  clean at the 2026-06-18 baseline and has been unscanned since; and while
  SBOMs have been *generated*, none is published against a version, because
  this repo has no tag and no GitHub release. Treat the first three bullets
  as the live controls and these two as dormant-since-June.

**Residual risk:** a malicious commit to one of the pinned-by-SHA GitHub
Actions repos that targets a release tag we haven't yet bumped to is not
automatically caught — we'd need to actively bump that pin. Mitigation
is calendar-driven: dependency reviews quarterly. And the native host's
crate graph is outside this repository, so nothing in this repository's CI
has ever analysed it.

### A5 — Compromised CI / build pipeline

A CI environment that is compromised (an attacker steals a GitHub token,
or modifies a workflow file via a PR) could publish a poisoned release
under the project's identity.

**Mitigations — configured, not yet exercised.** `release.yml` now runs
automatically on a push to `main` and publishes when the version changed,
but it has not yet run for a release, so per
`docs/security/CONTROL-CATALOG.md`'s 2026-08-12 correction no artifact
shipped to date is signed by us or carries an attestation. The design below
is real and the workflow is committed; what is not yet true is that it has
run.

- Releases are signed with sigstore keyless OIDC, binding each artifact
  to a specific source commit and a specific GitHub Actions workflow
  invocation. An attacker who steals the GitHub token but cannot run a
  release workflow under the official path cannot produce a verifiable
  signature.
- SLSA Level 3 build provenance (`actions/attest-build-provenance`)
  attaches a verifiable attestation to every release artifact. IT
  verifies with `gh attestation verify <artifact> -R sonomoshq/Locke-Extension`.
- Both release zips are built reproducibly — one timestamp shared by
  every entry, a file list sorted by `scripts/store-build.mjs::entries`,
  and a fixed deflate level — so a third party can rebuild from a tag and
  byte-compare against the published artifact. Matching a *release* build
  additionally needs `SOURCE_DATE_EPOCH` set to the tag commit's committer
  time, which is what `release.yml` pins; unset, the writer uses its own
  fixed stamp, which is still deterministic but will not match.
- Workflow permissions are scoped per-job. `release.yml` is the only
  workflow that has `contents: write`; other jobs are read-only.
- ~~OpenSSF Scorecard runs weekly and publishes results to the public
  dataset.~~ `[corrected 2026-08-21]` — `scorecard.yml` did run weekly
  on a schedule until 2026-06-18, and **failed on every one of those
  runs**; `publish_results` needs a public repo, so nothing was ever
  published to the dataset. Its trigger is `workflow_dispatch`-only
  now. There is no score, and therefore no score to watch for a drop.
  The README badge asserting one was removed on 2026-08-21.

**Residual risk:** a compromise of GitHub itself (or of the sigstore
public-good infrastructure) is outside our control. Both are widely
audited but not infallible.

### A6 — Insider with local user privileges

There is no auth token to steal any more — it retired with the old
architecture. What a process running as the user's own OS account has instead is direct
access to the desktop app's local sockets: the socket the native host dials
is mode `0600` and owned by that user, so that user's processes can open it.
This is structurally unavoidable: any process running as that user has full
access to the user's files, including its sockets.

**What this DOES NOT enable:**

- Reading PII *other* OS users would have masked. The desktop app's sockets
  are per-user and mode `0600`; a different OS user cannot open them.
- Producing forged release artifacts; that requires the GitHub OIDC
  identity, not local file access.

**What this DOES enable:**

- Submitting traffic to the user's own desktop app, or standing in front of
  it — see A3, whose tampered-manifest case is the same access level and is
  likewise unmitigated. Both are equivalent to "the user themselves has
  compromised the install", which is out of scope for the extension's
  threat model. Endpoint-level mitigations (EDR, full-disk encryption,
  OS-level user isolation) belong upstream.

This adversary is documented because vendor questionnaires ask about it;
no extension-side mitigation is meaningful.

## Supported versions

This extension follows the Sonomos Locke release cadence. Only the latest
released version receives security updates.

## Coordinated disclosure

We follow standard 90-day coordinated disclosure for vulnerabilities found
in our code. Vulnerabilities in our dependencies — including the Rust crate
graph the native host pulls in (A4) — are addressed on the same timeline.
