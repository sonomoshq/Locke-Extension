# Locke Extension

**The browser piece of [Locke](https://sonomos.ai/locke) — Sonomos's on-device
privacy screen for AI apps.**

Before a prompt leaves your browser for ChatGPT, Claude, Gemini, Grok,
Perplexity or an AI-answering search engine, this extension holds it and asks
the Locke desktop app whether it contains anything that shouldn't leave your
machine. The request is sent, sent redacted, or blocked — decided **entirely on
your device**. Nothing is scanned in a cloud, because nothing goes to one.

*Formerly the Sonomos Desktop Connector.*

[![Quality](https://github.com/sonomoshq/Locke-Extension/actions/workflows/quality.yml/badge.svg)](https://github.com/sonomoshq/Locke-Extension/actions/workflows/quality.yml)
[![CI](https://github.com/sonomoshq/Locke-Extension/actions/workflows/ci.yml/badge.svg)](https://github.com/sonomoshq/Locke-Extension/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sonomoshq/Locke-Extension/actions/workflows/codeql.yml/badge.svg)](https://github.com/sonomoshq/Locke-Extension/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sonomoshq/Locke-Extension/badge)](https://scorecard.dev/viewer/?uri=github.com/sonomoshq/Locke-Extension)
[![License: PolyForm Strict 1.0.0](https://img.shields.io/badge/license-PolyForm_Strict_1.0.0-blue)](LICENSE)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](package.json)

| | |
|---|---|
| 🏠 **Product** | [sonomos.ai/locke](https://sonomos.ai/locke) — what Locke is and how to get it |
| 📖 **Help & guides** | [support.sonomos.ai](https://sonomos.ai/support) — how the desktop app and this extension work together |
| 🔒 **Security & trust** | [trust.sonomos.ai](https://trust.sonomos.ai) — security posture, and [`SECURITY.md`](SECURITY.md) for reporting |
| 💬 **Questions** | [GitHub Discussions](https://github.com/sonomoshq/Locke-Extension/discussions), or [sonomos.ai](https://sonomos.ai) for anything else |
| 📚 **How it works** | [the wiki](https://github.com/sonomoshq/Locke-Extension/wiki), [`HONEST.md`](HONEST.md) for exactly what is and isn't covered |

> **This source is published for transparency. It is not open source.**
> The repository is licensed under the **PolyForm Strict License 1.0.0** —
> see [`LICENSE`](LICENSE). You may read and run it for **noncommercial**
> purposes, including auditing and rebuilding it to check that what ships
> matches this source. You may **not** redistribute it, modify it, or make
> derivative works, and commercial use needs a separate licence
> (`info@sonomos.ai`). Bug and security reports are welcome
> ([`SECURITY.md`](SECURITY.md)); pull requests cannot be accepted
> ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

This is a deliberately simple hold-and-enforce capture surface. It contains no
detection or redaction logic of its own: when the page sends a bodied request to
an AI web surface, the extension holds it, ships the raw request to the Locke
desktop app, and applies the verdict — send it unchanged (`allow`), send the
app's rebuilt request (`redact`), or block it. All scanning and redaction happen
**in the desktop app**. The failure posture is **fail-closed**: no verdict, no
send.

It covers browser-based AI web apps. Locke screens desktop / native AI apps by a
separate path that this extension does not feed; the two are independent, and
this repository is only the browser half.

**Once installed, it is almost invisible.** It works silently: no prompts, no
notifications, no injected page UI. The page-visible behaviour is the screening
round-trip itself — an in-scope request waits for its verdict, and a blocked one
fails the way a network error would. When healthy it is quiet — the toolbar badge is *empty* on a
healthy connection and only shows a glyph when the desktop app is unreachable, so it
surfaces only when something is actually wrong. The only user-visible touchpoints are
(1) that badge, which appears only on a connection problem, and (2) an opt-in popup
showing connection status *and* whether anything is actually screening — two separate
facts, because a reachable desktop app does not prove the screener behind it is alive.

## What it does

> **Read `HONEST.md` before reading this section as a coverage claim.** Only
> requests with a BODY are screened. A prompt that reaches a provider as a
> top-level navigation — address bar, default search engine, `?q=` deep link,
> `<form>` submit — is not screened on **any** host, search hosts included;
> the search entries in `web_hosts` are declared `web_screening: "none"` in
> the catalog and are there because those hostnames also carry other surfaces'
> chat traffic. Screening navigation-borne prompts is deferred to 1.x.

- **Page-world fetch / XHR interception** (`content/shim.js`) — runs in the page's
  MAIN world and wraps outbound `fetch` and `XMLHttpRequest`. If the request host
  matches an AI **web surface** (ChatGPT, Claude, Gemini, Grok, Perplexity, and the
  in-scope search hosts — from `shared/ai-surfaces.json` → `web_hosts`, baked into
  `content/web-surfaces.generated.js` as `SONOMOS_WEB_HOSTS`) and carries a body,
  the shim HOLDS it, captures the exact body bytes, synthesizes the raw HTTP
  request, and enforces the verdict it gets back. It also holds a **cross-origin
  object write initiated by one of those pages** — the pre-signed `PUT` an AI
  web app uses to send an attachment straight to S3 / GCS / Azure Blob, which
  never addresses an AI host and so was previously unscreened. That scope is
  bounded by the *initiator*, not the destination: nothing is added to the
  surface catalog and no host permission is requested, because the shim already
  runs inside the page. Everything else is ignored and passes through untouched.
  `navigator.sendBeacon` is also wrapped, but a beacon cannot be held at all, so
  an in-scope one carrying data is refused rather than let through. What the
  extension does **not** cover — `WebSocket`, unrecognised upload shapes,
  prompts carried in a query string — is catalogued in
  [`HONEST.md`](HONEST.md).
- **Isolated-world relay** (`content/content-script.js`) — receives the held
  request (base64) from the shim, round-trips it through the service worker, and
  answers the shim with the verdict. An unreachable service worker answers null →
  the shim blocks.
- **Native-messaging host** (`ai.sonomos.desktop`) — a stdin/stdout JSON host
  that relays each held request to the Locke desktop app and returns the
  verdict. It forwards bytes; it parses nothing. It is installed and
  registered by the Locke desktop app and is **not part of this
  repository**.
- **Connection health + status** — the service worker heartbeats the native host
  (every ~30 s) and keeps a shape-only audit ring-buffer for IT incident response.
  The toolbar badge is deliberately quiet: **empty** while connected, and it only
  shows a glyph when there's a problem (`off` disconnected, `!` no bridge, `…`
  warming, `?` unknown). The opt-in popup surfaces the connection status and, as a
  separate row, whether screening is **Active** (a real verdict came back on a
  request that was fully screened), **Unavailable**, or **Not yet confirmed** — the
  honest answer when the desktop app is reachable but nothing has yet proved the
  screener behind it screened what was sent. A request that went out under the user's
  fail-open setting reads "Not yet confirmed" too, never "Active": the receipt
  proves the app answered AND that those bytes were never examined. The popup
  also counts anything that went out that way.
- **Managed-storage policy** — admins can push configuration via
  `chrome.storage.managed` (see `managed-schema.json`).

## Architecture

```
Page (chatgpt.com, claude.ai, gemini.google.com, …)
    │  fetch / XHR to an AI web surface
    ▼
content/shim.js          ─── MAIN world; HOLDS in-scope outbound calls,
    │  window.postMessage      synthesizes the raw HTTP request (base64),
    ▼  (SONOMOS_CAPTURE ⇄       enforces the verdict. FAIL CLOSED.
    │   SONOMOS_VERDICT)
content/content-script.js ─── isolated world; round-trip relay
    │  chrome.runtime.sendMessage { type: 'capture', requestB64 }
    ▼
background/service-worker.js
    │  - heartbeat health checks (~30 s, backs off) + connection badge
    │  - presence beacon → desktop app (fixed 30 s, never backs off)
    │  - native-messaging client → the native messaging host
    │  - shape-only audit ring buffer (no bodies, no PII)
    ▼  sendNativeMessage (4-byte length-prefixed JSON over stdio)
native messaging host  (ai.sonomos.desktop — installed by the desktop app)
    │  one connection per held request; forwards bytes, parses nothing
    ▼  no network hop; the browser never opens a socket to the app
Locke desktop app  (parse + screen + redact)
```

The desktop app returns a verdict, with a whole rebuilt raw request on `redact`.
The shim acts on it while the page's request is still held: send as held,
re-issue with the rebuilt body bytes (and its Content-Type), or block. Anything
short of a clean verdict — timeout, missing host, half-parsed receipt — blocks.

That is where this repository ends. Everything past the native-messaging
boundary — how the held request is parsed, what detects PII, how a redacted
request is rebuilt — happens inside the Locke desktop app and is not
published here.

## Install

The extension ships inside the Locke desktop installer; installing the desktop
app is the supported path and it needs no separate steps.

The rest of this section is how a Sonomos maintainer loads this source as an
unpacked extension. It is not a grant of any right to do so — the licence is
read-only (see [`LICENSE`](LICENSE)).

1. **Install and run the Locke desktop app.** It is what screens requests, and
   it is also what installs and registers the native messaging host
   (`ai.sonomos.desktop`) the extension talks to. Without it the extension has
   nothing to report to and every in-scope request fails closed. Neither the
   host nor its installer is part of this repository.
2. **Build the per-browser trees**, then load **from `dist/`** — not from the
   repo root, whose `manifest.json` is a superset carrying both background
   families and is not valid for either browser as-is:

   ```sh
   npm run package
   ```

   - Chrome / Edge / Brave: `chrome://extensions` → Developer mode → "Load
     unpacked" → select `dist/chromium/`.
   - Firefox: `about:debugging` → "This Firefox" → "Load Temporary Add-on" →
     select `dist/firefox/manifest.json`.
3. **Chromium-family only: the load's extension ID has to be authorised.**
   Chromium derives an unpacked extension's ID (32 letters a–p) from the
   absolute path it was loaded from, so every checkout gets its own — and the
   native-messaging manifest allows only the published store IDs by default.
   Until that ID is added to the manifest's `allowed_origins`, the browser
   refuses to start the host ("access to the specified native messaging host
   is forbidden") and the popup shows Setup. That manifest belongs to the
   Locke desktop app's installer, so authorising a development ID is a
   desktop-app-side step; this repository has no command for it.

   Firefox is unaffected — a temporary add-on keeps the fixed gecko ID the
   manifest already allows.

## Files

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Content scripts scoped to the AI web-surface list; one loopback host permission. Carries both browser families' keys — `npm run package` strips the wrong ones per target. |
| `background/service-worker.js` | Heartbeat, connection badge, native-messaging client, capture relay, audit log |
| `content/shim.js` | MAIN-world fetch/XHR interception of AI web surfaces; holds, synthesizes the raw request, enforces the verdict |
| `content/content-script.js` | Isolated-world round-trip relay: shim ⇄ service worker |
| `content/web-surfaces.generated.js` | Generated `SONOMOS_WEB_HOSTS` global (run `npm run generate`) |
| `shared/vocab.generated.js` | Generated `INFRASTRUCTURE_REASONS`, from the vendored `shared/vocab.json` (run `npm run generate`) |
| `popup/` | Extension action popup (connection status) |
| `shared/` | Shared constants, browser-API polyfill, health client, `ai-surfaces.json` catalog |
| `scripts/store-build.mjs` | Per-target staging + the store-rule checks `npm run validate` / `npm run package` gate on |
| `scripts/zip.mjs` | Dependency-free deterministic ZIP writer (forward-slash entry names — see its header) |

## Store packaging

```
npm run validate   # check the tree against Chrome Web Store / Edge / AMO rules
npm run package    # validate, then write dist/locke-extension-<version>-{chromium,firefox}.zip
```

The chromium zip serves both the Chrome Web Store and Edge Add-ons; the firefox
zip goes to AMO. `npm run package` refuses to emit an artifact that fails
validation. Listing copy, permission justifications, and the human checklist
live in [docs/store/LISTING.md](docs/store/LISTING.md).

## Releasing

`npm run package` builds the two store artifacts — one Chromium zip
that serves **both** the Chrome Web Store and Edge Add-ons, and one Firefox
zip for AMO.

Submitting them is always a **deliberate act**, never a side effect of
merging, by one of two routes:

- **From CI (the normal one):** merge the version bump, then dispatch
  Actions → Release → "Run workflow" on `main`. `release.yml` is
  `workflow_dispatch`-only, and `scripts/release-gate.mjs` publishes only
  when this repository has no `v<version>` release tag yet.
- **From a workstation:** pushing a `vX.Y.Z` tag, where the
  `scripts/hooks/pre-push` hook runs preflight and then
  `scripts/publish.mjs --store=all`.

Neither route has a second-person approval step.

- [`docs/store/RELEASE-PIPELINE.md`](docs/store/RELEASE-PIPELINE.md) — the
  operator's guide: the bump → PR → merge → dispatch sequence, what the
  pre-push hook does on a branch versus a tag, dry runs, reproducible builds,
  and a troubleshooting table for the ways each store says no.
- [`docs/store/CREDENTIALS.md`](docs/store/CREDENTIALS.md) — every store
  credential, where to get it, and how each one expires (the Edge API key
  every 72 days; the Chrome refresh token every 7 while the OAuth consent
  screen is in Testing).

Policy — who may release, and what is actually enforced versus merely
committed to — is [`docs/security/RELEASE-POLICY.md`](docs/security/RELEASE-POLICY.md).

## Security model

See [SECURITY.md](SECURITY.md). TL;DR:

- **Hold-and-enforce, fail-closed.** An in-scope bodied request leaves only after
  an `allow` or `redact` verdict; anything short of that blocks it. Out-of-scope
  traffic is never touched.
- **No remote network egress.** Page data travels only to the same-user
  native-messaging host (`ai.sonomos.desktop`), which relays to the Locke
  desktop app over a user-only `0600` Unix domain socket. There is no HTTP
  daemon and no URL for a policy to redirect. The single `host_permissions` entry
  is loopback (`http://127.0.0.1/*`) and carries nothing but the
  `{ browser, version }` presence beacon — see
  [docs/security/PERMISSIONS.md](docs/security/PERMISSIONS.md).
- **Content scripts are scoped** to the AI web-surface host list (not `<all_urls>`);
  `scripts/store-build.mjs::validate` rejects a wildcard host in any of its
  spellings at build time and in the pre-push gate.
- **Native-messaging host name** is `ai.sonomos.desktop`. The extension keeps it
  in exactly one place, `shared/constants.js`, and it has to match the
  registration the Locke desktop app writes; a mismatch means the browser
  launches nothing and the extension fails closed.

Both checks run locally (`npm run validate` or `npm run package`, and the
`scripts/hooks/pre-push` hook), and a contributor can bypass the hook with
`git push --no-verify`.
`.github/workflows/` re-asserts them, and those workflows now run on pushes
to `main` and on pull requests — but branch protection is not configured, so
nothing there *gates* a merge yet. `release.yml` is the deliberate exception
in the other direction: it is `workflow_dispatch`-only, so nothing publishes
to a store without somebody choosing to.
The Scorecard and SLSA badges above are aspirational because the release
pipeline has not run yet, not because it cannot; see
[`docs/security/RELEASE-POLICY.md`](docs/security/RELEASE-POLICY.md).
- **All redaction happens in the desktop app.** The extension deliberately does
  none of it.

## Why publish the source of a privacy product?

Because "we don't read your prompts" is a claim, and claims about privacy
software deserve to be checkable. Publishing the source lets anyone verify the
properties that matter:

- **No outbound request except loopback.** The extension's only network
  destination is the Locke desktop app on `127.0.0.1`. This is not a policy —
  it is enforced by CI on every change (`scripts/audit-payload.mjs` fails the
  build on any other endpoint), and you can grep the source yourself.
- **Zero runtime dependencies.** `package.json` declares none, so there is no
  third-party code in what ships and no supply chain to take on faith.
- **Reproducible builds.** Two builds of the same commit are byte-identical,
  verified by CI on every push. The recipe is in
  [`docs/security/RELEASE-POLICY.md`](docs/security/RELEASE-POLICY.md).
- **Honest limitations, in writing.** [`HONEST.md`](HONEST.md) documents what
  the extension does *not* cover — WebSocket traffic, address-bar prompts, and
  more — rather than letting silence imply completeness.

The publication is one-way by design: the licence permits reading and
noncommercial verification, not reuse. See [`LICENSE`](LICENSE).

## Getting help

| I want to… | Go to |
|---|---|
| Install or use Locke | [sonomos.ai/support](https:/sonomos.ai/support) |
| Understand how the extension and desktop app work together | [sonomos.ai/support](https:/sonomos.ai/support), or [the wiki](https://github.com/sonomoshq/Locke-Extension/wiki) |
| Ask about security posture, compliance, audits | [trust.sonomos.ai](https://trust.sonomos.ai) |
| Report a bug in this extension | [GitHub issues](https://github.com/sonomoshq/Locke-Extension/issues) |
| Report a **vulnerability** | [`SECURITY.md`](SECURITY.md) — **not** a public issue |
| Ask anything else | [GitHub Discussions](https://github.com/sonomoshq/Locke-Extension/discussions), or [sonomos.ai](https://sonomos.ai) |
| Commercial licensing | `info@sonomos.ai` |

---

<sub>Locke and Sonomos are products of Sonomos, Inc. This repository contains
the browser extension only; the Locke desktop app is distributed from
[sonomos.ai/locke](https://sonomos.ai/locke).</sub>
