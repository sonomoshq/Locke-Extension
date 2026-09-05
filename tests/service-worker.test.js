// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS, NATIVE_CALL_TIMEOUT_MS, PRESENCE_INTERVAL_SECONDS, PRESENCE_STALE_MS, PRESENCE_URL, REGISTRATION_MIN_INTERVAL_MS, REGISTRATION_URL } from '../shared/constants.js';

// background/service-worker.js had no test at all, and three of the things in it
// are boundaries rather than plumbing:
//
//   1. `isTrustedSender`. Every runtime message is checked against it before
//      anything is relayed onward. Its failure direction is TRUST.
//   2. `captureViaHost`. The shim is holding the page's request while this runs.
//      Its failure direction is SEND: any native-messaging answer that is not a
//      real receipt must come back as `ok: false`, because `ok: true` is what
//      the shim reads as "the desktop app spoke".
//   3. `sendPresenceBeacon`. It is the extension's ONLY outbound network call.
//      Its failure direction is EGRESS: whatever rides it leaves the browser.
//
// The worker is an ES module that resolves `ext` from `globalThis.chrome` at
// import time, so the stub is installed before the import and stays mutable —
// node:test gives this file its own process, so the single import is ours.

// ── the stub browser ───────────────────────────────────────────────

const store = { local: {}, session: {} };
let managedThrows = true;
let nativeHandler = null;      // (payload) => response, or throws
// A host that launches and then blocks forever — it neither replies nor
// exits, so runtime.lastError never sets. This is the mesh-restart transition
// the native timeout exists for; `nativeHandler` returns it to trigger that.
const HANG = Symbol('native host hangs — port never replies');
const sessionSets = [];
const nativePorts = [];

const areaFor = (name) => ({
  get: async (keys) => {
    const bag = store[name];
    if (typeof keys === 'string') return { [keys]: bag[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (bag[k] !== undefined) out[k] = bag[k];
      return out;
    }
    return { ...bag };
  },
  set: async (obj) => { Object.assign(store[name], obj); if (name === 'session') sessionSets.push(obj); },
  remove: async (key) => { delete store[name][key]; }
});

const registered = {};
const on = (name) => ({ addListener: (fn) => { registered[name] = fn; } });

// A real-enough alarms registry. Two things about it are load-bearing:
// `create` REPLACES by name, which is the browser behaviour that makes an
// unconditional re-create a way to starve a periodic alarm; and `alarmCreates`
// keeps every call in order, so a test can see a countdown being restarted
// rather than merely armed. `alarmsGetThrows` stands in for a browser that
// will not say what is armed.
const alarmRegistry = new Map();
const alarmCreates = [];
let alarmsGetThrows = false;
const HEALTH_ALARM = 'sonomos-desktop-heartbeat';
const PRESENCE_ALARM = 'sonomos-presence';

globalThis.chrome = {
  runtime: {
    id: 'locke-extension-id',
    lastError: null,
    getManifest: () => ({ version: '2.0.0' }),
    onMessage: on('message'),
    onInstalled: on('installed'),
    onStartup: on('startup'),
    sendMessage: () => Promise.resolve(),
    connectNative: () => {
      const messages = new Set();
      const disconnects = new Set();
      const port = {
        onMessage: { addListener: (fn) => messages.add(fn), removeListener: (fn) => messages.delete(fn) },
        onDisconnect: { addListener: (fn) => disconnects.add(fn), removeListener: (fn) => disconnects.delete(fn) },
        closed: false,
        messages,
        disconnects,
        disconnect() { this.closed = true; },
        postMessage(payload) {
          let response;
          try { response = nativeHandler(payload); }
          catch (e) {
            chrome.runtime.lastError = { message: e.message };
            for (const fn of disconnects) fn(port);
            chrome.runtime.lastError = null;
            return;
          }
          if (response !== HANG) for (const fn of messages) fn(response);
        }
      };
      nativePorts.push(port);
      return port;
    }
  },
  storage: {
    local: areaFor('local'),
    session: areaFor('session'),
    managed: { get: async () => { if (managedThrows) throw new Error('no managed schema'); return {}; } },
    onChanged: on('storageChanged')
  },
  alarms: {
    create: async (name, info) => { alarmCreates.push({ name, info }); alarmRegistry.set(name, { name, ...info }); },
    get: async (name) => { if (alarmsGetThrows) throw new Error('alarms.get unavailable'); return alarmRegistry.get(name); },
    onAlarm: on('alarm')
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
};

await import('../background/service-worker.js');
// Imported dynamically for the same reason the worker is: it pulls in
// shared/browser.js, which throws unless the stub above is already installed.
const { classifyLastError } = await import('../shared/health-client.js');

const onMessage = registered.message;
assert.ok(typeof onMessage === 'function', 'the worker must register a runtime message listener');

// Drive one runtime message the way the browser does, and resolve with what the
// listener passed to sendResponse (or a marker when it answered nothing).
const NO_ANSWER = Symbol('no answer');
function deliver(message, sender) {
  return new Promise((resolve) => {
    let answered = false;
    const kept = onMessage(message, sender, (response) => { answered = true; resolve(response); });
    // A listener that returns anything but `true` will never call sendResponse.
    if (kept !== true) { setImmediate(() => { if (!answered) resolve(NO_ANSWER); }); }
  });
}

const TRUSTED = { id: 'locke-extension-id', tab: { id: 4 } };
const B64 = Buffer.from('POST /v1/messages HTTP/1.1\r\n\r\nssn 123-45-6789').toString('base64');
const captureMsg = { type: 'capture', requestB64: B64 };

function captureConsole(fn) {
  const lines = [];
  const real = { warn: console.warn, debug: console.debug, log: console.log };
  console.warn = (...a) => lines.push(a.join(' '));
  console.debug = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => { Object.assign(console, real); })
    .then((value) => ({ value, lines }));
}

// ── trust ──────────────────────────────────────────────────────────

test('service-worker: a message from another extension is not relayed', async () => {
  let called = false;
  nativeHandler = () => { called = true; return { type: 'receipt', receipt: { decision: 'allow' } }; };

  for (const sender of [
    { id: 'some-other-extension' },
    { id: undefined },
    {},
    null,
    undefined
  ]) {
    const answer = await deliver(captureMsg, sender);
    assert.equal(answer, NO_ANSWER, `sender ${JSON.stringify(sender)} must get no answer`);
  }
  assert.equal(called, false, 'and nothing may reach the native host');
});

test('service-worker: our own content script is trusted', async () => {
  nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'allow', redactedCount: 0 } });
  const answer = await deliver(captureMsg, TRUSTED);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.receipt, { decision: 'allow', redactedCount: 0 });
});

