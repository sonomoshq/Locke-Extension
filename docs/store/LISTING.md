# Store listing copy — Locke Extension

Submission copy and checklists for the Chrome Web Store, Edge Add-ons, and
Firefox AMO. The artifacts come from `npm run package`
(`dist/locke-extension-<version>-chromium.zip` serves Chrome AND Edge;
`dist/locke-extension-<version>-firefox.zip` serves AMO). Items that need a
human are marked **[HUMAN]**. How the artifacts actually get submitted is
[`RELEASE-PIPELINE.md`](RELEASE-PIPELINE.md); the credentials that submit
them are [`CREDENTIALS.md`](CREDENTIALS.md).

Everything mechanically checkable is enforced by `npm run validate`
(`scripts/store-build.mjs`) and re-run as a gate inside `npm run package`:
field limits, icon dimensions, every manifest reference actually shipping,
the keys that get an upload auto-rejected (`update_url`, `key`), remote-code
smells, and the per-family key hygiene each store's linter checks. What
remains below is copy and human judgement.

## Name

**Locke Extension**

## Summary (short description)

Reused from the manifest `description` (129 chars, within every store's
132-char limit):

> Connects your browser to the Locke desktop app so AI website requests are
> held and scanned on-device before leaving your machine.

## Long description

Locke Extension is the browser half of the Locke desktop app. It watches a
fixed list of AI websites (ChatGPT, Claude, Gemini, Perplexity, and the other
in-scope chat and search surfaces) and, when a page on one of those sites
sends a request with a body, it holds that request and relays it to the Locke
desktop app running on your machine. The app scans it on-device and returns a
verdict, which the extension enforces before anything leaves your browser:

- **allow** — the request is sent exactly as the page issued it.
- **redact** — the request is sent with sensitive data replaced by the
  desktop app's rebuilt version.
- **block** — the request is not sent; the page sees a network error.

The failure posture is fail-closed: if the desktop app is unreachable or no
clean verdict arrives, an in-scope request is blocked rather than sent
unscreened. Traffic to sites outside the list is never touched.

What it does not cover: a prompt that travels in the web address itself rather
than in a request body. A query you type into the browser's address bar, send
to your default search engine, or submit from a search box is sent by the
browser as a page navigation, which this extension does not see and cannot
hold. That applies to every site on the list, search engines included, so
search queries are not screened today.

All scanning and redaction happen locally in the Locke desktop app. The
extension has no detection logic of its own, contacts no remote servers, and
sends no data off your machine. Its only two endpoints are the desktop app's
native-messaging host and a loopback heartbeat (`127.0.0.1`) that tells the
app the extension is installed and connected.

**Requires the Locke desktop app.** Without it, in-scope AI-website requests
are blocked (fail-closed) and the toolbar badge shows the connection problem.

## Category

- Chrome Web Store: **Privacy & Security** (fallback: Productivity → Tools)
- Edge Add-ons: **Privacy** (fallback: Productivity)
- Firefox AMO: **Privacy & Security**

## Single-purpose statement (Chrome Web Store)

> Locke Extension has one purpose: it holds requests that AI websites send
> from your browser and lets the local Locke desktop app scan them on-device,
> enforcing the app's allow/redact/block verdict before the request leaves
> your machine.

## Permission justifications

Ground truth: `docs/security/PERMISSIONS.md` (kept in sync with the
manifest). Store-form phrasing:

### `storage`
Persists the connection-state cache, popup UI state, and a 100-entry
shape-only audit log (no page data, no PII). `storage.managed` lets IT
admins push policy via the enterprise schema (`managed-schema.json`).

### `alarms`
Drives two periodic ticks: the ~30-second heartbeat that checks the
desktop-app connection and keeps the toolbar badge accurate (this one
backs off when the app is down), and a fixed 30-second presence tick that
sends the loopback presence beacon (this one never does — "the extension
is installed" is not a claim that should go quiet because something else
is failing). MV3 service workers cannot use timers for this.

### `nativeMessaging`
The core capability: held requests travel to the local Locke desktop app
through the OS native-messaging channel (host `ai.sonomos.desktop`), not
over the network. This is the only path page data ever takes.

### Host permission `http://127.0.0.1/*`
A loopback-only heartbeat: every ~30 s the extension POSTs
`{ "browser": "...", "version": "..." }` to the Locke desktop app's local
presence listener (port 18795) so the app can show "extension connected".
Nothing but those two fields is sent, and the endpoint is unreachable from
off-machine. The pattern is portless because Firefox ignores match
patterns that carry an explicit port; the extension-pages CSP pins
`connect-src` to `http://127.0.0.1:18795`, so only that port is reachable
in practice.

### Content-script matches (24 AI hosts)
Content scripts run only on the fixed list of protected AI surfaces (chat
UIs, plus search hosts that carry chat traffic) generated from the product's surface
catalog (`scripts/generate-surfaces.mjs`). These are the sites whose
requests the extension exists to screen. It deliberately does NOT request
`<all_urls>`.

## Privacy disclosures

- **Remote code:** none. No remote scripts, no eval, no CDN assets; the CSP
  is `default-src 'none'` with same-origin scripts only.
