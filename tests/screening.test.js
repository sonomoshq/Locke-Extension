// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

import {
  captureFailureToName,
  evidenceFromReceipt,
  evidenceFromRelayFailure,
  screeningFor,
  tallyFromReceipt
} from '../shared/screening.js';
import {
  SCREENING,
  SCREENING_CONTRADICTION_WINDOW_MS,
  SCREENING_EVIDENCE_TTL_MS,
  STATUS
} from '../shared/constants.js';
import { copyFor, noteFor, viewFor } from '../popup/copy.js';

// The defect these tests exist to prevent: a popup that reads "Online — Locke
// is protecting your AI chats" while screening is down and every request is
// being held back. That is a false assurance the user acts on. The host's
// probe cannot tell the two apart, so the answer has to come from evidence.

const NOW = 1_770_000_000_000;

// ── evidence from a capture receipt ────────────────────────────────

test('a real verdict proves the desktop app answered', () => {
  for (const decision of ['allow', 'redact']) {
    assert.deepEqual(
      evidenceFromReceipt({ decision }, NOW),
      { state: SCREENING.AVAILABLE, fragment: null, at: NOW, code: null },
      decision
    );
  }
});

test('a policy block also proves the desktop app answered — it looked and said no', () => {
  assert.deepEqual(
    evidenceFromReceipt({ decision: 'block', reason: 'US SSN detected' }, NOW),
    { state: SCREENING.AVAILABLE, fragment: null, at: NOW, code: null }
  );
});

test('an infrastructure block proves it did not, and names which fragment', () => {
  assert.deepEqual(
    evidenceFromReceipt(
      { decision: 'block', reason: 'guard unreachable — blocked (fail-closed)' },
      NOW
    ),
    { state: SCREENING.UNAVAILABLE, fragment: 'guard unreachable', at: NOW, code: null }
  );
  // Only ever a fragment from our own closed set — never a string echoed back
  // from upstream into storage or the audit log.
  assert.equal(
    evidenceFromReceipt({ decision: 'block', reason: 'screening: engine saturated' }, NOW)
      .fragment,
    'engine saturated'
  );
});

test('an undecodable-frame block proves it did not — it must not read as an answer', () => {
  // The desktop app's undecodable-record reason, verbatim. It fails CLOSED
  // here correctly (block), but before `bridge protocol failure` joined
  // INFRASTRUCTURE_REASONS this reason matched nothing, so this receipt
  // evaluated as evidence the request had been screened — end to end, a popup
  // reading "Screening: Active" while nothing was being screened.
  const reason =
    'bridge protocol failure — undecodable extension record (wire-version mismatch?), blocked (fail-closed)';
  const evidence = evidenceFromReceipt({ decision: 'block', reason }, NOW);
  assert.deepEqual(evidence, { state: SCREENING.UNAVAILABLE, fragment: 'bridge protocol failure', at: NOW, code: null });

  // …and the popup renders that as unavailable/retryable, never as active.
  const screening = screeningFor(STATUS.CONNECTED, evidence, NOW);
  assert.equal(screening, SCREENING.UNAVAILABLE);
  const copy = copyFor({ status: STATUS.CONNECTED, error: null, screening });
  assert.equal(copy.screeningLabel, 'Unavailable');
  assert.match(copy.detail, /screening isn’t answering/);
  assert.match(copy.detail, /held back/);
  // The literal claim this whole split exists to keep honest: "could not
  // check" is not "checked and refused" — the copy must never say both.
  assert.ok(!/protecting/.test(copy.detail), copy.detail);
  assert.ok(!/refused/.test(copy.detail), copy.detail);
});

// ── THE FIX: blockCause first, string match as fallback ──

test('a capacity refusal with a real cause proves nothing was screened', () => {
  // A verbatim capacity refusal: the desktop app declined to LOOK, so this
  // must read as UNAVAILABLE even though the reason string matches nothing in
  // the legacy fragment set.
  const reason = 'request exceeds the size cap';
  assert.deepEqual(
    evidenceFromReceipt({ decision: 'block', blockCause: 'infrastructure', reason }, NOW),
    { state: SCREENING.UNAVAILABLE, fragment: null, at: NOW, code: null },
    'fragment is null (no legacy string matched) but state must still be UNAVAILABLE'
  );
});

test('a genuine policy block stays AVAILABLE-proving even with infrastructure-shaped prose', () => {
  // The cause is authoritative once a peer sets it, never overridden by
  // prose that happens to contain a legacy fragment.
  assert.deepEqual(
    evidenceFromReceipt(
      {
        decision: 'block',
        blockCause: 'policy',
        reason: 'blocked: this would leave the engine unavailable to others'
      },
      NOW
    ),
    { state: SCREENING.AVAILABLE, fragment: null, at: NOW, code: null }
  );
});

test('an unspecified or missing blockCause falls back to the string match unchanged', () => {
  // Same fixtures as the pre-existing tests above, but with an explicit
  // unspecified cause: proves the fallback path is reached deliberately,
  // not just by accident of an absent key.
  assert.deepEqual(
    evidenceFromReceipt(
      { decision: 'block', blockCause: 'unspecified', reason: 'guard unreachable — blocked (fail-closed)' },
      NOW
    ),
    { state: SCREENING.UNAVAILABLE, fragment: 'guard unreachable', at: NOW, code: null }
  );
  assert.deepEqual(
    evidenceFromReceipt({ decision: 'block', blockCause: 'unspecified', reason: 'US SSN detected' }, NOW),
    { state: SCREENING.AVAILABLE, fragment: null, at: NOW, code: null }
  );
});