test('service-worker: a capture with no payload is not relayed', async () => {
  let called = false;
  nativeHandler = () => { called = true; return { type: 'receipt', receipt: {} }; };
  assert.equal(await deliver({ type: 'capture' }, TRUSTED), NO_ANSWER);
  assert.equal(await deliver({ type: 'capture', requestB64: 12 }, TRUSTED), NO_ANSWER);
  assert.equal(await deliver(null, TRUSTED), NO_ANSWER);
  assert.equal(called, false);
});

// ── send: what may and may not read as "the desktop app spoke" ─────

test('service-worker: an empty native answer is a failure, never an allow', async () => {
  // The one that matters most. The shim reads `ok: true` as a verdict; a host
  // that answered nothing has told us nothing.
  for (const empty of [null, undefined, '', 0, 'a string']) {
    nativeHandler = () => empty;
    const answer = await deliver(captureMsg, TRUSTED);
    assert.equal(answer.ok, false, `${JSON.stringify(empty)} must not read as a verdict`);
    assert.equal(answer.code, 'bridge-empty');
  }
});

test('service-worker: an error frame comes back classified, not as a verdict', async () => {
  nativeHandler = () => ({ type: 'error', code: 'screening-timeout', message: 'guard did not answer' });
  const answer = await deliver(captureMsg, TRUSTED);
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'screening-timeout');
  assert.equal(answer.message, 'guard did not answer');
});

test('service-worker: a frame type we do not know is a failure', async () => {
  nativeHandler = () => ({ type: 'something-newer' });
  const answer = await deliver(captureMsg, TRUSTED);
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'bridge-unknown-response');
});

test('service-worker: a host that never answers fails the send closed at the native timeout', async (t) => {
  // The failure this exists for: the native host launches but neither replies
  // nor exits (a mesh-restart transition — the bridge accepts, nothing behind
  // it answers yet). Without a bound the worker awaits it for its whole
  // lifetime and every later capture hangs behind it, which is the page that
  // "hangs until you reload the extension".
  t.mock.timers.enable({ apis: ['setTimeout'] });
  nativeHandler = () => HANG;

  const answered = deliver(captureMsg, TRUSTED);
  let settled = false;
  answered.then(() => { settled = true; });

  // One tick short of the ceiling: still held, the send has NOT been decided.
  t.mock.timers.tick(NATIVE_CALL_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false, 'the send must still be held one tick before the ceiling');

  // Cross the ceiling: the worker gives up and fails closed, with its own code
  // rather than the shim's generic give-up, so the next capture — a fresh host
  // — recovers on its own and the user never has to reload.
  t.mock.timers.tick(2);
  const answer = await answered;
  assert.equal(answer.ok, false, 'a hung host must fail the send closed');
  assert.equal(answer.code, 'native-timeout');
  assert.ok(nativePorts.length > 0, 'capture owns a port it can cancel');
  const port = nativePorts.at(-1);
  assert.equal(port.closed, true, 'timeout must close the native port');
  assert.equal(port.messages.size + port.disconnects.size, 0, 'no callbacks retained');
  nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'allow' } });
  assert.equal((await deliver(captureMsg, TRUSTED)).ok, true, 'next request recovers');
});

test('service-worker: a missing native host is told apart from a broken one', async () => {
  // These get opposite advice from the shim — "start the desktop app" versus
  // "try again" — so the classification is the whole message the user reads.
  const missing = [
    'Specified native messaging host not found.',
    'No such native application ai.sonomos.desktop',
    'Native host exited unexpectedly'
  ];
  for (const message of missing) {
    nativeHandler = () => { throw new Error(message); };
    const answer = await deliver(captureMsg, TRUSTED);
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'no-bridge', `"${message}" is a missing host`);
  }

  nativeHandler = () => { throw new Error('Error when communicating with the native messaging host.'); };
  const answer = await deliver(captureMsg, TRUSTED);
  assert.equal(answer.code, 'bridge-error', 'anything else is a live host that failed');
});

