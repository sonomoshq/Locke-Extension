// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Is anything actually screening? — and how much has gone out unscreened.
//
// Pure functions, no browser APIs, so both the service worker and the tests
// can use them directly. The service worker owns the storage; this file owns
// the reasoning.
//
// ## Why "connected" is not an answer
//
// The popup's connection state comes from the native host's `status` message.
// `connected` proves the Locke desktop app is running and NOTHING about
// whether it can actually screen.
//
// Rendering that as "you are protected" would be a false assurance the user
// acts on — the same defect class as an on/off switch that does nothing — and
// it is worst in exactly the state where it matters most: screening down,
// every AI request being held back, and the popup calmly reporting Online.
// `screeningFor`'s first branch is what keeps `connected` from ever being read
// that way.
//
// ## The live probe can prove a negative, and only a negative
//
// The host's `status` reply carries a live reachability answer as a
// `screening` field, run fresh on every call and never cached, passed to
// `screeningFor` here as `liveScreening`. It is the fastest way to learn that
// screening has DIED between sends, which used to go unnoticed until the next
// request was blocked, and that is what it is for.
//
// It is NOT a way to learn "Active" without waiting on the first real send,
// and it was read that way for a while. The probe establishes reachability and
// nothing further: a desktop app whose screener is down, crashed, or still
// starting up answers the probe exactly the way a healthy one does. In that
// window every real capture fail-closes with `engine unavailable` while the
// probe says yes throughout. Opening the popup then used to read "Active —
// Locke confirmed screening is active" while nothing in the chain could screen
// a single request.
//
// So a live positive contributes NOTHING here — it does not raise the answer,
// and `screeningFromStatus` (shared/health-client.js) does not even forward
// one. It is the same defect this file's first paragraph is about ("connected"
// rendering as "protected"), displaced one hop inward, and the fix is the
// same: let the claim be earned by evidence that supports it. Bad news still
// travels instantly — a live `'unavailable'` is acted on the moment it
// arrives.
//
// There is deliberately no deeper probe to reach for. The only frame that
// would reach the screener is a synthetic capture, which would spend the
// user's scan budget and land in their own detection history as an event they
// did not cause.
//
// ## What we can honestly assert
//
// Four things:
//
//  1. **No path, no screening.** If the host cannot reach the desktop app,
//     nothing can be screened. That is certain, and it is the one negative
//     the extension could always assert on its own.
//  2. **A live `'unavailable'` outranks everything but rule 1.** It was
//     checked THIS instant against the desktop app itself, so it is newer than
//     any receipt could be, and it is the direction that holds requests back.
//     Its mirror image is not symmetric: a live positive establishes only that
//     the app answered, so it is not evidence of screening at any freshness and
//     never outranks anything.
//  3. **The traffic itself is evidence.** Every capture receipt is first-hand
//     testimony about the screener, because it came from the screener. A
//     verdict that could only follow a real screen — `allow`, `redact`, or a
//     `block` for a policy reason — proves it answered. A `block` classified
//     `blockCause: infrastructure` (or, absent that, one of the shared
//     INFRASTRUCTURE_REASONS — see `constants.js::isInfrastructureBlock`)
//     proves it did not. But a verdict is testimony about the SCREENER, not a
//     certificate for the REQUEST: an `allow` or `redact` carrying
//     `unchecked` shipped content nobody examined, and that receipt cannot
//     be read as a screen — see `shippedUnscreened` below.
//  4. **A capture that failed without producing a verdict proves neither.**
//     A relay that could not deliver, an empty or undecodable reply, a
//     half-parsed receipt that fail-closed to `block` with no reason — each
//     of these means a real request was held back and nobody can say whether
//     anything behind it is screening. That is UNCONFIRMED evidence: a
//     first-class "we cannot tell", not a negative and emphatically not an
//     absence. Before it existed, all of these produced NO evidence at all,
//     which left whatever the last good receipt said standing — so a browser
//     on which every single capture was failing kept rendering "Active" off a
//     verdict from ten minutes ago.
//
// ## Why the popup cannot contradict the page
//
// This file used to carry an explicit rule for the case where the probe said
// yes and a real capture had just said no: inside
// SCREENING_CONTRADICTION_WINDOW_MS, the failed send won and the answer was
// UNCONFIRMED. The rule existed because the page had just told the user "the
// Locke desktop app could not be reached" while the popup read "Active" in the
// same instant — two of our own surfaces disagreeing, which a user resolves by
// concluding the site is broken and Sonomos is fine.
//
// That rule is gone because the conflict it arbitrated cannot arise any more:
// a live positive is not evidence here at all, so there is nothing for a
// failed capture to have to outrank. The guarantee is now structural rather
// than time-boxed — and strictly stronger, since it no longer expires after a
// minute. The window constant remains, still doing its other job: bounding
// which recent capture event the popup may NAME (`captureFailureToName`).
//
// Evidence is timestamped and decays (SCREENING_EVIDENCE_TTL_MS), because a
// verdict from an hour ago says nothing about now. When there is no fresh
// evidence — live or stored — the answer is UNCONFIRMED, never AVAILABLE by
// default.