test('a block with no reason is "cannot tell" — never a screen that happened', () => {
  // The host defaults a truncated receipt to `block` (fail-closed, correctly),
  // so a broken wire arrives looking exactly like a policy refusal. Counting
  // that as "it answered" would render a broken chain as Active; counting it
  // as "it is down" would blame the desktop app for a wire
  // fault. It is neither, and it must not be silence either — silence leaves
  // the last good receipt standing, which is how a browser whose captures are
  // all failing kept reading Active.
  const cannotTell = { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW, code: 'verdict-unreadable' };
  assert.deepEqual(evidenceFromReceipt({ decision: 'block' }, NOW), cannotTell);
  assert.deepEqual(evidenceFromReceipt({ decision: 'block', reason: '' }, NOW), cannotTell);
});

// ── an allow that shipped unexamined bytes is not a screen ─────────
//
// The worst version of the defect this file exists to prevent, because the
// signal does not merely fail to prove protection — it disproves it. A
// receipt marked `unchecked` says the request WENT OUT with content nobody
// examined — the unexamined bytes DID leave — and the popup rendered a
// confident "Screening: Active" for exactly that send.
//
// UNCONFIRMED, not UNAVAILABLE: the desktop app is demonstrably alive — it answered
// — and it honoured a window the user opened themselves. Blaming the
// infrastructure ("screening isn't answering", plus a `screening-unavailable`
// audit entry on a healthy machine) would be a different wrong answer.

const unscreenedEvidence = { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW, code: 'sent-unscreened' };

test('an allow marked unchecked is NOT proof of a screen — the bytes left unexamined', () => {
  assert.deepEqual(evidenceFromReceipt({ decision: 'allow', unchecked: true }, NOW), unscreenedEvidence);
});

test('a redact marked unchecked is not either — a partial screen is not a screen', () => {
  assert.deepEqual(
    evidenceFromReceipt({ decision: 'redact', unchecked: true, redactedCount: 2, unscreened: [pdf] }, NOW),
    unscreenedEvidence
  );
});

test('an allow with unscreened items says so even from a bridge too old to send the flag', () => {
  // An allow can never be a withhold (withholding rebuilds the request, which
  // makes it a `redact`), so items on an allow mean they shipped — the same
  // belt-and-braces `content/shim.js` and `tallyFromReceipt` already apply.
  assert.deepEqual(evidenceFromReceipt({ decision: 'allow', unscreened: [pdf] }, NOW), unscreenedEvidence);
});

test('a WITHHELD redact still reads Active — held-back bytes are screening working', () => {
  // redact + !unchecked + items: the desktop app looked, could not examine
  // one part, and replaced it with an inert placeholder. Nothing unexamined
  // left the machine. Downgrading this would punish it for doing its job.
  const active = { state: SCREENING.AVAILABLE, fragment: null, at: NOW, code: null };
  assert.deepEqual(
    evidenceFromReceipt({ decision: 'redact', unchecked: false, unscreened: [pdf, pdf] }, NOW),
    active
  );
  assert.deepEqual(
    evidenceFromReceipt({ decision: 'redact', unchecked: false, redactedCount: 3 }, NOW),
    active
  );
});

test('an ABSENT unchecked key does not flip the state — old bridge, not a leak', () => {
  // The native messaging host defaults this field to `false` and emits the
  // key always. An absent key therefore means "a bridge too old to have the
  // field", never "a sender who declined to answer" — reading it as `true`
  // would report every request on such a bridge as a fail-open leak.
  const active = { state: SCREENING.AVAILABLE, fragment: null, at: NOW, code: null };
  assert.deepEqual(evidenceFromReceipt({ decision: 'allow' }, NOW), active);
  assert.deepEqual(evidenceFromReceipt({ decision: 'redact', redactedCount: 1 }, NOW), active);
  // And nothing but a real `true` counts: no truthy strings, no 1.
  for (const unchecked of [undefined, null, false, 0, '', 'true', 1]) {
    assert.deepEqual(evidenceFromReceipt({ decision: 'allow', unchecked }, NOW), active, String(unchecked));
  }
});

test('the tally and the screening state never disagree about one receipt', () => {
  // Both read `shippedUnscreened`. A receipt counted as a fail-open send must
  // never also be rendered as a confirmed screen, and vice versa.
  const receipts = [
    { decision: 'allow' },
    { decision: 'allow', unchecked: true },
    { decision: 'allow', unscreened: [pdf] },
    { decision: 'redact', unchecked: true, unscreened: [pdf] },
    { decision: 'redact', unchecked: false, unscreened: [pdf] },
    { decision: 'redact', redactedCount: 4 }
  ];
  for (const receipt of receipts) {
    const counted = tallyFromReceipt(receipt).uncheckedSends > 0;
    const claimed = evidenceFromReceipt(receipt, NOW).state === SCREENING.AVAILABLE;
    assert.equal(counted && claimed, false, JSON.stringify(receipt));
    assert.equal(counted || claimed, true, JSON.stringify(receipt));
  }
});

test('a missing or unrecognised decision is "cannot tell" too', () => {
  const cannotTell = { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW, code: 'verdict-unreadable' };
  assert.deepEqual(evidenceFromReceipt({}, NOW), cannotTell);
  assert.deepEqual(evidenceFromReceipt({ decision: 'maybe' }, NOW), cannotTell);
  assert.deepEqual(evidenceFromReceipt(null, NOW), cannotTell);
  assert.deepEqual(evidenceFromReceipt('nope', NOW), cannotTell);
});

// ── evidence from a relay failure ──────────────────────────────────

test('the two relay failures that prove no screen happened', () => {
  for (const code of ['bridge-unreachable', 'screening-timeout']) {
    assert.deepEqual(
      evidenceFromRelayFailure(code, NOW),
      { state: SCREENING.UNAVAILABLE, fragment: null, at: NOW, code },
      code
    );
  }
});

