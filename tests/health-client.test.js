// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Stub the WebExtensions global before importing health-client.js,
// because shared/browser.js throws on import if neither chrome nor
// browser is present. The pure functions we're testing don't use
// the global, but the module-level import does.
globalThis.chrome = { runtime: {} };

const { classify, classifyLastError, classifyLastErrorDetail, disabledWebHostsFromStatus, sanitizeBody, screeningFromStatus } = await import('../shared/health-client.js');
const { SCREENING, STATUS } = await import('../shared/constants.js');

// ── classifyLastError ──────────────────────────────────────────────

test('classifyLastError: known no-bridge messages → no-bridge', () => {
  assert.equal(
    classifyLastError('Specified native messaging host not found.'),
    'no-bridge'
  );
  assert.equal(
    classifyLastError('No such native application com.example'),
    'no-bridge'
  );
  assert.equal(
    classifyLastError('Native host has exited.'),
    'no-bridge'
  );
  assert.equal(
    classifyLastError('Failed to start native messaging host.'),
    'no-bridge'
  );
  assert.equal(
    classifyLastError('Access to the specified native messaging host is forbidden because of the system policy.'),
    'no-bridge'
  );
  // The manifest exists but does not list this extension id in
  // `allowed_origins` — the shape a tester hits loading an unpacked build
  // against a manifest written for the store id. A registration problem, and
  // it used to read as a generic bridge-error, i.e. an outage.
  assert.equal(
    classifyLastError('Access to the specified native messaging host is forbidden.'),
    'no-bridge'
  );
});

test('classifyLastError: unknown messages fall through to bridge-error', () => {
  assert.equal(classifyLastError('Some other error'), 'bridge-error');
  assert.equal(classifyLastError('I/O error'), 'bridge-error');
});

test('classifyLastError: empty/null returns bridge-error', () => {
  assert.equal(classifyLastError(''), 'bridge-error');
  assert.equal(classifyLastError(null), 'bridge-error');
  assert.equal(classifyLastError(undefined), 'bridge-error');
});

// ── classifyLastErrorDetail ────────────────────────────────────────
//
// The finer split under classifyLastError: 'forbidden' is "a registration
// exists but does not name this extension id" (the unpacked-load shape, and
// the enterprise-policy block), 'not-found' is every other no-usable-
// registration shape. Both are NO_BRIDGE to the popup; the split exists so
// the connection state can record WHICH wall was hit. Misclassifying between
// the two only moves a diagnostic label — it must never change status.

test('classifyLastErrorDetail: the two forbidden shapes → forbidden', () => {
  assert.equal(
    classifyLastErrorDetail('Access to the specified native messaging host is forbidden.'),
    'forbidden'
  );
  assert.equal(
    classifyLastErrorDetail('Access to the specified native messaging host is forbidden because of the system policy.'),
    'forbidden'
  );
});

test('classifyLastErrorDetail: the not-registered shapes → not-found', () => {
  assert.equal(classifyLastErrorDetail('Specified native messaging host not found.'), 'not-found');
  assert.equal(classifyLastErrorDetail('No such native application com.example'), 'not-found');
  assert.equal(classifyLastErrorDetail('Native host has exited.'), 'not-found');
  assert.equal(classifyLastErrorDetail('Failed to start native messaging host.'), 'not-found');
});

test('classifyLastErrorDetail: anything else (and nothing) → other', () => {
  assert.equal(classifyLastErrorDetail('Some other error'), 'other');
  assert.equal(classifyLastErrorDetail(''), 'other');
  assert.equal(classifyLastErrorDetail(null), 'other');
});

