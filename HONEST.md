# Honest assessment

This document catalogs every known limitation of the Sonomos Desktop
Connector browser extension that a sophisticated buyer, security
researcher, or auditor might discover. We publish it because we'd
rather you find these limits here than in a procurement bake-off, a
pen-test report, or a customer-facing incident.

If a limitation is missing from this list, that's a documentation
bug — file an issue. We don't want there to be daylight between what
we know and what we say.

**Last updated:** 2026-08-18. Reviewed every release pass.

---

## What this product is NOT

- **It has no SOC 2 report, and no SOC 2 engagement exists.**
  `[corrected 2026-08-21]` — this used to say "not audited *yet*",
  which reads as an engagement running somewhere. There isn't one:
  no auditor has been selected, no gap assessment has been done, no
  observation window has opened, and no date is set for any of that.
  Nor is there an ISO 27001 certificate or any other independent
  attestation. Every security claim in this repository is
  self-asserted and evidenced by a file you can open.
- **It is not pen-tested by a third party yet.** Internal red-team
  activity exists; an independent engagement is unscheduled.
- **It does not have a live bug bounty.** The program is fully
  designed in [`docs/security/BUG-BOUNTY.md`](docs/security/BUG-BOUNTY.md)
  with safe-harbour and rules of engagement, but paid submissions
  are not yet accepted. Currently kudos + acknowledgement only on
  [`docs/security/DISCLOSURE-LOG.md`](docs/security/DISCLOSURE-LOG.md).
- **It is not listed on the Chrome Web Store, Edge Add-ons, or
  Mozilla AMO.** Maintainer-deferred until the product is more
  built out. Today's deployment path is force-install via managed
  policy + signed self-hosted artifact (see
  [`docs/enterprise/DEPLOYMENT.md`](docs/enterprise/DEPLOYMENT.md)).
  Most large enterprise IT teams treat sideload-only as a friction
  point.
- **It is not OSI-licensed in the public repo.** `LICENSE-MIT` and
  `LICENSE-APACHE` were deliberately removed; `TODO.md` flags the
  open question. External contributors who require certainty about
  licensing terms should reach out before submitting non-trivial
  changes.
- **It does not yet have a registered trademark.** "Sonomos" is used
  as a brand without a TM filing. No trademark policy exists.

## Legal docs are DRAFT

Every legal artifact in this repo is a **draft pending revision and
review by the legal reviewer**. Do not present any of these to a
customer as binding before that review:

- [`docs/legal/DPA-template.md`](docs/legal/DPA-template.md)
- [`docs/legal/DPIA-template.md`](docs/legal/DPIA-template.md)
- [`docs/legal/RETENTION.md`](docs/legal/RETENTION.md)
- [`docs/legal/SUB-PROCESSORS.md`](docs/legal/SUB-PROCESSORS.md)
- [`EXPORT_CONTROL_NOTICE.md`](EXPORT_CONTROL_NOTICE.md)

Indemnification language in the DPA is a placeholder. The MSA the
DPA references is not yet a public artifact. Cyber-liability
insurance status is undisclosed.

## Threat model — acknowledged residuals

See [`SECURITY.md`](SECURITY.md) for the fuller threat model with
mitigations. The most important thing to understand about this
extension is what it is *for*: it is a **hold-and-enforce capture
surface** for AI web apps. The shim holds an in-scope request until
the desktop app returns a verdict and then sends it, sends the app's
rebuilt (redacted) request, or blocks it — **fail-closed**: no
verdict means no send. The residuals we accept and document:

- **The extension enforces the verdict; it does not detect.** All
  scanning and redaction happen in the Locke desktop app; the shim
  only applies the result. If the host or the desktop app is
  unavailable, in-scope bodied requests to AI surfaces are
  **blocked** (the fetch rejects / the XHR aborts) — the
  availability of AI sites degrades rather than data leaking
  silently. There is no "send unmasked / cancel" prompt in the
  extension; fail-open is a per-user toggle the desktop app applies,
  not something the extension decides.
- **A surface the user switched off in the desktop app is not
  screened, and that is the point.** The desktop app writes
  `~/.sonomos/surfaces.local.json`; the native host reads its
  `disabled_web_hosts` field and returns it on the `status` reply the
  service worker already polls, which stores it and pushes it to each
  shim. A host in that set is treated as out of scope: its requests
  are never held, never sent for screening, and pass through untouched.
  Three things about this are deliberate. It is **subtractive** — the
  set can only remove a host from the scope the published manifest
  already declares, so nothing in that file, from any author, can
  make us inject into or screen a host we do not already ship.
  It **survives the desktop app being down**: the set is kept in
  `storage.local` and a host we cannot reach leaves it standing,
  because "off" has to keep meaning "Locke leaves this site alone" —
  otherwise the site the user took out of scope is the one that
  starts failing closed the moment the app stops. And it is
  **applied late**: the set arrives after `document_start`, so a
  request issued in the first moments of a page load can still be
  held and screened on a surface that is switched off. That error is
  in the over-screening direction and self-corrects on the next
  request.
