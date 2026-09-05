# Data flow

How a single AI request travels from the page out to the LLM provider — and how,
before it is allowed to leave, it makes a round-trip into the Locke desktop app
for screening.

The extension is a **hold-and-enforce capture surface**. When the page sends a
bodied request to an AI web surface, the shim HOLDS it, ships the synthesized raw
HTTP request to the desktop app, and acts on the verdict: release it unchanged
(`allow`), re-issue it with the screener's rebuilt body (`redact`), or block it.
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
│  │  │ (MAIN)     │  │  to AI web surfaces, HOLDS the request,    │
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
│  │  │worker.js   │  │  native-messaging client. No PII logged.   │
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
│  │ Locke desktop app  (parse + screen + redact)                  ││
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
> cannot be held (it answers synchronously), so an in-scope beacon carrying
> data is **refused** — it returns `false` and nothing is sent. Bodies are
> captured as **exact bytes**: strings as UTF-8; Blob / ArrayBuffer /
> TypedArray / URLSearchParams / FormData serialized once via
> `new Response(body)` (for FormData the generated multipart boundary and its
> matching Content-Type come from that same serialization). What can't be
> captured — a ReadableStream body, a synchronous XHR, an unresolvable target,
> anything over the 8 MiB cap — is in scope but unscreenable and therefore
> **blocked**, never sent unchecked.
>
> **Three things are out of scope by construction, and all are coverage gaps
> rather than fail-open branches.** Scope is the *request's host*, so an
> attachment `PUT` to pre-signed object storage on an unrelated host is never
> seen as AI traffic. Only requests with a BODY are screened, so a prompt
> carried entirely in a query string (the search surfaces) is not. And the
> hooks live in the page's MAIN world, which a `Worker` / `ServiceWorker`
> scope, a `<form>` submission and a top-level navigation never enter. All
> three are catalogued in [`HONEST.md`](../../HONEST.md).

## Where request content lives

| Hop | Contains request content? | Why |
|---|---|---|
| User keystroke → page DOM | yes | This is where the user typed it. |
| `shim.js` page-world | yes | Holds the outbound request; synthesizes the raw HTTP request (method, path, page-set headers, exact body bytes) as base64. |
| `content-script.js` → service worker | yes | Relays `requestB64` via `chrome.runtime.sendMessage` and returns the verdict. |
| `service-worker.js` | yes (passes through) | Relays `requestB64` to the native host. Never logs bodies — only the receipt metadata and shape-only audit events. |
| Native messaging host | yes (passes through) | Forwards the base64 request to the desktop app verbatim; logs metadata only. |
| Locke desktop app | yes | Parse + scan + redaction happens here — never in the extension. |
| Page → LLM provider | yes | Only after an `allow` (as held) or `redact` (the app's rebuilt body, as bytes). Blocked requests never leave. |

## What never leaves the device via the extension

- The extension makes **no network requests of its own**. The only outbound path is
  native messaging to the same-user native host, which relays over a local
  `0600` UDS. There is no HTTP egress.
- Telemetry events (logged to the service-worker console; no network egress).

## What the record carries

What the native host sends onward is one field:

- `request` — the synthesized raw HTTP/1.1 request, base64:
  `<METHOD> <path+query> HTTP/1.1\r\nHost: <host>\r\n<the headers the page set,
  incl. the effective Content-Type>\r\n\r\n<exact body bytes>`. The browser's own
  network-layer headers (cookies, `sec-fetch-*`, UA ordering) are added after the
  shim's reach and are not part of the capture. Sensitive end to end; relayed,
  never logged.

Nothing accompanies those bytes: no app name, no message list, no extracted
fields. Everything a screener needs is derivable from the request itself, so the
extension parses nothing and asserts nothing about what it captured.

## Failure modes

All of these follow the same rule: an in-scope bodied request that cannot get a
clean verdict is **blocked** (the fetch rejects / the XHR aborts). The page's
out-of-scope traffic is never touched.

- **Desktop app unreachable / host not registered**: the native host returns an
  error; the shim maps it to a block. The service worker's heartbeat flips the
  connection status (`disconnected` / `no-bridge`) and the badge reflects it.
- **Extension context torn down** (reload / SW restart): the content script answers
  the shim with a null verdict → block.
- **Verdict timeout** (45 s in the shim, settable via `enforceTimeoutMs`): block —
  the page never hangs indefinitely, and expiry is never "send the original".
  It must stay above worst-case screening time, or a healthy chain blocks sends
  purely because the shim gave up first.
- **Uncapturable body** (stream / oversized / unreadable): blocked without a
  round-trip — the desktop app never saw it, so it doesn't leave.
- **Unholdable transport** (synchronous XHR, `navigator.sendBeacon` with data):
  refused without a round-trip. There is no point at which a verdict could be
  applied, so there is nothing to wait for.
- **Unresolvable target** (a bodied request whose URL will not parse): blocked.
  The shim runs on AI surfaces and nowhere else, so a request we cannot even
  address is a "couldn't check" state, not somebody else's traffic.

### Which KIND of block

All four classes are fail-closed; the class says what happened, never whether
the content left. They are kept apart because telling a user their content was
refused when in fact the screener was down sends them hunting for PII they
never sent.

| Class | Means | Branches |
|---|---|---|
| `policy` | the screener looked and said no | `decision-block` |
| `unavailable` | screening never happened, or the chain answered unintelligibly | `verdict-timeout`, `verdict-channel-failed`, `verdict-missing`, `native-call-failed`, `connector-not-started`, `bridge-unreachable`, `bridge-unreadable-reply`, `relay-error`, `relay-rejected`, `screening-timeout`, `screening-unavailable`, `verdict-malformed`, `decision-missing`, `decision-unknown`, `redact-*`, `internal-error` |
| `too-large` | over the screening size limit — **not** a sensitive-data block | `uncapturable-oversize`, `receipt-too-large` |
| `unsupported` | this surface cannot screen this request at all | `uncapturable-stream`, `uncapturable-document`, `uncapturable-unreadable`, `uncapturable-request-clone`, `uncapturable-sync-xhr`, `uncapturable-beacon`, `scope-unresolvable` |

Every one of these branches names itself on the page console as
`[sonomos] reason=<branch> … action=block kind=<class>`, at `console.warn`.
Shapes only — host, path (never the query string), method, byte counts, media
types, elapsed ms. Bodies and header values never appear.

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
