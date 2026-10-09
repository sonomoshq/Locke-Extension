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

Reused from the manifest `description` (131 chars, within every store's
132-char limit):

> Connects your browser to the Locke desktop app so web requests are checked
> on-device for AI traffic and screened before they leave.

## Long description

Locke Extension connects your browser to the Locke desktop app for on-device
AI-traffic screening. On every website, for fetch/XHR requests with a body, it
holds the request and transfers the body (including conversation text and
supported uploaded files), method, destination, path/query and page-set headers
to the local app through native messaging. The app first classifies the
request locally — is this AI traffic? — and screens it only if it is, or if it
targets a known AI service's prompt path (ChatGPT, Claude, Gemini, Grok,
Perplexity and others in the built-in catalog), where it is always screened.
The app returns a verdict:

- **allow** — send the held request to the website (also the answer for a
  request classified as not AI, which is released unchanged without being
  screened).
- **redact** — send the desktop app's rebuilt body to the website.
- **block** — do not send the request; the page sees a network error.

No clean verdict means an in-scope request is blocked. A user's explicit
time-boxed fail-open setting in the desktop app can return an unchecked
verdict; the extension reports those sends in its popup.

Content scripts run on every http/https page (never `file://`; no
`<all_urls>`), because the extension no longer decides in the browser which
sites are AI sites — the desktop app's classifier does. Provider policy and
disabled-site settings can take sites back out. Cross-origin uploads started
by a known AI service's page are always screened. Not every action is
covered: navigation/address-bar search prompts, WebSockets, worker traffic,
and beacons or synchronous requests off known AI prompt paths (which cannot
be held, so cannot be classified) are outside this screening path. See https://github.com/sonomoshq/Locke-Extension/blob/main/HONEST.md.

Scanning happens in the local desktop app. The extension does not send
screening copies to a Sonomos cloud service; allowed/redacted page requests
still reach the user's chosen website. Browser-added Cookie headers are not
captured, but page-set headers may include authentication information. The
cross-origin upload screening copy omits presigned URL query credentials.

The extension does not persist request bodies. It stores local settings,
disabled-site configuration and a 100-entry diagnostic audit buffer, plus
session-only connection/screening state and counters. Diagnostic metadata may
include URLs or paths. Local connection requests carry browser/version and,
for Chromium host registration, the extension ID. See
https://sonomos.ai/locke/privacy for local processing and desktop retention.

**Requires the Locke desktop app.** Without a working connection, requests
with a body are blocked — on every website — and the toolbar badge shows the
connection problem, unless the user has opened a time-boxed fail-open window
in the desktop app.

## Category

- Chrome Web Store: **Privacy & Security** (fallback: Productivity → Tools)
- Edge Add-ons: **Privacy** (fallback: Productivity)
- Firefox AMO: **Privacy & Security**

## Single-purpose statement (Chrome Web Store)

> Locke Extension has one purpose: it holds the requests your browser sends
> so the local Locke desktop app can tell, on-device, which are AI traffic and
> scan those, enforcing the app's allow/redact/block verdict before the request
> leaves your machine.

## Permission justifications

Ground truth: `docs/security/PERMISSIONS.md` (kept in sync with the
manifest). Store-form phrasing:

### `storage`
Stores session connection/screening state and counters, and persistent
settings, disabled-site configuration and a 100-entry diagnostic audit log.
The audit buffer does not store request bodies; metadata may contain URLs.
`storage.managed` lets IT admins push policy via `managed-schema.json`.
See [`RETENTION.md`](../legal/RETENTION.md) for keys and lifetimes.

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
over the network. This transfers content and request metadata outside the
browser to a native app on the same device. Allowed/redacted page requests
subsequently travel to their original remote destinations.

### Host permission `http://127.0.0.1/*`
The service worker POSTs `{ browser, version }` to the local app's
`/heartbeat` endpoint about every 30 seconds. When Chromium native-host
registration needs repair, `/register-extension` receives `{ id, browser,
version }`. The browser also supplies the extension Origin. Neither carries
request bodies. The portless host pattern accommodates Firefox; the
extension-pages CSP pins `connect-src` to `http://127.0.0.1:18795`.

### Content-script matches (`http://*/*`, `https://*/*`)
Content scripts run on every http and https page. AI services are not a fixed
list: new AI sites, embedded assistants and AI features inside ordinary sites
appear constantly, and a host list always lags them, leaving exactly the
traffic the user does not know about unscreened. So the extension holds every
request with a body and the desktop app's on-device classifier decides which
ones are AI traffic; the rest are released unchanged, unscreened. Nothing is
sent off the device. The catalog of known AI services still ships in the
package, to mark their prompt paths as always-screened. It deliberately does
NOT request `<all_urls>` (no `file://`/`ftp://`), and adds no host
permission: the only host permission remains loopback.