// The capture path and the health check must agree about one message, because
// the page sentence and the popup sentence are both derived from it. They used
// to carry separate copies of the pattern list, and the copies had drifted in
// both directions: the capture path missed Chrome's actual "Native host has
// exited." and the health check missed the bare "Native host exited".
test('service-worker: the capture path classifies a host failure exactly as the health check does', async () => {
  const messages = [
    'Specified native messaging host not found.',
    'No such native application ai.sonomos.desktop',
    'Native host exited unexpectedly',
    'Native host has exited.',
    'Access to the specified native messaging host is forbidden.',
    'Error when communicating with the native messaging host.',
    'Some other error'
  ];
  for (const message of messages) {
    nativeHandler = () => { throw new Error(message); };
    const answer = await deliver(captureMsg, TRUSTED);
    assert.equal(answer.code, classifyLastError(message), `"${message}"`);
  }
});

test('service-worker: a receipt is passed through whole, including a rebuilt request', async () => {
  const receipt = {
    decision: 'redact', reason: 'pii found', redactedCount: 3,
    requestB64: Buffer.from('POST /x HTTP/1.1\r\n\r\nssn ***').toString('base64')
  };
  nativeHandler = () => ({ type: 'receipt', receipt });
  const answer = await deliver(captureMsg, TRUSTED);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.receipt, receipt, 'the shim needs the rebuilt request verbatim');
});

// ── the no-content rule ────────────────────────────────────────────

test('service-worker: the relay diagnostics carry sizes, never the payload', async () => {
  nativeHandler = () => ({ type: 'error', code: 'bridge-error', message: 'guard unreachable' });
  const { value, lines } = await captureConsole(() => deliver(captureMsg, TRUSTED));

  assert.equal(value.ok, false);
  const all = lines.join('\n');
  assert.match(all, /reason=bridge-error via=service-worker/, 'the failing hop names itself');
  assert.match(all, /b64Bytes=\d+/, 'and reports how much crossed');
  assert.doesNotMatch(all, /123-45-6789/, 'the request body must never reach the console');
  assert.doesNotMatch(all, new RegExp(B64.slice(0, 16)), 'nor the base64 of it');
});

test('service-worker: a healthy capture is silent unless debug logging is on', async () => {
  nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'allow', redactedCount: 0 } });
  const { lines } = await captureConsole(() => deliver(captureMsg, TRUSTED));
  assert.deepEqual(lines, [], 'a busy chat page must not narrate itself');
});

// ── the only thing that leaves over a socket ───────────────────────
//
// The extension has exactly one network call of its own: a fire-and-forget POST
// to the Locke desktop app's loopback presence listener. Three documents rest on
// what it carries — README.md ("carries nothing but the `{ browser, version }`
// presence beacon"), docs/security/PERMISSIONS.md ("The payload is exactly those
// two fields — no page data, no identifiers") and docs/architecture/DATA-FLOW.md
// — and PERMISSIONS.md goes further: "If that ever changes — any field added to
// the beacon, any remote endpoint — this declaration must change with it in the
// same commit; `tests/store-build.test.js` pins the current value so the change
// cannot be silent."
//
// It did not. That test pins the AMO data-collection *declaration* string in the
// manifest; nothing anywhere read the beacon. A third field carrying the tab URL
// (query strings carry prompts) could have been added to the body and the whole
// suite would have stayed green — over a plaintext loopback port any local
// process can bind, which is the port-squatter this repo's own threat model
// names. So this is that check, on the real call the real listeners make.
//
// The other half of the same guarantee is that held requests go by native
// messaging and never come near this channel (PERMISSIONS.md: "Held requests do
// NOT use this channel"), so a capture runs first and must produce no call at
// all.

test('service-worker: the loopback beacon carries { browser, version } and nothing else — and no held request rides it', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); };
  try {
    nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'allow', redactedCount: 0 } });
    await deliver(captureMsg, TRUSTED);
    assert.deepEqual(calls, [], 'a held request must never leave over the network channel');

    // The heartbeat is the one thing that may. onStartup is one of its three
    // callers (install, startup, alarm) and the least entangled to drive.
    await registered.startup();
    assert.equal(calls.length, 1, 'exactly one call, and it is the presence beacon');

    const [{ url, init }] = calls;
    assert.equal(url, PRESENCE_URL);
    assert.equal(new URL(url).hostname, '127.0.0.1', 'the only endpoint the extension may reach is loopback');
    assert.equal(init.method, 'POST');

    const payload = JSON.parse(init.body);
    assert.deepEqual(
      Object.keys(payload).sort(), ['browser', 'version'],
      'any field added here changes what leaves the browser — see PERMISSIONS.md and README.md'
    );
    assert.equal(payload.version, chrome.runtime.getManifest().version,
      'the manifest version, never an install identifier');
    assert.match(String(payload.browser), /^(chrome|edge|firefox|opera|vivaldi|brave|other)$/,
      'a browser id from detectBrowser, never the user-agent string itself');

    // The health check onStartup fires alongside the beacon is not awaited by
    // the worker; let it settle inside our stubs rather than after them.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── the desktop app's disable set, and the ack for it ──────────────
//
// The worker is the only place that can answer "which of these surfaces do we
// actually screen?", because it is the only half with both the catalog and the
// served list. That answer is what the native host writes into
// applied/extension.json.

const statusReply = (disabledWebHosts) => ({ type: 'status', connected: true, screening: 'available', disabledWebHosts });

