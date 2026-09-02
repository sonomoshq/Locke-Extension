// Copyright © 2026 Sonomos, Inc. All rights reserved.

// INFRASTRUCTURE_REASONS is GENERATED, not declared — see the block further
// down that used to hold the literal, and scripts/generate-vocab.mjs.
// Re-exported from here because this is where every consumer already imports
// it from, and moving that would be churn with no reader on the other end.
import { INFRASTRUCTURE_REASONS } from './vocab.generated.js';

export { INFRASTRUCTURE_REASONS };

export const DEFAULTS = Object.freeze({
  heartbeatSeconds: 30,
  backoffMaxSeconds: 300,
  bridgeTimeoutMs: 4000,
  schemaVersion: 3,
  // Enterprise-overridable defaults — see managed-schema.json. The
  // service worker merges (DEFAULTS < storage.local < storage.managed)
  // so an admin policy always wins.
  //
  // `allowedProviders` holds CATALOG PROVIDER IDS from
  // `shared/ai-surfaces.json` (`openai`, `anthropic`, `google`, …) — not
  // product nicknames. Empty means "every catalog surface is screened", which
  // is both the default and the only safe reading of an unset policy.
  allowedProviders: [],
  telemetryEnabled: true,
  lockedSettings: [],
  // ── capture-path diagnostics + the shim's fail-closed ceiling ──────
  //
  // Both are consumed by the MAIN-world shim, which has no chrome.* APIs and
  // cannot read storage itself: content/content-script.js reads them with this
  // same DEFAULTS < local < managed precedence and posts them over as
  // PAGE_MSG.CONFIG. See content/shim.js for what each one governs.
  //
  // `debugLogging` only gates the *healthy-path* console lines. Warnings for a
  // blocked or unscreened send are unconditional — that is the case a user
  // needs explained, and it must never depend on having flipped a flag first.
  debugLogging: false,
  // Matches the Locke desktop app's own 45 s verdict ceiling. Rationale in
  // content/shim.js, where the value is also inlined as the default the shim
  // holds until a config push arrives.
  enforceTimeoutMs: 45_000
});

// Property names that storage.managed is allowed to override. Anything
// not in this list is ignored even if an admin sets it — limits blast
// radius if the schema accidentally drifts wider than intended.
//
// `daemonUrl` was removed when the extension stopped talking to an HTTP
// daemon: there is no URL left for a policy to point (or mis-point)
// anywhere. Capture flows through the native-messaging host to the Locke
// desktop app over a local, user-only channel — no network egress for a
// managed policy to redirect.
export const MANAGED_KEYS = Object.freeze([
  'allowedProviders',
  'telemetryEnabled',
  'heartbeatSeconds',
  'lockedSettings',
  'debugLogging',
  'enforceTimeoutMs'
]);

// The subset of settings the page-world shim needs. content-script.js reads
// exactly these and posts them across as PAGE_MSG.CONFIG — nothing else about
// the user's configuration crosses into a page's world.
//
// `allowedProviders` is here because the shim is the only place that decides
// what is in scope. It was declared in `managed-schema.json` and merged into
// `settings` for a long time while no runtime code read it: an admin could push
// it, `getSettings()` would return it, and screening carried on over every
// catalog surface exactly as before. A policy knob that does nothing is worse
// than an absent one — it reads as a control in a deployment review. It is
// wired now (content/shim.js `isProviderAllowed`, tests/shim.test.js "policy:").
//
// Two of its neighbours in MANAGED_KEYS are still in that state and are
// documented as inert rather than quietly left to look live:
// `telemetryEnabled` (nothing consults it — `handleTelemetry` in
// background/service-worker.js logs unconditionally) and `lockedSettings`
// (there is no popup settings UI for anything to be locked in). See
// docs/enterprise/DEPLOYMENT.md, which says so to the admin who would
// otherwise set them.
//
// SUBTRACTIVE, like `disabledWebHosts` and for the same reason: it can only
// ever REMOVE a catalog surface from screening. Nothing an admin (or a page
// forging this message) puts in it can screen a host the manifest does not
// already inject us on. See content/shim.js `isProviderAllowed`.
export const SHIM_SETTING_KEYS = Object.freeze([
  'debugLogging',
  'enforceTimeoutMs',
  'allowedProviders'
]);