test('a relay failure that says nothing about screening still says a capture failed', () => {
  // These prove no verdict was produced without proving screening is down, so
  // they are UNCONFIRMED — a first-class "cannot tell". They used to be null,
  // which meant a browser blocking every single request went on rendering
  // whatever the last good receipt said.
  for (const code of ['no-bridge', 'bridge-empty', 'bridge-unknown-response',
                      'bridge-error', 'capture-error', 'bad-request']) {
    assert.deepEqual(
      evidenceFromRelayFailure(code, NOW),
      { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW, code },
      code
    );
  }
});

test('a screened request whose reply was too big is not doubt about screening', () => {
  // `receipt-too-large`: it was screened and a redaction was found; the
  // rebuilt body just did not fit back through native messaging. The shim
  // tells the user it is a size limit and NOT a sensitive-data block, so
  // downgrading the popup would manufacture a doubt the page never raised.
  assert.equal(evidenceFromRelayFailure('receipt-too-large', NOW), null);
  assert.equal(evidenceFromRelayFailure('something-new', NOW), null);
  assert.equal(evidenceFromRelayFailure(undefined, NOW), null);
});

// ── the unchecked / withheld pairing ───────────────────────────────
//
// `unchecked` and `unscreened` mean nothing apart. Together they separate two
// outcomes that look identical from the browser: content that LEFT unexamined
// under the user's fail-open window, and content that was held back BECAUSE it
// could not be examined. Counting a withhold as a leak would be as wrong as
// hiding the leak.

const pdf = { kind: 'file', media_type: 'application/pdf', reason: 'engine_unsupported' };

test('allow + unchecked flag: the bytes shipped', () => {
  assert.deepEqual(
    tallyFromReceipt({ decision: 'allow', unchecked: true, unscreened: [pdf] }),
    { uncheckedSends: 1, withheldItems: 0, redactedItems: 0 }
  );
});

test('allow + items but no flag: still shipped — an allow can never be a withhold', () => {
  // Withholding rebuilds the request, so it is always a `redact`. Reading the
  // items alone keeps this honest against a bridge too old to send the flag.
  assert.deepEqual(
    tallyFromReceipt({ decision: 'allow', unscreened: [pdf] }),
    { uncheckedSends: 1, withheldItems: 0, redactedItems: 0 }
  );
});

test('redact + unchecked: the fail-open window let it out', () => {
  assert.deepEqual(
    tallyFromReceipt({ decision: 'redact', unchecked: true, unscreened: [pdf] }),
    { uncheckedSends: 1, withheldItems: 0, redactedItems: 0 }
  );
});

test('redact + items without the flag is a WITHHOLD, and must never count as a leak', () => {
  assert.deepEqual(
    tallyFromReceipt({ decision: 'redact', unchecked: false, unscreened: [pdf, pdf] }),
    { uncheckedSends: 0, withheldItems: 2, redactedItems: 0 }
  );
});

test('a clean screen and a block tally nothing', () => {
  const none = { uncheckedSends: 0, withheldItems: 0, redactedItems: 0 };
  assert.deepEqual(tallyFromReceipt({ decision: 'allow', unchecked: false }), none);
  assert.deepEqual(tallyFromReceipt({ decision: 'redact', unchecked: false }), none);
  assert.deepEqual(tallyFromReceipt({ decision: 'block', reason: 'US SSN detected' }), none);
  assert.deepEqual(tallyFromReceipt(null), none);
});

// ── redactedItems: the evidence a redacted send actually happened ──
//
// The popup's `noteFor` used to have no way to answer "was I protected at
// all?" — a redacted send and a clean send looked identical everywhere. The
// desktop app's own `redactedCount` was already on every receipt; it just was not
// collected. This is a separate, independent fact from the unchecked/withheld
// pairing above — it can be true at the same time as either.

test('redact with a positive redactedCount and nothing else unusual: the count is surfaced', () => {
  assert.deepEqual(
    tallyFromReceipt({ decision: 'redact', unchecked: false, redactedCount: 3 }),
    { uncheckedSends: 0, withheldItems: 0, redactedItems: 3 }
  );
});

test('a redaction and a withhold in the same receipt are both counted, independently', () => {
  // Some of the request's TEXT was redacted; a SEPARATE attachment could not
  // be examined and was withheld. Both are true; hiding one because the
  // other fired would be the exact defect this file exists to prevent.
  assert.deepEqual(
    tallyFromReceipt({ decision: 'redact', unchecked: false, redactedCount: 2, unscreened: [pdf] }),
    { uncheckedSends: 0, withheldItems: 1, redactedItems: 2 }
  );
});

test('a redaction alongside a fail-open send is still counted as a redaction', () => {
  // The fail-open flag says a DIFFERENT part of the request shipped
  // unexamined; it says nothing about whether a real span of text was also
  // found and removed in the part that could be examined.
  assert.deepEqual(
    tallyFromReceipt({ decision: 'redact', unchecked: true, redactedCount: 1, unscreened: [pdf] }),
    { uncheckedSends: 1, withheldItems: 0, redactedItems: 1 }
  );
});

test('an allow never carries a redaction count, even if the field is malformed', () => {
  // An `allow` always carries redacted_count: 0 (nothing was rewritten);
  // this also guards against a receipt that lies.
  assert.deepEqual(
    tallyFromReceipt({ decision: 'allow', unchecked: false, redactedCount: 5 }),
    { uncheckedSends: 0, withheldItems: 0, redactedItems: 0 }
  );
});

test('a zero, missing, or malformed redactedCount counts as no redaction', () => {
  for (const redactedCount of [0, undefined, null, -1, 'lots', NaN]) {
    assert.deepEqual(
      tallyFromReceipt({ decision: 'redact', unchecked: false, redactedCount }),
      { uncheckedSends: 0, withheldItems: 0, redactedItems: 0 },
      String(redactedCount)
    );
  }
});