- **The page↔shim channel is `window.postMessage` and is forgeable.**
  A hostile *page* can observe or forge `SONOMOS_CAPTURE` /
  `SONOMOS_VERDICT` messages, and `SONOMOS_CONFIG` with them — which
  since the disable set rides that channel means a page can switch
  *itself* out of scope. We accept this: the channel carries no
  secret, and the worst any of it can do is downgrade to "send the
  original" — which a hostile page could already do by issuing the
  request through a transport we don't hook, at lower cost than
  forging anything. It can never read anything, force a redacted body
  to leak, or put a host we do not ship *into* scope. On a
  cooperative site this is a non-issue; on a hostile one there is
  nothing to gain.
- **Capture coverage is `fetch` + `XMLHttpRequest` only.** There are no
  `WebSocket` or `EventSource` hooks. AI traffic a site sends over
  those transports is not screened or gated. Two APIs cannot be *held*
  at all — both answer synchronously and the browser then sends on its
  own schedule, so there is no point at which a verdict could be
  applied — and an in-scope call carrying data on either is **refused**
  rather than let through: `navigator.sendBeacon` (returns `false`) and
  `fetchLater()`, the Deferred Fetch API (throws a `TypeError`, which is
  what its callers already handle for a stream body or an exceeded
  quota). Each is refused with its own API's failure signal; neither is
  ever silently dropped.
  **The rest of the outbound sweep, and why each is where it is:**
  `WebTransport` is a bidirectional stream transport, the same class as
  `WebSocket` — unhooked, and it would need a design of its own rather
  than a refusal. **Background Fetch**
  (`registration.backgroundFetch.fetch`) can carry an upload body and is
  **not hooked**: it is a download-oriented API, no catalog surface uses
  it, and the only thing we could do with it is refuse — so this one
  fails toward "we did not look", deliberately and on the record rather
  than by omission. `<a ping>`, `<form method="POST">`, top-level
  navigations and CSP/reporting endpoints are not script calls and are
  out of reach of any hook in this file.
  Within the hooked transports, bodies are captured as exact bytes
  (strings, Blob, ArrayBuffer, TypedArray, URLSearchParams, FormData —
  including the multipart boundary as serialized); what can't be
  captured faithfully (a ReadableStream body, a synchronous XHR,
  anything over the 8 MiB shim cap) is **blocked**, never sent
  unscreened.
- **The hooks only exist where the shim runs, which is the page's own
  MAIN world.** A MAIN-world content script is not injected into
  `Worker`, `SharedWorker` or `ServiceWorker` scopes, so a request a
  site issues from one of those has an unwrapped `fetch` and is neither
  screened nor gated. The same is true of a plain `<form method="POST">`
  submission and of top-level navigations, which are not script calls at
  all.
- **Which frames get hooks, stated precisely — the old wording here was
  wrong.** This file used to say "`all_frames` is on, so same- and
  cross-origin iframes on a covered page each get their own hooks". That
  is not what `all_frames` means. `all_frames` injects into every frame
  **whose own URL matches `content_scripts.matches`** — not into every
  frame of a matching tab. So a cross-origin iframe to a host outside
  the catalog gets no hooks (it is also unreachable from the parent, so
  it is not a bypass), and — the part that *was* a bypass — a frame with
  no matchable URL of its own got none either. A page could
  `document.createElement('iframe')`, leave it at `about:blank`, and use
  `frame.contentWindow.fetch`: a pristine, unhooked `fetch` in the
  parent's own origin. `srcdoc` and `blob:` frames were the same hole.
  The manifest now declares `match_origin_as_fallback` (Chrome 99+,
  Firefox 128+ — both at or below the minimums this extension already
  requires) and `match_about_blank`, which extend injection to frames
  **created by an already-matching origin** whose own URL is `about:`,
  `data:`, `blob:` or `filesystem:`. No host permission and no catalog
  entry was added to do it: the reach is exactly the frames a page we
  already cover made for itself. Inside `about:blank`, `about:srcdoc`
  and `blob:` frames the shim resolves relative URLs and its own page
  identity against the base the frame inherited from its creator, so
  both the AI-host scope and the initiator-scoped upload path work there
  rather than degrading to `scope-unresolvable`. **A `data:` frame gets
  only half of that** — this file used to claim it got both. A `data:`
  document does not inherit its creator's base URL the way
  `about:blank` and `about:srcdoc` do (`document.baseURI` is the `data:`
  URL itself), so the shim has no initiator to read there: `PAGE_HOST`
  is empty, the frame is not treated as an AI surface, and the
  cross-origin upload scope — which is defined *on* the initiator —
  cannot fire in it. The AI-host scope still does, because that one
  reads the request's own host. **What is still open:** Firefox does not
  inject into empty iframes at `document_start`, so a frame that issues
  a request before its first document is committed can still slip past
  there; a browser older than those versions ignores the keys silently;
  and none of this is a defence against a *hostile* page, which can
  always reach a pristine `fetch` (see the forgeable-channel bullet
  above) — it is a defence against a cooperative site whose upload or
  worker-ish path happens to live in one of these frames.