test('service-worker: the disable set is stored filtered to surfaces we screen', async () => {
  delete store.local.disabledWebHosts;
  nativeHandler = () => statusReply(['gemini.google.com', 'login.bank.example']);

  await deliver({ type: 'requestCheck' }, TRUSTED);

  // `gemini.google.com` is a web surface we inject on; the bank is not and can
  // never be — the manifest does not inject us there in any configuration.
  // (chatgpt.com used to sit here, but it was promoted to an api_host, which
  // the extension no longer screens, so it too would be filtered.)
  assert.deepEqual(store.local.disabledWebHosts, { hosts: ['gemini.google.com'], ignoredCount: 1 });
});

test('service-worker: a parent of a catalog host counts as applicable', async () => {
  delete store.local.disabledWebHosts;
  // chat.openai.com and platform.openai.com sit below it, so this is a real
  // setting — the same membership rule applied everywhere else.
  nativeHandler = () => statusReply(['openai.com']);

  await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.deepEqual(store.local.disabledWebHosts, { hosts: ['openai.com'], ignoredCount: 0 });
});

test('service-worker: a host that says nothing leaves the stored set standing', async () => {
  store.local.disabledWebHosts = { hosts: ['chatgpt.com'], ignoredCount: 0 };
  // An older host, or one that answers without the field.
  nativeHandler = () => ({ type: 'status', connected: true, screening: 'available' });

  await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.deepEqual(store.local.disabledWebHosts, { hosts: ['chatgpt.com'], ignoredCount: 0 },
    'one silent probe must not re-enable screening the user declined');
});

test('service-worker: the probe reports what we are enforcing so the host can ack it', async () => {
  store.local.disabledWebHosts = { hosts: ['chatgpt.com'], ignoredCount: 2 };
  let seen = null;
  nativeHandler = (payload) => { if (payload.type === 'status') seen = payload; return statusReply(['chatgpt.com']); };

  await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.deepEqual(seen?.applied, { hosts: ['chatgpt.com'], ignoredCount: 2 });
});

test('service-worker: with nothing stored the probe claims nothing, so no ack is written', async () => {
  delete store.local.disabledWebHosts;
  let seen = null;
  nativeHandler = (payload) => { if (payload.type === 'status') seen = payload; return statusReply([]); };

  await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.equal('applied' in (seen ?? {}), false,
    'an absent field makes the host write no ack, rather than one asserting an empty set is in force');
});

// ── the popup may not claim green while a capture is failing ───────
//
// A reported failure, end to end through the real worker:
// a capture fails, the very next heartbeat's live reachability probe
// answers "available" (the desktop app is reachable), and the question is
// what the popup is handed. Before this, the probe short-circuited the stored
// evidence and the answer was "Active" — a green row sitting next to a page
// that had just refused the user's message.

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function resetScreening() {
  delete store.session.screeningState;
  delete store.session.connectionState;
  delete store.session.inFlight;
  await flush();
}

// The probe says the desktop app is up. Nothing here knows anything about
// captures.
const guardIsUp = () => ({ type: 'status', connected: true, screening: 'available' });

test('service-worker: a failed capture stops the next probe rendering as Active', async () => {
  await resetScreening();
  nativeHandler = () => { throw new Error('Native host has exited.'); };
  await deliver(captureMsg, TRUSTED);
  await flush();

  nativeHandler = guardIsUp;
  const { state } = await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.equal(state.status, 'connected', 'the desktop app really is reachable — that row stays honest');
  assert.equal(state.screening, 'unconfirmed',
    'a reachability probe does not explain the send that just failed');
  // `no-bridge`, not `bridge-error`: a host that exited is the browser failing
  // to run our connector, which is what the health check has always called it.
  // The capture path used to disagree — it carried a second copy of the
  // pattern list that missed Chrome's actual "Native host has exited." string
  // — so one event produced two codes and two sentences. Same UNCONFIRMED
  // either way (both codes prove no verdict, neither proves anything about the
  // guard); what changes is that the page and the popup now name it alike.
  assert.equal(state.lastCaptureFailure?.code, 'no-bridge');
});

test('service-worker: an unreadable receipt does the same — silence used to leave Active standing', async () => {
  await resetScreening();
  // A truncated frame: the host fail-closes to `block` with no reason, which
  // arrives looking exactly like a policy refusal.
  nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'block' } });
  await deliver(captureMsg, TRUSTED);
  await flush();

  nativeHandler = guardIsUp;
  const { state } = await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.equal(state.screening, 'unconfirmed');
  assert.equal(state.lastCaptureFailure?.code, 'verdict-unreadable');
});

test('service-worker: a capture that really was screened still reads Active', async () => {
  await resetScreening();
  nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'allow' } });
  await deliver(captureMsg, TRUSTED);
  await flush();

  nativeHandler = guardIsUp;
  const { state } = await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.equal(state.screening, 'available');
  assert.equal(state.lastCaptureFailure, null,
    'nothing to name means nothing is named — the note must not outlive the failure');
});