// ── what the popup is allowed to conclude ──────────────────────────

test('no connection means screening is certainly unavailable', () => {
  for (const status of [STATUS.DISCONNECTED, STATUS.NO_BRIDGE, STATUS.UNKNOWN]) {
    assert.equal(
      screeningFor(status, { state: SCREENING.AVAILABLE, at: NOW }, NOW),
      SCREENING.UNAVAILABLE,
      status
    );
  }
});

test('connected with no evidence is UNCONFIRMED, never available', () => {
  // The headline case. A reachable bridge proves the desktop app is running
  // and nothing about whether it screens.
  assert.equal(screeningFor(STATUS.CONNECTED, null, NOW), SCREENING.UNCONFIRMED);
  assert.equal(screeningFor(STATUS.CONNECTED, {}, NOW), SCREENING.UNCONFIRMED);
  assert.equal(
    screeningFor(STATUS.CONNECTED, { state: 'protected', at: NOW }, NOW),
    SCREENING.UNCONFIRMED
  );
});

test('evidence decays: a verdict from long ago is not a claim about now', () => {
  const stale = { state: SCREENING.AVAILABLE, at: NOW - SCREENING_EVIDENCE_TTL_MS - 1 };
  assert.equal(screeningFor(STATUS.CONNECTED, stale, NOW), SCREENING.UNCONFIRMED);

  const fresh = { state: SCREENING.AVAILABLE, at: NOW - 1000 };
  assert.equal(screeningFor(STATUS.CONNECTED, fresh, NOW), SCREENING.AVAILABLE);
});

test('fresh negative evidence surfaces the outage', () => {
  assert.equal(
    screeningFor(
      STATUS.CONNECTED,
      { state: SCREENING.UNAVAILABLE, fragment: 'guard unreachable', at: NOW, code: null },
      NOW
    ),
    SCREENING.UNAVAILABLE
  );
});

// ── the live probe: one direction only ─────────────────────────────
//
// `liveScreening` is the host's own `screening` field on its `status` reply —
// a reachability probe checked THIS instant. Reaching the desktop app is not
// the same as it having screened anything, so the probe proves a negative
// outright and cannot prove the positive, and it is read here in that one
// direction only.

test('a live "available" earns nothing — the probe cannot prove a screen', () => {
  // The asymmetry this exists for. A desktop app that is reachable but not
  // yet able to screen accepts the probe's connection exactly the way a
  // healthy one does. Freshly started, the popup used to read "Active — Locke
  // confirmed screening is active" while every request was being held back.
  assert.equal(
    screeningFor(STATUS.CONNECTED, null, NOW, SCREENING.AVAILABLE),
    SCREENING.UNCONFIRMED
  );
  // And it cannot even revive stale positive evidence that has aged out.
  const expired = { state: SCREENING.AVAILABLE, at: NOW - SCREENING_EVIDENCE_TTL_MS - 1 };
  assert.equal(
    screeningFor(STATUS.CONNECTED, expired, NOW, SCREENING.AVAILABLE),
    SCREENING.UNCONFIRMED
  );
});

test('NO live value can produce AVAILABLE — the guarantee is structural', () => {
  // Not "screeningFromStatus only forwards `unavailable`, so we are fine" —
  // this function must hold on its own, against a caller that hands it a
  // positive anyway (an older build, a future signal nobody reasoned about).
  const anything = [
    SCREENING.AVAILABLE, SCREENING.UNAVAILABLE, SCREENING.UNCONFIRMED,
    'available', 'unknown', '', true, 1, {}, undefined, null
  ];
  for (const live of anything) {
    assert.notEqual(
      screeningFor(STATUS.CONNECTED, null, NOW, live),
      SCREENING.AVAILABLE,
      String(live)
    );
  }
});

test('a live "unavailable" answer needs no capture evidence at all', () => {
  assert.equal(
    screeningFor(STATUS.CONNECTED, null, NOW, SCREENING.UNAVAILABLE),
    SCREENING.UNAVAILABLE
  );
});

test('a live negative overrides fresh positive capture evidence — screening just went down', () => {
  const freshPositive = { state: SCREENING.AVAILABLE, at: NOW - 1000 };
  assert.equal(
    screeningFor(STATUS.CONNECTED, freshPositive, NOW, SCREENING.UNAVAILABLE),
    SCREENING.UNAVAILABLE
  );
});

// ── the probe does not get to overrule the traffic ─────────────────
//
// The sharpest form of a reported failure: "Sonomos blocks my 1 MB attachment
// saying 'the Locke desktop app could not be reached' — but Locke IS running
// and the popup says Online / Active at the same time." Both surfaces were
// reading their own signal correctly. The probe asks whether a connection is
// accepted; a capture asks whether a real request got screened.
//
// This was arbitrated by a 60-second contradiction window. It is now
// structural — a live positive is not evidence at all — which is the same
// answer without an expiry date.

test('a live positive does NOT overrule a capture that just failed', () => {
  const justFailed = { state: SCREENING.UNAVAILABLE, fragment: 'guard unreachable', at: NOW - 1000 };
  assert.equal(
    screeningFor(STATUS.CONNECTED, justFailed, NOW, SCREENING.UNAVAILABLE),
    SCREENING.UNAVAILABLE
  );
  assert.equal(
    screeningFor(STATUS.CONNECTED, justFailed, NOW, SCREENING.AVAILABLE),
    SCREENING.UNAVAILABLE,
    'first-hand proof of an outage stands; a reachability probe does not refute it'
  );
  // Same for the "cannot tell" kind of failure: a probe that succeeded does
  // not explain a relay that did not.
  const cannotTell = { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW - 1000, code: 'bridge-error' };
  assert.equal(
    screeningFor(STATUS.CONNECTED, cannotTell, NOW, SCREENING.AVAILABLE),
    SCREENING.UNCONFIRMED
  );
});

