// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import {
  AUDIT_KEY,
  AUDIT_MAX_ENTRIES,
  BLOCK_CAUSE,
  BRIDGE_MSG,
  DEFAULTS,
  INFRASTRUCTURE_REASONS,
  MANAGED_KEYS,
  MSG,
  NATIVE_HOST,
  PAGE_MSG,
  PRESENCE_INTERVAL_SECONDS,
  PRESENCE_STALE_MS,
  PRESENCE_URL,
  REGISTRATION_MIN_INTERVAL_MS,
  REGISTRATION_URL,
  SCREENING,
  SCREENING_EVIDENCE_TTL_MS,
  STATE_KEY,
  SETTINGS_KEY,
  STATUS,
  hostMatches,
  infrastructureFragment,
  isInfrastructureBlock,
  isInfrastructureReason
} from '../shared/constants.js';

// ── Sanity: shapes that the rest of the codebase relies on ─────────

test('constants: NATIVE_HOST is the pinned host name', () => {
  // This is the name the browser looks up to launch the native messaging
  // host. It has to match the host manifest the Locke desktop app installs;
  // that manifest is not part of this repository, so this test pins only our
  // half of the contract.
  assert.equal(NATIVE_HOST, 'ai.sonomos.desktop');
});

test('constants: PRESENCE_URL is the pinned desktop heartbeat endpoint', () => {
  // The Locke desktop app's presence listener accepts POST /heartbeat on
  // this loopback port. The manifest's
  // host_permissions and CSP connect-src are pinned to the same origin.
  assert.equal(PRESENCE_URL, 'http://127.0.0.1:18795/heartbeat');
});

test('constants: REGISTRATION_URL rides the presence origin — a new path, never a new port', () => {
  // The manifest's CSP connect-src pins exactly one origin (see
  // manifest.test.js). A registration endpoint on any other origin would be
  // silently unreachable from the worker; sharing the origin is what makes
  // this a no-manifest-change feature.
  assert.equal(new URL(REGISTRATION_URL).origin, new URL(PRESENCE_URL).origin);
  assert.equal(new URL(REGISTRATION_URL).pathname, '/register-extension');
});

test('constants: the registration floor rides under the presence cadence', () => {
  // One POST per tick at most; a floor above the cadence would skip beats
  // and stretch recovery past the interval the desktop reader expects.
  assert.ok(REGISTRATION_MIN_INTERVAL_MS < PRESENCE_INTERVAL_SECONDS * 1000);
});

// The presence cadence is half of a contract with another process, so the
// thing worth pinning is the RELATIONSHIP, not either number on its own.
test('constants: the presence tick fits inside the reader’s staleness window', () => {
  assert.ok(
    PRESENCE_INTERVAL_SECONDS * 1000 < PRESENCE_STALE_MS,
    'a producer slower than the reader’s window reports absence between its own ticks'
  );
  // One tick of headroom and no more: presence is a liveness claim, so a
  // browser that has genuinely gone away must stop counting as present
  // promptly. 30 s / 45 s is exactly that — one dropped beacon shows.
  assert.ok(
    PRESENCE_STALE_MS >= PRESENCE_INTERVAL_SECONDS * 1000 * 1.5,
    'the window must survive the jitter on one tick'
  );
});

// The cadence must NOT be derived from a setting. `heartbeatSeconds` is
// user- and policy-settable (MANAGED_KEYS), and an admin who widened the
// health beat to 600 s to spare a machine's CPU would, if the two were tied,
// silently switch off every one of those machines' "extension installed"
// answers — the same defect as the backoff, arriving by policy instead.
test('constants: the presence tick is not derived from heartbeatSeconds', () => {
  assert.ok(MANAGED_KEYS.includes('heartbeatSeconds'), 'still policy-settable, which is the point');
  assert.equal(typeof PRESENCE_INTERVAL_SECONDS, 'number');
  assert.ok(!('presenceIntervalSeconds' in DEFAULTS), 'nor may it become one');
  assert.ok(!MANAGED_KEYS.includes('presenceIntervalSeconds'));
});

test('constants: STATUS enum has the 5 values badges expect', () => {
  const expected = ['connected', 'warming', 'disconnected', 'no-bridge', 'unknown'];
  const actual = Object.values(STATUS).sort();
  assert.deepEqual(actual.sort(), expected.sort());
});

