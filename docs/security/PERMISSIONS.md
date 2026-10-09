# Permission justifications

Every entry in `manifest.json`'s `permissions`, `host_permissions`,
and `content_scripts` is documented here. This file is the ground
truth for store-listing submissions and IT vendor reviews.

## API permissions

### `storage`
**Why:** `storage.local` holds settings, the last applied disabled-site
configuration and a 100-entry diagnostic audit buffer. `storage.session`
holds connection/screening state, counters and retry/scheduling metadata;
it survives worker eviction but is cleared on browser restart. Managed
policy uses `storage.managed` (see `managed-schema.json`). See the
[retention inventory](../legal/RETENTION.md) for exact keys and lifetimes.

The audit log captures seven event kinds: `daemon-down`,
`daemon-recovered`, `bridge-missing`, `policy-loaded`,
`csp-violation`, `screening-unavailable` and `screening-restored`.
(Corrected 2026-08-21: this listed five; the two `screening-*` kinds
were added to `AUDITED_KINDS` without the count following.) Entries contain
event/error metadata, not captured request bodies. CSP events can include
URLs and source-file information, so “shape-only” is not an anonymity
guarantee. Adding a new kind requires updating `AUDITED_KINDS` in
`background/service-worker.js`.

**Could we do without it?** No — without it the extension would lose
connection state on every service-worker restart (MV3 workers are
ephemeral) and admins would lose both the policy channel and the
audit trail.

### `alarms`
**Why:** drives the periodic health check that keeps the toolbar
badge accurate (empty when connected and screening, a glyph when
not — the badge is also re-derived from each capture's own evidence,
so an outage or a fail-open send marks it without waiting for the
next beat) and the loopback presence beacon to the Locke desktop app. The default
cadence is 30 s with exponential backoff on failure, exposed via
`chrome.storage.managed` for admins who want it tighter or looser.

**Could we do without it?** Not without using a more aggressive
mechanism (a persistent worker, polled via `setInterval`) which MV3
doesn't allow service workers to do.

### `nativeMessaging`
**Why:** this is *the* core capability. Each held AI-website request
travels to the local native messaging host over the OS
native-messaging channel (stdin/stdout JSON frames), which relays it
to the Sonomos desktop app for scanning and returns the verdict the
shim enforces. The transfer includes body/file bytes and request metadata
(method, destination, path/query and page-set headers), plus a provider ID
when available. It crosses the browser-process boundary on the same device;
it is still data handling and must be disclosed. The
`ai.sonomos.desktop` host name is pinned across the manifest
templates, the host, `shared/constants.js`, and
`tests/constants.test.js`.

**Could we do without it?** No — this is the entire point of the
extension. Removing it would mean the extension has nothing to do.

## Host permissions

### `http://127.0.0.1/*`
**Why:** the only outbound network endpoint the extension can reach,
and it is loopback-only. The pattern carries no port because Firefox
treats match patterns with an explicit port as matching **nothing**
(Bugzilla 1362809 and 1468162) — Chrome accepts a port here and
matches it correctly, so Firefox is the binding constraint, and
narrowing this to `http://127.0.0.1:18795/*` would silently drop the
permission on AMO builds and start failing the presence beacon there.
The control that actually bounds the port is the extension-pages CSP,
which pins `connect-src` to `http://127.0.0.1:18795`, so in practice
only that port is reachable; both the portless pattern and the pinned
CSP are asserted by `tests/manifest.test.js`.
`[reviewed again 2026-09-08]` The Locke desktop app runs a presence
listener on port
18795; on a fixed 30-second presence tick — its own alarm, NOT the
health check's, which backs off to 5 minutes when the desktop app is
down — the service worker POSTs `/heartbeat` with `{ "browser":
"<id>", "version": "<manifest version>" }` so the app can show
install/connected state per browser. The two were one tick until the
backoff was found silencing "I am installed" for up to five minutes
against a listener that calls a heartbeat stale at 45 seconds. The heartbeat
JSON contains exactly those two fields, not page content; the browser also
sends its extension Origin header. The call is fire-and-forget: the app not
running is the normal case and every failure is swallowed
(`sendPresenceBeacon` in `background/service-worker.js`).

**Registration metadata.** On a missing/refused native-host connection,
Chromium also POSTs `{ id, browser, version }` to `/register-extension`.
The `id` is the extension ID, not a Sonomos account ID. This is a separate
local connection-repair request, not the two-field heartbeat or the content
screening channel (`requestHostRegistration`).

**How the desktop app knows it is us.** Both POSTs on this origin
(`/heartbeat` and `/register-extension`) are identified by the
request's `Origin` header — `chrome-extension://<id>` or
`moz-extension://<uuid>` — which the browser sets and a page cannot
forge, and the app answers CORS for that exact origin rather than with
a wildcard. Neither call sets a `fetch` `mode`, which is what keeps
the header present: `mode: "no-cors"` would strip it, silently, while
the fire-and-forget calls carried on looking fine. The header itself is
the browser's to attach and no test in this repo can observe it; what
`tests/service-worker.test.js` pins is that neither request's options
grow a `mode`, `credentials`, or a second header.

**Could we do without it?** Only by giving up the desktop app's
"extension connected" UI — the app would have no way to know the
extension exists. Held requests do NOT use this channel; they go
through native messaging.

**Why this and nothing else?** The extension is loopback-only by
deliberate design — see `SECURITY.md` A1. There is no remote
`host_permissions` entry and no HTTP daemon for page data.