- **Injecting into a frame is not the same as being able to ask about
  it, and for a while it wasn't.** Everything above buys nothing unless
  the shim can reach the extension, and that hop is a
  `window.postMessage` back into its own window. It named
  `location.origin` as the target, which is the origin of the *frame's
  URL*, not of its *document* — and those differ in exactly the frames
  the keys above opt into. In an `about:blank`, `about:srcdoc` or
  `data:` frame `location.origin` reads the string `"null"`, which is
  truthy (so the `|| '*'` fallback never fired) and is not a parseable
  URL, so `postMessage` threw and every held request in the frame was
  refused as `verdict-channel-failed` — a fail-CLOSED refusal, so
  nothing leaked, but its advice was to reload a frame whose origin is
  opaque by construction. In a *sandboxed* frame at a catalog URL the
  same call read the real origin, matched the frame's opaque document
  origin against it, and silently dropped the message: the request hung
  for the full 45 s enforce ceiling and was then refused as
  `verdict-timeout`, blaming a desktop app that had never been asked.
  Both posts now name no origin at all, which is the only spelling that
  works in every frame and gives nothing away — the message never leaves
  the window, both ends already reject any `event.source` that is not
  it, and `targetOrigin` filters by the receiving document's origin
  rather than by listener, so the page could read these posts whatever
  we passed.
- **The extension and the catalog used to disagree about what a
  protected surface is, and the extension lost.** The catalog's rule is
  that an entry means itself *and every subdomain of it*,
  case-insensitively, trailing dots stripped. The
  shim's `isAiHost` has always enforced that rule, but
  `content_scripts.matches` was generated with the catalog's exact
  spellings only — so on a surface served from a subdomain
  (`www.perplexity.ai` is the live example; `perplexity.ai` redirects
  there) the shim was never *injected*, and coverage was not partial, it
  was nil. `matches` is now generated as the match-pattern spelling of
  the same rule (`https://<h>/*` **and** `https://*.<h>/*`), and
  `tests/manifest.test.js` checks every catalog spelling against the
  real catalog file mechanically. This
  widens **where we inject** and nothing else: the shim's scope test was
  already `host_matches`, so every request this now screens is one it
  would already have screened had it been running. What bounds it is the
  catalog's own care — it lists `www.google.com`, not `google.com`,
  precisely so a wildcard cannot swallow all of Google. `isAiHost` also
  now strips trailing dots, closing an absolute-FQDN evasion
  (`chatgpt.com.`).
