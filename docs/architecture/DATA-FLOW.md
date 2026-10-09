# Data flow

How a single AI request travels from the page out to the LLM provider — and how,
before it is allowed to leave, it makes a round-trip into the Locke desktop app
for screening.

The extension is a **hold-and-enforce capture surface**. When any page sends a
bodied request to a host the user/admin has not switched off, the shim HOLDS
it and sends the synthesized raw HTTP request to the desktop app with a
`coverage` hint. The app's guard first **classifies** the request (is this AI
traffic?) and screens it only if it is — or if the hint says `capture_path`
(a catalog AI service's prompt path, or an upload a catalog page started),
which is screened regardless. The shim acts on the verdict: release it
unchanged (`allow`, also the answer for a request classified not-AI), re-issue
it with the screener's rebuilt body (`redact`), or block it.
Detection and redaction still happen **in the desktop app**, never in the
extension — the extension only applies the result. The failure posture is
**fail-closed**: no verdict, no send.

## Components

```
┌──────────────────────────────────────────────────────────────────┐
│ User's machine                                                   │
│                                                                  │
│  ┌──────────────────┐                                            │
│  │ Browser tab      │                                            │
│  │ (chatgpt.com,    │   request → LLM provider proceeds only     │
│  │  claude.ai, …)   │   after an allow/redact verdict ───────────┼──▶ (TLS)
│  │                  │                                            │
│  │  ┌────────────┐  │                                            │
│  │  │ shim.js    │  │  MAIN world; intercepts outbound fetch/XHR │
│  │  │ (MAIN)     │  │  on every page, HOLDS the request,         │
│  │  └─────┬──────┘  │  synthesizes the raw HTTP request (base64),│
│  │        │         │  and enforces the verdict. FAIL CLOSED.    │
│  │  postMessage     │  (SONOMOS_CAPTURE ⇄ SONOMOS_VERDICT,       │
│  │        ▼         │   matched by callId)                       │
│  │  ┌────────────┐  │                                            │
│  │  │content-    │  │  isolated world; round-trip relay. A dead  │
│  │  │script.js   │  │  SW answers null → the shim blocks.        │
│  │  └─────┬──────┘  │                                            │
│  │        │         │                                            │
│  │  chrome.runtime.sendMessage { type: 'capture', requestB64 }  │
│  │        ▼         │                                            │
│  │  ┌────────────┐  │                                            │
│  │  │service-    │  │  connection status, badge, audit log,      │
│  │  │worker.js   │  │  native client; local diagnostics.         │
│  │  └─────┬──────┘  │                                            │
│  │        │         │                                            │
│  └────────┼─────────┘                                            │
│           │ connectNative port (4-byte length-prefixed JSON, stdio)│
│  ┌────────▼─────────┐                                            │
│  │ native messaging │  installed by the Locke desktop app; one   │
│  │ host             │  connection per held request; forwards     │
│  └────────┬─────────┘  bytes, parses nothing.                    │
│           │ length-prefixed JSON over a user-only 0600           │
│           │ Unix domain socket — no network hop                  │
│  ┌────────▼─────────────────────────────────────────────────────┐│
│  │ Locke desktop app  (classify → parse + screen + redact)       ││
│  └────────────────────────────────────────────────────────────────┘
│                                                                  │
│  The app returns a verdict, with a whole rebuilt raw request on   │
│  `redact`. The shim ACTS on it: send as held, send the rebuilt    │
│  body, or block.                                                  │
└──────────────────────────────────────────────────────────────────┘
```

> **Page-side capture surfaces (`content/shim.js`).** `fetch` and
> `XMLHttpRequest` are the only surfaces **held and screened**. There are no
> `WebSocket` or `EventSource` hooks. `navigator.sendBeacon` is hooked but
> cannot be held (it answers synchronously), so a beacon carrying data to a
> catalog prompt path is **refused** — it returns `false` and nothing is sent;
> anywhere else it cannot be classified and is sent. Bodies are
> captured as **exact bytes**: strings as UTF-8; Blob / ArrayBuffer /
> TypedArray / URLSearchParams / FormData serialized once via
> `new Response(body)` (for FormData the generated multipart boundary and its
> matching Content-Type come from that same serialization). What can't be
> captured — a ReadableStream body, an unresolvable target, anything over the
> 8 MiB cap — is in scope but unscreenable and therefore **blocked**, never
> sent unchecked. A synchronous XHR is blocked on a catalog prompt path and
> sent elsewhere, for the beacon's reason.
>
> **Coverage is request-specific.** Scripts are injected on every http(s)
> page (`http://*/*`, `https://*/*`; no `<all_urls>`, so no `file://`).
> `isScreenedUrl` applies provider/disabled-site checks only; the catalog's
> host and capture-path/skip rules now set the `coverage` hint
> (`coverageFor`): `capture_path`, `catalog_host` or `open_web`. A separate
> `isUploadScope` path handles recognized cross-origin object writes initiated
> by a catalog page (HTTPS bodied PUT, or POST with recognized object-write
> headers) and always claims `capture_path`. It needs no new destination host
> permission. Requests the classifier gets wrong, prompts sent by navigation,
> WebSockets, workers, and unholdable sends (`fetchLater`, beacons, sync XHR)
> off catalog prompt paths remain coverage gaps. See
> [`HONEST.md`](../../HONEST.md).
>
> **Without data-sharing consent** (where the browser requires it), nothing
> is relayed: catalog prompt paths are refused, and every other request is
> released untouched, since it could not be classified.

## Where request content lives

| Hop | Contains request content? | Why |
|---|---|---|
| User keystroke → page DOM | yes | This is where the user typed it. |
| `shim.js` page-world | yes | Holds the outbound request; synthesizes method, destination, path/query, page-set headers and body/file bytes as base64. |
| `content-script.js` → service worker | yes | Relays `requestB64` via `chrome.runtime.sendMessage` and returns the verdict. |
| `service-worker.js` | yes (passes through) | Relays `requestB64` to the native host. Never logs bodies — only the receipt metadata and shape-only audit events. |
| Native messaging host | yes | Receives the base64 request, optional provider ID and `coverage` hint for the desktop app. Host implementation and retention are outside this repository. |
| Locke desktop app | yes | Classification, then parse + scan + redaction, happen here — never in the extension. A request classified not-AI is answered `allow` without being scanned. |
| Page → LLM provider | yes | Only after an `allow` (as held) or `redact` (the app's rebuilt body, as bytes). Blocked requests never leave. |

## Local processing and remote destinations

The screening copy travels through `runtime.connectNative` to
`ai.sonomos.desktop` on the same device. There is no configured remote
extension analytics or screening endpoint. Separately, the service worker
uses loopback HTTP at `127.0.0.1:18795` for `/heartbeat` (`browser`, `version`)
and Chromium `/register-extension` (`id`, `browser`, `version`). The browser
adds the extension Origin header. Neither JSON body contains page content.

The page's allowed/redacted request still goes to its original website or
upload destination. “Local screening” does not mean that the user's request
never reaches a remote provider, that no personal data is processed, or that
the desktop app retains no metadata. See the
[product privacy policy](https://sonomos.ai/locke/privacy) for that app's
handling, and [RETENTION.md](../legal/RETENTION.md) for browser-side storage.

## What the record carries

`captureViaHost` sends `{ type: "capture", requestB64, provider? }` to the
native host. `requestB64` contains a synthesized HTTP/1.1 request:

`<METHOD> <path+query> HTTP/1.1`, `Host: <destination>`, page-set headers
(including effective Content-Type), then the exact body bytes. Content can
include prompts, conversation text, personal information and supported files.
Page-set headers can contain authentication information. The browser-added
Cookie header, `sec-fetch-*` and other network-layer additions are outside
the capture. This is not a claim that every captured header is non-sensitive.

For the separate cross-origin upload path, `synthesizeRequest(..., dropQuery)`
omits the query from the screening copy because presigned URL queries carry
upload credentials. The original URL is retained for the page's actual send;
this is not a general removal of all credentials from bodies or headers.

`provider`, when available, is a catalog provider ID. Native status messages
also acknowledge the applied disabled-host list and ignored-entry count.
They are connection/configuration metadata, not body screening records.

## Scope and minimization follow-up

`freezeFetchCall` runs before `isScreenedUrl` / `isUploadScope`. It snapshots
headers and copies mutable body inputs (FormData entries, URLSearchParams,
ArrayBuffer and typed-array bytes) even when a request is later out of scope.
Those requests are not relayed to the native app for screening, but “never
accessed” or “untouched” is too broad. A separate engineering review should
assess moving unnecessary copying behind the scope gate while preserving
request immutability and fail-closed behavior. This disclosure-only change
does not alter that logic.

## Failure modes

All of these follow the same rule: an in-scope bodied request that cannot get a
clean verdict is **blocked** (the fetch rejects / the XHR aborts). The page's
out-of-scope traffic is not relayed for screening (see the snapshot caveat
above).

- **Desktop app unreachable / host not registered**: the native host returns an
  error; the shim maps it to a block. The service worker's heartbeat flips the
  connection status (`disconnected` / `no-bridge`) and the badge reflects it.
- **Extension context torn down** (reload / SW restart): the content script answers
  the shim with a null verdict → block. One cause is told apart from the rest,
  because its remedy is different: an extension reload, update or re-enable
  **orphans the content script in every tab that was already open**, so that tab
  relays on a channel belonging to an extension generation that no longer exists
  and blocks every in-scope request for the life of the tab. Retrying cannot
  clear it; reloading the page can. The content script recognises the browser's
  "Extension context invalidated" and answers with the relay-failure shape
  carrying `extension-reloaded` instead of a bare null — the same block, with a
  reason and an instruction. A sleeping service worker ("Receiving end does not
  exist") keeps the unattributed null, because for that one retrying is the fix.
  Nothing about this reaches the popup: the service worker was never called, so
  no capture failure is recorded (see HONEST.md's note on per-tab evidence).
- **Verdict timeout** (200 s in the shim, settable via `enforceTimeoutMs`; behind
  the worker's 190 s `NATIVE_CALL_TIMEOUT_MS` and the native host's 180 s
  `CAPTURE_DEADLINE`, so the specific diagnosis fires first): block —
  the page never hangs indefinitely, and expiry is never "send the original".
  It must stay above worst-case screening time, or a healthy chain blocks sends
  purely because the shim gave up first.
- **Uncapturable body** (stream / oversized / unreadable): blocked without a
  round-trip — the desktop app never saw it, so it doesn't leave.
- **Unholdable transport** (synchronous XHR, `navigator.sendBeacon` with data)
  on a catalog prompt path: refused without a round-trip. Elsewhere it is
  sent, because it cannot be classified. There is no point at which a verdict could be
  applied, so there is nothing to wait for.
- **Unresolvable target** (a bodied request whose URL will not parse): blocked.
  The shim treats every page as in scope, so a request we cannot even
  address is a "couldn't check" state, not somebody else's traffic.

### Which KIND of block

All four classes are fail-closed; the class says what happened, never whether
the content left. They are kept apart because telling a user their content was
refused when in fact the screener was down sends them hunting for PII they
never sent.

| Class | Means | Branches |
|---|---|---|
| `policy` | the screener looked and said no | `decision-block` |
| `unavailable` | screening never happened, or the chain answered unintelligibly | `verdict-timeout`, `verdict-channel-failed`, `verdict-missing`, `native-call-failed`, `connector-not-started`, `bridge-unreachable`, `bridge-unreadable-reply`, `relay-error`, `relay-rejected`, `extension-reloaded`, `screening-timeout`, `screening-unavailable`, `verdict-malformed`, `decision-missing`, `decision-unknown`, `redact-*`, `internal-error` |
| `too-large` | over the screening size limit — **not** a sensitive-data block | `uncapturable-oversize`, `receipt-too-large` |
| `unsupported` | this surface cannot screen this request at all | `uncapturable-stream`, `uncapturable-document`, `uncapturable-unreadable`, `uncapturable-request-clone`, `uncapturable-sync-xhr`, `uncapturable-beacon`, `scope-unresolvable` |

Every one of these branches names itself on the page console as
`[sonomos] reason=<branch> … action=block kind=<class>`, at `console.warn`.
The request-shape line contains host, path (not query), method, byte counts,
media types and elapsed time, not body bytes or header values. Other console
telemetry can contain a tab URL and CSP URIs, so this is not a guarantee that
all diagnostics are free of identifying data. See the retention inventory.

Beside that machine-shaped line, every block also emits the **human sentence**
— `[sonomos] Request blocked by Sonomos: … [kind=… reason=…]` — at
`console.warn`, on every transport, from one place (`reporter`). That is the
only attribution that does not depend on the page choosing to surface what it
was handed. What each transport can hand it, on top of that line:

| Transport | Channel |
|---|---|
| `fetch`, `fetchLater` | the rejection's `TypeError` message |
| XHR | `sonomosBlocked` / `sonomosBlockReason` / `sonomosBlockKind` / `sonomosBlockMessage`, own properties set on the object *before* the `error` event fires — an event carries no message, and this is the only surface an XHR has that a handler can still read |
| `sendBeacon` | nothing; its only signal is the `false` return |

A blocked XHR also has the `error` event dispatched at it: `abort()` alone
fires nothing when the send was never forwarded, and a page left waiting
forever is the worst shape a fail-closed branch can take. What the shim does
**not** do is draw anything in the page, or synthesize a `status` /
`responseText` that would make the refusal look like a response from the
site's own server.

The healthy allow/redact path logs at `console.debug` and is off unless
`debugLogging` is set (or `SONOMOS_DEBUG = true` is typed into the page
console). A timeout is reported as
`blockedBecause=no-verdict-arrived-not-pii`, because "we found something" and
"we never heard back" must never look alike.

### Sends that were not fully screened

Two reasons are logged at `console.warn` **without** blocking, because the user
needs to know they happened:

- `allow-unchecked` / `redact-unchecked` — the request shipped without a
  complete screen. Reachable only under the user's explicit, time-boxed
  fail-open setting in the desktop app; never a decision the extension makes.
  The line carries how many items went unexamined and their kinds.
- `redact-withheld` — the screener could not examine an attachment, so it
  replaced the attachment's bytes with an inert placeholder and rebuilt the
  request. **Nothing unexamined left the machine**; the line exists because the
  user's prompt now refers to something the model cannot see.

The `unchecked` flag is what separates these two, and it must survive every hop
to the browser — an absent flag and a `false` flag would make a withheld
attachment and a fail-open send read alike.
- **Oversized receipt** (a rebuilt request too large for Chrome's 1 MB
  native-messaging reply cap): the host returns a compact error instead → block.