test('constants: DEFAULTS frozen + has the keys getSettings reads', () => {
  assert.equal(Object.isFrozen(DEFAULTS), true);
  for (const key of [
    'heartbeatSeconds', 'backoffMaxSeconds', 'bridgeTimeoutMs',
    'schemaVersion', 'allowedProviders',
    'telemetryEnabled', 'lockedSettings'
  ]) {
    assert.ok(key in DEFAULTS, `DEFAULTS missing ${key}`);
  }
});

test('constants: no daemonUrl remains — there is no HTTP endpoint to point at', () => {
  assert.ok(!('daemonUrl' in DEFAULTS), 'DEFAULTS must not carry daemonUrl');
  assert.ok(!MANAGED_KEYS.includes('daemonUrl'), 'MANAGED_KEYS must not carry daemonUrl');
});

test('constants: MANAGED_KEYS allowlist is frozen + non-empty', () => {
  assert.equal(Object.isFrozen(MANAGED_KEYS), true);
  assert.ok(MANAGED_KEYS.length > 0);
  // Every managed key must also exist in DEFAULTS so the merge in
  // service-worker.js::getSettings doesn't silently introduce unknown keys.
  for (const key of MANAGED_KEYS) {
    assert.ok(key in DEFAULTS, `MANAGED_KEYS has '${key}' but DEFAULTS doesn't`);
  }
});

test('constants: storage keys are unique strings', () => {
  const keys = [STATE_KEY, SETTINGS_KEY, AUDIT_KEY];
  for (const k of keys) {
    assert.equal(typeof k, 'string');
    assert.ok(k.length > 0);
  }
  assert.equal(new Set(keys).size, keys.length, 'storage keys must be distinct');
});

test('constants: AUDIT_MAX_ENTRIES is a small positive integer', () => {
  assert.equal(typeof AUDIT_MAX_ENTRIES, 'number');
  assert.ok(Number.isInteger(AUDIT_MAX_ENTRIES));
  assert.ok(AUDIT_MAX_ENTRIES > 0);
  assert.ok(AUDIT_MAX_ENTRIES <= 1000);
});

test('constants: MSG / BRIDGE_MSG / PAGE_MSG are frozen', () => {
  assert.equal(Object.isFrozen(MSG), true);
  assert.equal(Object.isFrozen(BRIDGE_MSG), true);
  assert.equal(Object.isFrozen(PAGE_MSG), true);
});

test('constants: BRIDGE_MSG matches the native messaging protocol', () => {
  // The native messaging host knows exactly these three types.
  assert.deepEqual(
    new Set(Object.values(BRIDGE_MSG)),
    new Set(['hello', 'status', 'capture'])
  );
});

test('constants: message-map values are non-empty strings', () => {
  for (const map of [MSG, BRIDGE_MSG, PAGE_MSG]) {
    for (const v of Object.values(map)) {
      assert.equal(typeof v, 'string');
      assert.ok(v.length > 0);
    }
  }
});

// ── the infrastructure/policy split ────────────────────────────────
//
// The closed set that decides whether a user is told "screening is
// unavailable, try again" or "this request was held back". It is shared with
// the Locke desktop app, and it is matched on strings rather than on a
// wire-level flag. Every surface pins it by test for exactly that reason.

test('constants: INFRASTRUCTURE_REASONS is the shared closed set, frozen', () => {
  assert.equal(Object.isFrozen(INFRASTRUCTURE_REASONS), true);
  assert.deepEqual([...INFRASTRUCTURE_REASONS], [
    'engine unavailable',
    'guard unreachable',
    'engine saturated',
    'rate limit exceeded',
    'engine protocol failure',
    'bridge protocol failure'
  ]);
});

test('constants: the real outage token classifies as infrastructure', () => {
  // The desktop app's outage token, verbatim. The fragments are matched as
  // substrings because what it emits are sentences.
  const token = 'guard unreachable — blocked (fail-closed)';
  assert.equal(isInfrastructureReason(token), true);
  assert.equal(infrastructureFragment(token), 'guard unreachable');
});

test('constants: an undecodable-frame block classifies as infrastructure, not policy', () => {
  // The desktop app's undecodable-record reason, verbatim. This
  // is the exact defect the fragment closes: before it was added here, this
  // token matched nothing in our set, so `evidenceFromReceipt` read the block
  // as a real verdict and the popup showed "Screening: Active" while every
  // capture on that connection was silently failing to decode.
  const token =
    'bridge protocol failure — undecodable extension record (wire-version mismatch?), blocked (fail-closed)';
  assert.equal(isInfrastructureReason(token), true);
  assert.equal(infrastructureFragment(token), 'bridge protocol failure');
});