// ── the one definition of "the same host" ───────────────────────────
//
// The single definition of "the same host", and the one every capture surface
// uses: an entry matches itself, and any SUBDOMAIN of itself,
// case-insensitively, with trailing dots stripped from BOTH sides
// (`chatgpt.com.` is not a different host, it is the same host spelled
// absolutely — a regression on exactly that point has shipped before).
//
// The `.`-boundary is what stops the prefix trick: `notanthropic.com` is not a
// subdomain of `anthropic.com`, and must never be treated as one.
//
// This lives here so the generator, the tests and the ES-module halves of the
// extension all read the same rule instead of restating it. `content/shim.js`
// carries an inline copy — a MAIN-world classic script cannot import an ES
// module — and tests/shim.test.js drives the same spelling matrix through the
// real shim so the two cannot drift.
export function hostMatches(entry, host) {
  const e = String(entry ?? '').replace(/\.+$/, '').toLowerCase();
  const h = String(host ?? '').replace(/\.+$/, '').toLowerCase();
  if (e === '' || h === '') return false;
  return h === e || h.endsWith(`.${e}`);
}

export const STATE_KEY = 'connectionState';
export const SETTINGS_KEY = 'settings';
// Ring-buffered audit log for IT incident response. Stored in
// storage.local (persists across browser restarts unlike storage.session)
// so an admin investigating "what happened on this user's machine
// yesterday" can pull the trail without needing live debugging access.
// Capped — see AUDIT_MAX_ENTRIES.
export const AUDIT_KEY = 'auditLog';
export const AUDIT_MAX_ENTRIES = 100;

// Web surfaces the user switched off in the desktop app, as last reported by
// the native host (which reads ~/.sonomos/surfaces.local.json).
// NOT a setting: the extension never writes it and neither the user nor an
// admin edits it here, which is why it sits outside SETTINGS_KEY.
//
// storage.local, so it survives a browser restart and an MV3 worker eviction.
// That persistence is deliberate: a host we cannot reach must not quietly
// re-enable screening on a surface the user excluded. "Off" has to keep
// meaning "Locke leaves this site alone", including while Locke is down —
// otherwise the site the user took out of scope is the one that starts
// failing closed the moment the desktop app stops.
export const DISABLED_WEB_HOSTS_KEY = 'disabledWebHosts';
// Matches the cap the host and the desktop writer both apply.
export const MAX_DISABLED_WEB_HOSTS = 64;

// The native-messaging host the browser launches. The registered host name is
// unchanged from earlier builds, so host manifests already installed on disk
// keep resolving.
export const NATIVE_HOST = 'ai.sonomos.desktop';

// The Locke desktop app's presence listener accepts `POST /heartbeat` on this
// loopback port. The extension announces itself there on its own fixed
// presence tick, fire-and-forget — the app not running is the normal case.
export const PRESENCE_URL = 'http://127.0.0.1:18795/heartbeat';

// Same listener, the self-registration route: when the native host refuses
// this extension (NO_BRIDGE — an unpacked load whose path-derived id is not
// in allowed_origins, or nothing registered at all), the worker POSTs
// `{ id, browser, version }` here and the desktop app decides — an already-
// authorised id answers `approved` with no UI; an unknown one pends a
// one-click consent prompt in the app. Same origin as PRESENCE_URL, which
// is the one origin the manifest's CSP `connect-src` pins — a new PATH
// needs no manifest change, a new port would.
export const REGISTRATION_URL = 'http://127.0.0.1:18795/register-extension';

// Client-side floor between registration POSTs. Rides under the 30 s
// presence/heartbeat cadence so at most one request per tick; the desktop
// app has its own pending-set cap on top.
export const REGISTRATION_MIN_INTERVAL_MS = 25_000;