import {
  SCREENING,
  SCREENING_CONTRADICTION_WINDOW_MS,
  SCREENING_EVIDENCE_TTL_MS,
  STATUS,
  infrastructureFragment,
  isInfrastructureBlock
} from './constants.js';

// Relay failures that PROVE nothing was screened. Deliberately short: only
// the two codes that mean "the hop below the browser reached far enough to
// establish that no verdict could be produced".
const RELAY_FAILURES_PROVING_NO_SCREEN = Object.freeze([
  'bridge-unreachable', // the host could not reach the desktop app
  'screening-timeout'   // the host's own deadline expired with no verdict
]);

// Relay failures that prove a capture got NO verdict without proving anything
// about the screener. Every one of these blocked a real request in the browser
// (`content/shim.js` maps them to `native-call-failed` / `verdict-malformed`
// and fails closed), so each is first-hand proof that the popup cannot claim
// screening is active — and equally, no proof that screening is down.
//
// These used to yield NO evidence, on the reasoning that they say nothing
// reliable about the screener. That reasoning is right about the screener and
// wrong about the popup: "no evidence" left the last good receipt standing, so
// a browser whose every capture was failing kept reading Active. UNCONFIRMED is
// the state that was missing.
//
// NOT here, deliberately: `receipt-too-large` (the native-messaging reply cap).
// That request WAS screened and a redaction was found — the rebuilt body
// simply did not fit back through native messaging. It is a size limit, the
// shim says so to the user (`kind=too-large`, "NOT a sensitive-data block"),
// and downgrading the popup for it would manufacture a doubt the page did not
// raise. It yields no evidence either way rather than a guess.
const RELAY_FAILURES_PROVING_NO_VERDICT = Object.freeze([
  'no-bridge',               // the native host is not registered at all
  'bridge-empty',            // the host answered with nothing we can read
  'bridge-unknown-response', // ...or with a frame type this build doesn't know
  'bridge-error',            // native messaging itself failed
  'capture-error',           // the worker threw relaying it
  'bad-request'              // the host rejected our frame as malformed
]);

// Did this receipt's request go out WITHOUT a complete screen?
//
// The screener's own unchecked/withheld pairing, in one place, because two
// surfaces answering it differently is the bug this predicate exists to make
// impossible: `tallyFromReceipt` counts it for the popup's session note and
// `evidenceFromReceipt` refuses to call it a screen, and they must never
// disagree about the same receipt. `content/shim.js` `decide()` is the third
// copy (a MAIN-world classic script cannot import this module) and is worded
// the same on purpose.
//
//   allow  + (unchecked OR unscreened items) ⇒ true. An allow can never be a
//     withhold — withholding rebuilds the request, so a withhold is always a
//     `redact` — which is why the items alone are enough here, and why this
//     stays honest against a sender too old to send the flag.
//   redact + unchecked                       ⇒ true (the user's fail-open
//     window let the unexamined bytes out).
//   redact + !unchecked + unscreened items   ⇒ FALSE. This is a withhold: the
//     bytes stayed on this machine and an inert placeholder went in their
//     place. The screener looked, could not examine one part, and held it back
//     — which is screening working, not screening skipped.
//   block                                    ⇒ false; nothing left at all.
//
// `unchecked` is read as `=== true`, so an ABSENT key is `false` — matching
// the host's own default for a missing field. That is the safe direction for
// both callers here, because absent means "a sender too old to have the
// field", not "a sender who declined to answer": reading it as `true` would
// report every request from an old sender as a fail-open leak. The `allow`
// branch's items fallback is the belt to that braces — the one shape where an
// old sender can still prove the send went out unexamined.
function shippedUnscreened(receipt) {
  const unchecked = receipt.unchecked === true;
  if (receipt.decision === 'allow') {
    return unchecked || (Array.isArray(receipt.unscreened) && receipt.unscreened.length > 0);
  }
  if (receipt.decision === 'redact') return unchecked;
  return false;
}