test('classifyLastError is exactly the detail collapsed: forbidden/not-found → no-bridge, other → bridge-error', () => {
  // The coarse classifier is defined ON the fine one; this pins that no
  // message can ever land in different buckets between the two.
  for (const msg of [
    'Specified native messaging host not found.',
    'No such native application com.example',
    'Native host has exited.',
    'Failed to start native messaging host.',
    'Access to the specified native messaging host is forbidden.',
    'Access to the specified native messaging host is forbidden because of the system policy.',
    'Some other error',
    '',
    null
  ]) {
    const detail = classifyLastErrorDetail(msg);
    assert.equal(
      classifyLastError(msg),
      detail === 'other' ? 'bridge-error' : 'no-bridge',
      `divergence on: ${msg}`
    );
  }
});

// ── sanitizeBody ───────────────────────────────────────────────────
//
// The host's status reply carries no body anymore — only an optional
// non-sensitive `message` (e.g. why a connect failed). sanitizeBody keeps just
// that, capped, so nothing unexpected leaks into the popup/broadcast.

test('sanitizeBody: keeps a short message', () => {
  const out = sanitizeBody({ type: 'status', connected: false, message: 'connect refused' });
  assert.deepEqual(out, { message: 'connect refused' });
});

test('sanitizeBody: drops everything when no message', () => {
  assert.equal(sanitizeBody({ type: 'status', connected: true }), null);
});

test('sanitizeBody: rejects non-object payloads', () => {
  assert.equal(sanitizeBody(null), null);
  assert.equal(sanitizeBody(undefined), null);
  assert.equal(sanitizeBody('string'), null);
  assert.equal(sanitizeBody(42), null);
});

test('sanitizeBody: over-long message rejected', () => {
  const big = 'x'.repeat(300);
  assert.equal(sanitizeBody({ message: big }), null);
  const ok = 'x'.repeat(255);
  assert.deepEqual(sanitizeBody({ message: ok }), { message: ok });
});

test('sanitizeBody: non-string message rejected', () => {
  assert.equal(sanitizeBody({ message: 123 }), null);
});

// ── classify ───────────────────────────────────────────────────────
//
// classify() turns the host's status reply into the toolbar-badge state. The
// host answers `{ type:'status', connected: bool }` after trying to reach the
// desktop app — there is no HTTP endpoint and no warming state.

test('classify: connected=true → connected', () => {
  assert.equal(classify({ type: 'status', connected: true }), STATUS.CONNECTED);
});

test('classify: connected=false → disconnected', () => {
  assert.equal(classify({ type: 'status', connected: false }), STATUS.DISCONNECTED);
  assert.equal(
    classify({ type: 'status', connected: false, message: 'connect refused' }),
    STATUS.DISCONNECTED
  );
});

test('classify: error reply → disconnected', () => {
  assert.equal(classify({ type: 'error', code: 'bad-request' }), STATUS.DISCONNECTED);
});

test('classify: garbage payload → disconnected (fail-closed)', () => {
  assert.equal(classify(null), STATUS.DISCONNECTED);
  assert.equal(classify(undefined), STATUS.DISCONNECTED);
  assert.equal(classify('string'), STATUS.DISCONNECTED);
  assert.equal(classify({}), STATUS.DISCONNECTED);
  assert.equal(classify({ type: 'unexpected' }), STATUS.DISCONNECTED);
  assert.equal(classify({ type: 'status' }), STATUS.DISCONNECTED); // connected absent
});

// ── screeningFromStatus ────────────────────────────────────────────
//
// The host's live reachability-probe answer, folded onto the status reply.
// 'unavailable' is the only definite answer the probe can supply; everything
// else must read as "no live signal" (null) so screeningFor
// (shared/screening.js) falls back to stored capture evidence instead of
// guessing.

test('screeningFromStatus: passes through the one definite value', () => {
  assert.equal(
    screeningFromStatus({ type: 'status', connected: true, screening: 'unavailable' }),
    SCREENING.UNAVAILABLE
  );
});