// ── presence is a fact, not a health verdict ────────────────────────
//
// Two questions, two answers, two cadences:
//
//   "am I installed?"        — the extension always knows. Never in doubt,
//                              never expensive to say, and the desktop app
//                              shows an INSTALL instruction when the answer
//                              goes missing.
//   "can I reach the app?"   — a native-messaging round trip that may launch
//                              a host process and probe the desktop app behind
//                              it (shared/health-client.js::checkHealth).
//                              Worth backing off when it keeps failing.
//
// The beacon used to ride the health alarm, so the second question's backoff
// silenced the first one's answer: with Locke down the health alarm walks out
// to `backoffMaxSeconds` (300 s), and the moment Locke comes UP is precisely
// the moment the backoff is at its widest. The app — whose listener only
// starts with the app, so it begins each run having never heard from us — then
// told the user to install an extension that was installed and screening, for
// up to five minutes. Presence now has its own alarm that never backs off.
//
// 30 s is the MV3 `chrome.alarms` floor and the cadence the reader's staleness
// window was sized for. It is deliberately NOT derived from `heartbeatSeconds`
// (user- and policy-settable): the presence cadence is half of a contract with
// another process, not a preference.
export const PRESENCE_INTERVAL_SECONDS = 30;

// The reader's half of that contract: the desktop app marks a heartbeat stale
// — and reports the browser as absent — once it is older than this. Mirrored
// here so the producer cadence can be checked against it.
export const PRESENCE_STALE_MS = 45_000;

export const STATUS = Object.freeze({
  CONNECTED: 'connected',
  WARMING: 'warming',
  DISCONNECTED: 'disconnected',
  NO_BRIDGE: 'no-bridge',
  UNKNOWN: 'unknown'
});

// ── infrastructure vs policy ────────────────────────────────────────
//
// The whole capture chain fails CLOSED, so "screening was down" and "your
// content was refused" both arrive as `decision: block`. The difference is
// the entire message a user gets: an outage is transient and retrying is the
// right advice; a policy refusal is terminal and the user must change what
// they are sending. Telling somebody the second when the first is true sends
// them hunting for PII they never sent, which is how a privacy tool loses
// their trust.
//
// `receipt.blockCause` answers that question directly, and
// [`isInfrastructureBlock`] below is the classifier every caller should use:
// cause first, this string set only as the fallback.
//
// ── TRANSITIONAL FALLBACK — do not extend, and do not delete yet ────
//
// `INFRASTRUCTURE_REASONS` / `isInfrastructureReason` / `infrastructureFragment`
// stay for the mixed-version window where a sender predates `blockCause` (or
// hasn't set it): the extension and the Locke desktop app ship on separate
// schedules, so that window is real. Once every peer this extension talks to
// is confirmed to send a real cause on every block, this whole set — and
// `isInfrastructureBlock`'s fallback arm — can go.
//
// Two facts govern the set. Every fragment names an OUTAGE rather than a
// policy refusal — that is the only distinction it exists to draw. And the
// fragments are matched as substrings against text the desktop app authors, so
// they must stay in step with what it emits; one that drifts stops recognising
// the outage it names.
//
// The sixth fragment, `bridge protocol failure`, covers a frame that could not
// be decoded at all — a wire-version mismatch, not a policy decision. That
// branch still fails CLOSED (`decision: block`), correctly, but until this
// fragment was added here it carried no token this repo recognised, so
// `evidenceFromReceipt` (`shared/screening.js`) read it as a real verdict and
// the popup showed "Screening: Active" while every capture on that connection
// was silently failing to decode.
//
// NOT on this list, deliberately: the screener's own capacity refusals —
// `request exceeds the size cap`, `over the … cap`, `unparseable request` —
// which really are infrastructure (it declined to LOOK, on a byte count, a
// field count, or a parse failure) but were never enumerated here. Reading
// them through this string set alone (no `blockCause`) fell through to the
// policy default and showed the user "screening stopped this request" on a
// prompt with nothing sensitive in it. `isInfrastructureBlock` is what fixes
// that, by reading `blockCause` before ever reaching this fallback.
//
// Degradation is one-way and safe: an UNMATCHED reason is read as a policy
// refusal, which still blocks. Drift costs a worse message, never a send.
//
// ── where the list comes from ───────────────────────────────────────
//
// It is NOT declared here any more. `INFRASTRUCTURE_REASONS` is imported at the
// top of this file from `shared/vocab.generated.js`, which
// `scripts/generate-vocab.mjs` compiles from `shared/vocab.json` — the copy of
// `Service-Mesh/sonomos-vocab/vocab.json` that Locke's
// `scripts/sync-surfaces.sh` vendors into this repo.
//
// The chain, and what holds each link:
//
//   sonomos_vocab::INFRASTRUCTURE_REASON_FRAGMENTS   the one declaration
//     ↓  pinned entry-for-entry and IN ORDER by that crate's
//        `vocab_json_matches_the_enums`
//   Service-Mesh/sonomos-vocab/vocab.json            canonical, machine-readable
//     ↓  vendored by Locke `scripts/sync-surfaces.sh`, held identical by its
//        `--check` mode, which Locke's `vendored-vocab` fleet pin runs on every
//        gated push
//   shared/vocab.json                                this repo's copy
//     ↓  `npm run generate`, and `tests/constants.test.js` pins the export back
//        to the JSON so a hand-edit of the generated file is caught
//   shared/vocab.generated.js → what you import from here
//
// Until this landed, the fragments were declared here as a literal and the only
// thing holding them to the Rust was a test in a THIRD repo: Extension-Bridge
// read a constants.js off the filesystem and regexed the array out of it. It
// was the wrong mechanism — no repo can declare, version or fetch
// `../<Neighbour>`, so it was green only on a machine with the whole fleet
// checked out beside it — and it was also aimed at the wrong repo: the path it
// read was `../Depreciated-Desktop-Extension/shared/constants.js`, this
// extension's home before the 2026-08-31 rename. It had been comparing Rust to
// a copy in a repo that ships no extension. There is nothing here to drift now.
//
// Deleting all of this stays easy, which the note above says is the plan: it is
// this import, the generated file, two tests and one Locke sync target. No
// consumer changes, because `isInfrastructureBlock` reads the cause first and
// only falls through to these strings.
//
// `content/shim.js` carries a byte-identical copy — a MAIN-world classic script
// cannot import an ES module, generated or not — and tests/constants.test.js
// fails if the two ever drift.

