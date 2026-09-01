// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Runs in the page's MAIN world at document_start (declared in manifest.json).
//
// Job: intercept outbound `fetch` / `XMLHttpRequest` calls to AI web surfaces,
// HOLD the request, send it to the Locke desktop app for screening, get the
// verdict back, and act on it before anything leaves.
//
// v3 wire (the parse-and-reconstruct redesign): the shim parses NOTHING. It
// captures the exact body bytes the page is about to send, SYNTHESIZES a raw
// HTTP/1.1 request (request line + Host + the headers the page set + body) and
// ships those bytes — base64, because the message chain crosses postMessage /
// runtime messaging. The verdict comes back as a receipt:
//   allow  → release the held request unchanged
//   redact → the receipt carries a WHOLE rebuilt raw request; we split it at
//            the first CRLFCRLF and re-issue the held call with the rebuilt
//            body BYTES (and its Content-Type, whose fresh multipart boundary
//            must match those bytes byte-for-byte)
//   block  → the request never leaves
//
// This ENFORCES: the page's request is blocked until we have a verdict. The
// extension does no redaction itself — the desktop app rebuilds the request;
// the shim only substitutes it in (or blocks). See decide() for the verdict →
// action map.
//
// FAIL CLOSED: if we ever can't get a clean allow/redact verdict — timeout, no
// bridge, an unreadable/uncapturable body, an unresolvable target, a transport
// we cannot hold, a `block` decision, a missing or unrecognised decision, or
// any error in our own logic once a request is in scope — we BLOCK the request
// and never let the original unscreened body reach the provider. The one way
// content leaves this machine unscreened is the user's own explicit,
// time-boxed fail-open window, which the Locke desktop app applies and is
// never a decision the extension makes; when it is exercised, the verdict says
// so (`unchecked`) and we say so too.
//
// Hard rule: out-of-scope requests (non-AI host, or no body to scan) must pass
// through untouched — every hook wraps its scoping work in try/catch and only
// ever alters requests it has deliberately committed to enforcing.
//
// SCOPE is two things, not one. The first is the request's HOST being a
// catalog AI surface. The second — see SCOPE.UPLOAD below — is a cross-origin
// object write initiated BY a catalog AI surface: the pre-signed `PUT` an AI
// web app uses to send an attachment straight to object storage, which by
// definition never addresses an AI host and used to leave unscreened. Both are
// bounded by the same catalog, because the shim only ever runs on a page the
// catalog names; neither adds a host to it.
//
// TRANSPORTS: `fetch` and `XMLHttpRequest` are held and screened.
// `navigator.sendBeacon` and `fetchLater()` cannot be held at all (both answer
// synchronously and the browser sends on its own schedule), so an in-scope
// call carrying data is REFUSED rather than let through — the beacon by its
// own `false`, the deferred fetch by a throw, each being the failure signal
// that API's callers already handle. `WebSocket`, `EventSource`,
// `WebTransport` and Background Fetch are not hooked; see HONEST.md for those
// residuals and the rest.
//
// SELF-DIAGNOSING: every branch that ends in a block, that ships something
// unscreened, or that lets a request through, names itself on the console with
// a stable `reason=` string, and every block also carries its refusal `kind=`
// (policy | unavailable | too-large | unsupported — see BLOCK_KIND). Fail
// closed plus silence is the worst combination a privacy tool can ship: the
// user sees only the AI site's own generic "Something went wrong", and cannot
// tell "we caught PII" from "nothing ever answered". So the reason travels
// on the thrown error too, not only on the console — and on the XHR object,
// which has no thrown error to carry it. See the diagnostics block below for
// the vocabulary and the strict no-content rule, and `blockMessage` for the
// per-transport channels.