test('a failed capture is no longer outranked by a probe once a minute has passed', () => {
  // The old rule let a live positive take over after
  // SCREENING_CONTRADICTION_WINDOW_MS, on the reasoning that a screen which
  // had really recovered should not be held in "can't tell" forever. That was
  // the false green arriving late rather than early: the probe cannot see
  // whether screening works, so it cannot report a recovery at any age.
  //
  // Recovery is signalled by traffic instead — deliberately, and it is the
  // conservative direction: the worst case is a user seeing "Unavailable"
  // until their next send (bounded by SCREENING_EVIDENCE_TTL_MS in any case),
  // rather than "Active" while nothing screens.
  const old = {
    state: SCREENING.UNAVAILABLE,
    fragment: 'guard unreachable',
    at: NOW - SCREENING_CONTRADICTION_WINDOW_MS - 1
  };
  assert.equal(
    screeningFor(STATUS.CONNECTED, old, NOW, SCREENING.AVAILABLE),
    SCREENING.UNAVAILABLE
  );
  // A real successful capture proves recovery immediately, with no wait.
  const recovered = { state: SCREENING.AVAILABLE, at: NOW };
  assert.equal(
    screeningFor(STATUS.CONNECTED, recovered, NOW, SCREENING.AVAILABLE),
    SCREENING.AVAILABLE
  );
  // ...and evidence still ages out, so an outage is never permanent either.
  const expired = { ...old, at: NOW - SCREENING_EVIDENCE_TTL_MS - 1 };
  assert.equal(
    screeningFor(STATUS.CONNECTED, expired, NOW, SCREENING.AVAILABLE),
    SCREENING.UNCONFIRMED
  );
});

test('bad news is never held back by the contradiction rule', () => {
  // The window only ever suppresses an AVAILABLE. A live negative still wins
  // outright, even over a successful capture from a moment ago.
  const freshPositive = { state: SCREENING.AVAILABLE, at: NOW - 1000 };
  assert.equal(
    screeningFor(STATUS.CONNECTED, freshPositive, NOW, SCREENING.UNAVAILABLE),
    SCREENING.UNAVAILABLE
  );
});

test('a live positive cannot un-send what already went out unexamined', () => {
  // The fail-open receipt end to end: a probe that gets a reply is not an
  // answer about the bytes that already left.
  const failOpen = evidenceFromReceipt({ decision: 'allow', unchecked: true }, NOW - 1000);
  assert.equal(
    screeningFor(STATUS.CONNECTED, failOpen, NOW, SCREENING.AVAILABLE),
    SCREENING.UNCONFIRMED
  );
  assert.equal(screeningFor(STATUS.CONNECTED, failOpen, NOW), SCREENING.UNCONFIRMED);
  // And it is nameable, so the popup can say which event it means.
  assert.deepEqual(
    captureFailureToName(failOpen, NOW),
    { code: 'sent-unscreened', at: NOW - 1000 }
  );
});

test('stored "cannot tell" evidence renders as unconfirmed with no live signal at all', () => {
  const cannotTell = { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW, code: 'bridge-empty' };
  assert.equal(screeningFor(STATUS.CONNECTED, cannotTell, NOW), SCREENING.UNCONFIRMED);
});

// ── which failure the popup may name ───────────────────────────────

test('a recent capture failure is nameable, and carries only our own code', () => {
  const failure = { state: SCREENING.UNCONFIRMED, fragment: null, at: NOW - 1000, code: 'bridge-error' };
  assert.deepEqual(captureFailureToName(failure, NOW), { code: 'bridge-error', at: NOW - 1000 });
  const outage = { state: SCREENING.UNAVAILABLE, fragment: 'guard unreachable', at: NOW, code: null };
  assert.deepEqual(captureFailureToName(outage, NOW), { code: null, at: NOW });
});

test('nothing nameable when screening is fine, unknown, or the failure is old', () => {
  assert.equal(captureFailureToName({ state: SCREENING.AVAILABLE, at: NOW }, NOW), null);
  assert.equal(captureFailureToName(null, NOW), null);
  assert.equal(captureFailureToName({ state: 'protected', at: NOW }, NOW), null);
  const old = { state: SCREENING.UNAVAILABLE, at: NOW - SCREENING_CONTRADICTION_WINDOW_MS - 1 };
  assert.equal(captureFailureToName(old, NOW), null);
});

test('a nameable failure and an Active row can never co-exist', () => {
  // The invariant the whole pairing rests on: whenever there is a failure
  // recent enough to name, `screeningFor` refuses AVAILABLE off a live probe.
  for (const state of [SCREENING.UNAVAILABLE, SCREENING.UNCONFIRMED]) {
    for (const age of [0, 1, 1000, SCREENING_CONTRADICTION_WINDOW_MS]) {
      const evidence = { state, fragment: null, at: NOW - age, code: 'bridge-error' };
      if (captureFailureToName(evidence, NOW) === null) continue;
      for (const live of [SCREENING.AVAILABLE, SCREENING.UNAVAILABLE, null, 'unknown']) {
        assert.notEqual(
          screeningFor(STATUS.CONNECTED, evidence, NOW, live),
          SCREENING.AVAILABLE,
          `${state} @-${age} with live=${live}`
        );
      }
    }
  }
});

test('a live "unknown" (or anything else) asserts nothing and falls back to capture evidence', () => {
  const freshPositive = { state: SCREENING.AVAILABLE, at: NOW - 1000 };
  for (const inconclusive of ['unknown', undefined, null, '', 'not-a-real-value']) {
    assert.equal(
      screeningFor(STATUS.CONNECTED, freshPositive, NOW, inconclusive),
      SCREENING.AVAILABLE,
      String(inconclusive)
    );
  }
  // And with no capture evidence either, it lands on the same honest default
  // as if no live probe had ever been asked.
  assert.equal(screeningFor(STATUS.CONNECTED, null, NOW, 'unknown'), SCREENING.UNCONFIRMED);
});