// Which fragment matched, or null. Returning the fragment (rather than a bare
// boolean) means anything we persist or display is a string from OUR closed
// set, never one echoed back from upstream.
export function infrastructureFragment(reason) {
  if (typeof reason !== 'string') return null;
  return INFRASTRUCTURE_REASONS.find((fragment) => reason.includes(fragment)) ?? null;
}

// Transitional fallback — see the module doc above. Prefer
// [`isInfrastructureBlock`] for anything that has a receipt to read.
export function isInfrastructureReason(reason) {
  return infrastructureFragment(reason) !== null;
}

// The three wire values `blockCause` can carry.
export const BLOCK_CAUSE = Object.freeze({
  POLICY: 'policy',
  INFRASTRUCTURE: 'infrastructure',
  UNSPECIFIED: 'unspecified'
});

// THE REAL CLASSIFIER. Reads `receipt.blockCause` when the sender said
// something meaningful — authoritative, never second-guessed against
// `reason` prose — and falls back to [`isInfrastructureReason`]'s string
// match only when the cause is `unspecified`, missing, or a value this
// build doesn't recognise (a newer peer's vocabulary; absorbing here, not
// throwing, is deliberate — the whole point of a closed-set field is that a
// reader who doesn't know a word still has a safe answer). Never lets an
// unknown cause soften a block: whatever this returns, the caller still has
// exactly the same fail-closed default it had before `blockCause` existed.
export function isInfrastructureBlock(receipt) {
  const cause = receipt && typeof receipt === 'object' ? receipt.blockCause : undefined;
  if (cause === BLOCK_CAUSE.INFRASTRUCTURE) return true;
  if (cause === BLOCK_CAUSE.POLICY) return false;
  return isInfrastructureReason(receipt && receipt.reason);
}