test('constants: unknown and absent reasons degrade to a policy refusal', () => {
  // One-way degradation: an unmatched reason still BLOCKS, it just carries the
  // refusal wording. Drift costs a worse message, never an unscreened send.
  //
  // The desktop app's own capacity refusals ('unparseable request', a size
  // cap, a field-count cap) used to be asserted here too, as examples of an
  // "unknown" reason. They are not unknown — they are KNOWN reasons that were
  // never enumerated in INFRASTRUCTURE_REASONS, so they fall through this same
  // default and are shown to the user as "screening stopped this request"
  // (a policy refusal — "we found something") when the truth is "we declined
  // to scan it". That is a live classification bug, not this test's "an
  // unrecognised reason degrades safely" invariant, and asserting it here
  // read as this test pinning the bug as correct. Do not add those strings
  // back — the fix is the wire-level `blockCause` tag below; re-patching this
  // set of matched strings would only entrench the fragile string-matching
  // that made the bug possible in the first place.
  for (const terminal of [
    'US SSN detected',
    'reconstruction failed verification',
    'something shipped after this build',
    'a reason string that will never exist'
  ]) {
    assert.equal(isInfrastructureReason(terminal), false, terminal);
  }
  assert.equal(isInfrastructureReason(null), false);
  assert.equal(isInfrastructureReason(undefined), false);
  assert.equal(isInfrastructureReason(''), false);
  assert.equal(isInfrastructureReason(42), false);
});

// ── isInfrastructureBlock: block_cause first, string match as fallback ──
//
// The block cause is now a wire-level field (`receipt.blockCause`, camelCase
// — the native messaging host relays it in that spelling). This is the
// classifier every caller should use instead of matching reason strings
// directly.

test('constants: THE FIX — a capacity refusal with a real cause IS infrastructure', () => {
  // These are the desktop app's own capacity refusals: it declined to LOOK,
  // on a byte count, a field count, or a parse failure — verbatim reason
  // strings that do NOT match INFRASTRUCTURE_REASONS and never should (see the test
  // above and its comment). What makes them classify correctly now is
  // `blockCause`, not a fourth string added to the fallback set.
  for (const reason of [
    'request exceeds the size cap',
    'request holds 9000 extractable fields, over the 4096 cap',
    'unparseable request: bad header line'
  ]) {
    // The string-only fallback still gets this wrong, by design — it's the
    // transitional path for a peer that hasn't sent a cause yet.
    assert.equal(isInfrastructureReason(reason), false, reason);
    // But with the wire-level cause, the real classifier gets it right.
    assert.equal(
      isInfrastructureBlock({ decision: 'block', blockCause: BLOCK_CAUSE.INFRASTRUCTURE, reason }),
      true,
      reason
    );
  }
});

test('constants: a genuine policy block stays policy even with infrastructure-shaped prose', () => {
  // The cause is authoritative once a peer sets it — never overridden by
  // prose that happens to CONTAIN one of the legacy fragments. Proves the
  // classifier discriminates in both directions rather than always
  // answering "infrastructure".
  assert.equal(
    isInfrastructureBlock({
      decision: 'block',
      blockCause: BLOCK_CAUSE.POLICY,
      reason: 'blocked: this would leave the engine unavailable to others'
    }),
    false
  );
});

test('constants: an unspecified, missing, or unrecognised cause falls back to the string match', () => {
  const capacityReason = 'request exceeds the size cap';
  // Explicit unspecified: same as the old shape, still degrades to policy —
  // never invents an infrastructure claim the sender didn't make.
  assert.equal(
    isInfrastructureBlock({ decision: 'block', blockCause: BLOCK_CAUSE.UNSPECIFIED, reason: capacityReason }),
    false
  );
  // No blockCause key at all — an old bridge.
  assert.equal(isInfrastructureBlock({ decision: 'block', reason: capacityReason }), false);
  // A word this build doesn't recognise (a newer bridge's vocabulary).
  assert.equal(
    isInfrastructureBlock({ decision: 'block', blockCause: 'quota', reason: capacityReason }),
    false
  );
  // But the ordinary fragment match still works through the fallback.
  assert.equal(
    isInfrastructureBlock({ decision: 'block', reason: 'guard unreachable — blocked (fail-closed)' }),
    true
  );
  // And a non-receipt never softens to true.
  assert.equal(isInfrastructureBlock(null), false);
  assert.equal(isInfrastructureBlock(undefined), false);
  assert.equal(isInfrastructureBlock({}), false);
});