test('screeningFromStatus: a legacy "available" from an older host is NOT a live signal', () => {
  // The probe establishes only that the desktop app is reachable, not that it
  // can screen. A desktop app that is reachable but not yet ready — the
  // routine state of its first minutes — answers the probe exactly as a ready
  // one does, so a positive establishes a path and not a screen.
  //
  // A current host no longer sends this value at all. The demotion is for the
  // skew that outlives the fix: the host is installed natively and this
  // extension updates through a store, so an older host must not be able to
  // keep earning a green it was never entitled to.
  assert.equal(
    screeningFromStatus({ type: 'status', connected: true, screening: 'available' }),
    null
  );
});

test('screeningFromStatus: "unknown" and anything unrecognised read as no live signal', () => {
  for (const screening of ['unknown', 'active', '', 'available ', undefined, null, 42]) {
    assert.equal(
      screeningFromStatus({ type: 'status', connected: true, screening }),
      null,
      String(screening)
    );
  }
});

test('screeningFromStatus: no input at all can make it assert a positive', () => {
  // The structural half of the guarantee: whatever a host sends, this function
  // has exactly two possible return values and neither is AVAILABLE.
  const values = ['available', 'unavailable', 'unknown', 'AVAILABLE', true, 1, {}, ['available']];
  for (const screening of values) {
    const out = screeningFromStatus({ type: 'status', connected: true, screening });
    assert.notEqual(out, SCREENING.AVAILABLE, String(screening));
    assert.ok(out === SCREENING.UNAVAILABLE || out === null, String(screening));
  }
});

test('screeningFromStatus: a non-status reply (error, garbage) never asserts a live signal', () => {
  assert.equal(screeningFromStatus({ type: 'error', code: 'bad-request' }), null);
  assert.equal(screeningFromStatus(null), null);
  assert.equal(screeningFromStatus(undefined), null);
  assert.equal(screeningFromStatus('string'), null);
  assert.equal(screeningFromStatus({}), null);
  // Even a well-formed-looking screening value must not leak through if the
  // envelope itself isn't a real status reply.
  assert.equal(screeningFromStatus({ type: 'receipt', screening: 'available' }), null);
});

// ── disabledWebHostsFromStatus ─────────────────────────────────────
//
// The surfaces the user switched off, read by the native host out of
// ~/.sonomos/surfaces.local.json. The null-vs-empty distinction is the whole
// point of this function: "said nothing" must not be storable as "nothing is
// off", or one reply from an older host would re-enable screening on a
// surface the user excluded.

test('disabledWebHostsFromStatus: an omitted field is null, not an empty set', () => {
  assert.equal(disabledWebHostsFromStatus({ type: 'status', connected: true }), null);
});

test('disabledWebHostsFromStatus: an explicit empty array is a real answer', () => {
  assert.deepEqual(disabledWebHostsFromStatus({ type: 'status', disabledWebHosts: [] }), []);
});

test('disabledWebHostsFromStatus: reads the set and normalizes it', () => {
  assert.deepEqual(
    disabledWebHostsFromStatus({ type: 'status', disabledWebHosts: ['ChatGPT.com.', 'perplexity.ai'] }),
    ['chatgpt.com', 'perplexity.ai']
  );
});

test('disabledWebHostsFromStatus: present on a disconnected reply too', () => {
  // Whether the desktop app is reachable and which surfaces the user excluded
  // are independent facts — an unreachable app must not re-scope a disabled
  // surface.
  assert.deepEqual(
    disabledWebHostsFromStatus({ type: 'status', connected: false, disabledWebHosts: ['chatgpt.com'] }),
    ['chatgpt.com']
  );
});

test('disabledWebHostsFromStatus: junk entries and non-status replies are refused', () => {
  assert.deepEqual(
    disabledWebHostsFromStatus({ type: 'status', disabledWebHosts: [42, '', null, 'chatgpt.com'] }),
    ['chatgpt.com']
  );
  assert.equal(disabledWebHostsFromStatus({ type: 'error', disabledWebHosts: ['chatgpt.com'] }), null);
  assert.equal(disabledWebHostsFromStatus(null), null);
});