// Evidence from one capture receipt.
//
// Only three shapes are a definite answer: a fully-screened `allow`, a
// fully-screened `redact`, and a `block` that carries a reason. Everything
// else — a `block` with NO reason string, a missing or unrecognised decision,
// a receipt that is not an object at all — is UNCONFIRMED: the request was
// held back and we cannot say why.
//
// ## An `allow` is not automatically proof of a screen
//
// The exception that used to be missing, and the reason this function ever
// returned a green it had no right to: `allow`/`redact` + `unchecked` means
// the request WENT OUT with content nobody examined, under the user's own
// time-boxed fail-open window. The receipt proves the screener is alive and it
// proves this send was not fully screened, in the same breath.
//
// AVAILABLE was the one answer that could not be true of it — the popup
// rendered a confident "Screening: Active" for the single kind of send where
// unexamined bytes had just reached the provider, which is this file's own
// rule ("never render a green state from a signal that does not prove
// protection") violated by a signal that actively disproves it.
//
// UNCONFIRMED, not UNAVAILABLE, and the distinction is the whole point:
//
//   - UNAVAILABLE means nothing is screening — no path to the desktop app, or
//     the app itself saying it could not. Neither is true here. It answered,
//     promptly and correctly, and its answer honoured a setting the
//     user deliberately opened. Saying "screening isn't answering" (the
//     UNAVAILABLE sentence in `popup/copy.js`) would blame the infrastructure
//     for a user's choice, fire a `screening-unavailable` audit event for a
//     healthy machine, and claim requests are "being held back" when the
//     opposite just happened.
//   - UNCONFIRMED is the state this repo already keeps for "a real capture
//     happened and it does not entitle us to claim a screen". That is exactly
//     what this is. It also carries the two behaviours we want for free: no
//     live probe answer can overwrite it (reaching the desktop app does not
//     un-send what already went out unexamined), and one clean receipt
//     restores AVAILABLE immediately — so this is honest about now, never a
//     sticky penalty for a window the user has since closed.
//
// The `code` rides along as `sent-unscreened` so the popup names WHICH event
// it is reasoning from. It matters more here than anywhere else: the generic
// "cannot tell" sentence says nothing was sent unscreened, which is the exact
// inverse of this case, and swapping one false sentence for its mirror image
// would not be a fix.
//
// The reasonless-block branch is the one worth reading twice. The host
// defaults a half-parsed receipt to `block` (fail-closed, deliberately), so a
// truncated frame arrives looking exactly like a policy refusal. Counting it
// as "the screener answered" would let a broken wire render as Active;
// counting it as "screening is down" would blame the screener for a wire
// fault. It is neither, and now it says so.
//
// `fragment` stays a fact about the reason STRING (via `infrastructureFragment`,
// never a re-spelling of `blockCause`) so callers that persist or audit-log it
// keep getting a value from our own closed set, or `null` when the classification
// came from `blockCause` and no legacy fragment happened to match too — `null`
// here is honest, not a regression: `state` already carries the real answer.
export function evidenceFromReceipt(receipt, now = Date.now()) {
  const cannotTell = { state: SCREENING.UNCONFIRMED, fragment: null, at: now, code: 'verdict-unreadable' };
  if (!receipt || typeof receipt !== 'object') return cannotTell;
  const decision = receipt.decision;
  if (decision === 'allow' || decision === 'redact') {
    return shippedUnscreened(receipt)
      ? { state: SCREENING.UNCONFIRMED, fragment: null, at: now, code: 'sent-unscreened' }
      : { state: SCREENING.AVAILABLE, fragment: null, at: now, code: null };
  }
  if (decision === 'block') {
    if (typeof receipt.reason !== 'string' || receipt.reason === '') return cannotTell;
    return isInfrastructureBlock(receipt)
      ? { state: SCREENING.UNAVAILABLE, fragment: infrastructureFragment(receipt.reason), at: now, code: null }
      : { state: SCREENING.AVAILABLE, fragment: null, at: now, code: null };
  }
  return cannotTell; // missing or unrecognised decision
}