- **Cross-origin attachment uploads are now screened, by initiator
  rather than by destination — but only the shapes we can recognise.**
  Several AI web apps do not upload attachment bytes to their own
  origin: they mint a pre-signed URL and `PUT` the file to object
  storage on an unrelated host. Scoping on the request's *destination*
  missed all of it. The shim now also holds a **cross-origin object
  write initiated by a catalog AI surface**: an `https` request with a
  body, whose method is `PUT`, or whose method is `POST` and which
  declares an object write in its own headers (`x-goog-upload-*`,
  `x-ms-blob-*`, the S3 object-write headers, `x-bz-file-name`).
  Nothing was added to the surface catalog to do this and no host
  permission was added: the shim already runs in the page, so the
  request's initiator is not inferred, it is the document we were
  injected into — and `content_scripts.matches` is generated from the
  same catalog, so the blast radius is exactly the surfaces we already
  covered. What the extension holds is bounded by the page, never by
  the destination; a `PUT` from any other page is untouched.
  **What is still not covered:** a POST-shaped upload that declares
  nothing we recognise (an S3 POST-policy form upload, a bespoke
  endpoint) still leaves unscreened. Each chunk of a **chunked or
  multipart** upload is screened independently, so a value split across
  a chunk boundary can be missed. Files over the shim's 8 MiB cap are
  **blocked**, not sent unscreened — an availability change on a path
  that previously always succeeded. Same-origin uploads (a
  `multipart/form-data` POST back to the AI host, which is what
  Claude's web app does) are captured as they always were. See the
  upload-specific refusals two bullets down.
- **On the upload path, an unexaminable file is blocked rather than
  withheld, and a checksum-committed body is never rewritten.**
  Withholding replaces an attachment the screener could not examine with
  an inert 1×1 placeholder so the rest of a chat prompt still ships —
  the right trade in a multipart POST. On a raw object write the
  attachment *is* the whole body, so withholding would `PUT` a 69-byte
  placeholder into the bucket, the site would record a successful
  upload of the user's file, and the model would be shown a blank
  square with nobody told. So a withhold on this path is a **block**
  (`upload-withheld`) — nothing left the machine either way, and this
  way we can say so. Likewise, if the request commits to its exact
  bytes (`Content-MD5`, a real `x-amz-content-sha256`, `x-goog-hash`)
  we cannot recompute the checksum for a redacted body, so a `redact`
  becomes a block (`upload-integrity-locked`) rather than an upload the
  storage provider rejects with an error the user reads as "the site is
  broken". A clean `allow` always ships the original bytes untouched,
  checksum intact.
- **A pre-signed URL's query string is a credential, and it does not
  cross the seam.** On the upload path the synthesized raw request
  carries the path only — the `X-Amz-Signature` / `X-Goog-Signature` /
  Azure `sig=` bearer capability is dropped before anything is sent for
  screening, and the object key (very often the user's filename) is kept
  off the console too, so an upload diagnostic names the host and
  `scope=upload` and nothing else. Enforcement is unaffected: the
  release or re-issue always goes out on the page's own original URL.
- **Only requests with a BODY are screened, and a prompt that arrives
  on a URL is not one.** This is the largest coverage hole in the
  extension, and it is worth stating exactly, because its shape is not
  "a few sites are missing".

  *What is screened:* the body of a script-issued `fetch` /
  `XMLHttpRequest` on a catalog `web_host`. That is what a chat box
  does — the prompt *is* the POST body — and it is held, screened and
  enforced as described above.

  *What is not screened:* a prompt that reaches the provider as a
  top-level **navigation**. Four everyday ways of doing that, none of
  them hooked: typed into the browser's **address bar**; sent to
  whatever engine the user set as their **default search engine** (the
  address bar again, one step removed); followed as a **`?q=` deep
  link** from another page or app; or submitted by a **`<form>`** —
  including `method="post"`, which looks bodied but is a browser
  navigation rather than a script call, and is unhooked exactly like a
  `GET`.

  The address-bar case bounds what any future page-side fix could
  achieve, so it gets its own sentence: **a query typed into the
  address bar never touches the page at all.** No content script — no
  matter how early it runs or how many transports it wraps — can
  observe a request the renderer is never asked to make. Even a
  perfect page-side interceptor would miss it. Closing this needs a
  browser-level observer (`webRequest` / `webNavigation` /
  `declarativeNetRequest`), permissions this extension deliberately
  does not hold and whose absence is itself a documented property (see
  `docs/security/PERMISSIONS.md`), or capture below the browser.

  *This is a property of the transport, not of a list of sites.* It is
  as true on `chatgpt.com` as on `www.google.com`: any surface that can
  be registered as a browser search engine, or reached by a `?q=` link,
  can be prompted this way. The catalog records that Perplexity, Kagi
  and DuckDuckGo all publish OpenSearch descriptors, so they can be
  made a browser's default engine outright. No per-site list can
  express this, so we no longer keep one that implies otherwise.

  *Where the catalog now stands.* `ai-surfaces.json` used to say the
  search surfaces were treated "like chat surfaces (page-side
  masking)". They were not, and that claim is gone. Each provider now
  carries a `web_screening` field answering one narrow question — does
  this surface have a screened submission path *at all*? — and the
  surfaces whose only submission path is a navigation are marked
  `none`: `www.google.com`, `www.bing.com`, `search.brave.com`,
  `duckduckgo.com`, `kagi.com` and `you.com`. Consumers must present
  those as unscreened and must not offer a protection toggle for them.
  Note what `web_screening: body` does *not* mean: not "everything you
  type here is screened", only "there is a submission path we screen".
  The navigation hole above is open on those hosts too.

  *Those hosts stay in the injection list, deliberately.* `web_hosts`
  is not only the injection list — it is also the shim's request-
  **target** scope set, and the target is not always the page you are
  looking at. `duck.ai`'s chat XHRs target `duckduckgo.com`, and Kagi
  Assistant is reached through `kagi.com`, so dropping either
  "unscreened" host would silently delete real screening on a
  different surface. Anything that does leave one of these hosts as a
  bodied `fetch`/`XHR` is still screened normally. `web_screening`
  moves the *claim*, never the capture.

  *Screening navigation-borne prompts is deferred to 1.x*, and the
  reason is product design, not plumbing. For chat, masking preserves
  utility: the model still answers the masked question. For search the
  PII often *is* the query — searching for `<PERSON_1> <ADDRESS_1>`
  returns nothing useful — so mask-and-forward, the primitive this
  whole product rests on, does not transfer. It needs a different
  interaction model (warn-and-confirm before the navigation commits,
  an override verdict path, "sent anyway" event semantics), which is a
  feature with its own design doc rather than another capture hook.
  Until that ships, treat these surfaces as **awareness/UI scope, not
  enforcement scope** — the long-standing instinct in this file, now
  stated precisely.
- **The extension cannot independently verify that screening happened.**
  It acts on the verdict it is handed. A verdict of `allow` is trusted
  as "screened and clean" unless it is marked `unchecked` or carries
  `unscreened` items. If a hop below the shim were to answer `allow`
  when the screener was unreachable, the extension would send. That is
  why the `unchecked` flag is relayed end to end and surfaced. The
  extension depends completely on the desktop app blocking, rather
  than allowing, when the screener behind it errors.
- **An outage costs availability, not confidentiality.** There is no
  durable spool and no retry: while the desktop app is down, in-scope
  requests are blocked and the connection badge reflects the outage.
- **"Connected" is not "protected", and the popup no longer implies it
  is.** A bare connection to the desktop app proves nothing about
  whether the screener behind it can screen, so the popup still shows
  connection and screening as two separate rows. Screening has a
  genuine **"Active"** state, earned exactly one way and never
  assumed: **a real verdict on real traffic**, within a bounded
  freshness window (`SCREENING_EVIDENCE_TTL_MS`, 10 minutes). Absence
  of that — an old desktop app, a truncated reply, or simply nothing
  sent yet — reads **"Not yet confirmed"**, never "Active" by default.

  It was briefly earned a second way, and that was a mistake worth
  writing down here rather than quietly deleting. The desktop app
  answers a live reachability probe, and a successful one was rendered
  as "Locke confirmed screening is active". But the probe reaches only
  the app's connection endpoint, not the screener behind it:
  screening can be down, crashed, or not yet ready while the app
  admits the probe's connection exactly as a healthy one
  would. That is the routine state of the first stretch after the
  desktop app starts — so opening the popup then showed a confident
  green while every request in the chain was being held back. The same
  "connected means protected" defect this bullet is about, displaced
  one hop inward. The probe is now read in one direction only: it can
  take the answer **down** the instant the app becomes unreachable,
  which is what catches a screener that dies between sends, and it can
  never take it up. So
  does a verdict marked `unchecked`: an `allow` or `redact` that
  shipped content nobody examined, under the user's own time-boxed
  fail-open window, is a receipt that proves the app is alive AND
  that this send was not fully screened. It used to render "Active" —
  a green row for the one kind of send where unexamined bytes had just
  reached the provider. It reads "Not yet confirmed" now, the popup
  names it as a send rather than a block, and the session note still
  counts it. It is deliberately NOT "Unavailable": the app answered
  and honoured a setting the user chose, so blaming the infrastructure
  would be a different wrong answer. A
  screener that dies between requests is caught by the next live probe
  rather than only surfacing when the next send is blocked — the gap
  this bullet used to describe as open. Recovery is the asymmetric
  half: it is signalled by traffic, because the probe cannot see the
  screener and so cannot report that screening came back.
- **The probe does not get to overrule the traffic, and a capture that
  failed is never silence.** Two rules added after the failure-UX
  audit, both about the same defect from opposite directions. First:
  the probe and a capture measure different things — the probe asks
  the app whether it accepts a connection, a capture asks whether a
  real request got screened — so a live positive cannot short-circuit
  a capture that just failed. This was originally arbitrated by a
  60-second window (`SCREENING_CONTRADICTION_WINDOW_MS`); it is now
  structural, since a live positive is not evidence of screening at
  all, which is the same protection without an expiry date. The popup
  names the failure as the same event the page already showed, rather
  than leaving a user to triage two of our own surfaces contradicting
  each other; that naming is what the window still bounds. A live
  *negative* still wins outright.
  Second: a relay that could not deliver, an empty or undecodable
  reply, and a half-parsed receipt that fail-closed to `block` with no
  reason used to produce **no evidence at all**, which left the last
  good receipt standing — so a browser on which every capture was
  failing kept reading "Active" for the full ten-minute TTL. Each of
  those is now first-class "cannot tell" evidence. `receipt-too-large`
  is deliberately excluded: the screener *did* screen that request, and
  the shim already tells the user it is a size limit, so downgrading
  the popup would manufacture a doubt the page never raised.
  **What is still open:** the evidence is browser-global, not per-tab
  — a failure on one AI surface downgrades the popup for all of them —
  and failures the service worker never sees (the content script's own
  `relay-rejected` / `relay-threw`, and the shim-local
  `verdict-timeout` / `verdict-missing`) still cannot reach the popup,
  because by definition the worker was unreachable when they happened.
  Both fail toward "we cannot tell", never toward green.
- **A blocked send says which KIND of block it is.** "We refused your
  content" and "our screener is down" are different sentences, and
  telling a user the first when the second is true sends them hunting
  for PII they never sent. Every block is classed `policy`,
  `unavailable`, `too-large` or `unsupported`, and the class and reason ride
  on the thrown error as well as the console line, so a site that
  surfaces the error message shows something actionable. All four
  classes are fail-closed; the class describes the cause, never
  whether the content left.
- **A block is attributable to us on every transport — but there is no
  in-page surface, and a site can still hide it.** `fetch` and
  `fetchLater` reject with the sentence in the error; an XHR block
  stamps `sonomosBlocked` / `sonomosBlockReason` / `sonomosBlockKind` /
  `sonomosBlockMessage` on the request object before firing `error`,
  because an event carries no message; `sendBeacon` has only its
  `false` return and nothing else. On all of them the same sentence
  goes to the page's console at `warn`, unconditionally. What we do
  **not** do is draw anything in the page: this extension hooks four
  APIs and writes nothing into the document, which is what makes its
  footprint auditable — and a banner injected into someone else's page
  is one the page can remove, restyle or forge. The residual is real
  and we state it plainly: a site that catches its own failure and
  renders "Something went wrong" will show you that, not us, and short
  of the console or the popup there is nothing on the page that says
  otherwise.
- **Content leaves unscreened in exactly one sanctioned case:** the
  user's own explicit, time-boxed fail-open window, which lives in
  the desktop app's configuration and is never a decision the
  extension makes. When the desktop app exercises it, the verdict is marked
  `unchecked` and the extension logs it at `console.warn`
  unconditionally **and counts it in the popup** — "N requests went out
  this session without a full screen, under your fail-open setting."
  A bypass the user cannot see is indistinguishable from a clean
  screen, which is the whole reason the flag exists; the wording is
  deliberately factual rather than alarmed, because it is a state they
  opted into. An attachment the screener could not examine but that the
  desktop app **withheld** (bytes replaced with an inert placeholder, so
  nothing unexamined left the machine) is counted and worded
  separately — "stayed on this machine", not "went out" — and must not
  be confused with it.
- **Large redactions fail closed.** Chrome caps a native-messaging
  reply at 1 MB; a rebuilt (redacted) request bigger than that can't
  round-trip and the request is blocked instead.
- **Insider with local user privileges** is out of scope for the
  extension's defenses (an endpoint-level concern). The native host
  and the desktop app speak over a user-only `0600` UDS; a user
  who can already run code as themselves can read their own socket.

## Engineering — what we haven't done yet

- **Reproducible-build verification by an independent third party.**
  The build is deterministic (`scripts/zip.mjs`, sorted entries, fixed
  timestamps; `SOURCE_DATE_EPOCH` pins mtimes for a release rebuild),
  and as of 2026-09-01 that is checked on every push rather than
  asserted: `quality.yml::reproducible-build` builds twice and fails
  unless the zips are byte-identical. `LICENSE` (PolyForm Strict 1.0.0)
  permits noncommercial use, so an outside reviewer is free to rebuild
  and compare. What we still don't have is anyone outside the project
  who has actually done it and published the result.
- **No two-person release rule — it was withdrawn on 2026-08-31.**
  Publication is automatic: a push to `main` that changes
  `manifest.json`'s version publishes to Chrome Web Store, Edge Add-ons
  and AMO with **no human approval step**
  ([`docs/security/RELEASE-POLICY.md`](docs/security/RELEASE-POLICY.md)).
  [`CODEOWNERS`](CODEOWNERS) names reviewers, but branch protection is
  not configured, so pull-request review is a process commitment rather
  than a rule — and merging is shipping. Do not answer a
  separation-of-duties question from this project's docs with a yes.
- **First management review hasn't happened yet.**
  [`docs/security/MANAGEMENT-REVIEW.md`](docs/security/MANAGEMENT-REVIEW.md)
  defines the cadence; the first quarterly review is pre-staged in
  the appendix waiting for the human meeting.
- **Test coverage is strongest at the shim and the host**, not the
  full live pipeline. The end-to-end scan/redaction tests live
  downstream, in the desktop app's own suites, not here. The
  extension's suite covers shared utilities, host-matching, the
  shim's raw-request synthesis and verdict enforcement (run against
  the real `shim.js` in a vm sandbox), and the native host's relay
  round-trip. The popup's **wording** is pinned by test (`popup/copy.js`
  is pure, so what the user is told about screening availability is
  assertable), but its rendering is not: there are no DOM-level popup
  tests and no in-browser integration tests.