test('service-worker: a fail-open send is not allowed to render as Active', async () => {
  await resetScreening();
  // The desktop app answered — promptly, correctly — and the request went out with
  // an attachment nobody examined, under the user's fail-open window. This is
  // the one receipt where "Active" is not merely unearned but false.
  nativeHandler = () => ({
    type: 'receipt',
    receipt: { decision: 'allow', redactedCount: 0, unchecked: true, unscreened: [{ kind: 'file' }] }
  });
  await deliver(captureMsg, TRUSTED);
  await flush();

  nativeHandler = guardIsUp;
  const { state } = await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.equal(state.status, 'connected');
  assert.equal(state.screening, 'unconfirmed',
    'unexamined bytes reached the provider — a green row here is the worst version of the bug');
  assert.equal(state.lastCaptureFailure?.code, 'sent-unscreened');
  assert.equal(state.uncheckedSends, 1, 'and the session note still counts it exactly once');
});

test('service-worker: a good capture after a bad one clears the doubt immediately', async () => {
  await resetScreening();
  nativeHandler = () => ({ type: 'error', code: 'bridge-unreachable', message: 'guard' });
  await deliver(captureMsg, TRUSTED);
  await flush();
  nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'redact', redactedCount: 1, requestB64: B64 } });
  await deliver(captureMsg, TRUSTED);
  await flush();

  nativeHandler = guardIsUp;
  const { state } = await deliver({ type: 'requestCheck' }, TRUSTED);

  assert.equal(state.screening, 'available', 'real traffic proves recovery with no waiting period');
  assert.equal(state.lastCaptureFailure, null);
});

test('service-worker: "restored" is only ever written on a real positive', async () => {
  await resetScreening();
  delete store.local.auditLog;
  nativeHandler = () => ({ type: 'error', code: 'bridge-unreachable', message: 'guard' });
  await deliver(captureMsg, TRUSTED);
  await flush();
  // Leaving an outage for "cannot tell" is losing sight of the broken thing,
  // not a recovery. An audit trail that records the second as the first is the
  // same lie as a green popup, written down for an incident responder.
  nativeHandler = () => ({ type: 'error', code: 'bridge-empty', message: '' });
  await deliver(captureMsg, TRUSTED);
  await flush();

  const kinds = (store.local.auditLog ?? []).map((entry) => entry.kind);
  assert.ok(kinds.includes('screening-unavailable'), kinds.join(','));
  assert.ok(!kinds.includes('screening-restored'), kinds.join(','));
});

// A helper for the badge tests below: record every setBadgeText while `fn`
// runs, then put the real one back.
async function badgesDuring(fn) {
  const badges = [];
  const realText = chrome.action.setBadgeText;
  chrome.action.setBadgeText = async ({ text }) => { badges.push(text); };
  try { await fn(); } finally { chrome.action.setBadgeText = realText; }
  return badges;
}

test('service-worker: a connected extension whose guard is down does not wear a clean badge', async () => {
  await resetScreening();
  const badges = [];
  const realText = chrome.action.setBadgeText;
  chrome.action.setBadgeText = async ({ text }) => { badges.push(text); };
  try {
    nativeHandler = () => ({ type: 'status', connected: true, screening: 'unavailable' });
    await deliver({ type: 'requestCheck' }, TRUSTED);
    assert.equal(badges.at(-1), '!',
      'an absent badge reads as "nothing to report" — wrong while every in-scope request is held back');

    nativeHandler = guardIsUp;
    await deliver({ type: 'requestCheck' }, TRUSTED);
    assert.equal(badges.at(-1), '', 'and it clears again when screening is confirmed');
  } finally {
    chrome.action.setBadgeText = realText;
  }
});

// ── the captured surface's identity ─────────────────────────────────────
//
// This worker holds no catalog. It relays the id the shim resolved, verbatim,
// so the desktop app can say which surface PII was caught on.

test('capture: the provider the shim named rides the native frame', async () => {
  const frames = [];
  nativeHandler = (payload) => {
    frames.push(payload);
    return { type: 'receipt', receipt: { decision: 'allow', redactedCount: 0 } };
  };

  await deliver({ ...captureMsg, provider: 'google' }, TRUSTED);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].provider, 'google');
  assert.equal(frames[0].requestB64, B64, 'the held request is unchanged');
});

// Omitted rather than nulled, so an unattributed capture is byte-identical to
// the frame older builds sent — which is why this needs no wire-format bump.
test('capture: no provider named means no provider key on the frame', async () => {
  const frames = [];
  nativeHandler = (payload) => {
    frames.push(payload);
    return { type: 'receipt', receipt: { decision: 'allow', redactedCount: 0 } };
  };

  await deliver(captureMsg, TRUSTED);

  assert.equal(frames.length, 1);
  assert.ok(!('provider' in frames[0]), 'an absent claim must not become a null one');
});

// The badge moved only in `runCheck`, on the heartbeat, so screening that
// died between beats left the toolbar clean for up to 30 s while
// every in-scope request on the page was already being refused. The evidence
// existed at the instant of the first failed send.
test('service-worker: a capture outage marks the badge without waiting for a heartbeat', async () => {
  await resetScreening();
  nativeHandler = guardIsUp;
  await deliver({ type: 'requestCheck' }, TRUSTED);

  const badges = await badgesDuring(async () => {
    // A relay failure that PROVES no screen happened — no heartbeat in sight.
    nativeHandler = () => ({ type: 'error', code: 'bridge-unreachable', message: 'unreachable' });
    await deliver(captureMsg, TRUSTED);
    await flush();
    await flush();
  });

  assert.equal(badges.at(-1), '!',
    'the send was refused now; the toolbar may not stay clean until the next beat');
});