// ── screening availability ──────────────────────────────────────────
//
// Deliberately NOT the same thing as STATUS. STATUS answers "is the Locke
// desktop app reachable"; this answers "is anything actually screening". The
// host's `status` probe can only establish the first — see
// shared/screening.js for why, and for the evidence that establishes the
// second.
export const SCREENING = Object.freeze({
  // A real verdict came back inside the freshness window.
  AVAILABLE: 'available',
  // Either there is no path to the desktop app, or it told us screening
  // could not happen (one of INFRASTRUCTURE_REASONS).
  UNAVAILABLE: 'unavailable',
  // The desktop app is reachable but nothing has proved anything behind it is
  // screening. This is the honest answer to "connected", NOT "protected".
  UNCONFIRMED: 'unconfirmed'
});

// storage.session key for the screening evidence + fail-open tallies.
export const SCREENING_KEY = 'screeningState';

// How long a capture's verdict stays evidence about *now*. Ten minutes: long
// enough that an idle popup still reflects the session the user was just in,
// short enough that "screened fine this morning" never renders as "Active"
// on an afternoon where screening has since died.
export const SCREENING_EVIDENCE_TTL_MS = 10 * 60 * 1000;

// How long a capture that failed stays the event the popup may NAME.
//
// It used to have a second, larger job — holding a failed send above a live
// reachability probe that said the desktop app was fine. That arbitration is
// gone, because the conflict cannot arise any more: a live positive is not evidence
// of screening at all (`shared/screening.js`, and `shared/health-client.js`'s
// `screeningFromStatus`, which no longer forwards one), so there is nothing
// for a failed capture to have to outrank. The popup-vs-page contradiction
// that motivated the window — "Sonomos blocks my attachment saying the Locke
// desktop app could not be reached, but the popup says Online / Active at the
// same time" — is now prevented structurally rather than for sixty seconds.
//
// What remains is naming: `captureFailureToName` uses this to decide whether a
// recent failure is still the same event the user is looking at on the page,
// and therefore whether the popup may describe it as that event rather than as
// a second problem.
//
// One minute: long enough to cover the heartbeat that follows a failed send
// (`heartbeatSeconds`, 30s) plus the retry a user makes straight after it,
// short enough that the popup stops pointing at an event that has scrolled out
// of the user's attention. Well under SCREENING_EVIDENCE_TTL_MS, which still
// bounds the same evidence for every other purpose.
export const SCREENING_CONTRADICTION_WINDOW_MS = 60 * 1000;

export const MSG = Object.freeze({
  REQUEST_CHECK: 'requestCheck',
  STATE_UPDATE: 'stateUpdate',
  TELEMETRY: 'telemetry',
  // Content script → service worker: one held AI request to relay to the
  // desktop app via the native host. Carries `requestB64` — the shim's synthesized
  // raw HTTP request, base64 (sensitive; relayed, never logged).
  CAPTURE: 'capture'
});

// Native-messaging host message `type`s. The host knows exactly these three.
export const BRIDGE_MSG = Object.freeze({
  HELLO: 'hello',
  STATUS: 'status',
  CAPTURE: 'capture'
});

// Page-world (shim) ↔ content-script protocol. Tagged with a unique prefix so
// we never confuse Sonomos messages with anything else on window.postMessage.
// Request/response, matched by callId: the shim posts CAPTURE (holding the
// page's request; `requestB64` is the synthesized raw HTTP request) and the
// content script answers with VERDICT once the desktop app returns one. The
// shim enforces on that verdict — send as held, send the rebuilt request, or
// block. Redaction itself happens in the desktop app; the shim only applies
// the result.
export const PAGE_MSG = Object.freeze({
  CAPTURE: 'SONOMOS_CAPTURE',
  VERDICT: 'SONOMOS_VERDICT',
  // Content script → shim, one-way: the SHIM_SETTING_KEYS values, pushed at
  // document_start and re-pushed whenever they change. The shim holds working
  // defaults until (and if) this ever arrives — it must never wait on config
  // to enforce.
  CONFIG: 'SONOMOS_CONFIG'
});