test('a live answer still cannot override "no connection" — no path, no screening', () => {
  for (const status of [STATUS.DISCONNECTED, STATUS.NO_BRIDGE, STATUS.UNKNOWN]) {
    assert.equal(
      screeningFor(status, null, NOW, SCREENING.AVAILABLE),
      SCREENING.UNAVAILABLE,
      status
    );
  }
});

test('omitting liveScreening behaves exactly as before it existed', () => {
  const freshPositive = { state: SCREENING.AVAILABLE, at: NOW - 1000 };
  assert.equal(screeningFor(STATUS.CONNECTED, freshPositive, NOW), SCREENING.AVAILABLE);
  assert.equal(screeningFor(STATUS.CONNECTED, null, NOW), SCREENING.UNCONFIRMED);
});

// ── the sentences themselves ───────────────────────────────────────

const connected = (extra = {}) => ({ status: STATUS.CONNECTED, error: null, ...extra });

test('a connected app that cannot screen does NOT read as protected', () => {
  const copy = copyFor(connected({ screening: SCREENING.UNAVAILABLE }));
  assert.equal(copy.screeningLabel, 'Unavailable');
  assert.match(copy.detail, /screening isn’t answering/);
  assert.match(copy.detail, /held back/);
  assert.ok(!/protecting/.test(copy.detail), copy.detail);
});

test('a connected app with nothing observed yet says exactly that', () => {
  const copy = copyFor(connected({ screening: SCREENING.UNCONFIRMED }));
  assert.equal(copy.badge, 'Online');
  assert.equal(copy.screeningLabel, 'Not yet confirmed');
  assert.match(copy.detail, /Screening is confirmed the first time you send/);
  assert.ok(!/protecting/.test(copy.detail), copy.detail);
});

test('"nothing tried yet" and "the last try just failed" are different sentences', () => {
  // Same label, deliberately — both are honestly "Not yet confirmed" — but a
  // user who has just watched the page refuse their message must not be told
  // that screening gets confirmed "the first time you send". They did send.
  const copy = copyFor(connected({
    screening: SCREENING.UNCONFIRMED,
    lastCaptureFailure: { code: 'bridge-error', at: NOW - 2000 }
  }));
  assert.equal(copy.screeningLabel, 'Not yet confirmed');
  assert.ok(
    !/the first time you send/.test(copy.detail),
    `must not tell someone who just sent to send: ${copy.detail}`
  );
  assert.match(copy.detail, /held back/);
  // And it must say which way round it went: held back, not leaked.
  assert.match(copy.detail, /nothing was sent unscreened/);
});

test('the popup names the page block as the SAME event, not a second problem', () => {
  // The reported failure: "Sonomos blocks my attachment saying the Locke
  // desktop app could not be reached — but the popup says Online / Active at
  // the same time", triaged as two faults by a tester reading two of our
  // surfaces disagreeing.
  const copy = copyFor(connected({
    screening: SCREENING.UNCONFIRMED,
    lastCaptureFailure: { code: 'bridge-error', at: NOW }
  }));
  assert.match(copy.detail, /same event, not a second problem/);
});

test('a fail-open send gets the opposite sentence, not the "nothing leaked" one', () => {
  // Same "Not yet confirmed" label, third distinct sentence. The generic
  // failure line ends "so nothing was sent unscreened" — the precise inverse
  // of what happened here — and swapping one false sentence for its mirror
  // image would not be a fix.
  const copy = copyFor(connected({
    screening: SCREENING.UNCONFIRMED,
    lastCaptureFailure: { code: 'sent-unscreened', at: NOW }
  }));
  assert.equal(copy.screeningLabel, 'Not yet confirmed');
  assert.ok(!/nothing was sent unscreened/.test(copy.detail), copy.detail);
  assert.ok(!/held back/.test(copy.detail), `it was not held back — it was sent: ${copy.detail}`);
  assert.ok(!/the first time you send/.test(copy.detail), copy.detail);
  assert.match(copy.detail, /was sent before it could be fully screened/);
  assert.match(copy.detail, /fail-open setting/);
  assert.match(copy.detail, /same event, not a second problem/);
});

test('a malformed lastCaptureFailure is ignored rather than guessed at', () => {
  for (const failure of [null, undefined, {}, 'bridge-error', { code: 'x' }, 42]) {
    const copy = copyFor(connected({ screening: SCREENING.UNCONFIRMED, lastCaptureFailure: failure }));
    assert.match(copy.detail, /Screening is confirmed the first time you send/, String(failure));
  }
});

// A reported failure: "Locke is blocking requests on
// google.com — since when is Google an AI site?" `www.google.com` is a real,
// deliberate catalog entry (shared/ai-surfaces.json's `search` provider —
// AI-answer search engines are treated like chat surfaces) — but "AI sites"
// asserts a category a plain search page visibly does not belong to. The copy
// must describe what actually decides scope (catalog membership: AI apps AND
// search engines) rather than assert a property of the site a user can
// correctly dispute.
test('every "held back" sentence names AI apps AND search engines, never bare "AI sites"', () => {
  const details = [
    copyFor({ status: STATUS.CONNECTED, error: 'worker-error' }).detail,
    copyFor({ status: STATUS.DISCONNECTED }).detail,
    copyFor(connected({ screening: SCREENING.UNAVAILABLE })).detail,
    copyFor(connected({ screening: SCREENING.UNCONFIRMED })).detail,
    copyFor(connected({
      screening: SCREENING.UNCONFIRMED,
      lastCaptureFailure: { code: 'bridge-error', at: NOW }
    })).detail,
    copyFor({ status: STATUS.NO_BRIDGE }).detail
  ];
  for (const detail of details) {
    assert.ok(!/\bAI sites\b/.test(detail), `must not say the bare, disputable phrase: ${detail}`);
    assert.match(detail, /search engines/, `must name search engines specifically: ${detail}`);
    assert.match(detail, /AI apps/, `must still name AI apps: ${detail}`);
  }
});