// Evidence from a relay failure the service worker saw instead of a receipt.
// Null only for a code that is not ours to interpret — see the two sets above
// for which failures prove a negative and which prove only a blind spot.
//
// `code` rides along on the non-positive answers so the popup can say WHICH
// capture failure it is reasoning from, rather than leaving the user to guess
// whether the block they just saw on the page and the state they are reading
// in the popup are the same event or two separate problems.
export function evidenceFromRelayFailure(code, now = Date.now()) {
  if (typeof code !== 'string') return null;
  if (RELAY_FAILURES_PROVING_NO_SCREEN.includes(code)) {
    return { state: SCREENING.UNAVAILABLE, fragment: null, at: now, code };
  }
  if (RELAY_FAILURES_PROVING_NO_VERDICT.includes(code)) {
    return { state: SCREENING.UNCONFIRMED, fragment: null, at: now, code };
  }
  return null;
}

// How much this receipt sent unscreened, how much it held back, and how much
// it redacted.
//
// The unscreened/withheld pairing rule is the screener's own, and it lives in
// `shippedUnscreened` above — read it there. This function only turns that
// one answer into counts: a count the popup shows, a warning the console
// shows, and the screening state the popup renders must never disagree about
// whether something leaked, which is why all three read the same predicate.
//
// `redactedItems` is a separate, independent fact: the screener's own
// `redactedCount`, the number of PII spans it actually found and removed from
// what shipped. It is NOT part of the pairing above — a request can be
// counted as WITHHELD (an attachment couldn't be examined) or as fail-open
// SENT unscreened (a different attachment did) and STILL have redacted a real
// span of text in the same breath, because those are facts about different
// parts of the same request. Hiding the redaction count because one of the
// other two fired would be exactly the kind of collapsed evidence this file
// exists to avoid — see popup/copy.js `noteFor`, which is the one place this
// number was going uncollected even though every receipt already carried it.
// `allow` never carries a positive count: an `allow` always sends
// `redactedCount: 0`, because nothing was rewritten.
export function tallyFromReceipt(receipt) {
  const none = { uncheckedSends: 0, withheldItems: 0, redactedItems: 0 };
  if (!receipt || typeof receipt !== 'object') return none;
  const items = Array.isArray(receipt.unscreened) ? receipt.unscreened.length : 0;
  const sentUnscreened = shippedUnscreened(receipt);
  const redactedItems = Number.isInteger(receipt.redactedCount) && receipt.redactedCount > 0
    ? receipt.redactedCount
    : 0;
  if (receipt.decision === 'allow') {
    // `allow` never carries a positive redacted count (see above), so it is
    // not passed on here even when a malformed receipt claims one.
    return sentUnscreened ? { uncheckedSends: 1, withheldItems: 0, redactedItems: 0 } : none;
  }
  if (receipt.decision === 'redact') {
    if (sentUnscreened) return { uncheckedSends: 1, withheldItems: 0, redactedItems };
    return { uncheckedSends: 0, withheldItems: items, redactedItems };
  }
  return none;
}