// The follow-up that was left over, decided here: UNCONFIRMED kept a blank badge for
// EVERY code, including `sent-unscreened` — a request that shipped unexamined
// bytes under the user's fail-open window. So the one state where content
// provably left unprotected was the one state the toolbar said nothing about,
// while an outage (where nothing leaked, because everything was held back)
// wore the mark. A leak deserves the mark at least as much as an outage does.
test('service-worker: a send that shipped unexamined bytes marks the badge too', async () => {
  await resetScreening();
  nativeHandler = guardIsUp;
  await deliver({ type: 'requestCheck' }, TRUSTED);

  const badges = await badgesDuring(async () => {
    nativeHandler = () => ({
      type: 'receipt',
      receipt: { decision: 'allow', redactedCount: 0, unchecked: true }
    });
    await deliver(captureMsg, TRUSTED);
    await flush();
    await flush();
  });

  assert.equal(badges.at(-1), '!',
    'unexamined bytes just left this machine — a blank toolbar reads as nothing to report');

  // ...and it is not sticky. One clean receipt is enough to take it back off:
  // the user's fail-open window is a setting they are entitled to have on, not
  // an offence the toolbar keeps reminding them about.
  const cleared = await badgesDuring(async () => {
    nativeHandler = () => ({ type: 'receipt', receipt: { decision: 'allow', redactedCount: 0 } });
    await deliver(captureMsg, TRUSTED);
    await flush();
    await flush();
  });
  assert.equal(cleared.at(-1), '');
});

// The state UNCONFIRMED was named for keeps its blank badge. "We cannot tell
// yet" is the absence of a claim, and a browser that has just started must not
// pull the user's eye to the toolbar to say nothing.
test('service-worker: a capture that proves nothing still leaves the badge blank', async () => {
  await resetScreening();
  nativeHandler = guardIsUp;
  await deliver({ type: 'requestCheck' }, TRUSTED);

  const badges = await badgesDuring(async () => {
    // bridge-empty: no verdict, and no evidence about screening either way.
    nativeHandler = () => ({ type: 'error', code: 'bridge-empty', message: '' });
    await deliver(captureMsg, TRUSTED);
    await flush();
    await flush();
  });

  assert.ok(badges.length > 0, 'the badge was re-derived from this capture at all');
  assert.ok(badges.every((text) => text === ''), `expected no mark, got ${JSON.stringify(badges)}`);
});

// ── presence is not a health verdict ───────────────────────────────
//
// The demo failure this section exists for, in order:
//
//   1. the browser has been open with the extension installed while Locke was
//      down, so the health alarm has walked out to `backoffMaxSeconds` (5 min);
//   2. the user starts Locke. Its presence listener starts WITH it, having
//      never heard from any browser (the app resets its view on stop);
//   3. the user opens Controls to flip a per-site toggle — and is told
//      "Locke Extension required — Install the Locke Extension", while the
//      extension is installed and screening every send on the page.
//
// The beacon was fired only from onInstalled, onStartup and the HEALTH alarm,
// so a fact the extension always knows was being rationed at the rate of a
// question that was failing. The desktop reader calls a heartbeat stale at 45 s
// (PRESENCE_STALE_MS), so five minutes of backoff reads as absent for four and
// a half of them. Presence now has its own alarm, which never backs off.

// Record every beacon fired while `fn` runs, then put the real fetch back.
async function beaconsDuring(fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return calls;
}

const presenceCreates = () => alarmCreates.filter((c) => c.name === PRESENCE_ALARM);

test('service-worker: presence has its own alarm, and it is not the health one', async () => {
  const presence = alarmRegistry.get(PRESENCE_ALARM);
  assert.ok(presence, 'the worker must arm a presence alarm of its own');
  assert.notEqual(PRESENCE_ALARM, HEALTH_ALARM, 'sharing the name would share the backoff');
  assert.equal(presence.periodInMinutes, PRESENCE_INTERVAL_SECONDS / 60,
    'the fixed cadence the desktop reader’s staleness window was sized for');
  assert.ok(PRESENCE_INTERVAL_SECONDS * 1000 < PRESENCE_STALE_MS,
    'a tick slower than the reader’s window is a tick that reports absence');
});

// The whole bug, pinned end to end.
test('service-worker: a health backoff at its maximum does not delay presence', async () => {
  await resetScreening();
  alarmCreates.length = 0;

  // Locke is down. Four beats is all it takes: 30 → 60 → 120 → 240 → capped at
  // backoffMaxSeconds (300 s).
  nativeHandler = () => { throw new Error('Native host has exited.'); };
  for (let i = 0; i < 4; i += 1) {
    await deliver({ type: 'requestCheck' }, TRUSTED);
  }

  assert.equal(alarmRegistry.get(HEALTH_ALARM).periodInMinutes, DEFAULTS.backoffMaxSeconds / 60,
    'the health probe really is backed off to its maximum — that part is correct and stays');
  assert.equal(alarmRegistry.get(PRESENCE_ALARM).periodInMinutes, PRESENCE_INTERVAL_SECONDS / 60,
    'and the presence tick did not move with it');
  assert.deepEqual(presenceCreates(), [],
    'nothing on the health path may re-arm (and so restart) the presence countdown');

  // Locke comes up. Nothing tells the extension; the next health beat is five
  // minutes away. The presence tick is what must not make the user wait.
  let probes = 0;
  nativeHandler = (payload) => { probes += 1; return guardIsUp(payload); };

  const calls = await beaconsDuring(async () => {
    registered.alarm({ name: PRESENCE_ALARM });
    await flush();
  });

  assert.equal(calls.length, 1, 'the app hears from us inside its 45 s window, not in five minutes');
  assert.equal(calls[0].url, PRESENCE_URL);
  assert.equal(probes, 0,
    'and it costs no health probe — the tick is cheap precisely so it need never be rationed');
});