test('the reassuring line names the evidence that earns it', () => {
  // AVAILABLE now has exactly one source — a real capture receipt — so the
  // sentence may, and should, say so. It used to be reachable from a live
  // reachability probe as well, which is why it was worded to avoid mentioning
  // traffic at all; that vagueness did not make the claim true, it only made
  // the false one harder to spot.
  const copy = copyFor(connected({ screening: SCREENING.AVAILABLE }));
  assert.equal(copy.screeningLabel, 'Active');
  assert.match(copy.detail, /screening is confirmed active/i);
  assert.match(copy.detail, /screened a recent request/i);
});

test('"Active" is unreachable without a capture receipt, whatever the live probe says', () => {
  // End to end: the desktop app has just started and is reachable, but
  // nothing has been sent yet. The popup must say so rather than render a
  // confident green.
  const justStarted = copyFor(connected({
    screening: screeningFor(STATUS.CONNECTED, null, NOW, SCREENING.AVAILABLE)
  }));
  assert.equal(justStarted.badge, 'Online');
  assert.equal(justStarted.screeningLabel, 'Not yet confirmed');
  assert.match(justStarted.detail, /Screening is confirmed the first time you send/);
  assert.ok(!/confirmed active/.test(justStarted.detail), justStarted.detail);
});

// NO_BRIDGE is the browser failing to START our native-messaging
// host — no manifest, one that omits this extension id, or a host that exited
// at once. Every surface once said "the desktop app isn't running… Open it to
// resume" while the real fix went unnamed; then the copy named the install
// command by hand. The app now repairs the registration itself when asked
// (the worker's requestHostRegistration), so the remedy is the app's Allow
// prompt — still never the useless "isn't running… resume" pair, and no
// longer a shell command either.
test('a browser that could not start the connector is sent to the consent prompt, not a script', () => {
  const copy = copyFor({ status: STATUS.NO_BRIDGE });
  assert.equal(copy.view, 'setup', 'not "offline": we cannot see the app at all from here');
  assert.equal(copy.badge, 'Setup');
  assert.match(copy.detail, /click Allow/);
  assert.ok(!/install\.(sh|ps1)/.test(copy.detail), copy.detail);
  assert.ok(!/isn’t running/.test(copy.detail), copy.detail);
  assert.ok(!/Open it to resume/.test(copy.detail), copy.detail);
  assert.match(copy.detail, /held back/, 'and it still says what is happening to requests');
});

test('offline and error both say requests are being held back', () => {
  assert.match(copyFor({ status: STATUS.DISCONNECTED }).detail, /held back/);
  assert.match(copyFor({ status: STATUS.CONNECTED, error: 'worker-error' }).detail, /held back/);
  assert.equal(viewFor({ status: STATUS.CONNECTED, error: 'bridge-error' }), 'error');
});

test('an unknown screening value falls back to unconfirmed, never to Active', () => {
  const copy = copyFor(connected({ screening: 'something-new' }));
  assert.equal(copy.screening, SCREENING.UNCONFIRMED);
  assert.equal(copy.screeningLabel, 'Not yet confirmed');
});

// ── the fail-open note: visible, and not accusatory ────────────────

test('unchecked sends are surfaced with a count and named as the user’s own setting', () => {
  const note = noteFor({ uncheckedSends: 3 });
  assert.match(note, /3 requests went out this session without a full screen/);
  assert.match(note, /fail-open setting/);
  // A sanctioned bypass the user opted into. It gets a fact, not a scolding.
  for (const alarm of ['leak', 'exposed', 'danger', 'warning', 'unsafe', '!']) {
    assert.ok(!note.toLowerCase().includes(alarm), `note must not say "${alarm}": ${note}`);
  }
});

test('withheld attachments read as held back, never as sent', () => {
  const note = noteFor({ withheldItems: 1 });
  assert.match(note, /1 attachment couldn’t be examined and stayed on this machine/);
  assert.ok(!/went out/.test(note), note);
});

test('both counts appear together, and singular/plural read correctly', () => {
  const note = noteFor({ uncheckedSends: 1, withheldItems: 2 });
  assert.match(note, /1 request went out/);
  assert.match(note, /2 attachments couldn’t be examined/);
});

test('nothing to report means no note at all', () => {
  assert.equal(noteFor({ uncheckedSends: 0, withheldItems: 0, redactedItems: 0 }), null);
  assert.equal(noteFor({}), null);
  assert.equal(noteFor(null), null);
  assert.equal(copyFor(connected({ screening: SCREENING.AVAILABLE })).note, null);
});

// ── the redaction note: the answer to "was I protected at all?" ────
//
// A reported failure: "There is no way to tell whether Locke
// actually redacted anything — a redacted send and a clean send look
// identical in the browser, the console and the popup." The evidence was
// already flowing to the popup (every capture receipt carries
// `redactedCount`); this note is that evidence finally reaching the screen.

test('a redacted send is surfaced with a count, singular reads correctly', () => {
  const note = noteFor({ redactedItems: 1 });
  assert.match(note, /1 item of personal information was redacted from what you sent this session/);
});

test('a redacted send pluralizes correctly and reads as reassurance, not alarm', () => {
  const note = noteFor({ redactedItems: 4 });
  assert.match(note, /4 items of personal information were redacted from what you sent this session/);
  for (const alarm of ['leak', 'exposed', 'danger', 'warning', 'unsafe', '!']) {
    assert.ok(!note.toLowerCase().includes(alarm), `note must not say "${alarm}": ${note}`);
  }
});