- **No formal performance benchmarks for the shim on a reference page
  set.** Anecdotal observation only — and because the shim holds
  in-scope requests for the verdict round-trip, slow screening shows up as
  AI-site latency or blocked requests, not as silent pass-through. The
  binding deadline in practice is the native host's **25 s**
  (`CAPTURE_DEADLINE`), chosen to answer inside the browser's own 30 s
  service-worker idle window so the user gets our reason rather than a
  generic failure; the shim's 45 s ceiling is now the last resort
  behind it. Both are informed by one machine's observations of real
  screening times, not by a benchmark: on slower
  hardware, or under heavy concurrency, they may still be too low.
  `enforceTimeoutMs` raises the shim's without a rebuild; the host's
  needs one.
- **The browser-side limit the host's deadline is set against is
  documented, not measured here.** Chrome's 30 s service-worker idle
  rule is from its published lifecycle docs; whether a pending
  `sendNativeMessage` resets that timer has not been checked on a real
  browser on this machine. 25 s is correct under either reading, but
  the margin is reasoned rather than observed.

## Browser-coverage gaps

- **MV3 only.** No MV2 fallback. Firefox ESR 128+ supports MV3 in
  some configurations; older Firefox releases may not work even
  though `browser_specific_settings.gecko.id` is set. We don't
  test against pre-128 Firefox.