test('service-worker: the health tick still runs the health probe', async () => {
  await resetScreening();
  nativeHandler = guardIsUp;
  let probes = 0;
  const wrapped = (payload) => { probes += 1; return guardIsUp(payload); };
  nativeHandler = wrapped;

  registered.alarm({ name: HEALTH_ALARM });
  await flush();
  await flush();

  assert.ok(probes > 0, 'splitting presence out must not have taken the health beat with it');
});

test('service-worker: opening the popup announces presence straight away', async () => {
  await resetScreening();
  nativeHandler = guardIsUp;

  const calls = await beaconsDuring(async () => {
    await deliver({ type: 'requestCheck' }, TRUSTED);
    await flush();
  });

  assert.equal(calls.length, 1, 'the user is looking at the connection right now');
  assert.equal(calls[0].url, PRESENCE_URL);
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(payload).sort(), ['browser', 'version'],
    'still the same two fields — a new firing point is not a new payload');
});

// Presence means installed. Nothing more. An extension whose guard is down is
// still installed, and must still say so — otherwise the desktop app answers a
// screening outage with an install instruction, which is the wrong fix pointed
// at the wrong user.
test('service-worker: an extension that cannot screen still says it is installed', async () => {
  await resetScreening();
  nativeHandler = () => ({ type: 'error', code: 'bridge-unreachable', message: 'guard' });
  await deliver(captureMsg, TRUSTED);
  await flush();
  assert.equal(store.session.screeningState?.state, 'unavailable', 'the outage is proven, not assumed');

  const calls = await beaconsDuring(async () => {
    registered.alarm({ name: PRESENCE_ALARM });
    await flush();
  });

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(payload).sort(), ['browser', 'version'],
    'and it carries no claim about screening in either direction');
});

// `alarms.create` replaces by name and restarts the countdown, so a worker
// that re-armed unconditionally on every wake would starve the tick it was
// trying to protect — a busy page evicts and wakes this worker constantly.
test('service-worker: re-arming presence on a wake does not restart its countdown', async () => {
  nativeHandler = guardIsUp;
  alarmCreates.length = 0;

  await beaconsDuring(async () => {
    await registered.startup();
    await flush();
    await flush();
  });

  assert.deepEqual(presenceCreates(), [],
    'the alarm was already armed, so asking was enough — creating again would push the tick out 30 s');
  assert.ok(alarmCreates.some((c) => c.name === HEALTH_ALARM), 'the health alarm is re-armed as it always was');
});

test('service-worker: a browser that will not say what is armed still gets a presence tick', async () => {
  nativeHandler = guardIsUp;
  alarmRegistry.delete(PRESENCE_ALARM);
  alarmCreates.length = 0;
  alarmsGetThrows = true;
  try {
    await beaconsDuring(async () => {
      await registered.startup();
      await flush();
      await flush();
    });
    assert.equal(alarmRegistry.get(PRESENCE_ALARM)?.periodInMinutes, PRESENCE_INTERVAL_SECONDS / 60,
      'an unanswerable alarms.get costs one restarted countdown; skipping the create costs presence entirely');
  } finally {
    alarmsGetThrows = false;
  }
});

// ── native messaging host self-registration ────────────────────────
//
// When the host refuses us (NO_BRIDGE), the worker asks the desktop app to
// authorise this extension's id — one POST to REGISTRATION_URL, riding the
// same loopback origin as the presence beacon. The boundaries under test:
//
//   EGRESS  the payload is exactly { id, browser, version }; the id is the
//           worker's own runtime id and nothing else rides along.
//   GATE    only a path-derived Chromium id (32 × a-p) ever POSTs. Firefox's
//           id is fixed in the manifest — there is nothing to register, so
//           there must be nothing sent.
//   PACING  at most one POST per REGISTRATION_MIN_INTERVAL_MS, whatever
//           mixture of health beats and captures hits the refusing host.
//   REPAIR  an `approved` reply re-arms the health alarm at its floor, so
//           recovery is one heartbeat away instead of a full backoff.
//   CALM    every failure is swallowed; a dead listener changes no state.

const CHROMIUM_ID = 'abcdefghijklmnopabcdefghijklmnop';
const CHROMIUM_SENDER = { id: CHROMIUM_ID, tab: { id: 4 } };
const registrationCalls = (calls) => calls.filter((c) => c.url === REGISTRATION_URL);

// The worker throttles via a session-storage timestamp; clearing it is how a
// test starts a fresh interval.
const clearRegistrationThrottle = () => { delete store.session.registrationLastAttempt; };

async function asChromiumUnpacked(fn) {
  const realId = chrome.runtime.id;
  chrome.runtime.id = CHROMIUM_ID;
  clearRegistrationThrottle();
  try { await fn(); } finally {
    chrome.runtime.id = realId;
    clearRegistrationThrottle();
  }
}