**Firefox note.** From Firefox 127 MV3 host permissions are shown in
the install prompt and granted on install, but a user can revoke them
later from `about:addons`. Nothing breaks if they do: the beacon is
fire-and-forget, so the only consequence is that the desktop app stops
showing "extension connected" for that browser. Screening is
unaffected — held requests never use this channel.

## Data collection declaration (Firefox / AMO)

**Unresolved before a future release:** the source still declares
`browser_specific_settings.gecko.data_collection_permissions` as
`{ "required": ["none"] }`, supports Firefox 128+, and has no data-consent UI.
The earlier rationale that native messaging stays on-device and therefore
justifies `none` is withdrawn. Mozilla's
[Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/#data-collection-and-transmission-disclosure-and-control)
explicitly apply data-transmission disclosure and user controls to native-app
transfers. The extension transfers request content and metadata that may
contain personal information.

The [store checklist](../store/LISTING.md#store-specific-privacy-review-checklist)
requires an approved, implemented and verified consent/disclosure solution
covering the supported Firefox versions before the next AMO submission.
Manifest tests pinning `none` check the current artifact, not compliance.
This documentation correction does not change manifest permissions, consent
behavior or store-console declarations.

## Content script matches

### MAIN-world `shim.js` — every http(s) page: `http://*/*`, `https://*/*`
**Why:** wraps `fetch` / `XMLHttpRequest` on every web page, holding bodied
requests until the desktop app returns a verdict. Since the discovery gate
(super PR #15) the extension does not decide which sites are AI sites: the
desktop app's on-device classifier does, the same one the Proxy defers to.
A host list always lags the AI features people actually use — new chat
sites, assistants embedded in ordinary sites — and the traffic it misses is
precisely the traffic nobody knew to list. So every bodied request is held
and classified; a request classified not-AI is released unchanged and
unscreened.

The surface catalog (`shared/ai-surfaces.json` → `web_hosts`) still ships,
generated into `content/web-surfaces.generated.js` by
`scripts/generate-surfaces.mjs`, but it no longer decides where we inject. It
decides the `coverage` hint each capture carries (`content/shim.js`
`coverageFor`): `capture_path` (a catalog host's prompt path, or an upload a
catalog page started — screened regardless of the classifier), `catalog_host`
(a catalog host off its prompt paths) or `open_web` (anything else) — the
last two classified first. The generator writes the two match patterns;
`tests/manifest.test.js` pins them, and `scripts/store-build.mjs` refuses any
match that reaches past http(s) (`<all_urls>`, `*://`, `file://`).

**What still bounds it.** No new host permission (loopback only, below); the
user's disabled-site list and an admin's `allowedProviders` policy still take
catalog sites out; where the browser requires data-sharing consent, nothing
off a catalog prompt path is relayed until it is given; and the unholdable
transports (`sendBeacon`, `fetchLater`, synchronous XHR) are refused only on
catalog prompt paths — elsewhere they cannot be classified, so they pass.

**Which frames?** `all_frames` injects into every frame whose *own* url
matches — not every frame of a matching tab. `match_about_blank` and
`match_origin_as_fallback` extend that to frames an already-matching
origin created but which have no matchable url of their own
(`about:blank`, `about:srcdoc`, `blob:`, `data:`). Neither key reaches
any origin that is not already in the list above: they widen *frames*,
never *hosts*, and add no `host_permissions`.

**Why not `<all_urls>`?** It adds `file://` and `ftp://` pages, which no web
prompt travels over. Every http(s) page is the ceiling. See
[DATA-FLOW.md](../architecture/DATA-FLOW.md) for the distinction between
injection, local input snapshots and native-app transfers.

**What about the cross-origin uploads it screens?** A `matches` entry
governs *where the script runs*, not which destinations the page it runs
in may address. Once injected, the shim is page JavaScript wrapping that
page's own `fetch`/`XHR`, so it observes every request the page makes
regardless of destination — no host permission is involved, because the
extension is not the one making the request. That is what lets the shim
hold a pre-signed `PUT` to object storage **without** adding a storage
host to `matches`, to `host_permissions`, or to the surface catalog. The
upload scope (screened regardless of the classifier) is bounded by the
initiating page (`pageIsAiSurface` in `content/shim.js`), which is the
catalog list; every other cross-origin request is ordinary capture, held and
classified like any other.

### Isolated-world `content-script.js` — the same patterns
**Why:** receives the held request from `shim.js` via
`window.postMessage` (page world → content script bridge),
round-trips it through the service worker, and answers the shim with
the verdict. Must match the shim's host list exactly.

## What we deliberately don't have

| Permission | Why not |
|---|---|
| `cookies` | Never needed — the extension doesn't manipulate user sessions. |
| `webRequest` / `declarativeNetRequest` | The shim intercepts at the page-world `fetch`/`XHR` layer, not the network layer. Less invasive. |
| `tabs` / `activeTab` | No tab access at all — the popup only renders stored connection state. |
| `scripting` | All content scripts are static manifest entries; nothing is injected at runtime. |
| `history` / `bookmarks` / `downloads` | No use case. |
| `debugger` | Massive privilege; never needed. |
| `clipboardRead` / `clipboardWrite` | The screening flow is page-bound; clipboard is out of scope. |
| `notifications` | All user-facing UI is the toolbar badge and the popup. |
| `geolocation` / `unlimitedStorage` / `system.cpu` | No use case. |
| `<all_urls>` host permission | Unnecessary for the supported-host scope; not requested. |

This list exists so a reviewer (or store-listing maintainer) can
scan a single doc to understand why every privilege is justified.
