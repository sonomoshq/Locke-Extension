# Permission justifications

Every entry in `manifest.json`'s `permissions`, `host_permissions`,
and `content_scripts` is documented here. This file is the ground
truth for store-listing submissions and IT vendor reviews.

## API permissions

### `storage`
**Why:** the extension persists three things: the connection-state
cache (`storage.session`, cleared on browser restart), popup UI
state, and an audit-log ring buffer (`storage.local`, so an admin
investigating "what happened on this user's machine yesterday" can
pull the trail without live debugging access). Managed-policy reads
use `storage.managed` (see `managed-schema.json`).

The audit log captures seven event kinds: `daemon-down`,
`daemon-recovered`, `bridge-missing`, `policy-loaded`,
`csp-violation`, `screening-unavailable` and `screening-restored`.
(Corrected 2026-08-21: this listed five; the two `screening-*` kinds
were added to `AUDITED_KINDS` without the count following.) Each entry
is shape-only — never PII, never request bodies. Adding a new kind
requires updating `AUDITED_KINDS` in `background/service-worker.js`.

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
shim enforces. That's how page data reaches the desktop app across
the browser-process sandbox — it never touches a network socket. The
`ai.sonomos.desktop` host name is pinned across the manifest
templates, the host, `shared/constants.js`, and
`tests/constants.test.js`.

**Could we do without it?** No — this is the entire point of the
extension. Removing it would mean the extension has nothing to do.

## Host permissions

### `http://127.0.0.1/*`
**Why:** the only outbound network endpoint the extension can reach,
and it is loopback-only. The pattern carries no port because Firefox
treats match patterns with an explicit port as matching nothing
(Bugzilla 1362809); the extension-pages CSP still pins `connect-src`
to `http://127.0.0.1:18795`, so in practice only that port is
reachable. The Locke desktop app runs a presence listener on port
18795; on a fixed 30-second presence tick — its own alarm, NOT the
health check's, which backs off to 5 minutes when the desktop app is
down — the service worker POSTs `/heartbeat` with `{ "browser":
"<id>", "version": "<manifest version>" }` so the app can show
install/connected state per browser. The two were one tick until the
backoff was found silencing "I am installed" for up to five minutes
against a listener that calls a heartbeat stale at 45 seconds. The payload is exactly those two fields — no page data,
no identifiers — and the call is fire-and-forget: the app not
running is the normal case and every failure is swallowed
(`sendPresenceBeacon` in `background/service-worker.js`).

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

`browser_specific_settings.gecko.data_collection_permissions` is
`{ "required": ["none"] }`. Since 2025-11-03 AMO requires every new
add-on to declare what personal data it collects or transmits, and
Firefox surfaces that declaration in the install prompt.

`none` is the accurate answer: the extension has no analytics, no
telemetry endpoint, and no account. What it stores stays in the
browser profile (connection state, popup state, the shape-only audit
log); what it sends leaves only via native messaging to the same-user
desktop app, plus a `{ browser, version }` loopback beacon. Nothing
crosses the machine boundary.

If that ever changes — any field added to the beacon, any remote
endpoint — this declaration must change with it in the same commit;
`tests/store-build.test.js` pins the current value so the change
cannot be silent.

## Content script matches

### MAIN-world `shim.js` — 24 catalog hosts, 48 patterns
**Why:** wraps `fetch` / `XMLHttpRequest` on the specific AI
surfaces the Sonomos product line knows about (chat UIs +
search hosts), holding in-scope bodied requests until
the desktop app returns a verdict. The host list is generated from the
vendored surface catalog (`shared/ai-surfaces.json` → `web_hosts`)
by `scripts/generate-surfaces.mjs`, which also rewrites the
manifest `matches` — there is no hand-maintained copy to drift.
`content/web-surfaces.generated.js` loads first to provide the host
list as a global.

**Why two patterns per host?** The catalog's own host rule treats an
entry and every subdomain of it as the same host, and `shim.js` has
always enforced that rule. The
generator therefore emits `https://<h>/*` **and** `https://*.<h>/*` per
entry — 48 patterns for 24 catalog hosts — so the set of pages we are
injected on matches the set of destinations we already screen. Listing
the exact spellings only meant a surface served from a subdomain
(`www.perplexity.ai`) got no hooks at all. The catalog bounds the
wildcard: it names `www.google.com`, not `google.com`.
`tests/manifest.test.js` checks both directions against the real catalog
file — every catalog spelling injected, and `notclaude.ai` /
`accounts.google.com` not. It also fails if the manifest names a host the
catalog no longer lists, so a host removed upstream cannot keep its injection
because someone forgot `npm run generate`.

**Why inject on search hosts we screen nothing on?** Fair question, and the
answer is not "for coverage". The catalog marks `www.google.com`,
`www.bing.com`, `search.brave.com`, `duckduckgo.com`, `kagi.com` and
`you.com` as `web_screening: "none"`: what a user types into those search
boxes leaves as a top-level **navigation**, which no hook in this extension
observes — the manifest holds no `webRequest`, `webNavigation` or
`declarativeNetRequest` permission, and a query typed into the address bar
never reaches the page at all. They stay in `web_hosts` for a different
reason: that list is also the shim's request-**target** scope set, and
`duck.ai`'s chat XHRs target `duckduckgo.com` while Kagi Assistant is reached
through `kagi.com`. Removing them would delete real screening on a different
page. Anything that does leave one of these hosts as a bodied `fetch`/`XHR`
is screened normally. See `HONEST.md` for the full statement and for why
screening navigation-borne prompts is deferred to 1.x.

**Which frames?** `all_frames` injects into every frame whose *own* url
matches — not every frame of a matching tab. `match_about_blank` and
`match_origin_as_fallback` extend that to frames an already-matching
origin created but which have no matchable url of their own
(`about:blank`, `about:srcdoc`, `blob:`, `data:`). Neither key reaches
any origin that is not already in the list above: they widen *frames*,
never *hosts*, and add no `host_permissions`.

**Could we use `<all_urls>`?** Could, but extension risk-rating
tools (Spin.AI, ExtensionTotal) score that as "broad host access" by
default. Scoping to named hosts drops the risk score by a tier and
matches the principle of least privilege.

**What about the cross-origin uploads it screens?** A `matches` entry
governs *where the script runs*, not which destinations the page it runs
in may address. Once injected, the shim is page JavaScript wrapping that
page's own `fetch`/`XHR`, so it observes every request the page makes
regardless of destination — no host permission is involved, because the
extension is not the one making the request. That is what lets the shim
hold a pre-signed `PUT` to object storage **without** adding a storage
host to `matches`, to `host_permissions`, or to the surface catalog. The
capture is bounded by the initiating page (`PAGE_IS_AI_SURFACE` in
`content/shim.js`), which is this same catalog list, so the reviewable
blast radius is exactly what is written above and nothing wider.

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
| `<all_urls>` host permission | Would defeat the loopback-only architecture. |

This list exists so a reviewer (or store-listing maintainer) can
scan a single doc to understand why every privilege is justified.