test('service-worker: a refused host makes the worker ask the app to register it', async () => {
  await resetScreening();
  nativeHandler = () => { throw new Error('Access to the specified native messaging host is forbidden.'); };

  await asChromiumUnpacked(async () => {
    const calls = await beaconsDuring(async () => {
      await deliver({ type: 'requestCheck' }, CHROMIUM_SENDER);
      await flush();
    });

    const regs = registrationCalls(calls);
    assert.equal(regs.length, 1, 'the refusal is reported to the app exactly once');
    const payload = JSON.parse(regs[0].init.body);
    assert.deepEqual(Object.keys(payload).sort(), ['browser', 'id', 'version'],
      'the id, which browser, which build — and nothing else leaves the browser');
    assert.equal(payload.id, CHROMIUM_ID, 'the id is our own runtime id, never user input');
  });
});

test('service-worker: a missing host asks too — the app, not the wording, decides', async () => {
  await resetScreening();
  // "not found" rather than "forbidden": a fresh machine where nothing is
  // registered yet. The request is the repair channel for both shapes.
  nativeHandler = () => { throw new Error('Specified native messaging host not found.'); };

  await asChromiumUnpacked(async () => {
    const calls = await beaconsDuring(async () => {
      await deliver({ type: 'requestCheck' }, CHROMIUM_SENDER);
      await flush();
    });
    assert.equal(registrationCalls(calls).length, 1);
  });
});

test('service-worker: registration is paced — one POST per interval, not one per beat', async () => {
  await resetScreening();
  nativeHandler = () => { throw new Error('Access to the specified native messaging host is forbidden.'); };

  await asChromiumUnpacked(async () => {
    const calls = await beaconsDuring(async () => {
      await deliver({ type: 'requestCheck' }, CHROMIUM_SENDER);
      await flush();
      await deliver({ type: 'requestCheck' }, CHROMIUM_SENDER);
      await flush();
      await deliver(captureMsg, CHROMIUM_SENDER);
      await flush();
    });
    assert.equal(registrationCalls(calls).length, 1,
      'two health beats and a held capture inside one interval still cost one POST');
    assert.ok(REGISTRATION_MIN_INTERVAL_MS < 30_000,
      'the floor rides under the heartbeat cadence, or the throttle would skip beats');
  });
});

test('service-worker: a Firefox-shaped id never POSTs — there is nothing to register', async () => {
  await resetScreening();
  nativeHandler = () => { throw new Error('Access to the specified native messaging host is forbidden.'); };

  const realId = chrome.runtime.id;
  chrome.runtime.id = 'desktop-connector@sonomos.ai';
  clearRegistrationThrottle();
  try {
    const calls = await beaconsDuring(async () => {
      await deliver({ type: 'requestCheck' }, { id: 'desktop-connector@sonomos.ai', tab: { id: 4 } });
      await flush();
    });
    assert.equal(registrationCalls(calls).length, 0,
      'a manifest-fixed id refused by policy is not an unpacked load to authorise');
  } finally {
    chrome.runtime.id = realId;
    clearRegistrationThrottle();
  }
});

test('service-worker: an approved reply re-arms the health alarm at its floor', async () => {
  await resetScreening();
  nativeHandler = () => { throw new Error('Access to the specified native messaging host is forbidden.'); };

  await asChromiumUnpacked(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url) => Promise.resolve({
      ok: true,
      json: async () => (url === REGISTRATION_URL ? { status: 'approved' } : {})
    });
    alarmCreates.length = 0;
    try {
      await deliver({ type: 'requestCheck' }, CHROMIUM_SENDER);
      await flush();
      await flush();
    } finally {
      globalThis.fetch = realFetch;
    }

    const floorArm = alarmCreates.find(
      (c) => c.name === HEALTH_ALARM && c.info?.delayInMinutes === 0.5
    );
    assert.ok(floorArm,
      'the manifest just gained this id — the next probe must not wait out a backoff earned while it refused us');
  });
});

test('service-worker: a dead listener changes nothing — state, badge and calm are kept', async () => {
  await resetScreening();
  nativeHandler = () => { throw new Error('Access to the specified native messaging host is forbidden.'); };

  await asChromiumUnpacked(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    try {
      const next = await deliver({ type: 'requestCheck' }, CHROMIUM_SENDER);
      await flush();
      assert.equal(next.state.status, 'no-bridge',
        'the connection state reports the host refusal exactly as before this feature');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});


test('recovery: a worker-eviction lock cannot return stale connected status', async () => {
  await resetScreening();
  store.session.connectionState = { status: 'connected', screening: 'available' };
  store.session.inFlight = Date.now();
  nativeHandler = () => ({ type: 'status', connected: false, screening: 'unavailable' });
  const reply = await deliver({ type: 'requestCheck' }, TRUSTED);
  assert.equal(reply.state.status, 'disconnected');
  delete store.session.inFlight;
});

test('recovery: simultaneous popup checks share one live probe', async () => {
  await resetScreening();
  let probes = 0;
  nativeHandler = () => { probes++; return { type: 'status', connected: false }; };
  const replies = await Promise.all([
    deliver({ type: 'requestCheck' }, TRUSTED),
    deliver({ type: 'requestCheck' }, TRUSTED)
  ]);
  assert.equal(probes, 1);
  assert.ok(replies.every((reply) => reply.state.status === 'disconnected'));
});

test('recovery: worker evaluation re-arms a lost health alarm', async () => {
  alarmRegistry.delete(HEALTH_ALARM);
  await import('../background/service-worker.js?recovery-wake');
  await flush();
  assert.ok(alarmRegistry.has(HEALTH_ALARM));
});