test('the redaction note appears alongside the fail-open notes when all three are true', () => {
  const note = noteFor({ redactedItems: 2, uncheckedSends: 1, withheldItems: 1 });
  assert.match(note, /2 items of personal information were redacted/);
  assert.match(note, /1 request went out/);
  assert.match(note, /1 attachment couldn’t be examined/);
});

test('a zero redaction count reports nothing extra', () => {
  assert.equal(noteFor({ redactedItems: 0 }), null);
});

// ── "we have not heard yet" is not "the app is down" ───────────────
//
// `STATUS.UNKNOWN` is the worker's initial state and the literal fallback
// `popup/popup.js` renders when the service worker cannot be reached at all.
// It used to collapse into the `offline` view, so opening the popup asserted
// **"The Locke desktop app isn't running… Open it to resume"** before anything
// had been checked — a claim about somebody else's process, made from having
// asked nobody, and prescribing a fix for it. Exactly the defect the NO_BRIDGE
// branch was carved out to stop, one status over.

test('an unchecked state says it is checking, and blames nothing', () => {
  const copy = copyFor({ status: STATUS.UNKNOWN, screening: SCREENING.UNCONFIRMED });
  assert.equal(copy.view, 'checking');
  assert.equal(copy.badge, 'Checking…');
  assert.ok(!/isn’t running/.test(copy.detail), copy.detail);
  assert.ok(!/isn’t answering/.test(copy.detail), copy.detail);
  assert.ok(!/Open it to resume/.test(copy.detail), copy.detail);
  assert.match(copy.detail, /Nothing has answered yet/);
});

test('a state object with no status at all is "checking", not "offline"', () => {
  // popup.js renders `{ status: STATUS.UNKNOWN }` when the worker is
  // unreachable, and `copyFor` defaults a missing status to the same thing.
  // Neither is evidence about the desktop app.
  for (const state of [{}, null, undefined, { status: STATUS.UNKNOWN }]) {
    assert.equal(copyFor(state).view, 'checking', String(state));
  }
});

test('checking never claims protection either — it says nothing is proved', () => {
  const copy = copyFor({ status: STATUS.UNKNOWN });
  assert.equal(copy.screeningLabel, 'Not yet confirmed');
  assert.ok(!/confirmed active/.test(copy.detail), copy.detail);
  assert.ok(!/protecting/.test(copy.detail), copy.detail);
});

test('an error still outranks an unchecked status', () => {
  // A health check that threw told us something, even though it left the
  // status where it was. "Checking" would be the wrong answer there.
  assert.equal(viewFor({ status: STATUS.UNKNOWN, error: 'worker-error' }), 'error');
  assert.equal(viewFor({ status: STATUS.UNKNOWN, error: 'bridge-error' }), 'error');
});

test('the checking badge is the same word popup.html already ships', async () => {
  // The placeholder markup told the truth and the copy replaced it with a
  // claim. They have to agree, or the badge flickers through two words.
  const html = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const copy = copyFor({ status: STATUS.UNKNOWN });
  assert.ok(
    html.includes(`data-status="checking"`),
    'popup.html must ship the checking state, not offline, as its placeholder'
  );
  assert.ok(html.includes(copy.badge), `popup.html must ship the badge text "${copy.badge}"`);
});

// ── the offline line says what was observed, not what it guesses ───

test('offline reports silence, not a claim about whether the app is running', () => {
  // This branch is reached from a host that replied `connected: false` AND
  // from a bridge timeout. A timeout is silence: the app may be running and
  // wedged, or just slower than `bridgeTimeoutMs`. "isn't answering" is true
  // in both; "isn't running" is only true in one, and is the sentence that
  // sends somebody to start an app that is already open.
  const copy = copyFor({ status: STATUS.DISCONNECTED });
  assert.equal(copy.view, 'offline');
  assert.match(copy.detail, /isn’t answering/);
  assert.ok(!/isn’t running/.test(copy.detail), copy.detail);
  assert.match(copy.detail, /held back/);
});

// ── "held back" names the subset, not the whole site ───────────────
//
// Only requests with a BODY are ever screened, and on the `search` catalog
// entries a prompt that arrives as a top-level navigation — the address bar,
// the default search engine, a `?q=` link, a form submit — is not screened on
// any host (HONEST.md, and `web_screening: "none"` in shared/ai-surfaces.json).
// So "requests to the AI apps and search engines Locke screens are being held
// back" was a comfortable sentence rather than a true one: during an outage a
// user reading it concludes nothing of theirs left, and a search typed into
// the address bar left anyway.

test('no outage sentence claims that everything to those sites is held back', () => {
  const details = [
    copyFor({ status: STATUS.CONNECTED, error: 'worker-error' }).detail,
    copyFor({ status: STATUS.DISCONNECTED }).detail,
    copyFor({ status: STATUS.NO_BRIDGE }).detail,
    copyFor(connected({ screening: SCREENING.UNAVAILABLE })).detail
  ];
  for (const detail of details) {
    assert.match(detail, /held back/, detail);
    assert.match(
      detail,
      /requests Locke screens on/,
      `must name the screened subset rather than the whole site: ${detail}`
    );
    assert.ok(
      !/requests to the AI apps/.test(detail),
      `must not claim every request to those sites is held: ${detail}`
    );
  }
});

test('the "nothing sent yet" line does not promise that any send confirms screening', () => {
  // A send that is out of scope — no body, a skipped path, a surface the user
  // or a policy excluded — confirms nothing, and the line used to say
  // "the first time you send" flatly.
  const copy = copyFor(connected({ screening: SCREENING.UNCONFIRMED }));
  assert.match(copy.detail, /the first time you send something it screens/);
});