- **`minimum_chrome_version: 120`.** The manifest pin is the floor
  (MAIN-world content scripts + managed-storage semantics). Edge /
  Brave / Arc / Vivaldi inherit Chromium's baseline.
- **Safari is not supported.** Safari Web Extensions need a
  separate manifest, a different native-messaging host
  registration, an Apple Developer account for distribution, and
  WKWebView-specific shimming. Out of scope for v1.0.

## What we measure honestly

`[corrected 2026-08-21; restated 2026-09-01]` — this list used to read
as a set of published measurements. Three of the four were not
measurements, they were intentions, and the README badges asserting them
have been removed. Every workflow now carries real triggers, which is
not the same as having produced a result: **this repository is newly
public and no workflow run has completed in it**. What is actually true:

- **OpenSSF Scorecard:** **no published score.** `scorecard.yml` now
  runs weekly, on push to `main`, and on `branch_protection_rule` — but
  no run has completed, and `publish_results` is still `false` in that
  file, so even once it runs the result goes to a SARIF artifact rather
  than to the public OpenSSF dataset. The README carries no Scorecard
  badge, and should not until there is a published score.
- **CII Best Practices:** **not submitted, and not eligible.** The
  badge is for open-source projects, and this repository is published
  under PolyForm Strict 1.0.0, which is not an open-source licence. Checklist pre-filled at
  [`docs/security/CII-CHECKLIST.md`](docs/security/CII-CHECKLIST.md);
  no project ID has been assigned, and the README carries no CII badge.