**Review note.** This is a broad-host-access change from 2.0.x, which matched
24 catalog hosts. Chrome and Edge will show "Read and change all your data on
all websites" and disable the extension on update until the user re-approves;
Firefox prompts similarly. Chrome Web Store review for broad host access is
typically slower — budget for it.

## Privacy disclosures

- **Remote code:** none; scripts ship in the package.
- **Data handled:** request content, supported files and request metadata
  from requests with a body, on any website, are transferred to the local
  desktop app for classification and, where AI, screening. Local
  processing is not a reason to claim that no user data is handled.
- **Destinations:** native messaging to the local app; loopback connection
  endpoints as described above; the page's original destination for
  allowed/redacted requests. No extension analytics endpoint is configured.
- **Local retention:** see [`RETENTION.md`](../legal/RETENTION.md). Do not
  describe diagnostic metadata as guaranteed anonymous or extend the
  extension's no-body-storage claim to desktop databases, logs or crash files.
- **Privacy policy URL:** <https://sonomos.ai/locke/privacy>. This is the
  product-specific policy; the company-wide <https://sonomos.ai/privacy>
  is not a substitute for an extension disclosure.

### Store-specific privacy review checklist

Reviewed against official sources on **2026-10-05**. These are release-review
items, not legal advice, a store approval guarantee, or a record that console
settings have been changed. Build validation checks structure, not the truth
of a privacy declaration.

**Chrome Web Store**

- [ ] **[HUMAN]** Read the current Privacy practices form and reconcile its
      category choices with the request-content/metadata inventory above.
      The [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
      explicitly requires disclosure and a privacy policy for local-only
      handling. That obligation does not itself establish which checkboxes
      are currently selected in the developer console; inspect them directly.
- [ ] **[HUMAN]** Verify the website policy, listing and UI describe the same
      purpose and data flow. Review website content, communications, browsing
      information and any sensitive categories actually handled; do not
      copy a blanket “no data collected” answer into the console.
- [ ] **[HUMAN]** Validate the actual Chrome-API/user-data uses and transfers
      before approving the required [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
      certification and a matching affirmative statement on the product's
      website. Do not paste a Google-API compliance claim without checking
      what data it covers, allowed purposes, transfers and human access.

**Microsoft Edge Add-ons**

- [ ] **[HUMAN]** In Partner Center, declare every relevant category for the
      actual content and metadata handled, including website content and
      communications, and assess browsing/authentication or other sensitive
      information present in the payload. Explain local native-app processing
      and persistent diagnostics. Do not reuse Chrome console answers without
      checking Edge's current form.
- [ ] **[HUMAN]** Match the data-usage certifications, permission reasons,
      listing and policy URL to the same inventory. The official
      [publishing guide, Privacy section](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension#step-6-enter-privacy-information)
      requires accurate category declarations and a policy for personal data
      accessed, transmitted or collected.

**Firefox / AMO and Edge — consent implementation for the next release**

- [x] **[ENGINEERING]** Replace Firefox's `required: ["none"]` with truthful
      request-data categories and optional `technicalAndInteraction`.
- [x] **[ENGINEERING]** Add a focused, versioned consent flow on Firefox and
      Edge, with an older-Firefox fallback, independent optional metadata,
      explicit refusal/uninstall and revocation controls. Prevent request
      content collection/transfer before consent and cancel in-flight work
      after revocation. Chrome behavior remains unchanged.
- [ ] **[RELEASE REVIEW]** Complete the actual-browser and signed-package
      installation/upgrade checklist in
      [DATA-CONSENT.md](../testing/DATA-CONSENT.md). Automated tests are not a
      substitute for store permission prompts or the native desktop pairing.
- [ ] **[STORE OWNER]** Align AMO-hosted privacy copy and all store descriptions,
      links and data disclosures with <https://sonomos.ai/locke/privacy> and the
      version being distributed. Repository edits do not update store text.

**Release hold:** consent code is prepared for review; this does not publish it.
Do not submit Firefox/Edge binaries until release verification and disclosure
alignment are complete. The currently published binary may still have the old
behavior. See [DATA-CONSENT.md](../testing/DATA-CONSENT.md) for the category map,
policy sources, implemented controls and remaining browser verification.

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
- [ ] **[HUMAN]** Verify <https://sonomos.ai/locke/privacy> is reachable and
      its published copy matches the release's actual handling, retention and
      disclosures. Obtain legal sign-off; a source edit alone does not publish
      or verify the hosted policy.
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

1. Complete the store-specific privacy review above; the unresolved Firefox
   consent/declaration item blocks an AMO submission. Then run
   `npm test && npm run validate` — both must be clean.
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
- Review Partner Center's current data-usage categories independently; use
  the Edge checklist above rather than assuming its answers match CWS.