// Stored evidence, but only if it is still a claim about now. Null for
// anything absent, unreadable, carrying a state outside our closed set, or
// older than the TTL — all of which mean the same thing to every caller: there
// is nothing here to reason from.
function freshEvidence(evidence, now) {
  if (!evidence || typeof evidence !== 'object') return null;
  const { state } = evidence;
  if (state !== SCREENING.AVAILABLE &&
      state !== SCREENING.UNAVAILABLE &&
      state !== SCREENING.UNCONFIRMED) {
    return null;
  }
  const at = typeof evidence.at === 'number' ? evidence.at : 0;
  if (now - at > SCREENING_EVIDENCE_TTL_MS) return null;
  return evidence;
}

// The screening state to show, given the connection status, the stored
// capture evidence, and (optionally) the host's own live probe answer.
//
// **AVAILABLE has exactly one source: a real capture receipt.** No connection
// state, and no live probe answer at any freshness, can produce it. That is
// the whole shape of this function — see the module doc for why a probe that
// reaches the desktop app establishes nothing about whether it can screen.
//
// `liveScreening` is `screeningFromStatus`'s return value
// (shared/health-client.js): `SCREENING.UNAVAILABLE`, or `null`/anything else
// for "no live signal". It is deliberately read for one value only. A caller
// that hands this a `SCREENING.AVAILABLE` — an older build, a test, a future
// signal that has not been reasoned about — gets it ignored rather than
// honoured: there is no branch here that a positive can reach, so the
// guarantee holds by construction rather than by every caller being careful.
//
// The precedence, in the order it is applied:
//
//   1. No connection ⇒ UNAVAILABLE. Nothing outranks "there is no path".
//   2. A live `'unavailable'` ⇒ UNAVAILABLE. The newest possible bad news,
//      and bad news is never held back or softened.
//   3. Otherwise ⇒ whatever fresh stored evidence says, including its own
//      UNCONFIRMED, and UNCONFIRMED when there is none. This is where a live
//      positive lands, alongside "the host said nothing": both leave the
//      answer to the traffic.
//
// One consequence, chosen rather than stumbled into: **recovery is signalled
// by traffic, not by the probe.** After a real outage receipt, a screener that
// comes back does not turn the popup green until something is actually
// screened — the probe cannot see the screener, so it cannot report that it
// recovered. The cost is a user seeing "Unavailable" until their next
// send (and the receipt ages out at SCREENING_EVIDENCE_TTL_MS regardless);
// the alternative is "Active" while nothing screens, which is the failure
// this whole file exists to prevent.
export function screeningFor(status, evidence, now = Date.now(), liveScreening = null) {
  if (status !== STATUS.CONNECTED) return SCREENING.UNAVAILABLE;

  if (liveScreening === SCREENING.UNAVAILABLE) return SCREENING.UNAVAILABLE;

  const fresh = freshEvidence(evidence, now);
  return fresh ? fresh.state : SCREENING.UNCONFIRMED;
}

// The recent capture event the popup should NAME, or null when there is
// nothing to name. Non-null exactly while it is recent enough to be the same
// event the user is looking at on the page.
//
// It can never appear next to an "Active" row, and no longer needs a window to
// guarantee that: a non-null answer here requires fresh non-AVAILABLE stored
// evidence, and that same evidence is the only thing `screeningFor` reads once
// the connection is up and the live probe has not said "unavailable". The two
// cannot disagree because they are looking at one value.
//
// Mostly a failure, but not always: `sent-unscreened` is a capture that
// SUCCEEDED and shipped part of itself unexamined. It belongs here for the
// same reason the failures do — the shim warned about it in the page's
// console at that moment, so a popup that cannot name it is a second surface
// telling a different story about one event (`popup/copy.js` `detailFor`
// keys on the code for exactly this reason).
//
// Shape-only: our own closed-set code and a timestamp. Never a URL, never a
// reason echoed from upstream.
export function captureFailureToName(evidence, now = Date.now()) {
  const fresh = freshEvidence(evidence, now);
  if (!fresh || fresh.state === SCREENING.AVAILABLE) return null;
  const at = typeof fresh.at === 'number' ? fresh.at : 0;
  if (now - at > SCREENING_CONTRADICTION_WINDOW_MS) return null;
  return { code: typeof fresh.code === 'string' ? fresh.code : null, at };
}