- **CycloneDX + SPDX SBOMs:** **none published.** `sbom.yml` now runs on
  push to `main` and monthly, and `release.yml` generates both formats
  per release, but no run has completed here and **no SBOM is bound to a
  version anyone can download**, because no release has been published.
- **Sigstore signatures + SLSA L3 attestations:** **none exist.**
  `release.yml` holds the `Sign artifacts` and `SLSA build provenance
  attestation` steps and runs automatically on a push to `main` that
  changes the version, but no release has been published through it, so
  nothing shipped is signed by us or attested. The verification recipe
  in [`docs/enterprise/DEPLOYMENT.md`](docs/enterprise/DEPLOYMENT.md)
  describes what a release *will* produce, not what you can check
  today.

Two things on this page *are* now checkable rather than asserted, and
they are checked by jobs that fail rather than by scanners that report:

- **No outbound request except loopback.** `quality.yml::payload-audit`
  runs `scripts/audit-payload.mjs` over the staged payload and fails on
  any absolute URL that is not `http://127.0.0.1`, `http://localhost` or
  the `https://sonomos.ai/` link the popup opens in a tab — and on
  `eval`, `new Function`, remote dynamic `import()`, `document.write`
  and `innerHTML` built by concatenation. `tests/audit-payload.test.js`
  (14 tests) shows the check catches an exfiltration endpoint and a
  lookalike of the allowed link, so this is a gate rather than a
  gesture. Before 2026-09-01, the central privacy claim of this product
  was maintained by review and by a manifest tripwire; nothing looked at
  the shipped code.
- **Reproducible builds.** `quality.yml::reproducible-build` builds
  twice under a fixed `SOURCE_DATE_EPOCH` and fails unless the zips are
  byte-identical.