- **User data collected:** none. No analytics, no telemetry to any server,
  no accounts. The extension stores connection state and a shape-only audit
  log locally in the browser.
- **Data sold / shared with third parties:** none.
- **Processing location:** everything is on-device. Held requests go to the
  local Locke desktop app via native messaging; the only network endpoint is
  loopback (`127.0.0.1:18795`) and carries only `{ browser, version }`.
- **Privacy policy URL:** <https://sonomos.ai/locke/privacy> — the
  extension-specific policy. The company-wide policy at
  <https://sonomos.ai/privacy> does **not** cover this extension; do not
  submit it in the store forms.

### Firefox data-collection declaration

AMO requires every new add-on to declare its data collection in the manifest
(mandatory since 2025-11-03; Firefox shows it in the install prompt). Ours:

```json
"data_collection_permissions": { "required": ["none"] }
```

`none` is accurate — see `docs/security/PERMISSIONS.md` for the reasoning and
for what must change if the beacon payload ever grows. In the AMO submission
form, answer the data-collection questions to match: no personal data, no
technical/interaction data.

## Required assets checklist

`scripts/preflight.mjs::checkAssets` warns (it does not fail) when any of
the three image files below is missing, so drop them at exactly these paths
— the check is path-literal:

- [ ] **[HUMAN]** `docs/store/assets/screenshot-1280x800-1.png` — at least
      one 1280x800 screenshot; all three stores accept this size, CWS allows
      up to 5. Suggested shots: popup Online state, popup Offline state,
      desktop app showing the extension connected.
- [ ] **[HUMAN]** `docs/store/assets/promo-tile-440x280.png` — Chrome Web
      Store small promo tile.
- [ ] **[HUMAN]** `docs/store/assets/edge-logo-300x300.png` — Edge Add-ons
      requires a 300x300 store logo per listing language.
- [x] Icons: shipped in the zip (`icons/icon-128.png` satisfies every
      store's listing-icon requirement). `scripts/package.mjs` stages every
      `icons/*.png` into both artifacts; the SVG design sources are
      deliberately left out.
- [ ] **[HUMAN]** Publish <https://sonomos.ai/locke/privacy>. As of
      2026-08-12 it returns 404. All three stores require a reachable
      privacy-policy URL — a dead link fails review, and a listing whose
      policy URL later breaks can be taken down. This must be live *before*
      the first submission, and legal sign-off must cover the extension.
- [x] Store accounts: Chrome Web Store developer, Microsoft Partner Center,
      and Firefox Add-on Developer Hub accounts all exist under the Sonomos,
      Inc. org identity. What each one still needs is a credential in
      `~/.config/sonomos/release.env` — see
      [`CREDENTIALS.md`](CREDENTIALS.md) — and, for Edge, one manual
      first-publish in Partner Center, because the Update API can update a
      product but can never create one.

> **Screenshots must come from a real running browser.** The shipped
> extension injects no page UI at all — its only surfaces are the toolbar
> badge and the popup, so a screenshot showing anything else is a
> misleading-imagery rejection under Chrome Web Store policy, and a
> rejection costs a full review cycle at every store you sent it to.


## Submission runbook

1. `npm test && npm run validate` — both must be clean.
2. `npm run package` — writes both zips into `dist/`. The build is
   deterministic (fixed entry order and timestamps), so re-running it on
   another machine produces byte-identical artifacts; AMO source review can
   reproduce them from this repo.
3. Upload `…-chromium.zip` to the Chrome Web Store and, unchanged, to Edge
   Partner Center. Upload `…-firefox.zip` to AMO.
4. Paste the copy above into each listing; answer the privacy/permission
   questions from the sections above.
5. **[HUMAN]** Attach screenshots and the CWS promo tile.

Do not zip the repo by hand. `scripts/zip.mjs` exists because PowerShell's
`Compress-Archive` writes backslash entry names, which violates §4.4.17.1 of
the ZIP spec — the stores then fail the upload with "manifest file not found"
or flatten the directory structure.

## Firefox (AMO) notes

- `gecko.id` is `desktop-connector@sonomos.ai` and must never change — it is
  the add-on's identity; changing it orphans existing installs. It is
  invisible to users.
- `strict_min_version` is `128.0` (the floor for `world: "MAIN"` content
  scripts).
- Suggested AMO slug: `locke-extension`.
- The firefox zip keeps `background.scripts` (event page) and drops the
  Chromium-only keys — `background.service_worker`, `minimum_chrome_version`,
  and the `storage.managed_schema` pointer (Chrome-only; Firefox delivers
  managed storage through a native manifest, so `managed-schema.json` is not
  in this zip). AMO source-code review can point at this public repo.
- Host permissions on MV3 are granted at install from Firefox 127 but remain
  revocable in `about:addons`. Revoking only silences the presence beacon;
  screening is unaffected.

## Edge Add-ons notes

- Edge reuses the **chromium** zip unchanged — do not build a separate
  artifact.
- Partner Center asks the same permission/privacy questions as CWS; reuse
  the answers above.