(() => {
  'use strict';

  // Web surfaces to capture, from shared/ai-surfaces.json (→ web_hosts) — our
  // vendored copy of the shared surface catalog — injected as a global by
  // content/web-surfaces.generated.js: this MAIN-world
  // shim is a classic content script and can't import ES modules. Run
  // `npm run generate` to refresh.
  const AI_HOSTS = new Set(
    (globalThis.SONOMOS_WEB_HOSTS || []).map((h) => String(h).replace(/\.+$/, '').toLowerCase())
  );

  // The ONE definition of "the same host", inline — duplicated here because a
  // MAIN-world classic script cannot import an ES module. shared/constants.js
  // `hostMatches` is the same rule; tests/shim.test.js drives the spelling
  // matrix through this copy.
  //
  // Trailing dots come off BOTH sides. `chatgpt.com.` is a legal absolute
  // spelling of `chatgpt.com`, not a different host, and treating it as one is
  // how a captured surface turns into an uncaptured one — a regression that has
  // shipped before, on exactly that point. The `.`-boundary on the suffix is
  // what keeps `notchatgpt.com` out.
  function isAiHost(host) {
    const h = String(host || '').replace(/\.+$/, '').toLowerCase();
    if (h === '') return false;
    if (AI_HOSTS.has(h)) return true;
    for (const known of AI_HOSTS) {
      if (h.endsWith(`.${known}`)) return true;
    }
    return false;
  }

  // ── path scoping: which paths on a screened host actually carry a prompt ──
  //
  // The catalog's path half, inline for the same reason `isAiHost` is: a
  // MAIN-world classic script cannot import a module. The composition is the
  // catalog's, verbatim:
  //
  //     screen = allowlistAdmits(host, path) && !skipsPath(path)
  //
  // Both, never either — the deny-list wins, so a provider cannot re-admit
  // telemetry by naming it in its allow-list.
  //
  // ## Why the shim needs this at all
  //
  // A `web_host` is injected wholesale. Without path scoping the shim held
  // EVERY request on the host, which is survivable only where the whole
  // hostname carries prompts. `chatgpt.com` also serves sign-in, billing,
  // telemetry and sentinel proof-of-work; the on-device screener cannot examine
  // sentinel's opaque payload, fails closed, and the page — denied its
  // chat-requirements token — reports itself unreachable while the popup still
  // reads Connected.
  //
  // ## Which way it fails
  //
  // A host with NO allow-list keeps capture-everything: absence must never
  // quietly stop screening a surface that was never narrowed. Within a host
  // that HAS one, an unmatched or malformed pattern falls to passthrough, not
  // to capture — on a host narrowed for this reason, "capture everything" is
  // precisely the sign-in-breaking behaviour.
  function pathSegments(path) {
    return String(path || '')
      .split('/')
      .filter((s) => s !== '')
      .map((s) => s.toLowerCase());
  }

  // A '*' stands for ONE WHOLE segment. Segment counts must be equal, so a
  // pattern can never act as a prefix: `/a/b` must not admit `/a/b/c`, or the
  // 3-segment reads and side-ops beside a 2-segment prompt POST come with it.
  // A partial-segment wildcard (`chat_*`) is malformed and matches nothing —
  // the naive-substring bug through the other door.
  function patternAdmits(segments, pattern) {
    const want = String(pattern || '').split('/').filter((s) => s !== '');
    if (want.length === 0 || want.length !== segments.length) return false;
    return want.every((w, i) => {
      if (w === '*') return true;
      if (w.includes('*')) return false;
      return w.toLowerCase() === segments[i];
    });
  }

  // Most-specific entry wins, matched with the same host rule as everything
  // else here, so a narrowed apex cannot be dodged via a subdomain.
  function allowlistFor(host) {
    const table = globalThis.SONOMOS_CAPTURE_PATHS || {};
    const h = String(host || '').replace(/\.+$/, '').toLowerCase();
    let best = null;
    let bestLen = -1;
    for (const entry of Object.keys(table)) {
      const matches = h === entry || h.endsWith(`.${entry}`);
      if (matches && entry.length > bestLen) {
        best = table[entry];
        bestLen = entry.length;
      }
    }
    return best;
  }

  // The global deny-list, matched as complete segment RUNS rather than as
  // substrings, so `/v1/models` is skipped and `/v1/models-and-prompts` is not.
  function skipsPath(segments) {
    const runs = globalThis.SONOMOS_SKIP_PATH_SEGMENTS || [];
    return runs.some((needle) => {
      if (!Array.isArray(needle) || needle.length === 0) return false;
      if (needle.length > segments.length) return false;
      for (let i = 0; i + needle.length <= segments.length; i++) {
        let hit = true;
        for (let j = 0; j < needle.length; j++) {
          if (segments[i + j] !== String(needle[j]).toLowerCase()) { hit = false; break; }
        }
        if (hit) return true;
      }
      return false;
    });
  }

  function isScreenedPath(host, path) {
    const segments = pathSegments(path);
    if (skipsPath(segments)) return false;
    const allow = allowlistFor(host);
    if (!allow) return true; // not narrowed — capture-everything, as before
    return allow.some((pattern) => patternAdmits(segments, pattern));
  }

  // The request-level gate. `isScreenedHost` answers for a HOST; this answers
  // for a REQUEST, and every hook that has a URL must ask this one — a hook
  // that asks the host-only question holds sentinel again.
  //
  // ## Why the narrowed case is logged
  //
  // A path the allow-list declines never leaves the browser, so it appears in
  // NO file log anywhere: nothing downstream ever saw it, nothing was relayed,
  // the audit log has no connection to record. From every log an operator can
  // read, "we deliberately did not screen this path" and "this was never our
  // host" are the same silence — and telling those two apart is most of the
  // work of explaining why a surface looks unscreened.
  //
  // So the narrowing says so. Only when the HOST is one we screen: an
  // ordinary third-party request must stay silent, or a busy page turns this
  // into the noise everyone learns to ignore. `console.debug`, because a
  // narrowed passthrough is the healthy path, not a failure — the path is
  // being left alone on purpose. Path only, never `url.search`: a query string
  // can carry the prompt itself.
  function isScreenedUrl(url) {
    try {
      if (!url || !isScreenedHost(url.hostname)) return false;
      if (isScreenedPath(url.hostname, url.pathname)) return true;
      debug('path-not-screened', {
        host: url.hostname,
        path: url.pathname,
        narrowed: !!allowlistFor(url.hostname)
      });
      return false;
    } catch {
      return false;
    }
  }

  // ── which surface a capture belongs to ──────────────────────────────────
  //
  // The catalog id ("google", "anthropic", …) for a host, from the same
  // generated file and the same host-matching rule as AI_HOSTS. This is the
  // identity captured evidence is grouped by; without it every browser capture
  // arrives unattributed and renders as "unknown".
  //
  // We send the CATALOG ID and never a nickname or a bare hostname. Two
  // spellings of one provider would split it into two rows — which is exactly
  // what happened: the receiving end used to answer from a hand-maintained host
  // table that said "claude" and "gemini" where the catalog says "anthropic"
  // and "google", so one provider's traffic was filed under two names. That
  // table is gone; both ends read the catalog now, so they agree by
  // construction rather than by two people keeping two lists in step.
  const AI_PROVIDERS = new Map(
    Object.entries(globalThis.SONOMOS_WEB_PROVIDERS || {})
      .map(([h, id]) => [String(h).replace(/\.+$/, '').toLowerCase(), String(id)])
  );

  // The LONGEST matching catalog entry wins. The catalog lists both
  // `www.google.com` (search) and `gemini.google.com` (google), so a
  // shortest-match rule would file Gemini under whichever entry happened to be
  // tried first. Most-specific-wins is the only reading that survives one
  // company owning several surfaces.
  function providerForHost(host) {
    const h = String(host || '').replace(/\.+$/, '').toLowerCase();
    if (h === '') return null;
    let best = null;
    for (const [known, id] of AI_PROVIDERS) {
      if (h === known || h.endsWith(`.${known}`)) {
        if (!best || known.length > best.known.length) best = { known, id };
      }
    }
    return best ? best.id : null;
  }

  // The surface to attribute one captured request to.
  //
  // Normally the request's own target. The exception is the cross-origin
  // upload path: those go to S3/GCS/Azure, which are in nobody's catalog, so
  // the target names no provider. Falling back to the page we are running in
  // is not a guess — this shim is injected on catalog surfaces and nowhere
  // else, so the page IS the surface the user is sending to, and an attachment
  // to a Claude conversation belongs on the same row as the prompt it went
  // with. `null` when neither resolves: absent is honest, and the receiver
  // renders it as "unknown" rather than mislabelling the row.
  function providerFor(url) {
    let host = null;
    try { host = url && url.hostname; } catch { host = null; }
    return providerForHost(host) || providerForHost(location.hostname) || null;
  }

  // ── surfaces the user switched off ──────────────────────────────────────
  //
  // Pushed in SONOMOS_CONFIG from the desktop app's own settings, by way of
  // native host → service worker → content script. Empty until that arrives,
  // which is the fully-screening state: config never gates enforcement here,
  // it only ever removes a host from it.
  //
  // SUBTRACTIVE, and that is the whole security story. Nothing in this set can
  // put a host INTO scope — AI_HOSTS is generated into the package at build
  // time and the manifest only injects us on those hosts, so a host that is
  // not already in both is unreachable from here in any configuration.
  //
  // A hostile page can forge SONOMOS_CONFIG and switch itself off. It gains
  // nothing: HONEST.md's forgeable-channel bullet already grants that a
  // hostile page can reach a pristine `fetch`, so "don't screen me" was
  // always available to it at lower cost than this. The same reasoning the
  // enforceTimeoutMs knob above already relies on.
  let disabledHosts = new Set();

  // Same rule as isAiHost — an entry means itself and every subdomain of
  // itself — so switching off `perplexity.ai` also covers `www.perplexity.ai`.
  // Two matchers that disagree about what one host means is exactly how a
  // surface the user disabled keeps getting screened, or worse.
  function isDisabledHost(host) {
    if (disabledHosts.size === 0) return false;
    const h = String(host || '').replace(/\.+$/, '').toLowerCase();
    if (h === '') return false;
    if (disabledHosts.has(h)) return true;
    for (const off of disabledHosts) {
      if (h.endsWith(`.${off}`)) return true;
    }
    return false;
  }

  // The catalog says which hosts we screen; the user's own settings can take
  // one back out. Every scope decision goes through here rather than calling
  // isAiHost directly, so there is one place where "in scope" is decided.
  function isScreenedHost(host) {
    return isAiHost(host) && !isDisabledHost(host);
  }

  // ── the page-start race for the disable set ─────────────────────────────
  //
  // We run at document_start; SONOMOS_CONFIG cannot. content-script.js has to
  // read chrome.storage first (see its pushConfig), so for the first moments of
  // a page load `disabledHosts` is empty and isScreenedHost() answers for a
  // surface the user switched OFF exactly as it would for one they left on. The
  // concrete failure: the page's first chat POST on a disabled surface gets
  // HELD and screened, and with the desktop app down it is BLOCKED — the site breaks
  // in the one configuration where the user told us to leave it alone.
  //
  // So an in-scope request may wait, once, for the first config to land. The
  // rule above the enforce timeout still holds and is not weakened here: the
  // shim never waits on config in order to ENFORCE. Running out of this bound
  // resolves to "in scope" and the request is screened exactly as it is today
  // — the wait can only ever remove a host from scope, never add one, and
  // never let an unscreened body out.
  //
  // 250 ms, measured from document_start rather than from the request. What we
  // are waiting on is the isolated world getting injected and reading
  // storage.local plus storage.managed — single-digit ms on a warm profile, and
  // the managed read is the slow leg on a policy-managed browser — so 250 ms
  // clears it with room while staying under any bound a person could perceive.
  // Anchoring it to load is what keeps it a page-start race and not a permanent
  // tax: a page whose content script never answers pays it in the opening
  // quarter-second and never again, however long it stays open.
  //
  // In practice the wait is invisible even when it is taken in full, because
  // the only requests that take it are ones about to be held for screening
  // against a 45 s enforce ceiling (DEFAULT_ENFORCE_TIMEOUT_MS below). It is
  // never paid by an out-of-scope request: hosts the catalog does not name
  // cannot be affected by a subtractive set, so they are answered without ever
  // consulting it.
  //
  // SCOPE.UPLOAD deliberately takes no wait. Its disable question is about the
  // PAGE's host, and the page is a catalog surface by construction — so waiting
  // on it would mean waiting on every cross-origin request the page makes,
  // out-of-scope ones included, which is the one thing this must not do. It
  // costs nothing: a delegated object write follows a user attaching a file,
  // which is many seconds into a page's life and long past this window, by
  // which time pageIsAiSurface() is reading a config that has arrived.
  const CONFIG_WAIT_MS = 250;
  const CONFIG_DEADLINE = Date.now() + CONFIG_WAIT_MS;

  let configArrived = false;
  let configWaiters = [];

  // Resolves when the first config lands, or when the page-start window
  // closes, whichever comes first. Callers re-read isDisabledHost() after it
  // settles; a timeout leaves the set empty, i.e. fully screening.
  function waitForFirstConfig() {
    if (configArrived) return Promise.resolve();
    const remaining = CONFIG_DEADLINE - Date.now();
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      configWaiters.push(resolve);
      // Never reject. A rejection here would leave the fetch hook's catch with
      // committed still false — i.e. an in-scope request passing through
      // UNSCREENED, which is the one outcome this file does not have. A page
      // that has broken its own setTimeout gets no wait instead.
      try { setTimeout(resolve, remaining); } catch { resolve(); }
    });
  }

  function noteConfigArrived() {
    configArrived = true;
    const waiters = configWaiters;
    configWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // The frame's base URL, or '' if there is none to read. Read fresh on every
  // call rather than cached: a `<base>` element can be parsed after
  // document_start, and the browser resolves against whatever is current.
  function currentBaseURI() {
    try {
      return (typeof document !== 'undefined' && document &&
        typeof document.baseURI === 'string') ? document.baseURI : '';
    } catch {
      return '';
    }
  }

  // ── where is this request actually going? ───────────────────────────────
  //
  // TWO BASES, TRIED IN THAT ORDER, AND THE ORDER IS THE SAFETY PROPERTY.
  //
  // `location.href` first, exactly as before. On an ordinary page it is what
  // the shim has always resolved against, so nothing that resolves today
  // resolves anywhere different tomorrow. In particular a page that sets
  // `<base href>` to somewhere else keeps being scoped by its location, which
  // is the more closed reading: we would rather hold a request that turns out
  // to be leaving than pass one because a `<base>` tag said it was.
  //
  // `document.baseURI` second, and ONLY when the first threw. That happens in
  // exactly one situation: this frame's own location has an opaque path
  // (`about:blank`, `about:srcdoc`, `blob:`, `data:`), so a relative URL has
  // nothing to hang off. Those documents inherit their base from the document
  // that created them (HTML's "about base URL"), which — because we are only
  // ever injected into such a frame on behalf of a catalog surface, see the
  // manifest's `match_origin_as_fallback` — is the AI page itself. Resolving
  // there is resolving the request the way the browser will actually issue it.
  //
  // Absolute URLs never reach the fallback; they resolve against any base. So
  // this can only ever turn "we could not tell where this was going" — which
  // is a `scope-unresolvable` block — into "we can". It never moves a request
  // out of scope.
  function resolveUrl(input) {
    let raw;
    try {
      // Request object, URL, or string — all coerce via the URL constructor.
      raw = typeof input === 'string' ? input
        : (input && typeof input.url === 'string') ? input.url
        : String(input);
    } catch {
      return null;
    }
    try {
      return new URL(raw, location.href);
    } catch { /* opaque-scheme frame — try the base it inherited */ }
    const base = currentBaseURI();
    if (!base) return null;
    try {
      return new URL(raw, base);
    } catch {
      return null;
    }
  }

  // The host a URL names, or '' — with the one indirection a `blob:` URL
  // needs. `blob:https://claude.ai/uuid` has an opaque path, so `hostname` is
  // empty, but the URL spec still resolves its `origin` to the creating
  // origin. `about:` has neither and answers ''.
  function hostOfHref(href) {
    if (typeof href !== 'string' || href === '') return '';
    let u;
    try { u = new URL(href); } catch { return ''; }
    if (u.hostname) return u.hostname.toLowerCase();
    try {
      if (u.origin && u.origin !== 'null') return new URL(u.origin).hostname.toLowerCase();
    } catch { /* not an origin we can parse */ }
    return '';
  }

  // ── the page we are running in ──────────────────────────────────────────
  //
  // True by construction: `content_scripts.matches` is generated from this
  // same web_hosts list, so the shim only ever runs on a catalog surface, or
  // in a frame such a surface created. We compute and check it anyway, because
  // it is the bound on everything below. The cross-origin upload scope acts
  // only on requests a known AI surface initiated, and writing that down as
  // code rather than trusting the manifest means a `matches` list that widened
  // later — or an injection we did not anticipate — cannot silently widen what
  // this file holds.
  //
  // Same two sources as resolveUrl, same order, same reason. `location.href`
  // answers for every ordinary frame. It answers '' for `about:blank` and
  // `about:srcdoc` — frames that have no host of their own but were created BY
  // one — and only those fall through to the inherited base. (A `blob:` frame
  // needs neither fallback: hostOfHref reads the creating origin straight off
  // the blob URL.) Strictly additive: a frame that had a host keeps it, and
  // one that had '' — and therefore no upload scope at all — gets the surface
  // that made it, which is precisely the initiator that scope is defined on.
  const PAGE_HOST = (() => {
    let host = '';
    try { host = hostOfHref(location.href); } catch { /* no location in this realm */ }
    return host || hostOfHref(currentBaseURI());
  })();
  // A function, not the constant this used to be: the disable set arrives
  // after document_start, so a value computed once at load would keep the
  // cross-origin upload scope attached to a surface the user had switched off.
  function pageIsAiSurface() { return isScreenedHost(PAGE_HOST); }

  // ── scope, part two: the attachment that never goes to the AI host ──────
  //
  // Scoping on the request's HOST alone misses the densest PII on the page.
  // Several AI web apps do not POST attachment bytes to their own origin: the
  // page asks its API for a pre-signed URL and then `PUT`s the file straight
  // to object storage on an unrelated host — S3, GCS, Azure Blob, R2, a
  // provider CDN. `chatgpt.com` does exactly this. Those bytes are a CV, a
  // contract, a spreadsheet of customers, and today they leave unseen while
  // the user believes attachments are screened.
  //
  // ## Why we do NOT fix this by adding storage hosts to the catalog
  //
  // Because those hosts serve the entire internet. `s3.amazonaws.com` in the
  // catalog would put every bucket every application on the machine talks to in
  // scope. Adding a host to the catalog is a release event, and nothing
  // user-supplied may ever add one. The catalog stays exactly as it is; this
  // file does not touch it.
  //
  // ## What the extension knows that the network layer cannot
  //
  // We are inside the page. The request's INITIATOR is not something we infer
  // from a packet — it is the document we were injected into, and the manifest
  // guarantees that document is a catalog surface. So the question is not
  // "is this host an AI host" (it is not, and never will be) but "did an AI
  // surface just hand this file to somebody". That is answerable here and only
  // here.
  //
  // ## The signals, and why each one
  //
  // Conjunctive, and deliberately narrow — the failure we are avoiding is
  // holding traffic we had no business holding:
  //
  //   1. the initiating page is a catalog AI surface (pageIsAiSurface());
  //   2. the destination is https and is NOT itself a catalog host (a catalog
  //      host is the ordinary scope and is handled before we get here);
  //   3. the request carries a body — a bodyless PUT/POST is a protocol step,
  //      not an upload;
  //   4. and it is shaped like a delegated object write:
  //        • the method is PUT — a cross-origin PUT from a web page is very
  //          nearly only ever a write to storage. Everything a page does to a
  //          third party in the normal course — analytics, error reporting,
  //          feature flags, auth, payments — is a POST. That asymmetry is what
  //          makes PUT usable as a signal at all.
  //        • or the page itself DECLARED an object write in a request header:
  //          `x-goog-upload-*` (the resumable protocol Gemini's attachment
  //          path uses, which is a POST), `x-ms-blob-*`, the S3 object-write
  //          headers, Backblaze's `x-bz-file-name`. These are the page saying
  //          "these bytes are an object" in its own words.
  //
  // Header NAMES only, and only ones that mean "object write". `x-amz-date`,
  // `x-amz-content-sha256` and `authorization` are deliberately NOT in that
  // list: SigV4 signs every AWS call, analytics included, so they say "signed",
  // not "object write". (`x-amz-content-sha256` does appear below, in
  // declaresBodyIntegrity, where "signed" is exactly what is being asked.)
  //
  // ## Which way each decision fails
  //
  // A request that matches is HELD and screened, and every existing
  // fail-closed branch then applies to it — including "the desktop app is down,
  // so this upload is blocked". That is a real availability cost on a path that
  // used to always succeed, and it is the direction the product fails in
  // everywhere else.
  //
  // A request that does not match passes through untouched, exactly as before.
  // So a POST-shaped upload we did not recognise stays a coverage gap (it
  // fails toward "we did not look", which is the state we started from), while
  // a mis-recognised payment or telemetry POST would fail toward "we held
  // something we should not have" — the worse direction. The predicate is
  // biased accordingly, and the residuals are in HONEST.md rather than papered
  // over by widening it.
  const SCOPE = Object.freeze({ AI: 'ai', UPLOAD: 'upload' });

  // Header-name prefixes by which a page declares "these bytes are an object
  // being written to storage". Matched as prefixes on the lowercased name;
  // values are never read and never logged.
  const OBJECT_WRITE_HEADERS = [
    'x-goog-upload-',              // Google resumable upload protocol
    'x-goog-resumable',            // GCS resumable initiation
    'x-upload-content-',           // the resumable initiation pair (type/length)
    'x-ms-blob-',                  // Azure Blob write (x-ms-blob-type: BlockBlob)
    'x-amz-acl',
    'x-amz-storage-class',
    'x-amz-server-side-encryption',
    'x-amz-meta-',
    'x-bz-file-name'               // Backblaze B2
  ];

  // Headers by which the request commits to the body's exact bytes. If the
  // screener rewrites the body, these no longer describe it, and the storage
  // service answers with a signature/checksum error the user cannot read as
  // anything but "upload broken". See uploadRedactVeto.
  const INTEGRITY_HEADERS = ['content-md5', 'x-goog-hash', 'content-digest', 'digest',
    'x-ms-blob-content-md5', 'x-ms-content-crc64', 'x-bz-content-sha1'];

  // `x-amz-content-sha256` is an integrity commitment only when it carries a
  // real hash; SigV4 also sends the literal `UNSIGNED-PAYLOAD`, which commits
  // to nothing. Read, compared, never logged.
  const UNSIGNED_PAYLOAD = 'unsigned-payload';

  function anyHeaderStartsWith(headers, prefixes) {
    for (const name of Object.keys(headers)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) return true;
    }
    return false;
  }

  function declaresBodyIntegrity(headers) {
    try {
      const h = headers || {};
      if (INTEGRITY_HEADERS.some((name) => typeof h[name] === 'string' && h[name] !== '')) return true;
      const amz = h['x-amz-content-sha256'];
      return typeof amz === 'string' && amz !== '' && amz.toLowerCase() !== UNSIGNED_PAYLOAD;
    } catch {
      // Unreadable headers on a request we are about to rewrite: assume the
      // commitment exists. The cost is a block; the alternative is a corrupted
      // upload nobody can explain.
      return true;
    }
  }

  // Is this a cross-origin object write initiated by an AI surface? Total by
  // construction — every failure answers `false`, which leaves the request
  // exactly where it was before this function existed (untouched), so a bug
  // here can never disturb the AI-host scope that runs before it.
  function isUploadScope(url, method, headersOf, hasBody) {
    try {
      if (!pageIsAiSurface()) return false;
      if (!url || url.protocol !== 'https:') return false;
      if (!hasBody()) return false;
      const verb = String(method || 'GET').toUpperCase();
      if (verb === 'PUT') return true;
      if (verb !== 'POST') return false;
      return anyHeaderStartsWith(headersOf() || {}, OBJECT_WRITE_HEADERS);
    } catch {
      return false;
    }
  }

  // ── tunables ────────────────────────────────────────────────────────────
  // This is a MAIN-world script: no chrome.* APIs, so it cannot read its own
  // settings. content-script.js (isolated world) reads them with the service
  // worker's precedence — DEFAULTS < storage.local < storage.managed — and
  // posts them over as SONOMOS_CONFIG, re-posting on every change. Until that
  // lands (and if it never does) these defaults hold: the shim must never wait
  // on config to enforce.

  // How long we hold the page's request waiting for a verdict before failing
  // closed. Whatever sits here is what a user experiences as "Sonomos gave up",
  // and a give-up is a BLOCK.
  //
  // 45 s, matching the Locke desktop app's own verdict ceiling, so the two
  // surfaces agree on when a screen counts as hung. This is a RESTORATION, not
  // a new number: the shim carried a 45 s enforce timeout with exactly this
  // reasoning (align with the desktop ceiling so a slow-but-valid scan isn't
  // false-blocked) until the v3 raw-relay rewrite silently dropped it to 5 s
  // with no rationale recorded.
  //
  // 5 s was under the floor, not near it: a single large, agent-shaped request
  // can take several seconds to screen, and concurrency makes it worse. So a
  // perfectly healthy chain was blocking sends purely because the shim gave up
  // first — and because a timeout resolves to `null`, which decide() maps to
  // block, the user saw the same symptom as a genuine PII block. Waiting longer
  // costs a slow spinner; waiting too little costs a send the user cannot make
  // at all.
  //
  // WHERE THIS SITS NOW. It used to be the controlling ceiling because no hop
  // below had one. It no longer is, and that is deliberate. The desktop app
  // runs its own, shorter deadline and reports a hung screen as
  // `screening-timeout` — an outage, with retry advice — and the browser's MV3
  // worker has its own 30 s idle-termination window that we do not set. This
  // ceiling is the last resort, for a channel that answers nothing at all.
  //
  // The ordering is the point. A ceiling here that fired FIRST would replace
  // every specific diagnosis below it with one generic "gave up".
  const DEFAULT_ENFORCE_TIMEOUT_MS = 45_000;
  // Clamp bounds for a pushed value. A hostile page can post SONOMOS_CONFIG
  // too; both extremes of this knob are self-harm (a page that wants its
  // request unscreened can simply not send it), so a sane range is the whole
  // defence needed.
  const MIN_ENFORCE_TIMEOUT_MS = 1_000;
  const MAX_ENFORCE_TIMEOUT_MS = 120_000;
  // Matches shared/constants.js MAX_DISABLED_WEB_HOSTS and the caps the native
  // host and the desktop writer apply. A MAIN-world script cannot import it.
  const MAX_DISABLED_HOSTS = 64;

  let enforceTimeoutMs = DEFAULT_ENFORCE_TIMEOUT_MS;
  let debugSetting = false;

  // `SONOMOS_DEBUG = true` in this page's devtools console turns the debug
  // lines on for the current page without touching settings — the fastest path
  // when someone is already staring at a blocked send. A hostile page can set
  // it too and gains nothing: these lines describe the page's OWN requests, in
  // shapes it already knows, and console output is not readable from script.
  function debugEnabled() {
    return debugSetting === true || globalThis.SONOMOS_DEBUG === true;
  }

  // ── diagnostics ─────────────────────────────────────────────────────────
  //
  // WHAT MAY BE LOGGED: shapes only. Host, path (never `url.search` — a query
  // string can carry the prompt itself), method, byte counts, media types, the
  // decision, elapsed ms, and the branch's own reason. The request body and
  // every header VALUE are radioactive and never appear here, not truncated,
  // not hashed, not "just this once". A diagnostic that leaks the thing we
  // protect is worse than no diagnostic at all.
  //
  // LEVELS: console.warn for anything that blocks or would ship unscreened —
  // always on, because that is the case that needs explaining. Everything on
  // the healthy path is console.debug and off unless debugEnabled(), so a
  // working install stays silent (a busy chat page issues hundreds of
  // requests, and noise that everyone learns to ignore is not a diagnostic).
  //
  // FORMAT: logfmt — the same `key=value` shape the desktop app's own logs use,
  // so a pasted console line and a line from those logs read alike.
  const LOG_PREFIX = '[sonomos]';

  function logfmt(fields) {
    let out = '';
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      if (value === undefined || value === null) continue;
      const s = String(value);
      out += ` ${key}=${/[\s"=]/.test(s) ? JSON.stringify(s) : s}`;
    }
    return out;
  }

  function warn(reason, fields) {
    try { console.warn(`${LOG_PREFIX} reason=${reason}${logfmt(fields)}`); } catch { /* no console */ }
  }

  function debug(reason, fields) {
    if (!debugEnabled()) return;
    try { console.debug(`${LOG_PREFIX} reason=${reason}${logfmt(fields)}`); } catch { /* no console */ }
  }

  // A Content-Type's media type only. Parameters are dropped — a multipart
  // boundary is browser-generated noise, and cutting at the first ';' means no
  // header value can reach the console whole by accident.
  function mediaType(ct) {
    if (typeof ct !== 'string') return null;
    const i = ct.indexOf(';');
    return (i < 0 ? ct : ct.slice(0, i)).trim().toLowerCase() || null;
  }

  // Strings that originated OUTSIDE this file — the screener's reason, a
  // native-messaging error, a decision from a forged verdict — are clipped
  // before they reach the console, so nothing upstream can turn a one-line
  // diagnostic into a dump.
  function clip(s, max = 120) {
    if (typeof s !== 'string') return null;
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  // Reasons that must be heard even with debugLogging off, although the
  // request was NOT blocked. Two things belong here and nothing else: a send
  // that went out without a complete screen, and a send whose attachment was
  // dropped on the way. Both are "you need to know this happened", and
  // neither may depend on someone having flipped a flag first.
  const LOUD = new Set(['allow-unchecked', 'redact-unchecked', 'redact-withheld']);

  function levelFor(action, reason) {
    return action === 'block' || LOUD.has(reason) ? 'warn' : 'debug';
  }

  // Cap on the body we copy out, so a giant upload can't balloon memory or
  // overflow the native-messaging frame downstream (the host's ceiling is
  // 16 MiB; 8 MiB of body survives base64 expansion within it). An oversized
  // body is in scope but uncapturable → fail closed.
  const MAX_BODY = 8 * 1024 * 1024;

  // ── the OTHER cap, the one on the way back ──────────────────────────────
  //
  // MAX_BODY governs what we can send OUT for screening. A different,
  // ten-times smaller cap governs what can come BACK: Chrome limits a
  // native-messaging host→browser reply to 1 MB, and a `redact` reply carries
  // the whole rebuilt request, base64, inside a JSON envelope. So the largest
  // ORIGINAL body whose redacted twin can still get home is about three
  // quarters of that, less the envelope — the number below.
  //
  // WE DO NOT REFUSE ON IT UP FRONT, and that is a deliberate answer to the
  // obvious question. This ceiling only binds when the screener actually
  // rewrites the request. An `allow` reply is a few hundred bytes whatever the
  // body weighed, so refusing every body over ~780 KB before the round trip would
  // block the clean 2 MB attachment that sails through today in order to save
  // a wait on the dirty one — trading a real regression for latency, in a
  // product whose whole claim is that it does not break the sites it protects.
  // Fail-closed is unaffected either way: nothing unscreened leaves in either
  // design.
  //
  // What we DO owe the user is a number. "Send a smaller attachment" with no
  // ceiling named is unactionable advice — see `blockMessage`'s
  // `receipt-too-large` branch, which names both this limit and what they
  // actually sent.
  const REDACT_REPLY_BODY_LIMIT = Math.floor((1024 * 1024 * 3) / 4) - 4096;

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  // ── bytes ⇄ base64 ──────────────────────────────────────────────────────
  // The raw request crosses postMessage + runtime messaging as JSON, so it
  // travels base64 from this boundary on. Chunked so an 8 MiB body doesn't
  // blow the argument-spread limit.
  const B64_CHUNK = 0x8000;

  function b64FromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
    }
    return btoa(bin);
  }

  function bytesFromB64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── enforce round-trip ──────────────────────────────────────────────────
  // Send the synthesized raw request (base64) to the content script (isolated
  // world) and wait for the verdict to come back. It goes out on
  // window.postMessage tagged with a monotonic callId; the verdict returns on
  // the same channel matched by that id. capture()/XHR resolve with the
  // verdict object (the SW's reply) or null on timeout — decide() turns that
  // into send | redact | block.
  //
  // A hostile *page* could forge a verdict, but the worst it can do is
  // downgrade to "send the original" — which it could already do by just
  // making the request without us. It can never read anything or force a
  // redacted body to leak.
  let nextCallId = 1;
  const pending = new Map(); // callId → resolve(verdict|null)

  // The `targetOrigin` this channel posts with — '*', deliberately, because
  // the target is THIS window and no origin string is correct in every frame
  // the manifest injects us into.
  //
  // `location.origin`, which this used to pass, is the origin of the frame's
  // URL, not of its document, and it is wrong in both directions:
  //
  //   about:blank · about:srcdoc · data:  — it reads the STRING 'null', which
  //     is truthy (so the old `|| '*'` fallback never fired) and is not a
  //     parseable URL, so postMessage throws SyntaxError. Every held request
  //     in such a frame failed closed as `verdict-channel-failed`, telling the
  //     user to reload a frame whose origin is opaque by construction.
  //   a sandboxed frame at a catalog URL — it reads the REAL origin, but the
  //     document's origin is opaque, so nothing throws and the message is
  //     silently DROPPED: the held request sat out the whole enforce timeout
  //     and blocked as `verdict-timeout`, blaming a desktop app that was fine.
  //
  // '*' gives nothing away here. The message never leaves this window; both
  // ends already drop anything whose `event.source` is not `window`; and
  // `targetOrigin` filters by the receiving DOCUMENT's origin, not by
  // listener, so every script in this document could read these posts whatever
  // we passed. A navigation cannot carry one off either — a queued message
  // task whose document stops being fully active never runs.
  //
  // content/content-script.js posts the other two messages of this protocol
  // and carries the same constant; tests/constants.test.js pins the pair.
  const SAME_WINDOW = '*';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d) return;
    if (d.type === 'SONOMOS_CONFIG') { applyConfig(d.config); return; }
    if (d.type !== 'SONOMOS_VERDICT' || typeof d.callId !== 'number') return;
    const resolve = pending.get(d.callId);
    if (resolve) resolve(d.verdict ?? null);
  });

  function applyConfig(config) {
    if (!config || typeof config !== 'object') return;
    const t = config.enforceTimeoutMs;
    if (typeof t === 'number' && Number.isFinite(t)) {
      enforceTimeoutMs = Math.min(Math.max(Math.round(t), MIN_ENFORCE_TIMEOUT_MS), MAX_ENFORCE_TIMEOUT_MS);
    }
    if (typeof config.debugLogging === 'boolean') debugSetting = config.debugLogging;
    // Only an actual array replaces the set. An absent key leaves it alone, so
    // a config push that could not read storage cannot put a surface the user
    // switched off back into scope; an empty array is a real answer ("nothing
    // is off") and does clear it.
    if (Array.isArray(config.disabledWebHosts)) {
      const next = new Set();
      for (const entry of config.disabledWebHosts.slice(0, MAX_DISABLED_HOSTS)) {
        if (typeof entry !== 'string') continue;
        const host = entry.replace(/\.+$/, '').toLowerCase();
        if (host !== '') next.add(host);
      }
      disabledHosts = next;
    }
    // The channel has answered, so nothing waits on it again — including a
    // push that carried no disabledWebHosts key. "Arrived" is about the
    // config, not about its contents: a later push still replaces the set,
    // it just no longer has anyone holding a request for it.
    noteConfigArrived();
    debug('config-applied', {
      enforceTimeoutMs, debugLogging: debugSetting, disabledHosts: disabledHosts.size
    });
  }

  // Post the raw request (base64) and resolve with the round-trip's OUTCOME,
  // not just its verdict — `timeout` and `channel-failed` both used to collapse
  // into a bare null, which is precisely the ambiguity that made a blocked send
  // unexplainable. Shape:
  //   { outcome: 'verdict' | 'timeout' | 'channel-failed',
  //     verdict, elapsedMs, timeoutMs }
  function enforce(requestB64, provider) {
    return new Promise((resolve) => {
      const callId = nextCallId++;
      const startedAt = Date.now();
      // Snapshot the ceiling: a config push mid-flight must not move the
      // deadline this call is already being judged against.
      const timeoutMs = enforceTimeoutMs;
      let settled = false;
      const finish = (outcome, verdict) => {
        if (settled) return;
        settled = true;
        pending.delete(callId);
        clearTimeout(timer);
        resolve({ outcome, verdict: verdict ?? null, elapsedMs: Date.now() - startedAt, timeoutMs });
      };
      const timer = setTimeout(() => finish('timeout', null), timeoutMs);
      pending.set(callId, (verdict) => finish('verdict', verdict));
      try {
        // the receiving DOCUMENT's origin, not by listener, so every script in this
        // document could read this post whatever we passed; and location.origin throws
        // or is silently dropped in the opaque-origin frames the manifest opts into.
        // Deliberate: targetOrigin filters by the receiving DOCUMENT origin, not
        // by listener, so narrowing it hides nothing; and location.origin throws
        // or is dropped in the opaque-origin frames the manifest opts into. Full
        // reasoning at the SAME_WINDOW declaration above.
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration
        window.postMessage(
          { type: 'SONOMOS_CAPTURE', callId, requestB64, provider: provider || null },
          SAME_WINDOW
        );
      } catch {
        finish('channel-failed', null); // channel gone → no verdict → fail closed
      }
    });
  }

  // ── unchecked / unscreened / withheld ───────────────────────────────────
  //
  // The desktop app's own vocabulary, verbatim, relayed to us through the
  // native messaging host. We do not coin our own names for these:
  //
  //   unchecked  — this request shipped WITHOUT a complete screen. Reachable
  //                only under the user's explicit, time-boxed fail-open
  //                window, which the desktop app applies. Never a decision the
  //                extension makes.
  //   unscreened — the items the screener could not examine, as
  //                { kind, media_type?, reason }. Metadata by construction:
  //                the vocabulary has no field that could carry a filename or
  //                any content.
  //
  // The PAIRING carries the meaning, and it is the screener's own:
  //
  //   unchecked=false + unscreened non-empty ⇒ WITHHELD — "we couldn't look,
  //     so we didn't send it". The bytes stayed on this machine; the rebuilt
  //     request carries an inert placeholder in their place, and the rest of
  //     the prompt was screened and redacted normally.
  //   unchecked=true ⇒ "we couldn't look and sent it anyway" — the user's
  //     fail-open window, the one sanctioned way content leaves unscreened.
  //
  // Why an `allow` is read differently from a `redact`: withholding rebuilds
  // the request, so a withhold is ALWAYS a `redact`. An `allow` carrying
  // unscreened items therefore shipped them, whatever `unchecked` says — and
  // that inference is what keeps this honest against a sender too old to send
  // the flag at all.
  function unscreenedList(receipt) {
    return Array.isArray(receipt.unscreened) ? receipt.unscreened : [];
  }

  // `file: application/pdf, text` — the screener's own kind list, rebuilt here
  // because the shim gets the array rather than the rendered string.
  // Kinds and media types only; both are classes of thing, and clipped
  // because they arrive from off-file.
  function summarizeUnscreened(items) {
    const parts = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') { parts.push('unknown'); continue; }
      const kind = clip(String(item.kind ?? 'unknown'), 24);
      const mediaType = typeof item.media_type === 'string' ? clip(item.media_type, 64) : null;
      const one = mediaType ? `${kind}: ${mediaType}` : kind;
      if (!parts.includes(one)) parts.push(one);
    }
    return parts.join(', ');
  }

  // ── infrastructure vs policy ────────────────────────────────────────────
  //
  // The whole chain fails CLOSED, so "screening was down" and "your content was
  // refused" both arrive as `decision: block`. That difference is the entire
  // message the user gets: an outage is transient and retrying is the right
  // advice; a policy refusal is terminal and the user must change what they
  // are sending. Telling somebody the second when the first is true sends
  // them hunting for PII they never sent — which is how a privacy tool loses
  // their trust.
  //
  // `blockCause` is a wire-level field on every verdict, carried here as
  // `r.blockCause` (camelCase). `isInfrastructureBlock` below is the
  // classifier: cause first, the string set only as the TRANSITIONAL FALLBACK
  // for a sender that predates the field or hasn't set it. Do not extend the
  // string set; do not delete it yet — the desktop app and this extension ship
  // on separate schedules, so a mixed-version window is real.
  //
  // These fragments are matched as substrings against text the desktop app
  // authors, so they must stay in step with what it emits; each one names an
  // OUTAGE rather than a policy refusal.
  //
  // NOT on this list, deliberately: the screener's own capacity refusals —
  // `request exceeds the size cap`, `over the … cap`, `unparseable request`
  // — which really are infrastructure (it declined to LOOK, on a byte
  // count, a field count, or a parse failure) but were never enumerated
  // here. Read through the string fallback alone, they used to fall through
  // to the policy default and show the user "screening stopped this
  // request" on a prompt with nothing sensitive in it.
  // `isInfrastructureBlock` fixes that by reading `blockCause` first.
  //
  // Duplicated from shared/constants.js because a MAIN-world classic script
  // cannot import an ES module; tests/constants.test.js fails if they drift.
  //
  // The sixth fragment, `bridge protocol failure`, is what the relay emits
  // when it receives a frame it cannot decode at all (wire-version mismatch,
  // not a policy decision) — still `decision: block`, correctly, but without
  // this fragment it read here as a policy refusal instead of an outage.
  const INFRASTRUCTURE_REASONS = [
    'engine unavailable',
    'guard unreachable',
    'engine saturated',
    'rate limit exceeded',
    'engine protocol failure',
    'bridge protocol failure'
  ];

  function isInfrastructureReason(reason) {
    return typeof reason === 'string' &&
      INFRASTRUCTURE_REASONS.some((fragment) => reason.includes(fragment));
  }

  // THE REAL CLASSIFIER — matches shared/constants.js::isInfrastructureBlock
  // (inlined here for the same reason as the rest of this block: a MAIN-world
  // classic script cannot import an ES module). `r.blockCause` is
  // authoritative when the sender set it; `isInfrastructureReason` is the
  // fallback for `unspecified`, absent, or an unrecognised value.
  function isInfrastructureBlock(r) {
    const cause = r && typeof r === 'object' ? r.blockCause : undefined;
    if (cause === 'infrastructure') return true;
    if (cause === 'policy') return false;
    return isInfrastructureReason(r && r.reason);
  }

  // Relay-failure code (from the service worker, `background/service-worker.js`
  // `captureViaHost`) → the block reason whose sentence in BLOCK_KIND is true
  // of it. A code absent here falls back to `native-call-failed`; see the
  // reasoning in `decide` for which codes belong where and why the fallback
  // was the bug. Every entry blocks — this table only ever chooses WORDS.
  const RELAY_BLOCK_REASON = {
    'screening-timeout': 'screening-timeout',
    'bridge-unreachable': 'bridge-unreachable',
    'receipt-too-large': 'receipt-too-large',
    'no-bridge': 'connector-not-started',
    'bridge-empty': 'bridge-unreadable-reply',
    'bridge-unknown-response': 'bridge-unreadable-reply',
    'capture-error': 'relay-error',
    'bad-request': 'relay-rejected'
  };

  // Map the round-trip result → what we do with the page's request, AND the
  // reason string that explains it. FAIL CLOSED: anything that isn't a clean
  // allow, or a redact carrying a rebuilt request, blocks — exactly as before;
  // the only change is that each way of failing now has its own name.
  //
  // Verdict shape (the SW's reply): { ok, receipt: { decision, reason,
  // redactedCount, unchecked, unscreened, requestB64?, … } }, or
  // { ok: false, code, message } when the relay itself failed.
  function decide(res) {
    const waitedMs = res.elapsedMs;
    if (res.outcome === 'timeout') {
      // The single most important line in this file. A timeout is NOT a
      // finding: no verdict arrived, so we blocked on principle rather than on
      // evidence. Say so in those words — "your privacy tool is working" and
      // "your privacy tool is broken" look identical from the page.
      return {
        action: 'block',
        reason: 'verdict-timeout',
        fields: { waitedMs, timeoutMs: res.timeoutMs, blockedBecause: 'no-verdict-arrived-not-pii' }
      };
    }
    if (res.outcome === 'channel-failed') {
      return { action: 'block', reason: 'verdict-channel-failed', fields: { waitedMs } };
    }
    const v = res.verdict;
    // The content script answers null when it cannot reach the service worker
    // at all (extension reloaded, SW restarting, context torn down).
    if (!v) return { action: 'block', reason: 'verdict-missing', fields: { waitedMs } };
    if (v.ok !== true) {
      // The service worker's own relay failure — no-bridge, bridge-error,
      // bridge-empty, bridge-unknown-response, capture-error — carrying the
      // native-messaging error text, which names hosts and shapes, never
      // request content.
      //
      // `screening-timeout` is pulled out because it is a different fact with
      // different advice. It means the native messaging host ran out its own
      // deadline waiting on the screener: the desktop app answered us, so
      // telling the user to start it is wrong and sends them looking in the
      // wrong place.
      //
      // `bridge-unreachable` is pulled out for the same reason, one hop
      // earlier. It means the host DID launch and DID answer the browser; it
      // only failed to reach the screening service beneath it. Collapsing the
      // two used to tell a user whose desktop app just replied to them to go
      // "start" it — while the popup's own Status row, fed by that same
      // reachable host, could be reading Online at that very moment. See
      // `BLOCK_KIND['bridge-unreachable']`.
      //
      // `receipt-too-large` is the same class of miscue, one layer further
      // in: the host answered, the screener answered, a redaction was even
      // found — the ONLY problem is that the rebuilt body is too big for the
      // native-messaging reply cap (1 MB). Left uncaught here it fell to the same
      // `native-call-failed` bucket and told the user to "start" an app that
      // had just fully screened their request — the exact wrong-advice shape
      // `bridge-unreachable` above was already pulled out to fix, recurring
      // through an uncaught code.
      //
      // The remaining four are the same defect once more, and the reason this
      // is now a table rather than an if-chain: "the Locke desktop app could
      // not be reached. Start it" was the default, so every code we had not
      // thought about inherited advice that is wrong for most of them.
      //
      //   `no-bridge`               — the browser could not START our
      //     native-messaging host: no manifest for us, a manifest that omits
      //     this extension id, or a host that exited immediately (a missing
      //     or broken binary). The BROWSER launches that process, from that
      //     manifest, per message — so a merely-running app used to change
      //     nothing, and this copy used to send people to run the native
      //     messaging host's installer script by hand. The app
      //     is in the loop now: on this same failure the worker asks it to
      //     repair the registration (background/service-worker.js
      //     `requestHostRegistration`), which re-runs the installer itself —
      //     silently for an already-authorised id, behind one Allow click
      //     for an unpacked load's path-derived id. So "open the app"
      //     is where the fix is actually waiting, with the Settings →
      //     Locke Extension paste field as the manual fallback. The wording
      //     still describes what we OBSERVED (the connector did not start)
      //     rather than guessing which cause it was — they arrive as
      //     browser-authored strings we cannot tell apart with confidence
      //     (shared/health-client.js `NO_HOST_PATTERNS`). Same sentence as
      //     `popup/copy.js`'s STATUS.NO_BRIDGE branch — one problem, one fix,
      //     on both surfaces.
      //   `bridge-empty` / `bridge-unknown-response` — the host answered, so
      //     it is running; we could not read the answer. A frame type we do
      //     not know is a version skew, not an outage.
      //   `capture-error`           — OUR OWN service worker threw while
      //     relaying. Nothing about the desktop app is implicated, and
      //     "restart Locke" sends the user to fix the one component that was
      //     working. Reloading the page re-establishes the content-script
      //     channel this failed on.
      //   `bad-request`             — the host rejected our frame as
      //     malformed. Also ours, and also a version skew.
      //
      // `bridge-error` (native messaging itself failed — the port died, the
      // host exited) keeps `native-call-failed`: there the app really is the
      // thing that is not answering.
      const reason = RELAY_BLOCK_REASON[v.code] ?? 'native-call-failed';
      return {
        action: 'block',
        reason,
        fields: { waitedMs, code: clip(v.code) || 'unknown', detail: clip(v.message) }
      };
    }
    if (!v.receipt || typeof v.receipt !== 'object') {
      return { action: 'block', reason: 'verdict-malformed', fields: { waitedMs } };
    }
    const r = v.receipt;
    if (r.decision === 'allow') {
      const unscreened = unscreenedList(r);
      // An allow can never be a withhold, so unscreened items on an allow
      // SHIPPED. Either signal — the flag or the items — means unchecked.
      if (r.unchecked === true || unscreened.length > 0) {
        return {
          action: 'send',
          reason: 'allow-unchecked',
          fields: {
            waitedMs,
            guardReason: clip(r.reason),
            sentUnscreened: unscreened.length || null,
            unscreenedKinds: summarizeUnscreened(unscreened) || null,
            because: 'user-fail-open-window'
          }
        };
      }
      return { action: 'send', reason: 'allow', fields: { waitedMs, guardReason: clip(r.reason) } };
    }
    if (r.decision === 'redact') {
      if (typeof r.requestB64 !== 'string') {
        return { action: 'block', reason: 'redact-missing-request', fields: { waitedMs } };
      }
      const unscreened = unscreenedList(r);
      const base = { waitedMs, redactedCount: r.redactedCount ?? null, guardReason: clip(r.reason) };
      if (r.unchecked === true) {
        return {
          action: 'redact',
          reason: 'redact-unchecked',
          fields: {
            ...base,
            sentUnscreened: unscreened.length || null,
            unscreenedKinds: summarizeUnscreened(unscreened) || null,
            because: 'user-fail-open-window'
          }
        };
      }
      if (unscreened.length > 0) {
        // The good kind of "couldn't examine": nothing left the machine. Say
        // it anyway — the user's prompt now refers to an attachment the model
        // will not be able to see, and that is worth knowing before the reply
        // comes back confused.
        return {
          action: 'redact',
          reason: 'redact-withheld',
          fields: { ...base, withheld: unscreened.length, withheldKinds: summarizeUnscreened(unscreened) }
        };
      }
      return { action: 'redact', reason: 'redact', fields: base };
    }
    if (r.decision === 'block') {
      // CLASSIFY BEFORE SHOWING IT. Both an outage and a refusal arrive here as
      // `block`; `blockCause` tells them apart (falling back to the reason
      // string only when it's unset — see isInfrastructureBlock above), and
      // the two need opposite sentences. An unrecognised/unspecified cause
      // whose reason also matches nothing falls through to the policy
      // wording, which still blocks.
      const fields = { waitedMs, guardReason: clip(r.reason) };
      return isInfrastructureBlock(r)
        ? { action: 'block', reason: 'screening-unavailable', fields }
        : { action: 'block', reason: 'decision-block', fields };
    }
    if (r.decision === undefined) {
      // A half-parsed receipt. The host already defaults a missing decision to
      // block; this is the belt to that braces.
      return { action: 'block', reason: 'decision-missing', fields: { waitedMs } };
    }
    return {
      action: 'block',
      reason: 'decision-unknown',
      fields: { waitedMs, decision: clip(String(r.decision)) }
    };
  }

  // ── the upload path's two extra refusals ────────────────────────────────
  //
  // A `redact` means the screener rebuilt the request and we substitute its
  // bytes for the page's. On an ordinary AI-host request that is the whole design.
  // On a raw object write it can produce an upload that SUCCEEDS and is wrong,
  // which is worse than a refusal because nobody is told:
  //
  //   • WITHHELD. Withholding replaces an unexaminable attachment with an
  //     inert placeholder so the rest of the prompt still ships. In a
  //     multipart chat POST that is
  //     strictly better than blocking. Here the attachment IS the whole body,
  //     so "the rest of the request" is nothing at all: we would PUT a 69-byte
  //     1×1 image into the bucket, the AI site would record a successful
  //     upload of the user's CV, and the model would be shown a blank square.
  //     The user is never told, and the file they think they sent is gone.
  //     So on this path a withhold means block — nothing left the machine
  //     either way, and this way we can say so.
  //
  //   • INTEGRITY. A pre-signed write may commit to the body's exact bytes
  //     (`Content-MD5`, a real `x-amz-content-sha256`, `x-goog-hash`). We
  //     cannot recompute those, and shipping rebuilt bytes under the old
  //     checksum earns the storage provider's own error, which reads to the
  //     user as "the site is broken". Refuse instead, and say why. Note this
  //     only ever fires when the screener actually FOUND something — a clean
  //     `allow` ships the original bytes untouched, checksum intact.
  //
  // Both are strictly more closed than the branch they replace: the page's
  // original unscreened bytes were never sendable here, and now the rebuilt
  // ones are not either. Returns the block reason, or null to leave the
  // verdict alone.
  function uploadRedactVeto(reason, headers) {
    if (reason === 'redact-withheld') return 'upload-withheld';
    if (declaresBodyIntegrity(headers)) return 'upload-integrity-locked';
    return null;
  }

  // ── the message a human sees ────────────────────────────────────────────
  //
  // A blocked send reaches the user as whatever the AI site does with a failed
  // request — usually its own generic "Something went wrong". A reason that
  // lives only on the devtools console is a reason nobody reads, and a privacy
  // tool that silently breaks sends is a privacy tool that gets turned off. So
  // the reason travels ON the rejection too: `fetch` rejects with this text,
  // and any site that surfaces the error shows something a person can act on.
  //
  // ## Every transport carries it, by the only channel each one has
  //
  //   fetch       — the rejection's `TypeError` message (a site that renders
  //                 the error renders ours).
  //   fetchLater  — the same, for the same reason.
  //   XHR         — `sonomosBlocked` / `sonomosBlockReason` /
  //                 `sonomosBlockKind` / `sonomosBlockMessage`, own properties
  //                 stamped on the object before the `error` event fires. An
  //                 event carries no message, and this is the only surface an
  //                 XHR has that a handler can still read. See `blockXhr`.
  //   sendBeacon  — nothing. The API's only signal is `false`, and there is no
  //                 object to stamp. The console line below is all it has.
  //
  // And on ALL of them, unconditionally, the console line `reporter` emits —
  // because every channel above depends on the page choosing to surface what
  // it was handed, and most do not. There is deliberately no in-page surface:
  // this extension hooks four APIs and writes nothing into the document, which
  // is what makes it auditable, and a banner injected into someone else's page
  // is removable, restylable and forgeable by that page. An unattributable
  // block is a real cost; a Sonomos-shaped element the page can fake is a
  // worse one.
  //
  // ## The classes, and why the split is load-bearing
  //
  // "We refused your content" and "our screener is down" are different
  // sentences, and telling a user the first when the second is true is how a
  // privacy tool loses their trust — they go hunting for PII they never sent.
  // So a refusal carries a class, and the four are kept apart:
  //
  //   policy      — the screener looked and said no. Terminal.
  //   unavailable — screening never happened; the chain
  //                 failed or answered unintelligibly. Retryable.
  //   too-large   — over the screening size limit. NOT a
  //                 sensitive-data block. Terminal.
  //   unsupported — this request cannot be screened by
  //                 THIS surface at all: a body we can't
  //                 read without consuming it, or a
  //                 transport we cannot hold. Terminal
  //                 and not retryable. Calling these
  //                 `unavailable` would tell the user to
  //                 retry something that can never work.
  //
  // Every class is fail-CLOSED. The class says what happened, not whether the
  // content left — nothing here ever leaves.
  //
  // Content-free by construction: our own fixed strings plus the screener's
  // `reason`, which the vocabulary defines as short, non-sensitive and safe to
  // surface. Never a body, never a header, never a URL.
  const BLOCK_KIND = {
    'decision-block': ['policy',
      'screening stopped this request.'],

    // The desktop app itself said screening could not happen
    // (INFRASTRUCTURE_REASONS). Same `decision: block` as a refusal, opposite
    // meaning — so it gets the outage sentence and the retry advice, never the
    // "we found something" one.
    'screening-unavailable': ['unavailable',
      'screening is unavailable, so this request could not be checked — this is NOT a sensitive-data block. Check that the Locke desktop app is running, then try again.'],
    // The native messaging host's own deadline expired waiting on the screener.
    // The desktop app answered us, so "start it" would be the wrong advice.
    'screening-timeout': ['unavailable',
      'the on-device screener did not finish in time, so nothing was checked — this is NOT a sensitive-data block. Try again; if it keeps happening, check the Locke desktop app.'],

    'verdict-timeout': ['unavailable',
      'the on-device screener did not answer in time, so nothing was checked — this is NOT a sensitive-data block. Check that the Locke desktop app is running, then try again.'],
    'verdict-channel-failed': ['unavailable',
      'the page could not reach the Locke extension. Reload the page and try again.'],
    'verdict-missing': ['unavailable',
      'the Locke extension restarted while this request was waiting. Reload the page and try again.'],
    'native-call-failed': ['unavailable',
      'the Locke desktop app could not be reached. Start it, then try again.'],
    // The browser could not start our native-messaging host at all — see the
    // `no-bridge` note in `decide()`. Says what we observed, not which of the
    // three causes it was, and names the one fix that covers all of them.
    'connector-not-started': ['unavailable',
      'Locke’s browser connector didn’t start, so nothing could be screened — this is NOT a sensitive-data block. Open the Locke desktop app and click Allow when it asks to connect this extension (or add this extension’s ID under Settings → Locke Extension), then retry.'],
    // The host answered — so it IS running — with a reply we could not read,
    // or a frame type this build does not know. Version skew or a truncated
    // frame; telling the user to start what just answered them is the same
    // wrong turn `bridge-unreachable` exists to avoid.
    'bridge-unreadable-reply': ['unavailable',
      'the Locke desktop app answered in a way this version of the extension could not read, so nothing was screened — this is NOT a sensitive-data block. Try again; if it keeps happening, update Locke.'],
    // OUR OWN service worker threw while relaying. Nothing about the desktop
    // app is implicated, and "restart Locke" would send the user to fix the
    // component that was working.
    'relay-error': ['unavailable',
      'the Locke extension hit an error passing this request on, so nothing was screened — this is NOT a sensitive-data block. Reload the page and try again.'],
    // The host rejected our frame as malformed. Also ours, also a version
    // skew — and not something retrying the same request will clear.
    'relay-rejected': ['unavailable',
      'the Locke desktop app rejected this request as malformed, so nothing was screened — this is NOT a sensitive-data block. Update Locke; report this if it persists.'],
    // The native host DID answer the browser — this is NOT "no-bridge" — it
    // only failed to reach the screening service beneath it. Telling the user to
    // "start" an app that just replied to them is wrong, and it is exactly
    // the sentence that used to sit next to a popup reading Online at the
    // same moment. See the branch in `decide()` above for the reasoning.
    'bridge-unreachable': ['unavailable',
      'the Locke desktop app answered, but it could not reach its screening service — this is NOT a sensitive-data block. Try again shortly; if it keeps happening, restart Locke.'],
    // The host and the screener both answered — a redaction was even found —
    // but the rebuilt body was too big for the native-messaging reply cap
    // (1 MB) and the host
    // failed closed rather than send a reply Chrome would silently drop.
    // `too-large`, not `unavailable`: telling the user to "start" or "retry"
    // an app that just fully screened their request is the same wrong-advice
    // shape `bridge-unreachable` above exists to avoid, and retrying the same
    // content reproduces the identical cap. Send less at once instead.
    'receipt-too-large': ['too-large',
      'this request’s screened content is too large for Locke to send back to the browser. This is a size limit, NOT a sensitive-data block — send a shorter request or a smaller attachment.'],
    'verdict-malformed': ['unavailable',
      'the screener returned an answer this version of the extension does not understand. Update Locke.'],
    'decision-missing': ['unavailable',
      'the screener returned an answer with no decision in it. Update Locke, or report this if it persists.'],
    'decision-unknown': ['unavailable',
      'the screener returned a decision this version of the extension does not understand. Update Locke.'],
    'redact-missing-request': ['unavailable',
      'the screener redacted this request but sent no rebuilt version of it. Try again; report this if it persists.'],
    'redact-undecodable': ['unavailable',
      'the rebuilt, redacted request could not be decoded. Try again; report this if it persists.'],
    'redact-malformed': ['unavailable',
      'the rebuilt, redacted request was malformed. Try again; report this if it persists.'],
    'redact-ct-conflict': ['unavailable',
      'the redacted request could not be re-sent with the right content type. Try again; report this if it persists.'],
    'redact-ct-set-failed': ['unavailable',
      'the redacted request could not be re-sent with the right content type. Try again; report this if it persists.'],
    'internal-error': ['unavailable',
      'the Locke extension hit an internal error while screening. Reload the page; report this if it persists.'],

    'uncapturable-oversize': ['too-large',
      'this request is larger than the screening limit. This is a size limit, NOT a sensitive-data block — send a smaller attachment.'],

    // ── the cross-origin upload path (SCOPE.UPLOAD) ────────────────────
    //
    // Both of these turn a `redact` into a block, and both exist so the user
    // is told something TRUE. The alternative in each case is an upload that
    // appears to succeed and is silently wrong — a 1×1 placeholder sitting in
    // the bucket the chat will now show them, or a checksum mismatch surfacing
    // as the storage provider's own opaque error.
    'upload-withheld': ['unsupported',
      'this file could not be examined, so it was not uploaded. Nothing left your machine — attach it in a format Locke can read, or send the details as text.'],
    'upload-integrity-locked': ['unsupported',
      'Locke found something in this file that needed removing, but the upload commits to the original bytes with a checksum, so the screened version could not be sent in its place. Nothing left your machine.'],

    'uncapturable-stream': ['unsupported',
      'this request streams its body, which cannot be read for screening before it is sent.'],
    'uncapturable-document': ['unsupported',
      'this request sends a document body, which cannot be read for screening before it is sent.'],
    'uncapturable-unreadable': ['unsupported',
      'this request’s body could not be read for screening.'],
    'uncapturable-request-clone': ['unsupported',
      'this request’s body could not be copied for screening.'],
    'uncapturable-sync-xhr': ['unsupported',
      'this request is sent synchronously and cannot be held for screening.'],
    'uncapturable-beacon': ['unsupported',
      'this request is sent as a background beacon, which cannot be held for screening.'],
    'uncapturable-deferred-fetch': ['unsupported',
      'this request is queued to be sent later in the background, which cannot be held for screening. Send it normally instead.'],
    'scope-unresolvable': ['unsupported',
      'this request’s destination could not be determined, so it could not be screened.']
  };

  // The refusal class for a reason. Unknown reasons are `unavailable`: a
  // branch we forgot to classify is our fault, and blaming the user's content
  // for it is the one answer that is certainly wrong.
  function blockKind(reason) {
    const entry = BLOCK_KIND[reason];
    return entry ? entry[0] : 'unavailable';
  }

  function blockMessage(reason, fields) {
    const f = fields || {};
    const entry = BLOCK_KIND[reason];
    let help = entry ? entry[1] : 'this request could not be screened before sending.';
    // Three branches can say something sharper than the fixed text, because
    // they know a number or carry the screener's own words.
    if (reason === 'decision-block' && f.guardReason) {
      help = `screening stopped this request — ${f.guardReason}.`;
    } else if (reason === 'screening-unavailable' && f.guardReason) {
      // Deliberately worded so it cannot be misread as the line above: the
      // screener's reason appears, but framed as the outage it describes.
      help = `screening is unavailable, so this request could not be checked (${f.guardReason}). This is NOT a sensitive-data block — try again shortly.`;
    } else if (reason === 'native-call-failed' && f.code) {
      help = `the Locke desktop app could not be reached (${f.code}). Start it, then try again.`;
    } else if (reason === 'receipt-too-large' && f.bytes) {
      // The whole point of naming both numbers: the user is being asked to
      // send less, and until this line existed nobody could tell them how much
      // less. The limit is the one on the REPLY (see REDACT_REPLY_BODY_LIMIT),
      // which is why it is smaller than the screening limit quoted below for
      // an oversize body — two different caps, in two different directions,
      // and a user who hits both deserves to be told they are not the same.
      help = `this request is ${f.bytes} bytes. Locke screened it and found something to remove, but the screened version is too large to hand back to the browser — the limit is about ${REDACT_REPLY_BODY_LIMIT} bytes. This is a size limit, NOT a sensitive-data block — send a smaller attachment.`;
    } else if (reason === 'uncapturable-oversize' && f.bytes) {
      // Exact bytes — "9 MB, over the 8 MB limit" for a body one byte over
      // reads as a bug in the tool rather than a limit.
      help = `this request is ${f.bytes} bytes, over Locke’s ${MAX_BODY} byte screening limit. This is a size limit, NOT a sensitive-data block — send a smaller attachment.`;
    }
    return `Request blocked by Sonomos: ${help} [kind=${blockKind(reason)} reason=${reason}]`;
  }

  // Decode + split the rebuilt raw request. A base64 that won't decode
  // and a request with no header/body split are different bugs and must not
  // share a reason string. Returns { rebuilt, reason } — rebuilt null ⇒ block.
  function rebuildFrom(requestB64) {
    let bytes;
    try {
      bytes = bytesFromB64(requestB64);
    } catch {
      return { rebuilt: null, reason: 'redact-undecodable' };
    }
    const rebuilt = splitRebuilt(bytes);
    if (!rebuilt) return { rebuilt: null, reason: 'redact-malformed' };
    return { rebuilt, reason: 'redact' };
  }

  // Split a rebuilt raw request at the first CRLFCRLF into the body BYTES and
  // the rebuilt Content-Type header value. Byte-level scan — the body is
  // binary and must never round-trip through a string. Returns null on a
  // malformed request (no header/body split) → the caller blocks.
  function splitRebuilt(bytes) {
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
        const head = textDecoder.decode(bytes.subarray(0, i));
        let contentType = null;
        for (const line of head.split('\r\n').slice(1)) {
          const m = /^content-type\s*:\s*(.*)$/i.exec(line);
          if (m) { contentType = m[1].trim(); break; }
        }
        return { body: bytes.subarray(i + 4), contentType };
      }
    }
    return null;
  }

  // Re-issue a fetch with the screener's rebuilt body swapped in — as BYTES,
  // never a string: the rebuilt Content-Type may carry a fresh multipart
  // boundary that must match the body byte-for-byte. Everything else about
  // the call (url, method, other headers, credentials mode, …) stays as the
  // page issued it; the browser recomputes framing (Content-Length).
  function resendFetch(input, init, bodyBytes, contentType) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const baseHeaders = (init && init.headers) ? init.headers : (isRequest ? input.headers : undefined);
    const headers = new Headers(baseHeaders || {});
    if (contentType) headers.set('content-type', contentType);
    if (isRequest) {
      return origFetch.call(window, new Request(input, { body: bodyBytes, headers }));
    }
    return origFetch.call(window, input, { ...(init || {}), body: bodyBytes, headers });
  }

  // Fail-closed block for an in-scope XHR: cancel it rather than let an
  // unscreened body out. abort() is the standard "this request is not
  // happening" signal.
  //
  // abort() ALONE is not enough here, and the difference matters. We never
  // forwarded the page's send(), so the XHR's send() flag is unset — and
  // abort() on an XHR in that state fires no events at all (XHR spec: the
  // error steps run only from opened-with-send-flag-set, headers-received or
  // loading). The page would sit on a request that never completes and never
  // fails: a spinner forever, with the explanation only on a console nobody
  // has open. That is the worst possible shape for a fail-closed branch. So
  // we raise the failure ourselves, the way a network error would, and every
  // caller that handles `onerror` / `onloadend` sees it.
  //
  // ## Why the reason is stamped on the object
  //
  // `error` on its own is exactly what a dropped connection looks like, so an
  // XHR block reached the user as the site's own network-failure copy and our
  // refusal was indistinguishable from ChatGPT being down. A
  // `fetch` block does not have that problem: it rejects with a `TypeError`
  // whose message says who refused and why.
  //
  // XHR has no equivalent channel — no message rides an event — so the
  // message goes on the OBJECT, as own properties under a `sonomos` prefix,
  // set before the event fires so a handler reading `event.target` finds them
  // already there. That is the only surface an XHR has that outlives the
  // event, and it is additive: nothing standard is overwritten, so no page
  // that ignores it can be broken by it.
  //
  // NOT DONE, deliberately: synthesizing a `status` / `statusText` /
  // `responseText`, which would make the block look like a response from the
  // site's own server. That is worse than saying nothing — it attributes our
  // refusal to them, in a form their own error handling will render as their
  // outage. The properties below can only ever be read as ours.
  //
  // The values are our closed-set reason and kind plus `blockMessage`'s fixed
  // sentence. No body, no header, no URL — the same rule as every console
  // line in this file.
  function blockXhr(xhr, reason, fields) {
    try { xhr.abort(); } catch { /* nothing more we can safely do */ }
    try {
      // Enumerable on purpose: a support engineer typing the object into a
      // console, or a tester pasting what they see, should find these without
      // knowing the names in advance. Non-writable so the page cannot rewrite
      // our account of why we refused it.
      const own = { enumerable: true, configurable: true, writable: false };
      Object.defineProperties(xhr, {
        sonomosBlocked: { ...own, value: true },
        sonomosBlockReason: { ...own, value: reason },
        sonomosBlockKind: { ...own, value: blockKind(reason) },
        sonomosBlockMessage: { ...own, value: blockMessage(reason, fields) }
      });
    } catch { /* a frozen or exotic XHR — the console line still stands */ }
    try {
      if (typeof xhr.dispatchEvent !== 'function') return;
      const make = typeof ProgressEvent === 'function'
        ? (type) => new ProgressEvent(type)
        : typeof Event === 'function' ? (type) => new Event(type) : null;
      if (!make) return;
      xhr.dispatchEvent(make('error'));
      xhr.dispatchEvent(make('loadend'));
    } catch { /* the page's own handler threw, or events are unavailable */ }
  }

  // Header collection is best-effort: the page may pass headers as a Headers
  // object, a plain object, or an array of pairs. These are the headers the
  // page/API caller set — they go into the synthesized raw request verbatim
  // (sensitive, screened downstream, never logged). The browser's own
  // network-layer headers (cookies, sec-fetch-*, UA) are added after our
  // reach and are not part of the capture.
  function readHeaders(init, requestObj) {
    const out = {};
    const absorb = (h) => {
      if (!h) return;
      try {
        if (typeof h.forEach === 'function' && !Array.isArray(h)) {
          h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        } else if (Array.isArray(h)) {
          for (const pair of h) {
            if (pair && pair.length === 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
          }
        } else if (typeof h === 'object') {
          for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
        }
      } catch { /* ignore malformed header containers */ }
    };
    if (requestObj && requestObj.headers) absorb(requestObj.headers);
    if (init && init.headers) absorb(init.headers);
    return out;
  }

  // ── body capture: exact bytes ───────────────────────────────────────────
  // Capture the EXACT bytes the page is about to send. Strings encode as
  // UTF-8 directly; Blob / ArrayBuffer / TypedArray / URLSearchParams /
  // FormData serialize once via `new Response(body)` — which for FormData
  // fixes the generated multipart boundary, so we also take the matching
  // Content-Type from that same Response when the caller didn't set one
  // (`effectiveCt`). What we screen is byte-for-byte what would leave.
  //
  // Returns { hadBody, bytes, effectiveCt, reason }: hadBody:false → out of
  // scope (nothing to scan); bytes:null with hadBody:true → in scope but
  // uncapturable → the caller fails closed. `reason` names WHICH kind of
  // uncapturable, because "blocked" on its own has never been enough to debug
  // from — a streamed body, an oversized one and an unreadable one are three
  // different bugs with three different fixes.
  const NO_BODY = Object.freeze({ hadBody: false, bytes: null, effectiveCt: null, reason: 'no-body' });

  function uncapturable(reason) {
    return { hadBody: true, bytes: null, effectiveCt: null, reason };
  }

  function capped(bytes, effectiveCt) {
    if (bytes.byteLength > MAX_BODY) {
      // Oversize → fail closed. Carry the length so the line can say how far
      // over the cap it went, rather than just that it was over.
      const over = uncapturable('uncapturable-oversize');
      over.byteLength = bytes.byteLength;
      return over;
    }
    return { hadBody: true, bytes, effectiveCt: effectiveCt || null, reason: null };
  }

  async function captureBodyBytes(body) {
    if (body == null) return NO_BODY;
    if (typeof body === 'string') {
      if (body.length === 0) return NO_BODY;
      // Exact UTF-8 bytes; the browser's default Content-Type for a string
      // body when the caller sets none.
      return capped(textEncoder.encode(body), 'text/plain;charset=UTF-8');
    }
    try {
      // A ReadableStream can only be read by consuming it — capturing would
      // eat the page's body. In scope, uncapturable → fail closed.
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        return uncapturable('uncapturable-stream');
      }
      // A Document body (legacy XHR) is serialized by the XHR machinery in
      // ways Response won't reproduce — fail closed rather than screen the
      // wrong bytes.
      if (typeof body === 'object' && body.nodeType === 9) return uncapturable('uncapturable-document');
      // Blob / ArrayBuffer / TypedArray / URLSearchParams / FormData:
      // serialize exactly once. For FormData this fixes the multipart
      // boundary; the matching Content-Type comes from the same Response.
      const resp = new Response(body);
      const effectiveCt = resp.headers.get('content-type');
      const buf = await resp.arrayBuffer();
      return capped(new Uint8Array(buf), effectiveCt);
    } catch {
      return uncapturable('uncapturable-unreadable'); // in scope, fail closed
    }
  }

  // The shape fields every diagnostic line for one intercepted call carries.
  // `path` deliberately excludes url.search: a query string can carry the
  // prompt itself, and this file never logs content.
  function newShape(via) {
    return { via, scope: null, host: null, path: null, method: null, bytes: null, ct: null };
  }

  function fillUrl(shape, url) {
    if (!url) return;
    shape.host = url.hostname;
    shape.path = url.pathname;
  }

  // Mark a line as the cross-origin upload path AND drop the path from it. On
  // a pre-signed URL the path is the object key, which is very often the
  // user's own filename — and a filename is content by the same rule that
  // keeps bodies and query strings off the console. `scope=upload` plus the
  // host is everything an operator needs to recognise the line; the rest of
  // the URL is exactly what they must not be handed.
  function markUpload(shape) {
    shape.scope = SCOPE.UPLOAD;
    shape.path = null;
  }

  // One reporter per intercepted call: merges the running shape, the branch's
  // own fields, and the total elapsed ms into a single logfmt line.
  //
  // Every blocked line also carries its refusal CLASS, in one place so a
  // console line and the page-visible error can never disagree about whose
  // fault the block was.
  //
  // A BLOCK ALSO EMITS THE HUMAN SENTENCE, and that is not redundancy with the
  // logfmt line above it. The two lines are for two readers. `reason=… kind=…
  // ms=…` is for whoever is grepping a console dump next to a desktop-app log;
  // `blockMessage` is the same sentence the `fetch` hook throws — the one that
  // says whether we found something or never looked, and what to do about it.
  //
  // It is emitted HERE, once, rather than at each transport, because only the
  // `fetch` hook ever had a channel for it. A rejected `fetch` carries the
  // sentence in its `TypeError`; an XHR block, a refused beacon and a refused
  // `fetchLater` had nothing but a bare failure the site renders in its OWN
  // words, so our refusal was indistinguishable from the site breaking. And
  // even on `fetch` the throw is not
  // reliable evidence: a site that catches its own rejection and renders
  // "Something went wrong" swallows the sentence whole. Logging it
  // unconditionally means every refusal this file makes is attributable to
  // Sonomos, on every transport, whatever the page does with the failure.
  function reporter(shape, startedAt) {
    return (level, reason, extra) => {
      const line = { ...shape, ...(extra || {}), ms: Date.now() - startedAt };
      if (line.action === 'block') line.kind = blockKind(reason);
      (level === 'warn' ? warn : debug)(reason, line);
      // The MERGED line, not just `extra`: the shape carries `bytes`, and the
      // size-limit sentences are the ones that most need a real number.
      if (line.action === 'block') announceBlock(reason, line);
    };
  }

  // The human sentence for a refusal, on the page's own console.
  //
  // Always emitted, never gated on debugEnabled(): a block is the case that
  // needs explaining, and "fail closed plus silence" is the combination this
  // file exists to avoid. Content-free by the same rule as every other line
  // here — `blockMessage` composes our own fixed strings with the screener's
  // short `reason` and byte counts, and nothing else.
  function announceBlock(reason, fields) {
    try { console.warn(`${LOG_PREFIX} ${blockMessage(reason, fields)}`); } catch { /* no console */ }
  }

  // Both hooks report an uncapturable body identically — the reason travels on
  // the capture result, and the oversize case additionally names the cap it
  // exceeded.
  function sayUncapturable(say, cap) {
    say('warn', cap.reason, {
      action: 'block',
      bytes: cap.byteLength ?? null,
      capBytes: cap.reason === 'uncapturable-oversize' ? MAX_BODY : null
    });
  }

  // ── raw request synthesis ───────────────────────────────────────────────
  // Assemble the raw HTTP/1.1 request that gets screened:
  //   <METHOD> <path+query> HTTP/1.1\r\nHost: <host>\r\n<page headers>\r\n\r\n<body>
  // Only the headers the page/API caller provided plus Host and the effective
  // Content-Type — the browser's network-layer headers are out of reach and
  // not needed. Host/Content-Length are dropped from the page set (Host is
  // ours to write once; the browser recomputes framing). Binary-safe: header
  // text encodes to bytes and concatenates with the body bytes untouched.
  //
  // `dropQuery` is set on the cross-origin upload path, where the query string
  // is not addressing — it IS the credential. A pre-signed URL's
  // `X-Amz-Signature` / `X-Goog-Signature` / Azure `sig=` is a bearer
  // capability to write that object, and it carries no screening value: the
  // screener scans the body, and it strips the query before it looks at a path
  // anyway. Sending it would put a live
  // credential into a subsystem that logs, caches and meters requests, for
  // nothing. Enforcement is unaffected — a release or a re-issue always goes
  // out on the page's own original URL, which this file never modifies.
  function synthesizeRequest(method, url, headers, effectiveCt, bodyBytes, dropQuery) {
    const lines = [
      `${String(method || 'GET').toUpperCase()} ${url.pathname}${dropQuery ? '' : url.search} HTTP/1.1`,
      `Host: ${url.host}`
    ];
    for (const name of Object.keys(headers)) {
      if (name === 'host' || name === 'content-length') continue;
      lines.push(`${name}: ${headers[name]}`);
    }
    if (!headers['content-type'] && effectiveCt) {
      lines.push(`content-type: ${effectiveCt}`);
    }
    const head = textEncoder.encode(lines.join('\r\n') + '\r\n\r\n');
    const raw = new Uint8Array(head.byteLength + bodyBytes.byteLength);
    raw.set(head, 0);
    raw.set(bodyBytes, head.byteLength);
    return raw;
  }

  // Does this fetch carry a body at all? Existence only — no capture, no
  // consumption. Used to decide whether an UNRESOLVABLE target is a "couldn't
  // check" state worth blocking or just a bodyless call to ignore. If we
  // cannot even tell, say yes: an unknown target plus an unknown body is the
  // definition of unscreenable.
  function hasFetchBody(input, init) {
    try {
      if (init && 'body' in init) return init.body != null && init.body !== '';
      return !!(input && typeof input === 'object' && input.body != null);
    } catch {
      return true;
    }
  }

  // ── fetch hook ──────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (input, init) {
      let action = 'send';   // out-of-scope / no-body → send the original untouched
      let rebuilt = null;    // redact: { body: Uint8Array, contentType }
      let committed = false; // did we enter enforcement scope for this request?
      // Which branch blocked, so the rejection can say so rather than shrug.
      let blockReason = 'internal-error';
      let blockFields = null;
      const shape = newShape('fetch');
      const say = reporter(shape, Date.now());
      try {
        const url = resolveUrl(input);
        fillUrl(shape, url);
        const reqObj = (typeof input === 'object' && input) ? input : null;
        const method = (init && init.method) || (reqObj && reqObj.method) || 'GET';
        // Headers are read at most once, and only when something asks — the
        // upload test consults them only for a cross-origin bodied POST, so a
        // busy chat page's hundreds of ordinary requests never pay for it.
        let headerCache = null;
        const headersOf = () => (headerCache ??= readHeaders(init, reqObj));
        // The AI-host test is evaluated first and is untouched by any of this:
        // isUploadScope is total and can only ever answer for a host the
        // catalog does NOT contain, so a bug in it cannot disturb the scope
        // this file has always enforced.
        let scope = null;
        if (isScreenedUrl(url)) scope = SCOPE.AI;
        else if (url && isUploadScope(url, method, headersOf, () => hasFetchBody(input, init))) {
          scope = SCOPE.UPLOAD;
        }
        // A catalog host, decided before the disable set could arrive: give the
        // config its page-start window and ask again. Only this branch waits —
        // a host the catalog never named cannot be in the subtractive set, so
        // it is already past us untouched. On timeout the set is still empty
        // and the request stays in scope, which is today's behaviour exactly.
        if (scope === SCOPE.AI && !configArrived) {
          await waitForFirstConfig();
          if (isDisabledHost(url.hostname)) scope = null;
        }
        if (scope) {
          if (scope === SCOPE.UPLOAD) markUpload(shape);
          shape.method = String(method).toUpperCase();
          const headers = headersOf();
          shape.ct = mediaType(headers['content-type']);
          const initBody = (init && 'body' in init) ? init.body : undefined;
          let cap;
          if (initBody !== undefined && initBody !== null) {
            cap = await captureBodyBytes(initBody);
          } else if (reqObj && typeof reqObj.clone === 'function' && reqObj.body != null) {
            // Body carried on the Request object — clone so the held original
            // stays sendable, and read the exact bytes (binary-safe).
            try {
              cap = capped(new Uint8Array(await reqObj.clone().arrayBuffer()), null);
            } catch {
              cap = uncapturable('uncapturable-request-clone'); // in scope, fail closed
            }
          } else {
            cap = NO_BODY;
          }
          if (!cap.hadBody) {
            say('debug', 'no-body', { action: 'send' });
          } else {
            // In scope: this request carries a body, so it must be screened
            // before it can leave. From here we NEVER send the original
            // unscreened body.
            committed = true;
            if (cap.bytes == null) {
              action = 'block'; // uncapturable body → fail closed, no round-trip
              blockReason = cap.reason;
              blockFields = { bytes: cap.byteLength ?? null };
              sayUncapturable(say, cap);
            } else {
              shape.bytes = cap.bytes.byteLength;
              if (!shape.ct) shape.ct = mediaType(cap.effectiveCt);
              const raw = synthesizeRequest(method, url, headers, cap.effectiveCt, cap.bytes,
                scope === SCOPE.UPLOAD);
              const res = await enforce(b64FromBytes(raw), providerFor(url));
              const d = decide(res);
              action = d.action;
              let reason = d.reason;
              let extra = d.fields;
              if (action === 'redact' && scope === SCOPE.UPLOAD) {
                const veto = uploadRedactVeto(reason, headers);
                if (veto) { action = 'block'; reason = veto; }
              }
              if (action === 'redact') {
                const built = rebuildFrom(res.verdict.receipt.requestB64);
                if (built.rebuilt) {
                  rebuilt = built.rebuilt;
                  extra = { ...extra, rebuiltCt: mediaType(built.rebuilt.contentType), rebuiltBytes: built.rebuilt.body.byteLength };
                } else {
                  action = 'block'; // malformed rebuild → fail closed
                  reason = built.reason;
                }
              }
              if (action === 'block') { blockReason = reason; blockFields = extra; }
              say(levelFor(action, reason), reason, { action, ...extra });
            }
          }
        } else if (!url && hasFetchBody(input, init)) {
          // We are injected on AI surfaces and nowhere else, so a bodied
          // request whose target we cannot even resolve is a "couldn't check"
          // state, not somebody else's traffic. Fail closed.
          committed = true;
          action = 'block';
          blockReason = 'scope-unresolvable';
          say('warn', 'scope-unresolvable', { action: 'block' });
        } else {
          say('debug', 'not-in-scope', { action: 'send' });
        }
      } catch (e) {
        // An error in our own scoping/enforce logic must not leak the body: once
        // committed we fail closed; if we never entered scope, pass through.
        if (committed) {
          action = 'block';
          blockReason = 'internal-error';
          say('warn', 'internal-error', { action: 'block', detail: clip(e && e.message) });
        } else {
          say('debug', 'internal-error-out-of-scope', { action: 'send', detail: clip(e && e.message) });
        }
      }
      if (action === 'block') {
        // `shape.bytes` merged in for the same reason `reporter` merges it:
        // the thrown sentence and the logged one must be the same sentence.
        throw new TypeError(blockMessage(blockReason, { bytes: shape.bytes, ...blockFields }));
      }
      if (action === 'redact') return resendFetch(input, init, rebuilt.body, rebuilt.contentType);
      return origFetch.apply(this, arguments);
    };
  }

  // ── XMLHttpRequest hook ─────────────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        // arguments[2] is the async flag; only `false` means a synchronous XHR,
        // which we can't defer (see send) and therefore fail closed.
        this.__sonomos = { method, url: resolveUrl(url), headers: {}, async: arguments[2] !== false };
      } catch { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__sonomos) this.__sonomos.headers[String(name).toLowerCase()] = String(value);
      } catch { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };

    // Re-issue a held XHR with the screener's rebuilt body BYTES. XHR headers are
    // append-only (a second setRequestHeader comma-joins), so the rebuilt
    // Content-Type can only be applied when the page never set one (the
    // FormData case — the fresh boundary must match the bytes). A page-set
    // Content-Type that matches the rebuilt one needs no touch; one that
    // *differs* can't be overridden without corrupting the header → fail
    // closed.
    function resendXhr(xhr, pageCt, rebuilt, say, reason, extra) {
      const rebuiltCt = mediaType(rebuilt.contentType);
      const level = levelFor('redact', reason);
      if (!rebuilt.contentType || rebuilt.contentType === pageCt) {
        say(level, reason, { action: 'redact', ...extra });
        origSend.call(xhr, rebuilt.body);
      } else if (!pageCt) {
        try {
          origSetHeader.call(xhr, 'Content-Type', rebuilt.contentType);
        } catch {
          say('warn', 'redact-ct-set-failed', { action: 'block', rebuiltCt });
          blockXhr(xhr, 'redact-ct-set-failed');
          return;
        }
        say(level, reason, { action: 'redact', ...extra, rebuiltCt });
        origSend.call(xhr, rebuilt.body);
      } else {
        say('warn', 'redact-ct-conflict', {
          action: 'block',
          pageCt: mediaType(pageCt),
          rebuiltCt,
          // Same media type but different parameters — i.e. the screener minted a
          // fresh multipart boundary the page-set header can no longer name —
          // is the usual shape of this conflict. Worth calling out: it points
          // at the boundary, not at a genuine type disagreement.
          paramsDifferOnly: mediaType(pageCt) === rebuiltCt
        });
        blockXhr(xhr, 'redact-ct-conflict');
      }
    }

    XHR.prototype.send = function (body) {
      let s = null;
      try { s = this.__sonomos; } catch { /* ignore */ }
      // Same two-step scope as the fetch hook, in the same order: the AI-host
      // test first and unchanged, the cross-origin object-write test only for
      // hosts it did not match. `body` is not consulted here — the bodyless
      // case is answered below, before scope is used.
      let scope = null;
      try {
        if (s && s.url) {
          scope = isScreenedUrl(s.url) ? SCOPE.AI
            : isUploadScope(s.url, s.method, () => s.headers, () => body != null && body !== '')
              ? SCOPE.UPLOAD : null;
        }
      } catch { /* ignore */ }

      const shape = newShape('xhr');
      try {
        fillUrl(shape, s && s.url);
        if (scope === SCOPE.UPLOAD) markUpload(shape);
        if (s) {
          shape.method = String(s.method || 'GET').toUpperCase();
          shape.ct = mediaType(s.headers && s.headers['content-type']);
        }
      } catch { /* diagnostics must never be the thing that throws */ }
      const say = reporter(shape, Date.now());

      if (body == null || body === '') { // nothing to scan → untouched
        say('debug', 'no-body', { action: 'send' });
        return origSend.apply(this, arguments);
      }
      // A bodied send whose target we could not record or resolve — open()
      // never ran through our wrapper, or the URL would not parse. We only run
      // on AI surfaces, so that is a "couldn't check" state, not out-of-scope
      // traffic: fail closed, exactly as the fetch hook does.
      if (!s || !s.url) {
        say('warn', 'scope-unresolvable', { action: 'block' });
        blockXhr(this, 'scope-unresolvable');
        return;
      }
      if (!scope) { // neither an AI host nor a cross-origin upload → untouched
        say('debug', 'not-in-scope', { action: 'send' });
        return origSend.apply(this, arguments);
      }

      // In scope with a body: hold it. A sync XHR can't be deferred → fail
      // closed before we spend anything on capture.
      const xhr = this;
      if (!s.async) {
        say('warn', 'uncapturable-sync-xhr', { action: 'block' });
        blockXhr(xhr, 'uncapturable-sync-xhr');
        return;
      }

      (async () => {
        // The same page-start race the fetch hook handles: this is a catalog
        // host, and the disable set had not arrived when send() ran. It can
        // only be asked here, after the synchronous branches above — a sync
        // XHR cannot be deferred at all and is already refused, and an
        // out-of-scope or bodyless send has already gone out untouched, so
        // neither ever waits.
        if (scope === SCOPE.AI && !configArrived) {
          await waitForFirstConfig();
          if (isDisabledHost(s.url.hostname)) { // switched off after all
            say('debug', 'not-in-scope', { action: 'send' });
            origSend.call(xhr, body);
            return;
          }
        }
        const cap = await captureBodyBytes(body);
        if (!cap.hadBody) { // empty after all → untouched
          say('debug', 'no-body', { action: 'send' });
          origSend.call(xhr, body);
          return;
        }
        if (cap.bytes == null) { // uncapturable → fail closed
          sayUncapturable(say, cap);
          blockXhr(xhr, cap.reason, { bytes: cap.byteLength ?? null });
          return;
        }
        shape.bytes = cap.bytes.byteLength;
        if (!shape.ct) shape.ct = mediaType(cap.effectiveCt);
        const raw = synthesizeRequest(s.method, s.url, s.headers, cap.effectiveCt, cap.bytes,
          scope === SCOPE.UPLOAD);
        const res = await enforce(b64FromBytes(raw), providerFor(s.url));
        const d = decide(res);
        const veto = (d.action === 'redact' && scope === SCOPE.UPLOAD)
          ? uploadRedactVeto(d.reason, s.headers) : null;
        if (veto) {
          say('warn', veto, { action: 'block', ...d.fields });
          blockXhr(xhr, veto, { bytes: shape.bytes, ...d.fields });
        } else if (d.action === 'send') {
          say(levelFor('send', d.reason), d.reason, { action: 'send', ...d.fields });
          origSend.call(xhr, body);
        } else if (d.action === 'redact') {
          const built = rebuildFrom(res.verdict.receipt.requestB64);
          if (!built.rebuilt) { // malformed rebuild → fail closed
            say('warn', built.reason, { action: 'block', ...d.fields });
            blockXhr(xhr, built.reason, { bytes: shape.bytes, ...d.fields });
            return;
          }
          resendXhr(xhr, s.headers['content-type'] || null, built.rebuilt, say, d.reason, {
            ...d.fields,
            rebuiltBytes: built.rebuilt.body.byteLength
          });
        } else {
          say('warn', d.reason, { action: 'block', ...d.fields });
          blockXhr(xhr, d.reason, { bytes: shape.bytes, ...d.fields });
        }
      })().catch((e) => {
        say('warn', 'internal-error', { action: 'block', detail: clip(e && e.message) });
        blockXhr(xhr, 'internal-error');
      });
    };
  }

  // ── navigator.sendBeacon hook ───────────────────────────────────────────
  //
  // A beacon cannot be held. `sendBeacon` answers true/false synchronously and
  // the browser then sends it on its own schedule — there is no point at which
  // a verdict could be applied, and no way to substitute a rebuilt body. That
  // makes an in-scope beacon carrying data exactly the synchronous-XHR case:
  // in scope, unholdable, therefore unscreenable. It gets the same answer —
  // refuse it.
  //
  // `false` is the API's own "the user agent could not queue this transfer",
  // which every caller already has to handle, and the return value is the only
  // signal the API has. The alternative is a body reaching an AI surface with
  // no screening at all, which is the thing this file exists to prevent.
  //
  // Bodyless beacons (a bare ping) and beacons to anywhere else are delegated
  // untouched — the hard rule about out-of-scope traffic applies here as
  // everywhere. That includes the cross-origin upload scope, deliberately: a
  // beacon is always a POST and cannot carry a request header, so it can never
  // be a delegated object write, and widening it here would refuse the ordinary
  // third-party telemetry every AI page sends. Uploads do not ride beacons.
  const beaconOwner =
    (typeof Navigator !== 'undefined' && Navigator.prototype &&
      typeof Navigator.prototype.sendBeacon === 'function') ? Navigator.prototype
      : (typeof navigator !== 'undefined' && navigator &&
        typeof navigator.sendBeacon === 'function') ? navigator
        : null;
  if (beaconOwner) {
    const origSendBeacon = beaconOwner.sendBeacon;
    try {
      beaconOwner.sendBeacon = function (url, data) {
        const shape = newShape('beacon');
        shape.method = 'POST'; // sendBeacon is always a POST
        let target = null;
        try {
          target = resolveUrl(url);
          fillUrl(shape, target);
        } catch { /* diagnostics must never be the thing that throws */ }
        const say = reporter(shape, Date.now());
        const hasData = data != null && data !== '';
        if (hasData) {
          let inScope = false;
          // isScreenedUrl (isScreenedHost + capture-path), not isAiHost:
          // a surface the user switched off in the desktop app is out of
          // scope, and a beacon is not the one request type that ignores
          // their setting — nor the one that ignores a host's capture-path
          // allow-list (chatgpt.com telemetry beacons must not be refused
          // just for being beacons). Reading the catalog
          // directly here meant a disabled host still had every beacon
          // refused — enforcement the user had explicitly turned off, on the
          // one transport that cannot be released later.
          //
          // No config wait, deliberately, and for the same reason the fetch
          // and XHR hooks do not take one on their synchronous branches:
          // `sendBeacon` answers synchronously, so there is nothing to wait
          // WITH. During the page-start quarter-second the disable set may not
          // have landed yet and this reads as in scope — fail-closed, exactly
          // as before, and the window is the one it always was.
          inScope = isScreenedUrl(target);
          if (inScope) {
            say('warn', 'uncapturable-beacon', { action: 'block' });
            return false;
          }
          if (!target) {
            // Same rule as fetch/XHR: on an AI surface, a bodied request we
            // cannot even address is a "couldn't check" state.
            say('warn', 'scope-unresolvable', { action: 'block' });
            return false;
          }
        }
        say('debug', hasData ? 'not-in-scope' : 'no-body', { action: 'send' });
        return origSendBeacon.apply(this, arguments);
      };
    } catch { /* sendBeacon not writable here — nothing to install */ }
  }

  // ── fetchLater() hook (the Deferred Fetch API) ──────────────────────────
  //
  // `fetchLater()` queues a request the page does not have to stay alive for:
  // the browser sends it on its own schedule — after `activateAfter`, or when
  // the document is discarded — and throws the response away. It answers
  // synchronously with a `FetchLaterResult` whose only property is `activated`.
  // So there is no point at which a verdict could be applied, and no way to
  // substitute a rebuilt body.
  //
  // That is `navigator.sendBeacon`'s situation exactly, one API later: in
  // scope, unholdable, therefore unscreenable. It gets the same answer —
  // refuse it. A transport we cannot hold is the one case where "we did not
  // look" and "it left anyway" would be the same event, which is precisely
  // what this file exists to prevent.
  //
  // WE REFUSE BY THROWING, where the beacon returns `false`, because each
  // API's own callers are already written for its own failure signal.
  // `fetchLater` throws for a `ReadableStream` body, an untrustworthy url and
  // an exceeded quota, so a `TypeError` carrying our reason is a shape callers
  // handle — and it is what the `fetch` hook does. A silent drop is the one
  // answer that would be unacceptable.
  //
  // SCOPE IS THE FULL TWO-PART SCOPE HERE, unlike the beacon's. A beacon is
  // always a POST and cannot carry a request header, so it can never be a
  // delegated object write, and applying the upload scope there would have
  // refused the ordinary third-party telemetry every AI page sends.
  // `fetchLater` takes the same `input`/`init` as `fetch`: it can be a `PUT`
  // and it can carry the headers by which a page declares an object write. So
  // isUploadScope is meaningful, and its deliberately narrow predicate still
  // leaves telemetry POSTs alone.
  //
  // Bodyless deferred fetches, and ones aimed anywhere else, are delegated
  // untouched — the hard rule about out-of-scope traffic applies here as
  // everywhere.
  const origFetchLater = typeof globalThis.fetchLater === 'function' ? globalThis.fetchLater : null;
  if (origFetchLater) {
    try {
      window.fetchLater = function (input, init) {
        const shape = newShape('fetch-later');
        let refuse = null;
        try {
          const url = resolveUrl(input);
          fillUrl(shape, url);
          const reqObj = (typeof input === 'object' && input) ? input : null;
          const method = (init && init.method) || (reqObj && reqObj.method) || 'GET';
          shape.method = String(method).toUpperCase();
          const hasBody = () => hasFetchBody(input, init);
          let headerCache = null;
          const headersOf = () => (headerCache ??= readHeaders(init, reqObj));
          if (hasBody()) {
            // isScreenedHost, not isAiHost — same rule as the beacon hook
            // above, one API later: the user's own disable set decides scope,
            // here as everywhere else.
            if (isScreenedUrl(url)) {
              shape.scope = SCOPE.AI;
              refuse = 'uncapturable-deferred-fetch';
            } else if (url && isUploadScope(url, method, headersOf, hasBody)) {
              markUpload(shape);
              refuse = 'uncapturable-deferred-fetch';
            } else if (!url) {
              // Same rule as fetch/XHR/beacon: on an AI surface, a bodied
              // request we cannot even address is a "couldn't check" state.
              refuse = 'scope-unresolvable';
            }
          }
        } catch (e) {
          // Our own scoping threw. We never held anything — refusing is what
          // committing would mean here — so this follows the fetch hook's
          // uncommitted branch and passes through.
          const say = reporter(shape, Date.now());
          say('debug', 'internal-error-out-of-scope', { action: 'send', detail: clip(e && e.message) });
          return origFetchLater.apply(this, arguments);
        }
        const say = reporter(shape, Date.now());
        if (refuse) {
          say('warn', refuse, { action: 'block' });
          throw new TypeError(blockMessage(refuse, null));
        }
        say('debug', 'not-in-scope', { action: 'send' });
        return origFetchLater.apply(this, arguments);
      };
    } catch { /* fetchLater not writable here — nothing to install */ }
  }
})();