The honest caveat on both: they will run from the first push, no run has
completed yet, and branch protection does not require them — so today
they fail a run without blocking a merge.

## Coverage ratings (out of 10, our own assessment)

These are point-in-time snapshots and will drift as the product
evolves. Re-rated each quarterly review.

| Area | Rating | Why |
|---|---|---|
| Least privilege | 9 | loopback-only `host_permissions` and a `connect-src` CSP pinned to one origin; the capture path is native messaging, not the network; no off-machine egress. `[re-rated 2026-09-01, was 10]` — the old cell claimed "no host permissions" (there is one, loopback) and credited a "CI-tripwired host name" check that was withdrawn on 2026-08-31 when the native-messaging host left this repository. What replaces it is stronger than either: `quality.yml::payload-audit` fails the build on any non-loopback endpoint anywhere in the shipped payload, not just in the manifest |
| Capture scoping | 8 | content scripts pinned to the AI web-surface list, not `<all_urls>`; generated from a single catalog; cross-origin attachment uploads now screened by initiator without widening that catalog or asking for a host permission. Still short of 9: only recognisable upload shapes are covered, and **no navigation-borne prompt is screened on any surface** — an address-bar query, a default-search-engine query, a `?q=` link or a `<form>` submit reaches the provider unscreened, deferred to 1.x; see the residuals above |
| Transport isolation | 9 | native messaging → the same-user native host → `0600` UDS; no HTTP daemon, no URL a policy can redirect |
| Page-page defenses | 9 | extension-page CSP, `frame-ancestors 'none'`; no injected page UI |
| Supply chain | 6 | **Re-rated 2026-09-01, was 5; was 9 before 2026-08-21 on "sigstore, SLSA L3, SBOM, SHA-pin, version-pin".** Still unexercised: `release.yml` carries the cosign and `attest-build-provenance` steps and runs automatically on a version-changing push to `main`, but **no release has been published through it**, so no artifact is signed or attested and no SBOM is bound to a version. That is what keeps this out of the 8s. What earned the point: the SHA-pinning claim and the determinism claim stopped being assertions. `quality.yml::actions-pinned` fails the run if any `uses:` is not a 40-character SHA (51 references, all pinned), and `quality.yml::reproducible-build` fails unless two builds are byte-identical — and PolyForm Strict permits a noncommercial reviewer to rebuild and check that themselves. Also real and load-bearing: **zero JS dependencies** (empty `dependencies` and `devDependencies` in `package.json`, checkable by opening the file). It goes up again the day a release actually publishes. Note what this rating cannot cover: the native messaging host is installed by the desktop app rather than shipped from here, and its Rust dependency graph is not published in this repository, so nobody reading this repository can audit it |
| CI enforcement | 4 | `[added 2026-09-01]` Every workflow now has real triggers — lint, tests, SAST, secret scanning, SCA, SBOM, Scorecard, and seven `quality.yml` jobs — where previously all were manual-dispatch-only. Two reasons this is a 4 and not higher: **no run has completed in this repository**, so nothing here has actually been checked by any of them; and **branch protection is not configured**, so a failing job does not block a merge, and a merge to `main` publishes to three stores. The wiring is done; the enforcement is not |
| ISMS / process | 7 | scaffolding present, first review unrun |
| Legal docs | 5 | drafted, pending legal review |
| Vendor maturity | 3 | v1.0, small team, and **no independent assurance of any kind** — no SOC 2, no ISO 27001, no third-party pen test, and no engagement started for any of them. Was 4 until 2026-08-21, when "no SOC 2" turned out to mean "none started" rather than "none finished" |
| Distribution | 5 | sideload + force-install only, no store listings |

The areas where we score highest (least privilege, capture scoping,
transport isolation, page-page defenses) are also the areas where
IT/cyber teams care most. The areas where we score lowest (legal,
vendor maturity, distribution) are also the areas least responsive to
engineering effort. `[corrected 2026-08-21; updated 2026-09-01]` —
supply chain used to be named in that first list on the strength of a 9.
It is a 6, and the two cheapest things that would move it are landing
one version bump on `main` (which is now all it takes to run
`release.yml` end to end and produce the first signed, attested, SBOM'd
release) and configuring branch protection so the checks that exist
actually gate the merge that ships.

---

## How to use this doc

- **Procurement / customer security teams:** if a question on your
  questionnaire isn't answered here or in
  [`docs/security/`](docs/security/) or
  [`docs/legal/`](docs/legal/), email `info@sonomos.ai`.
- **Researchers:** scope and safe-harbour at
  [`docs/security/BUG-BOUNTY.md`](docs/security/BUG-BOUNTY.md).
- **Maintainers:** when you discover or close a limitation, update
  this file in the same commit.