test('constants: the shim’s inlined copy of the set has not drifted', async () => {
  // content/shim.js is a MAIN-world classic script and cannot import an ES
  // module, so it carries its own copy. If the two ever disagree, one capture
  // surface starts calling an outage a refusal while the other does not — and
  // nothing else in the build would notice.
  const shim = await readFile(new URL('../content/shim.js', import.meta.url), 'utf8');
  const block = /const INFRASTRUCTURE_REASONS = \[([^\]]*)\]/.exec(shim);
  assert.ok(block, 'shim.js must declare INFRASTRUCTURE_REASONS');
  const inShim = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(inShim, [...INFRASTRUCTURE_REASONS]);
});

test('constants: both halves of the page channel post to the window, not to an origin', async () => {
  // The PAGE_MSG protocol above crosses `window.postMessage`, and its two ends
  // carry one rule between them: a message aimed at THIS window names no
  // origin. `location.origin` — what all three posts used to pass — is the
  // origin of the frame's URL rather than of its document, and in an
  // opaque-origin frame (`about:blank`, `about:srcdoc`, `data:`, anything
  // sandboxed, all of which `match_about_blank` / `match_origin_as_fallback`
  // opt us into) it either throws ('null' is not a parseable URL) or names an
  // origin the receiving document does not have and is silently dropped.
  // Either way the shim holds a request nobody can answer. Neither file can
  // import the other, so the pair is pinned here.
  for (const rel of ['../content/shim.js', '../content/content-script.js']) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf8');
    const declared = /const SAME_WINDOW = '([^']*)';/.exec(src);
    assert.ok(declared, `${rel} must declare SAME_WINDOW`);
    assert.equal(declared[1], '*', `${rel} must post to the window, not to an origin`);
    assert.ok(!/postMessage\([^)]*location\.origin/.test(src),
      `${rel} must not read a postMessage target off location`);
  }
});

// ── screening availability ─────────────────────────────────────────

test('constants: SCREENING has exactly three states and no "protected"', () => {
  assert.equal(Object.isFrozen(SCREENING), true);
  assert.deepEqual(
    new Set(Object.values(SCREENING)),
    new Set(['available', 'unavailable', 'unconfirmed'])
  );
  // UNCONFIRMED is load-bearing: it is what a reachable desktop app with no
  // observed traffic must render as. Collapsing it into AVAILABLE is the false
  // assurance this whole split exists to prevent.
  assert.equal(SCREENING.UNCONFIRMED, 'unconfirmed');
});

test('constants: screening evidence expires, and not after a whole workday', () => {
  assert.ok(SCREENING_EVIDENCE_TTL_MS > 60_000, 'must outlive a single slow screen');
  assert.ok(SCREENING_EVIDENCE_TTL_MS <= 30 * 60_000, 'stale evidence must not read as live');
});

// ── the one definition of "the same host" ──────────────────────────
//
// `hostMatches` is the JS mirror of the shared host rule. These cases are
// lifted from that rule's own tests so a drift shows up here rather than as a
// silently uncaptured surface.

test('hostMatches: an entry matches itself, any case, with or without the root dot', () => {
  assert.equal(hostMatches('claude.ai', 'claude.ai'), true);
  assert.equal(hostMatches('claude.ai', 'Claude.AI'), true);
  // A trailing dot is a legal absolute spelling, not a different host. This
  // has shipped as a regression before.
  assert.equal(hostMatches('claude.ai', 'claude.ai.'), true);
  assert.equal(hostMatches('claude.ai.', 'claude.ai'), true);
});

test('hostMatches: a subdomain is the same surface', () => {
  assert.equal(hostMatches('perplexity.ai', 'www.perplexity.ai'), true);
  assert.equal(hostMatches('api.anthropic.com', 'foo.api.anthropic.com'), true);
});

test('hostMatches: the dot boundary keeps the prefix trick out', () => {
  assert.equal(hostMatches('anthropic.com', 'notanthropic.com'), false);
  assert.equal(hostMatches('api.anthropic.com', 'anthropic.com'), false, 'a parent is not a child');
  assert.equal(hostMatches('claude.ai', 'claude.ai.evil.com'), false);
  assert.equal(hostMatches('claude.ai', ''), false);
  assert.equal(hostMatches('', 'claude.ai'), false);
});
