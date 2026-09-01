// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { DEFAULTS } from '../shared/constants.js';

// content/shim.js is a MAIN-world classic script (no exports), so we test it
// the way the browser runs it: evaluate the real source inside a vm context
// that stands in for the page — location, the generated host list, the
// original fetch (our fake "network"), and the postMessage channel the
// content script would answer on. The `onCapture` callback stands in for the
// Locke desktop app: it receives { requestB64 } and returns the SW-shaped
// verdict { ok, receipt } (or null), which we deliver back as SONOMOS_VERDICT.

const SHIM_SRC = await readFile(new URL('../content/shim.js', import.meta.url), 'utf8');

const AI_URL = 'https://chat.openai.com/backend-api/conversation';

// `settleConfig` (default on) delivers a benign SONOMOS_CONFIG as soon as the
// shim is installed, which is what a real page gets: content-script.js pushes
// config at document_start. Without it every in-scope request in this file
// would sit out the shim's page-start config wait, which took the suite from
// 4s to 22s and — worse — meant a hundred tests were quietly exercising the
// "config never arrives" path instead of the one users are on. Tests about the
// race itself pass `{ settleConfig: false }` and drive the timing themselves.
function makeWorld(onCapture, extraGlobals = {}, { settleConfig = true, documentOrigin = null } = {}) {
  const netCalls = [];   // arguments the original (held) fetch was released with
  const listeners = [];  // the shim's window message listeners
  const logs = [];       // every diagnostic line the shim emitted
  let innerWindow = null; // the context's OWN view of `window` (vm global proxy)

  // The diagnostics are a contract, so the harness captures them the way a
  // devtools console would rather than letting them escape to the test output.
  const record = (level) => (...args) => { logs.push({ level, line: args.join(' ') }); };
  const fakeConsole = { log: record('log'), warn: record('warn'), debug: record('debug'), error: record('error') };

  // The origin of the DOCUMENT this window holds, which is not always the
  // origin of its URL — see makeFrameWorld. Assigned once the sandbox exists,
  // because `extraGlobals` may replace `location`.
  let docOrigin = null;

  // postMessage's second argument is not decoration, and this harness used to
  // ignore it. Two browser behaviours decide whether the shim's capture ever
  // reaches the content script, and both end the round trip:
  //   an unparseable targetOrigin THROWS SyntaxError — `location.origin` reads
  //     the string 'null' in every opaque-origin frame, and 'null' is not a
  //     URL;
  //   one that parses but names an origin the receiving DOCUMENT does not have
  //     is silently DROPPED — a sandboxed frame at a catalog URL reads the real
  //     origin off `location` while its document's origin is opaque.
  // Only the throw is visible to the sender; the drop just never answers.
  function deliverable(targetOrigin) {
    if (targetOrigin === '*') return true;
    let named;
    try {
      named = new URL(String(targetOrigin)).origin;
    } catch {
      const err = new Error(`Failed to execute 'postMessage': Invalid target origin '${targetOrigin}'`);
      err.name = 'SyntaxError';
      throw err;
    }
    // An opaque document origin is same origin with nothing, itself included.
    return docOrigin !== 'null' && named === docOrigin;
  }

  const sandbox = {
    location: {
      href: 'https://chat.openai.com/',
      origin: 'https://chat.openai.com',
      hostname: 'chat.openai.com'
    },
    SONOMOS_WEB_HOSTS: ['chat.openai.com', 'chatgpt.com'],
    // The host -> catalog id map the generator emits beside the host list.
    SONOMOS_WEB_PROVIDERS: { 'chat.openai.com': 'openai', 'chatgpt.com': 'openai' },
    // Realm intrinsics the shim touches.
    URL, TextEncoder, TextDecoder, btoa, atob,
    Response, Request, Headers, FormData, Blob, URLSearchParams, ReadableStream,
    Event,
    setTimeout, clearTimeout, console: fakeConsole,
    // The "network": what the page's original fetch would have done.
    fetch: async (...args) => { netCalls.push(args); return { __net: true }; },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, targetOrigin) => {
      if (!deliverable(targetOrigin)) return;
      if (!data || data.type !== 'SONOMOS_CAPTURE') return;
      Promise.resolve(onCapture(data)).then((verdict) => {
        // event.source must be what the shim sees as `window` — inside the
        // vm that's the context's global proxy, not the sandbox object.
        const event = {
          source: innerWindow,
          data: { type: 'SONOMOS_VERDICT', callId: data.callId, verdict }
        };
        for (const fn of listeners) fn(event);
      });
    },
    ...extraGlobals
  };
  sandbox.window = sandbox;
  docOrigin = documentOrigin ?? sandbox.location.origin;
  vm.createContext(sandbox);
  innerWindow = vm.runInContext('window', sandbox);
  vm.runInContext(SHIM_SRC, sandbox, { filename: 'content/shim.js' });

  // Deliver a message INTO the shim, the way content-script.js does — used to
  // push SONOMOS_CONFIG.
  const deliver = (data) => { for (const fn of listeners) fn({ source: innerWindow, data }); };
  // An empty config is a real answer: the channel spoke and named nothing
  // disabled, so every catalog surface stays screened.
  if (settleConfig) deliver({ type: 'SONOMOS_CONFIG', config: {} });
  return { sandbox, netCalls, logs, deliver };
}

// A world with the debug lines on, so the healthy-path reasons are assertable.
// `SONOMOS_DEBUG` is the page-console escape hatch the shim honours.
function makeDebugWorld(onCapture, extraGlobals = {}, options = {}) {
  return makeWorld(onCapture, { SONOMOS_DEBUG: true, ...extraGlobals }, options);
}

// ── diagnostics assertions ─────────────────────────────────────────
//
// Every fail-closed branch must name itself. These helpers keep each test's
// assertion to one line: which reason, at which level.

function findLine(logs, reason) {
  return logs.find((l) => l.line.includes(`reason=${reason} `) || l.line.endsWith(`reason=${reason}`));
}

function assertReason(logs, reason, level = 'warn') {
  const hit = findLine(logs, reason);
  assert.ok(hit, `expected a '${reason}' line, got:\n${logs.map((l) => `  ${l.level} ${l.line}`).join('\n') || '  (nothing)'}`);
  assert.equal(hit.level, level, `'${reason}' must be logged at ${level}`);
  assert.match(hit.line, /^\[sonomos\] /, 'every line carries the grep prefix');
  return hit.line;
}

// A blocked send must be reported as blocked — a reason with no action is half
// a diagnostic — and must carry the refusal class, so "we refused your
// content" is never confused with "our screener is down".
function assertBlocked(logs, reason, kind) {
  const line = assertReason(logs, reason, 'warn');
  assert.match(line, /\baction=block\b/, `'${reason}' must record action=block`);
  assert.match(line, /\bkind=(policy|unavailable|too-large|unsupported)\b/,
    `'${reason}' must record its refusal class`);
  if (kind) assert.match(line, new RegExp(`\\bkind=${kind}\\b`), `'${reason}' must be classed ${kind}`);
  return line;
}

// The shim's block error is thrown with the vm realm's TypeError, so
// `assert.rejects(p, TypeError)` can't match cross-realm — match the
// name + message instead.
const blockedError = (e) => e.name === 'TypeError' && /blocked by Sonomos/.test(e.message);

const rawOf = (requestB64) => Buffer.from(requestB64, 'base64');

function splitRaw(raw) {
  const i = raw.indexOf('\r\n\r\n');
  assert.ok(i >= 0, 'raw request has a header/body split');
  return { head: raw.subarray(0, i).toString('utf8'), body: raw.subarray(i + 4) };
}

const allowVerdict = { ok: true, receipt: { decision: 'allow', redactedCount: 0 } };

function rebuiltVerdict(headLines, bodyBytes, redactedCount = 1) {
  const raw = Buffer.concat([Buffer.from(headLines.join('\r\n') + '\r\n\r\n'), Buffer.from(bodyBytes)]);
  return {
    ok: true,
    receipt: { decision: 'redact', redactedCount, requestB64: raw.toString('base64') }
  };
}

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, 'timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── raw-request synthesis ──────────────────────────────────────────

test('shim synthesizes a raw HTTP/1.1 request from a string body', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => {
    captured.push(msg.requestB64);
    return allowVerdict;
  });

  const body = '{"prompt":"héllo"}'; // multi-byte UTF-8 must survive exactly
  const res = await sandbox.fetch(`${AI_URL}?x=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body
  });

  assert.equal(captured.length, 1);
  assert.equal(
    rawOf(captured[0]).toString('utf8'),
    'POST /backend-api/conversation?x=1 HTTP/1.1\r\n' +
    'Host: chat.openai.com\r\n' +
    'content-type: application/json\r\n' +
    'authorization: Bearer t\r\n' +
    '\r\n' +
    body
  );
  // allow → the ORIGINAL call is released unchanged.
  assert.equal(res.__net, true);
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][1].body, body);
});

test('shim fills in the effective Content-Type when the caller set none', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  await sandbox.fetch(AI_URL, { method: 'POST', body: 'plain words' });
  const { head } = splitRaw(rawOf(captured[0]));
  assert.match(head, /\r\ncontent-type: text\/plain;charset=UTF-8$/i);

  await sandbox.fetch(AI_URL, { method: 'POST', body: new URLSearchParams({ a: 'b c' }) });
  const second = splitRaw(rawOf(captured[1]));
  assert.match(second.head, /\r\ncontent-type: application\/x-www-form-urlencoded;charset=UTF-8$/i);
  assert.equal(second.body.toString('utf8'), 'a=b+c');
});

test('shim serializes FormData once: Content-Type boundary matches the body bytes', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  const fd = new FormData();
  fd.append('field', 'value');
  fd.append('file', new Blob([Uint8Array.from([0, 1, 2, 255])]), 'a.bin');
  await sandbox.fetch(AI_URL, { method: 'POST', body: fd });

  const { head, body } = splitRaw(rawOf(captured[0]));
  const m = /\r\ncontent-type: multipart\/form-data; ?boundary=(\S+)$/i.exec(head);
  assert.ok(m, `multipart content-type with boundary present in:\n${head}`);
  const boundary = m[1];
  assert.ok(body.indexOf(`--${boundary}\r\n`) === 0, 'body opens with the same boundary');
  assert.ok(body.includes(`--${boundary}--`), 'body closes with the same boundary');
  assert.ok(body.includes(Buffer.from([0, 1, 2, 255])), 'binary part bytes are exact');
  assert.equal(netCalls.length, 1); // allow → original FormData released
  assert.equal(netCalls[0][1].body, fd);
});

test('shim captures a Request-object body binary-safely', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i); // every byte value
  const req = new Request(AI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
    duplex: 'half'
  });
  await sandbox.fetch(req);

  const { body } = splitRaw(rawOf(captured[0]));
  assert.deepEqual(new Uint8Array(body), bytes);
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], req); // released as held
});

// ── receipt handling ───────────────────────────────────────────────

test('redact: shim re-issues the rebuilt body BYTES with the rebuilt Content-Type', async () => {
  // The rebuilt body deliberately contains CRLFCRLF: only the FIRST split
  // in the rebuilt request may be honored.
  const rebuiltBody = Buffer.from('a\r\n\r\nb [REDACTED]');
  const rebuiltCt = 'multipart/form-data; boundary=FRESH';
  const { sandbox, netCalls } = makeWorld(() => rebuiltVerdict(
    ['POST /backend-api/conversation HTTP/1.1', 'Host: chat.openai.com', `content-type: ${rebuiltCt}`],
    rebuiltBody,
    2
  ));

  await sandbox.fetch(AI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: '{"prompt":"secret"}'
  });

  assert.equal(netCalls.length, 1);
  const [url, init] = netCalls[0];
  assert.equal(url, AI_URL);
  assert.ok(ArrayBuffer.isView(init.body), 'rebuilt body is bytes, never a string'); // vm-realm Uint8Array
  assert.deepEqual(Buffer.from(init.body), rebuiltBody);
  assert.equal(init.headers.get('content-type'), rebuiltCt);
  assert.equal(init.headers.get('authorization'), 'Bearer t'); // other headers untouched
  assert.equal(init.method, 'POST');
});

test('block: the held request never leaves', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'policy', redactedCount: 0 } }
  ));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: '{"prompt":"x"}' }),
    blockedError
  );
  assert.equal(netCalls.length, 0);
  // A real finding: say so, and carry the desktop app's own reason.
  assert.match(assertBlocked(logs, 'decision-block'), /\bguardReason=policy\b/);
});

// ── fail-closed ────────────────────────────────────────────────────

test('fail-closed: a receipt with no decision blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({ ok: true, receipt: {} }));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'decision-missing');
});

test('fail-closed: an unrecognised decision blocks and names what it saw', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({ ok: true, receipt: { decision: 'maybe' } }));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assert.match(assertBlocked(logs, 'decision-unknown'), /\bdecision=maybe\b/);
});

test('fail-closed: a verdict with no receipt at all blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({ ok: true }));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'verdict-malformed');
});

test('fail-closed: redact without a rebuilt request blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => (
    { ok: true, receipt: { decision: 'redact', redactedCount: 1 } }
  ));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'redact-missing-request');
});

test('fail-closed: a rebuilt request with no header/body split blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'redact', redactedCount: 1, requestB64: Buffer.from('no split here').toString('base64') }
  }));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'redact-malformed');
});

test('fail-closed: a rebuilt request that is not valid base64 blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'redact', redactedCount: 1, requestB64: '!!! not base64 !!!' }
  }));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  // Distinct from redact-malformed: an undecodable payload and a payload that
  // decodes but has no CRLFCRLF are different bugs upstream.
  assertBlocked(logs, 'redact-undecodable');
});

test('fail-closed: a null verdict (no bridge) blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => null);
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'verdict-missing');
});

test('fail-closed: an unclassified relay failure reports native-call-failed with the host error', async () => {
  // `bridge-error` is native messaging itself failing — the port died, the
  // host exited — which is the one relay failure where "the desktop app could
  // not be reached" is the true sentence. It is also the fallback every
  // unclassified code takes, so this pins the default too.
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: false,
    code: 'bridge-error',
    message: 'Native host has exited.'
  }));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  const line = assertBlocked(logs, 'native-call-failed');
  assert.match(line, /\bcode=bridge-error\b/);
  assert.match(line, /Native host has exited/);
});

// A reported failure: "Sonomos blocks my 1 MB attachment saying 'the Locke
// desktop app could not be reached' — but Locke IS running and the popup says
// Online / Active at the same time." `no-bridge` (the native messaging host
// never launched) and `bridge-unreachable` (the host DID launch and DID answer
// the browser; only the step past it failed) used to collapse into the same
// reason and the same "could not be reached... Start it" sentence — wrong
// advice for the second case, and the exact contradiction a popup reading
// Online produces next to it.
test('fail-closed: a bridge-unreachable relay failure is told apart from a missing host', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: false,
    code: 'bridge-unreachable',
    message: 'connect to the screening service: No such file or directory'
  }));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      // Must NOT claim the desktop app itself could not be reached — the
      // native host DID answer, which is exactly what the popup's Status row
      // reflects too. Saying so would have the two surfaces disagree.
      assert.ok(!/desktop app could not be reached/.test(e.message), e.message);
      assert.match(e.message, /answered/);
      assert.match(e.message, /screening service/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=unavailable\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0);
  const line = assertBlocked(logs, 'bridge-unreachable', 'unavailable');
  assert.match(line, /\bcode=bridge-unreachable\b/);
});

// The same wrong-advice shape as above, recurring through a code `decide()`
// never classified: `receipt-too-large` — raised by the native messaging host
// — means the host answered, the desktop app answered AND
// found something to redact — the only problem is the rebuilt body doesn't
// fit the native-messaging reply cap. Uncaught, this
// fell to the same `native-call-failed` bucket as a genuinely absent host and
// told the user to "start" an app that had just fully screened their
// request. It is also a size limit, not connectivity — `uncapturable-oversize`
// gets the same `too-large` class for the same reason.
test('fail-closed: a receipt-too-large relay failure is NOT told to start the desktop app', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: false,
    code: 'receipt-too-large',
    message: 'redacted body exceeds the native-messaging reply cap; failing closed'
  }));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x'.repeat(900_000) }),
    (e) => {
      assert.ok(!/desktop app could not be reached/.test(e.message), e.message);
      assert.ok(!/[Ss]tart it/.test(e.message), e.message);
      assert.match(e.message, /too large/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=too-large\b/);
      // "Send a smaller attachment" with no ceiling named is
      // unactionable: the user cannot tell whether to drop a kilobyte or a
      // megabyte, and the two caps in play (8 MiB out, ~1 MB back) differ by
      // ten times. Both real numbers or the advice is noise.
      assert.match(e.message, /this request is 900000 bytes/,
        `must name what they actually sent: ${e.message}`);
      assert.match(e.message, /limit is about 782336 bytes/,
        `must name the reply cap it hit, not the screening cap: ${e.message}`);
      return true;
    }
  );
  assert.equal(netCalls.length, 0);
  const line = assertBlocked(logs, 'receipt-too-large', 'too-large');
  assert.match(line, /\bcode=receipt-too-large\b/);
});

test('fail-closed: a dead postMessage channel reports verdict-channel-failed', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => allowVerdict, {
    postMessage: () => { throw new Error('channel gone'); }
  });
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'verdict-channel-failed');
});

test('fail-closed: an error in our own logic once committed blocks as internal-error', async () => {
  // btoa throwing puts the failure AFTER the request is in scope and committed.
  const { sandbox, netCalls, logs } = makeWorld(() => allowVerdict, {
    btoa: () => { throw new Error('boom'); }
  });
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'internal-error');
});

// ── uncapturable bodies: each kind names itself ────────────────────

test('fail-closed: a ReadableStream body cannot be captured and blocks', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, logs } = makeWorld(() => { meshAsked = true; return allowVerdict; });
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: stream, duplex: 'half' }),
    blockedError
  );
  assert.equal(meshAsked, false); // uncapturable → no round-trip at all
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'uncapturable-stream');
});

test('fail-closed: a Document body cannot be captured and blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => allowVerdict);
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: { nodeType: 9 } }),
    blockedError
  );
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'uncapturable-document');
});

test('fail-closed: an oversize body blocks and names both the size and the cap', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => allowVerdict);
  const tooBig = 'x'.repeat(8 * 1024 * 1024 + 1); // one byte past MAX_BODY
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: tooBig }), blockedError);
  assert.equal(netCalls.length, 0);
  const line = assertBlocked(logs, 'uncapturable-oversize');
  assert.match(line, /\bbytes=8388609\b/);
  assert.match(line, /\bcapBytes=8388608\b/);
});

test('fail-closed: an unreadable body blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => allowVerdict);
  // Response() stringifies an arbitrary object — a throwing toString makes the
  // body genuinely unreadable.
  const body = { toString() { throw new Error('nope'); } };
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body }), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'uncapturable-unreadable');
});

test('fail-closed: a Request body that will not clone blocks', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => allowVerdict);
  // Request-shaped enough to reach the clone path, and its clone rejects.
  const reqLike = {
    url: AI_URL,
    method: 'POST',
    body: {},
    clone: () => ({ arrayBuffer: () => Promise.reject(new Error('detached')) })
  };
  await assert.rejects(sandbox.fetch(reqLike), blockedError);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'uncapturable-request-clone');
});

// ── the timeout, which is its own kind of failure ──────────────────

test('timeout: no verdict blocks with verdict-timeout, NOT a generic block', async () => {
  // A desktop app that never answers. The configured ceiling is pushed down to the
  // clamp floor so the test does not wait 45 s.
  const { sandbox, netCalls, logs, deliver } = makeWorld(() => new Promise(() => {}));
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 1000 } });

  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' }), blockedError);
  assert.equal(netCalls.length, 0);

  const line = assertBlocked(logs, 'verdict-timeout');
  // The whole point: the line must say how long it waited, what it was
  // waiting for, and that nothing was found — a timeout is not a finding.
  assert.match(line, /\bwaitedMs=\d+/);
  assert.match(line, /\btimeoutMs=1000\b/);
  assert.match(line, /\bblockedBecause=no-verdict-arrived-not-pii\b/);
  // It must NOT masquerade as the desktop app having decided something.
  assert.ok(!findLine(logs, 'decision-block'), 'a timeout must not report as decision-block');
});

test('config: the enforce ceiling is clamped against a hostile page', async () => {
  const { sandbox, logs, deliver } = makeWorld(() => new Promise(() => {}));
  // A page posting an absurd ceiling must not be able to hold a request open
  // indefinitely; the clamp pins it to the 1 s floor.
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: -5 } });
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.match(assertBlocked(logs, 'verdict-timeout'), /\btimeoutMs=1000\b/);
});

// 45 s, restored from the value the v3 rewrite regressed to 5 s. The ceiling
// has to stay in step with the desktop app's own ceiling on how long it will
// work on a verdict: too short falsely reports a healthy-but-slow screen as a
// timeout, too long leaves the page hanging past the point the desktop app has
// already given up and answered something else. That number is not readable
// from here, so this pin holds the extension's end still — the literal, and
// the agreement between the shim's inlined copy and the shared default — and
// an accidental edit to either copy fails the suite.
const DEFAULT_ENFORCE_CEILING_MS = 45_000;

test('config: the default enforce ceiling is pinned, and both copies agree', () => {
  const shimMatch = /const DEFAULT_ENFORCE_TIMEOUT_MS = (\d[\d_]*);/.exec(SHIM_SRC);
  assert.ok(shimMatch, 'DEFAULT_ENFORCE_TIMEOUT_MS declaration not found in content/shim.js — update this test’s parser');
  const shimMs = Number(shimMatch[1].replace(/_/g, ''));

  assert.equal(
    shimMs,
    DEFAULT_ENFORCE_CEILING_MS,
    `content/shim.js DEFAULT_ENFORCE_TIMEOUT_MS is ${shimMs}ms, not the pinned ${DEFAULT_ENFORCE_CEILING_MS}ms`
  );
  assert.equal(
    DEFAULTS.enforceTimeoutMs,
    DEFAULT_ENFORCE_CEILING_MS,
    `shared/constants.js DEFAULTS.enforceTimeoutMs is ${DEFAULTS.enforceTimeoutMs}ms, not the pinned ${DEFAULT_ENFORCE_CEILING_MS}ms`
  );
  assert.equal(
    shimMs,
    DEFAULTS.enforceTimeoutMs,
    'content/shim.js inlines the ceiling it holds until a config push arrives; it must equal ' +
      'shared/constants.js DEFAULTS.enforceTimeoutMs, or a page that never gets config waits ' +
      'a different length of time from one that does.'
  );
});

// ── scoping: out-of-scope traffic must pass through untouched ──────

test('out-of-scope host and bodyless requests pass through untouched', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, logs } = makeDebugWorld(() => { meshAsked = true; return allowVerdict; });

  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  await sandbox.fetch(AI_URL); // no body → nothing to scan
  assert.equal(meshAsked, false);
  assert.equal(netCalls.length, 2);
  // Both pass-throughs are debug-level: a healthy install must stay quiet.
  assertReason(logs, 'not-in-scope', 'debug');
  assertReason(logs, 'no-body', 'debug');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0, 'nothing blocked → no warnings');
});

test('quiet by default: the healthy path logs nothing without the debug flag', async () => {
  const { sandbox, logs } = makeWorld(() => allowVerdict);
  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });
  assert.deepEqual(logs, [], 'a working install is silent');
});

test('the allow and redact paths report at debug with their shape', async () => {
  const { sandbox, logs } = makeDebugWorld(() => allowVerdict);
  await sandbox.fetch(AI_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"hi"}' });
  const line = assertReason(logs, 'allow', 'debug');
  assert.match(line, /\bvia=fetch\b/);
  assert.match(line, /\bhost=chat\.openai\.com\b/);
  assert.match(line, /\bpath=\/backend-api\/conversation\b/);
  assert.match(line, /\bmethod=POST\b/);
  assert.match(line, /\bbytes=10\b/);
  assert.match(line, /\bct=application\/json\b/);
  assert.match(line, /\baction=send\b/);
});

// ── the no-content rule ────────────────────────────────────────────

test('diagnostics never leak the body, the query string, or a header value', async () => {
  const SECRET_BODY = 'my-social-security-number-is-078-05-1120';
  const SECRET_QUERY = 'leak-me-in-the-query';
  const SECRET_HEADER = 'Bearer super-secret-token';

  // Every branch that could log: a block, a redact, and the healthy path, all
  // with debug wide open so nothing is hidden by the level gate.
  const worlds = [
    makeDebugWorld(() => ({ ok: true, receipt: { decision: 'block', reason: 'pii' } })),
    makeDebugWorld(() => allowVerdict),
    makeDebugWorld(() => rebuiltVerdict(
      ['POST /backend-api/conversation HTTP/1.1', 'Host: chat.openai.com', 'content-type: application/json'],
      Buffer.from('{"q":"[REDACTED]"}')
    ))
  ];

  for (const { sandbox, logs } of worlds) {
    await sandbox.fetch(`${AI_URL}?q=${SECRET_QUERY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: SECRET_HEADER },
      body: SECRET_BODY
    }).catch(() => { /* the block case rejects; we only care about the logs */ });

    assert.ok(logs.length > 0, 'something was logged');
    for (const { line } of logs) {
      assert.ok(!line.includes(SECRET_BODY), `body content leaked into a log line:\n${line}`);
      assert.ok(!line.includes('078-05-1120'), `body content leaked into a log line:\n${line}`);
      assert.ok(!line.includes(SECRET_QUERY), `query string leaked into a log line:\n${line}`);
      assert.ok(!line.includes('super-secret-token'), `header value leaked into a log line:\n${line}`);
    }
  }
});

// ── XMLHttpRequest ─────────────────────────────────────────────────

function makeXhrWorld(onCapture, { headerSetThrows = false, settleConfig = true } = {}) {
  // Minimal XHR stand-in installed BEFORE the shim runs, so the shim wraps
  // its prototype exactly as it would the real one. `dispatchEvent` records
  // what the page would have observed: a real XHR whose send() was never
  // forwarded fires nothing on abort(), so the shim raises the failure itself.
  class FakeXHR {
    constructor() { this.sent = []; this.setHeaders = []; this.aborted = false; this.events = []; }
    open(method, url) { this.opened = [method, url]; }
    setRequestHeader(name, value) {
      // A real XHR throws InvalidStateError here if the request has left the
      // OPENED state — which is exactly what defeats the rebuilt Content-Type.
      if (headerSetThrows) throw new Error('InvalidStateError');
      this.setHeaders.push([name, value]);
    }
    send(body) { this.sent.push(body); }
    abort() { this.aborted = true; }
    dispatchEvent(event) { this.events.push(event.type); return true; }
  }
  return makeWorld(onCapture, { XMLHttpRequest: FakeXHR }, { settleConfig });
}

test('XHR: allow releases the held body; the raw request carries the page headers', async () => {
  const captured = [];
  const { sandbox } = makeXhrWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.sent.length === 1);
  assert.deepEqual(xhr.sent, ['{"q":"hi"}']);
  assert.equal(
    rawOf(captured[0]).toString('utf8'),
    'POST /api/chat HTTP/1.1\r\nHost: chat.openai.com\r\ncontent-type: application/json\r\n\r\n{"q":"hi"}'
  );
});

test('XHR: redact of a FormData body sends bytes and sets the fresh-boundary Content-Type', async () => {
  const rebuiltBody = Buffer.from('--FRESH\r\ncontent-disposition: form-data; name="f"\r\n\r\n[REDACTED]\r\n--FRESH--\r\n');
  const rebuiltCt = 'multipart/form-data; boundary=FRESH';
  const { sandbox } = makeXhrWorld(() => rebuiltVerdict(
    ['POST /api/upload HTTP/1.1', 'Host: chat.openai.com', `content-type: ${rebuiltCt}`],
    rebuiltBody
  ));

  const fd = new FormData();
  fd.append('f', 'secret');
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/upload', true);
  xhr.send(fd); // page set no Content-Type — the browser would generate it

  await waitFor(() => xhr.sent.length === 1);
  assert.ok(ArrayBuffer.isView(xhr.sent[0]), 'rebuilt body is bytes, never a string'); // vm-realm Uint8Array
  assert.deepEqual(Buffer.from(xhr.sent[0]), rebuiltBody);
  assert.deepEqual(xhr.setHeaders, [['Content-Type', rebuiltCt]]);
  assert.equal(xhr.aborted, false);
});

test('XHR: a sync XHR with a body cannot be held and is aborted (fail-closed)', async () => {
  let meshAsked = false;
  const { sandbox, logs } = makeXhrWorld(() => { meshAsked = true; return allowVerdict; });

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', false); // sync
  xhr.send('{"q":"hi"}');

  assert.equal(xhr.aborted, true);
  assert.deepEqual(xhr.sent, []);
  assert.equal(meshAsked, false);
  assertBlocked(logs, 'uncapturable-sync-xhr');
});

test('XHR: block verdict aborts; nothing is sent', async () => {
  const { sandbox, logs } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, []);
  const line = assertBlocked(logs, 'decision-block');
  assert.match(line, /\bvia=xhr\b/);
  assert.match(line, /\bguardReason=pii\b/);
});

test('XHR: rebuilt Content-Type that conflicts with a page-set one aborts (append-only headers)', async () => {
  const { sandbox, logs } = makeXhrWorld(() => rebuiltVerdict(
    ['POST /api/chat HTTP/1.1', 'Host: chat.openai.com', 'content-type: multipart/form-data; boundary=FRESH'],
    Buffer.from('x')
  ));

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.setRequestHeader('Content-Type', 'application/json'); // cannot be overridden
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, []);
  assert.deepEqual(xhr.setHeaders, [['Content-Type', 'application/json']]);
  const line = assertBlocked(logs, 'redact-ct-conflict');
  assert.match(line, /\bpageCt=application\/json\b/);
  assert.match(line, /\brebuiltCt=multipart\/form-data\b/);
});

test('XHR: a rebuilt Content-Type that cannot be set aborts rather than sending mislabelled bytes', async () => {
  const { sandbox, logs } = makeXhrWorld(() => rebuiltVerdict(
    ['POST /api/upload HTTP/1.1', 'Host: chat.openai.com', 'content-type: multipart/form-data; boundary=FRESH'],
    Buffer.from('--FRESH--\r\n')
  ), { headerSetThrows: true });

  const fd = new FormData();
  fd.append('f', 'secret');
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/upload', true);
  xhr.send(fd); // page set no Content-Type, so the shim must set the rebuilt one

  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, []);
  assertBlocked(logs, 'redact-ct-set-failed');
});

test('XHR: out-of-scope and bodyless sends report at debug and pass through', async () => {
  const { sandbox, logs } = makeWorld(() => allowVerdict, {
    SONOMOS_DEBUG: true,
    XMLHttpRequest: class {
      constructor() { this.sent = []; this.setHeaders = []; this.aborted = false; }
      open(method, url) { this.opened = [method, url]; }
      setRequestHeader(name, value) { this.setHeaders.push([name, value]); }
      send(body) { this.sent.push(body); }
      abort() { this.aborted = true; }
    }
  });

  const off = new sandbox.XMLHttpRequest();
  off.open('POST', 'https://example.com/api', true);
  off.send('{"q":"hi"}');

  const empty = new sandbox.XMLHttpRequest();
  empty.open('POST', 'https://chat.openai.com/api/chat', true);
  empty.send('');

  assert.deepEqual(off.sent, ['{"q":"hi"}']);
  assert.deepEqual(empty.sent, ['']);
  assertReason(logs, 'not-in-scope', 'debug');
  assertReason(logs, 'no-body', 'debug');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

// ── unchecked / unscreened / withheld ──────────────────────────────
//
// The desktop app's vocabulary, relayed through the native messaging host.
// The pairing is what carries the meaning, and getting it wrong in
// either direction is a real failure: reading a fail-open send as clean hides
// the one case where content leaves unscreened, and reading a withheld
// attachment as a fail-open cries wolf about a request that was handled
// exactly right.

const pngUnscreened = { kind: 'file', media_type: 'image/png', reason: 'engine_unsupported' };
const pdfUnscreened = { kind: 'file', media_type: 'application/pdf', reason: 'engine_unsupported' };

test('unchecked allow: the send goes out, and says so out loud', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: {
      decision: 'allow',
      reason: '1 item(s) could not be examined (file: application/pdf) — passed unchecked (user fail-open)',
      redactedCount: 0,
      unchecked: true,
      unscreened: [pdfUnscreened]
    }
  }));

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });

  // The user opened their fail-open window, so this is allowed to ship — but
  // it is the ONE case where content leaves unscreened, and it must never be
  // silent, nor depend on debugLogging having been switched on first.
  assert.equal(netCalls.length, 1);
  const line = assertReason(logs, 'allow-unchecked', 'warn');
  assert.match(line, /\baction=send\b/);
  assert.match(line, /\bsentUnscreened=1\b/);
  assert.match(line, /\bunscreenedKinds="file: application\/pdf"/);
  assert.match(line, /\bbecause=user-fail-open-window\b/);
});

test('unchecked allow is inferred from the items alone, without the flag', async () => {
  // A bridge too old to relay `unchecked` still relays `unscreened`. An allow
  // can never be a withhold (withholding rebuilds the request), so unscreened
  // items on an allow SHIPPED — read them that way rather than trusting a
  // missing flag.
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'allow', redactedCount: 0, unscreened: [pdfUnscreened] }
  }));

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });
  assert.equal(netCalls.length, 1);
  assertReason(logs, 'allow-unchecked', 'warn');
});

test('a clean allow stays quiet: unchecked=false is not a warning', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'allow', redactedCount: 0, unchecked: false }
  }));
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });
  assert.equal(netCalls.length, 1);
  assert.deepEqual(logs, [], 'a fully screened send is silent');
});

test('withheld: unchecked=false with unscreened items reports a drop, not a leak', async () => {
  // The desktop app could not examine an attachment, so it stood an inert
  // placeholder in and rebuilt the request: nothing unexamined left the
  // machine. Still worth saying — the user's prompt now refers to an image
  // the model cannot see.
  const rebuiltBody = Buffer.from('{"q":"hi","img":"<placeholder>"}');
  const { sandbox, netCalls, logs } = makeWorld(() => {
    const v = rebuiltVerdict(
      ['POST /backend-api/conversation HTTP/1.1', 'Host: chat.openai.com', 'content-type: application/json'],
      rebuiltBody,
      0
    );
    v.receipt.reason = '1 image withheld (could not be examined)';
    v.receipt.unchecked = false;
    v.receipt.unscreened = [pngUnscreened];
    return v;
  });

  await sandbox.fetch(AI_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"hi","img":"…"}'
  });

  assert.equal(netCalls.length, 1, 'the rebuilt request still goes out');
  assert.deepEqual(Buffer.from(netCalls[0][1].body), rebuiltBody);
  const line = assertReason(logs, 'redact-withheld', 'warn');
  assert.match(line, /\baction=redact\b/);
  assert.match(line, /\bwithheld=1\b/);
  assert.match(line, /\bwithheldKinds="file: image\/png"/);
  // It must NOT be reported as an unchecked send: nothing shipped unexamined.
  assert.ok(!findLine(logs, 'allow-unchecked'), 'a withhold is not a fail-open');
  assert.ok(!findLine(logs, 'redact-unchecked'), 'a withhold is not a fail-open');
});

test('unchecked redact: a partial screen under the fail-open window names itself', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => {
    const v = rebuiltVerdict(
      ['POST /backend-api/conversation HTTP/1.1', 'Host: chat.openai.com', 'content-type: application/json'],
      Buffer.from('{"q":"[REDACTED]"}'),
      2
    );
    v.receipt.unchecked = true;
    v.receipt.unscreened = [pdfUnscreened];
    return v;
  });

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"secret"}' });
  assert.equal(netCalls.length, 1);
  const line = assertReason(logs, 'redact-unchecked', 'warn');
  assert.match(line, /\bredactedCount=2\b/);
  assert.match(line, /\bsentUnscreened=1\b/);
  assert.match(line, /\bbecause=user-fail-open-window\b/);
});

test('the unscreened summary reads kinds and media types and nothing else', async () => {
  // `Unscreened` has no field that could carry content — but the array
  // arrives from off-file, so a fabricated extra field must not reach the
  // console either.
  const SECRET = 'passport-number-X1234567';
  const { sandbox, logs } = makeDebugWorld(() => ({
    ok: true,
    receipt: {
      decision: 'allow',
      unchecked: true,
      unscreened: [{ kind: 'file', media_type: 'image/png', reason: 'engine_error', name: SECRET, content: SECRET }]
    }
  }));

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });
  assert.ok(logs.length > 0);
  for (const { line } of logs) {
    assert.ok(!line.includes(SECRET), `an unscreened entry leaked a field into a log line:\n${line}`);
  }
  assert.match(assertReason(logs, 'allow-unchecked', 'warn'), /\bunscreenedKinds="file: image\/png"/);
});

// ── refusal classes and the page-visible message ───────────────────
//
// "We refused your content" and "our screener is down" are different
// sentences. Conflating them sends a user hunting for PII they never sent —
// which is how a privacy tool loses the trust it runs on. The desktop app
// already splits these; the browser surface has to use the same distinction.

test('a policy block names the desktop app’s own reason on the rejection itself', async () => {
  const { sandbox, logs } = makeWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'US SSN detected', redactedCount: 0 } }
  ));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.match(e.message, /screening stopped this request — US SSN detected\./);
      assert.match(e.message, /\bkind=policy\b/);
      assert.match(e.message, /\breason=decision-block\b/);
      return true;
    }
  );
  assertBlocked(logs, 'decision-block', 'policy');
});

// ── the 503/403 split, on a decision that is `block` either way ─────
//
// The whole chain fails CLOSED, so an outage and a refusal both arrive as
// `decision: block`. Only the reason separates them. These are the tests that
// keep "Sonomos couldn't check this" from being shown as "Sonomos found
// something in this" — the mistake that sends a user hunting for PII they
// never sent.

// The exact token the desktop app emits when screening cannot be reached.
const GUARD_UNREACHABLE = 'guard unreachable — blocked (fail-closed)';

test('an infrastructure block reads as an outage, never as a refusal of the content', async () => {
  const { sandbox, logs } = makeWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: GUARD_UNREACHABLE, redactedCount: 0 } }
  ));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.match(e.message, /screening is unavailable, so this request could not be checked/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=unavailable\b/);
      assert.match(e.message, /\breason=screening-unavailable\b/);
      // The refusal wording must not appear at all — a user who reads
      // "screening stopped this request" starts editing their prompt.
      assert.ok(!/screening stopped this request/.test(e.message), e.message);
      return true;
    }
  );
  assertBlocked(logs, 'screening-unavailable', 'unavailable');
});

test('every shared infrastructure fragment is classified as an outage', async () => {
  // The closed set the outage-vs-refusal split runs on. If this drifts, an
  // outage starts being reported to users as a sensitive-data refusal.
  const fragments = [
    'engine unavailable',
    'guard unreachable',
    'engine saturated',
    'rate limit exceeded',
    'engine protocol failure',
    'bridge protocol failure'
  ];
  for (const fragment of fragments) {
    const { sandbox, logs } = makeWorld(() => (
      // Wrapped in surrounding text: the real reasons are sentences that
      // CONTAIN the fragment, never the bare fragment.
      { ok: true, receipt: { decision: 'block', reason: `screening: ${fragment} — blocked (fail-closed)` } }
    ));
    await assert.rejects(
      sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
      (e) => {
        assert.match(e.message, /\bkind=unavailable\b/, `${fragment} must class as an outage`);
        return true;
      }
    );
    assertBlocked(logs, 'screening-unavailable', 'unavailable');
  }
});

// ── THE FIX: blockCause, read through the real shim code ──

test('a capacity refusal with a real blockCause reads as an outage, not a refusal', async () => {
  // The desktop app's own capacity refusals: it declined to LOOK — on a byte
  // count, a field count, or a parse failure — before any content was ever
  // examined. None of these reason strings match INFRASTRUCTURE_REASONS and
  // never should; what makes this classify correctly is `blockCause`, carried
  // end-to-end by the native messaging host.
  for (const reason of [
    'request exceeds the size cap',
    'request holds 9000 extractable fields, over the 4096 cap',
    'unparseable request: bad header line'
  ]) {
    const { sandbox, logs } = makeWorld(() => (
      { ok: true, receipt: { decision: 'block', blockCause: 'infrastructure', reason } }
    ));
    await assert.rejects(
      sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
      (e) => {
        assert.match(e.message, /screening is unavailable, so this request could not be checked/, reason);
        assert.match(e.message, /NOT a sensitive-data block/, reason);
        assert.match(e.message, /\bkind=unavailable\b/, reason);
        assert.match(e.message, /\breason=screening-unavailable\b/, reason);
        assert.ok(!/screening stopped this request/.test(e.message), `${reason}: ${e.message}`);
        return true;
      }
    );
    assertBlocked(logs, 'screening-unavailable', 'unavailable');
  }
});

test('a genuine policy block still reads as a refusal even with infrastructure-shaped prose', async () => {
  // The cause is authoritative once the desktop app sets it — never overridden by
  // reason text that happens to CONTAIN a legacy fragment. Proves the shim's
  // classifier discriminates rather than defaulting to "always an outage"
  // once blockCause is in play.
  const { sandbox, logs } = makeWorld(() => (
    {
      ok: true,
      receipt: {
        decision: 'block',
        blockCause: 'policy',
        reason: 'blocked: this would leave the engine unavailable to others'
      }
    }
  ));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.match(e.message, /\bkind=policy\b/);
      assert.match(e.message, /\breason=decision-block\b/);
      assert.ok(!/NOT a sensitive-data block/.test(e.message), e.message);
      return true;
    }
  );
  assertBlocked(logs, 'decision-block', 'policy');
});

test('an unspecified or missing blockCause falls back to the reason string unchanged', async () => {
  // The old-guard shape must keep behaving exactly as it did before
  // blockCause existed — a capacity refusal with no cause on the wire still
  // (today, transitionally) reads as policy, and a real infrastructure
  // fragment with an explicit "unspecified" cause still reads as an outage.
  const capacity = makeWorld(() => (
    { ok: true, receipt: { decision: 'block', blockCause: 'unspecified', reason: 'request exceeds the size cap' } }
  ));
  await assert.rejects(
    capacity.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => { assert.match(e.message, /\bkind=policy\b/); return true; }
  );
  assertBlocked(capacity.logs, 'decision-block', 'policy');

  const outage = makeWorld(() => (
    {
      ok: true,
      receipt: {
        decision: 'block',
        blockCause: 'unspecified',
        reason: 'guard unreachable — blocked (fail-closed)'
      }
    }
  ));
  await assert.rejects(
    outage.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => { assert.match(e.message, /\bkind=unavailable\b/); return true; }
  );
  assertBlocked(outage.logs, 'screening-unavailable', 'unavailable');
});

test('an unrecognised reason degrades to the policy wording, and still blocks', async () => {
  // Degradation is one-way on purpose: a reason we do not know is treated as a
  // refusal, which still holds the request back. Drift costs a worse message,
  // never an unscreened send.
  const { sandbox, logs, netCalls } = makeWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'some reason shipped after this build' } }
  ));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.match(e.message, /\bkind=policy\b/);
      assert.match(e.message, /\breason=decision-block\b/);
      return true;
    }
  );
  assertBlocked(logs, 'decision-block', 'policy');
  assert.equal(netCalls.length, 0, 'nothing may leave on any block');
});

test('a block with no reason at all still blocks, as a policy refusal', async () => {
  const { sandbox, logs, netCalls } = makeWorld(() => (
    { ok: true, receipt: { decision: 'block' } }
  ));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assertBlocked(logs, 'decision-block', 'policy');
  assert.equal(netCalls.length, 0);
});

test('the host’s own deadline reads as a screen that timed out, not a missing app', async () => {
  // The native messaging host answers `screening-timeout` when its own 25 s
  // deadline expires. The desktop app is what just answered us, so telling the
  // user to start it would send them looking in the wrong place.
  const { sandbox, logs, netCalls } = makeWorld(() => ({
    ok: false,
    code: 'screening-timeout',
    message: 'no verdict within 25s — blocked (fail-closed)'
  }));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.match(e.message, /did not finish in time/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=unavailable\b/);
      assert.match(e.message, /\breason=screening-timeout\b/);
      assert.ok(!/could not be reached/.test(e.message), e.message);
      return true;
    }
  );
  assertBlocked(logs, 'screening-timeout', 'unavailable');
  assert.equal(netCalls.length, 0);
});

test('a timeout rejects as an infrastructure failure, explicitly not a PII finding', async () => {
  const { sandbox, logs, deliver } = makeWorld(() => new Promise(() => {}));
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 1000 } });
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /Locke desktop app is running/);
      assert.match(e.message, /\bkind=unavailable\b/);
      return true;
    }
  );
  assertBlocked(logs, 'verdict-timeout', 'unavailable');
});

test('an oversize body rejects as a size limit, with the real numbers', async () => {
  const { sandbox, logs } = makeWorld(() => allowVerdict);
  const tooBig = 'x'.repeat(8 * 1024 * 1024 + 1);
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: tooBig }),
    (e) => {
      assert.match(e.message, /8388609 bytes, over Locke’s 8388608 byte screening limit/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=too-large\b/);
      return true;
    }
  );
  assertBlocked(logs, 'uncapturable-oversize', 'too-large');
});

test('an unholdable transport rejects as unsupported, not as something to retry', async () => {
  const { sandbox, logs } = makeWorld(() => allowVerdict);
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: stream, duplex: 'half' }),
    (e) => {
      assert.match(e.message, /\bkind=unsupported\b/);
      assert.match(e.message, /streams its body/);
      return true;
    }
  );
  assertBlocked(logs, 'uncapturable-stream', 'unsupported');
});

// `no-bridge` is the browser failing to START our native-messaging host — no
// manifest, a manifest that omits this extension id, or a host that exited at
// once. The BROWSER launches that process, per message, from that manifest;
// the desktop app is not in the loop. So "start it, then try again" sent the
// tester to open an app that was already open, on the one failure where that
// is provably useless. The popup
// says the same thing on its own STATUS.NO_BRIDGE branch; the two surfaces
// must name one fix, not two.
test('a browser that could not start our connector is sent to the app’s consent prompt, not to a shell script', async () => {
  const { sandbox, logs } = makeWorld(() => ({ ok: false, code: 'no-bridge', message: 'not found' }));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      assert.ok(!/could not be reached/.test(e.message), e.message);
      assert.ok(!/[Ss]tart it/.test(e.message), e.message);
      // The worker has already asked the app to repair the registration
      // (requestHostRegistration); the app is where the Allow click waits.
      // Sending the user to run install.sh by hand is the instruction this
      // feature retired — its reappearance here would mean the copy split.
      assert.ok(!/install\.(sh|ps1)/.test(e.message), e.message);
      assert.match(e.message, /click Allow/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=unavailable\b/);
      return true;
    }
  );
  assertBlocked(logs, 'connector-not-started', 'unavailable');
});

// The rest of that residue: three relay codes that all inherited "the Locke
// desktop app could not be reached. Start it" from the fallback, and for which
// it is wrong. `capture-error` is the sharpest of them — it is OUR OWN service
// worker throwing, so the sentence sent the user to restart the one component
// that was working.
test('a relay code we own is never blamed on the desktop app', async () => {
  const cases = [
    ['bridge-empty', 'bridge-unreadable-reply', /could not read/],
    ['bridge-unknown-response', 'bridge-unreadable-reply', /could not read/],
    ['capture-error', 'relay-error', /Locke extension hit an error/],
    ['bad-request', 'relay-rejected', /rejected this request as malformed/]
  ];
  for (const [code, reason, says] of cases) {
    const { sandbox, netCalls, logs } = makeWorld(() => ({ ok: false, code, message: 'x' }));
    await assert.rejects(
      sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
      (e) => {
        assert.ok(!/desktop app could not be reached/.test(e.message), `${code}: ${e.message}`);
        assert.ok(!/[Ss]tart it/.test(e.message), `${code}: ${e.message}`);
        assert.match(e.message, says, code);
        assert.match(e.message, /NOT a sensitive-data block/, code);
        return true;
      }
    );
    assert.equal(netCalls.length, 0, `${code} must still fail closed`);
    assertBlocked(logs, reason, 'unavailable');
  }
});

test('the page-visible rejection never carries body, query or header content', async () => {
  const SECRET_BODY = 'my-social-security-number-is-078-05-1120';
  const SECRET_QUERY = 'leak-me-in-the-query';
  const SECRET_HEADER = 'Bearer super-secret-token';
  const { sandbox } = makeWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'US SSN detected' } }
  ));
  await assert.rejects(
    sandbox.fetch(`${AI_URL}?q=${SECRET_QUERY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: SECRET_HEADER },
      body: SECRET_BODY
    }),
    (e) => {
      assert.ok(!e.message.includes(SECRET_BODY), e.message);
      assert.ok(!e.message.includes('078-05-1120'), e.message);
      assert.ok(!e.message.includes(SECRET_QUERY), e.message);
      assert.ok(!e.message.includes('super-secret-token'), e.message);
      return true;
    }
  );
});

// ── an unresolvable target ─────────────────────────────────────────
//
// The shim is injected on AI surfaces and nowhere else. A bodied request whose
// target we cannot even resolve is therefore a "couldn't check" state on a
// surface we are responsible for, not somebody else's traffic.

// Defeats `new URL(String(input), …)` without being a Request: the only way
// resolveUrl answers null.
const unresolvable = (extra = {}) => ({ toString() { throw new Error('no url'); }, ...extra });

test('fail-closed: a bodied fetch whose target will not resolve blocks', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, logs } = makeWorld(() => { meshAsked = true; return allowVerdict; });
  await assert.rejects(sandbox.fetch(unresolvable({ body: '{"q":"hi"}' })), blockedError);
  assert.equal(meshAsked, false);
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'scope-unresolvable', 'unsupported');
});

test('a bodiless request whose target will not resolve still passes through', async () => {
  // The hard rule holds: we only ever alter requests we deliberately commit
  // to enforcing, and there is nothing to screen here.
  const { sandbox, netCalls, logs } = makeDebugWorld(() => allowVerdict);
  await sandbox.fetch(unresolvable());
  assert.equal(netCalls.length, 1);
  assertReason(logs, 'not-in-scope', 'debug');
});

test('fail-closed: a bodied XHR whose target will not resolve blocks', async () => {
  const { sandbox, logs } = makeXhrWorld(() => allowVerdict);
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', unresolvable(), true);
  xhr.send('{"q":"hi"}');
  assert.equal(xhr.aborted, true);
  assert.deepEqual(xhr.sent, []);
  assertBlocked(logs, 'scope-unresolvable', 'unsupported');
});

// ── a blocked XHR must fail, not hang ──────────────────────────────

test('a blocked XHR raises an error event rather than leaving the page waiting', async () => {
  // We never forwarded send(), so the XHR's send() flag is unset and abort()
  // fires nothing at all — the page would spin forever with the explanation
  // only on a console nobody has open.
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.events.length > 0);
  assert.deepEqual(xhr.sent, []);
  assert.equal(xhr.aborted, true);
  assert.deepEqual(xhr.events, ['error', 'loadend']);
});

// ── an XHR block must be attributable to us ────────────────────────
//
// A `fetch` block rejects with a `TypeError` whose message says who refused
// and why. An XHR block had no equivalent: `abort()` plus a bare
// `ProgressEvent('error')` is byte-for-byte what a dropped connection looks
// like, so every XHR-path refusal — a screening outage, a policy block, a
// too-large attachment — reached the user as the SITE's own network-error
// copy, and our refusals were filed as ChatGPT bugs.
//
// There is deliberately no in-page surface (see content/shim.js `blockMessage`
// for why). What there is instead: the same sentence on the console for every
// transport, and the reason stamped on the XHR object, which is the only
// channel an XHR has that outlives the event.

test('a blocked XHR carries the reason on the object, before the error event fires', async () => {
  const seenAtDispatch = [];
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'US SSN detected', blockCause: 'policy' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  // The page's own handler is the reader we care about — it must find the
  // properties already set, not race them.
  const realDispatch = xhr.dispatchEvent.bind(xhr);
  xhr.dispatchEvent = (event) => {
    seenAtDispatch.push([event.type, xhr.sonomosBlocked, xhr.sonomosBlockReason]);
    return realDispatch(event);
  };
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.events.length > 0);
  assert.equal(xhr.sonomosBlocked, true);
  assert.equal(xhr.sonomosBlockReason, 'decision-block');
  assert.equal(xhr.sonomosBlockKind, 'policy');
  assert.match(xhr.sonomosBlockMessage, /blocked by Sonomos/);
  assert.match(xhr.sonomosBlockMessage, /US SSN detected/);
  assert.deepEqual(seenAtDispatch[0], ['error', true, 'decision-block'],
    'a handler reading event.target must find the reason already there');
});

test('a blocked XHR says on the console what a blocked fetch says in its rejection', async () => {
  const verdict = () => ({ ok: false, code: 'bridge-unreachable', message: 'guard' });

  const xhrWorld = makeXhrWorld(verdict);
  const xhr = new xhrWorld.sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  await waitFor(() => xhr.aborted);

  const fetchWorld = makeWorld(verdict);
  let thrown = null;
  await fetchWorld.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }).catch((e) => { thrown = e; });

  const announced = xhrWorld.logs.find((l) => l.line.includes('blocked by Sonomos'));
  assert.ok(announced, `no human sentence on the XHR path:\n${xhrWorld.logs.map((l) => l.line).join('\n')}`);
  assert.equal(announced.level, 'warn', 'a block is never hidden behind the debug flag');
  assert.equal(announced.line, `[sonomos] ${thrown.message}`,
    'the two transports must not describe one outage in two different sentences');
  assert.equal(xhr.sonomosBlockMessage, thrown.message);
});

test('every transport announces a refusal, including the ones with nowhere to put it', async () => {
  // sendBeacon's only signal is `false` — there is no object to stamp and no
  // error to throw. The console line is the whole of its attribution, which is
  // exactly why the line is emitted centrally rather than per transport.
  const { sandbox, logs } = makeBeaconWorld();
  sandbox.navigator.sendBeacon('https://chat.openai.com/ces/v1/t', '{"e":1}');
  const announced = logs.find((l) => l.line.includes('blocked by Sonomos'));
  assert.ok(announced, 'a refused beacon must still name itself');
  assert.match(announced.line, /background beacon/);
});

test('the announced sentence never carries body, query or header content', async () => {
  const SECRET = 'my-social-security-number-is-078-05-1120';
  const { sandbox, logs } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'US SSN detected' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat?q=leak-me', true);
  xhr.setRequestHeader('Authorization', 'Bearer sk-live-secret');
  xhr.send(SECRET);
  await waitFor(() => xhr.aborted);

  for (const { line } of logs) {
    assert.ok(!line.includes(SECRET), `body leaked into the announcement:\n${line}`);
    assert.ok(!line.includes('leak-me'), `query string leaked:\n${line}`);
    assert.ok(!line.includes('sk-live-secret'), `header value leaked:\n${line}`);
  }
  assert.ok(!xhr.sonomosBlockMessage.includes(SECRET));
});

// ── navigator.sendBeacon ───────────────────────────────────────────
//
// A beacon cannot be held: it answers synchronously and the browser sends it
// on its own schedule. In scope with data, that is the sync-XHR case and takes
// the same answer — refuse it.

function makeBeaconWorld(hosts = ['chat.openai.com']) {
  const beacons = [];
  const world = makeWorld(() => allowVerdict, {
    SONOMOS_DEBUG: true,
    SONOMOS_WEB_HOSTS: hosts,
    navigator: { sendBeacon(url, data) { beacons.push([url, data]); return true; } }
  });
  return { ...world, beacons };
}

test('fail-closed: an in-scope beacon carrying data is refused', async () => {
  const { sandbox, beacons, logs } = makeBeaconWorld();
  const ok = sandbox.navigator.sendBeacon('https://chat.openai.com/ces/v1/t', '{"prompt":"secret"}');
  assert.equal(ok, false, 'sendBeacon must report that it could not queue the transfer');
  assert.deepEqual(beacons, [], 'nothing reached the network');
  const line = assertBlocked(logs, 'uncapturable-beacon', 'unsupported');
  assert.match(line, /\bvia=beacon\b/);
  assert.match(line, /\bhost=chat\.openai\.com\b/);
});

test('out-of-scope and bodiless beacons are delegated untouched', async () => {
  const { sandbox, beacons, logs } = makeBeaconWorld();
  assert.equal(sandbox.navigator.sendBeacon('https://example.com/t', 'anything'), true);
  assert.equal(sandbox.navigator.sendBeacon('https://chat.openai.com/ping'), true);
  assert.equal(beacons.length, 2);
  assertReason(logs, 'not-in-scope', 'debug');
  assertReason(logs, 'no-body', 'debug');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

test('fail-closed: a beacon carrying data to an unresolvable target is refused', async () => {
  const { sandbox, beacons, logs } = makeBeaconWorld();
  assert.equal(sandbox.navigator.sendBeacon(unresolvable(), 'payload'), false);
  assert.deepEqual(beacons, []);
  assertBlocked(logs, 'scope-unresolvable', 'unsupported');
});

// The beacon hook tested the CATALOG (`isAiHost`) rather than the catalog
// minus the user's own disable set (`isScreenedHost`), so a surface the user
// had switched off in the desktop app still had every beacon refused —
// enforcement they had explicitly turned off, on the one transport that can
// never be released later.
test('a beacon to a surface the user switched off is delegated, not refused', async () => {
  const { sandbox, beacons, deliver } = makeBeaconWorld();
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });
  assert.equal(
    sandbox.navigator.sendBeacon('https://chat.openai.com/ces/v1/t', '{"e":1}'), true,
    'the user disabled this surface; refusing its beacons enforces a setting they turned off'
  );
  assert.equal(beacons.length, 1);
});

test('a beacon to a surface that is still on is refused exactly as before', async () => {
  const { sandbox, beacons, logs, deliver } = makeBeaconWorld();
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['perplexity.ai'] } });
  assert.equal(sandbox.navigator.sendBeacon('https://chat.openai.com/ces/v1/t', '{"e":1}'), false);
  assert.deepEqual(beacons, []);
  assertBlocked(logs, 'uncapturable-beacon', 'unsupported');
});

test('beacon diagnostics never carry the beacon payload', async () => {
  const SECRET = 'my-social-security-number-is-078-05-1120';
  const { sandbox, logs } = makeBeaconWorld();
  sandbox.navigator.sendBeacon('https://chat.openai.com/ces/v1/t?q=leak-me', SECRET);
  assert.ok(logs.length > 0);
  for (const { line } of logs) {
    assert.ok(!line.includes(SECRET), `beacon payload leaked:\n${line}`);
    assert.ok(!line.includes('leak-me'), `beacon query string leaked:\n${line}`);
  }
});

// ── the cross-origin upload scope ──────────────────────────────────
//
// An AI web app that attaches a file often does NOT post the bytes to its own
// origin: it mints a pre-signed URL and PUTs the file straight to object
// storage on an unrelated host. Scoping on the request's host alone therefore
// misses the densest PII on the page — a CV, a contract, a customer list —
// while the user believes attachments are screened.
//
// The fix cannot be "add the storage hosts to the catalog": those hosts carry
// the whole internet's traffic. What the extension has instead is position —
// it runs inside the page, so it knows the request's initiator is an AI
// surface. These tests pin both halves of that: the writes we now hold, and
// the far larger set of cross-origin traffic we must keep our hands off.

const STORAGE_PUT = 'https://files.oaiusercontent.com/file-abc123';

// A page that is NOT a catalog surface. The upload scope must be inert there,
// whatever the request looks like.
const OFF_SURFACE_PAGE = { location: { href: 'https://example.com/', origin: 'https://example.com' } };

test('upload: a cross-origin PUT of a file is held and screened', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  await sandbox.fetch(STORAGE_PUT, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: bytes
  });

  assert.equal(captured.length, 1, 'the attachment reached the desktop app');
  const { head, body } = splitRaw(rawOf(captured[0]));
  assert.match(head, /^PUT \/file-abc123 HTTP\/1\.1\r\nHost: files\.oaiusercontent\.com\r\n/);
  assert.deepEqual(new Uint8Array(body), bytes, 'the exact file bytes were screened');
  // A clean allow releases the page's ORIGINAL call, untouched.
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], STORAGE_PUT);
  assert.equal(netCalls[0][1].body, bytes);
});

test('upload: the pre-signed credential in the query string is never sent onward', async () => {
  // A pre-signed URL's query string IS a bearer capability to write that
  // object. It has no screening value — the body is what gets scanned — so it must
  // not cross into a subsystem that logs, caches and meters requests.
  const SIGNATURE = 'a1b2c3d4deadbeefsignature';
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  const url = `https://s3.eu-west-2.amazonaws.com/bucket/key?X-Amz-Signature=${SIGNATURE}&X-Amz-Credential=AKIAEXAMPLE`;
  await sandbox.fetch(url, { method: 'PUT', body: 'file bytes' });

  const raw = rawOf(captured[0]).toString('utf8');
  assert.match(raw, /^PUT \/bucket\/key HTTP\/1\.1\r\n/, 'the request line carries the path, never the query');
  assert.ok(!raw.includes(SIGNATURE), `the pre-signed credential crossed the seam:\n${raw}`);
  assert.ok(!raw.includes('AKIAEXAMPLE'), `the access key id crossed the seam:\n${raw}`);
  // Enforcement is unaffected: the release goes out on the page's own URL.
  assert.equal(netCalls[0][0], url);
});

test('upload: diagnostics name the scope and the host, and never the object key', async () => {
  // On a pre-signed URL the path is the object key, which is very often the
  // user's own filename — content by the same rule that keeps bodies and query
  // strings off the console.
  const { sandbox, logs } = makeDebugWorld(() => allowVerdict);
  await sandbox.fetch('https://s3.example.com/bucket/Jane-Doe-CV-2026.pdf?X-Amz-Signature=sig', {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: 'bytes'
  });

  const line = assertReason(logs, 'allow', 'debug');
  assert.match(line, /\bscope=upload\b/);
  assert.match(line, /\bhost=s3\.example\.com\b/);
  assert.match(line, /\bmethod=PUT\b/);
  assert.ok(!/\bpath=/.test(line), `the object key reached the console:\n${line}`);
  for (const { line: l } of logs) {
    assert.ok(!l.includes('Jane-Doe-CV'), `a filename leaked:\n${l}`);
    assert.ok(!l.includes('sig'), `the query string leaked:\n${l}`);
  }
});

test('upload: a POST that declares a resumable object write is held', async () => {
  // Gemini's attachment path is a POST, not a PUT — the page declares the
  // object write in `x-goog-upload-*` headers. Header NAMES only; no value is
  // read or logged.
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  await sandbox.fetch('https://push.clients6.google.com/upload/session-xyz', {
    method: 'POST',
    headers: { 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0' },
    body: 'file bytes'
  });
  assert.equal(captured.length, 1);
  assert.match(rawOf(captured[0]).toString('utf8'), /^POST \/upload\/session-xyz HTTP\/1\.1\r\n/);
});

test('upload: ordinary third-party POSTs are NOT held — the false-positive floor', async () => {
  // The cost of getting this wrong is holding traffic we had no business
  // holding: error reports, analytics, feature flags, auth, payments. Every
  // one of them is a POST with no object-write declaration, and every one of
  // them must pass through exactly as it did before the upload scope existed.
  let meshAsked = false;
  const { sandbox, netCalls, logs } = makeDebugWorld(() => { meshAsked = true; return allowVerdict; });

  const passers = [
    ['https://o123.ingest.sentry.io/api/1/envelope/', { method: 'POST', body: '{"event":1}', headers: { 'content-type': 'application/x-sentry-envelope' } }],
    ['https://api.stripe.com/v1/payment_methods', { method: 'POST', body: 'card[number]=4242', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['https://api.segment.io/v1/t', { method: 'POST', body: '{"anonymousId":"x"}' }],
    // SigV4 signs every AWS call, analytics included — "signed" is not "object write".
    ['https://kinesis.us-east-1.amazonaws.com/', { method: 'POST', body: '{"Records":[]}', headers: { 'x-amz-date': '20260811T000000Z', 'x-amz-target': 'Kinesis_20131202.PutRecords' } }],
    // Bodyless writes are protocol steps, not uploads.
    ['https://files.oaiusercontent.com/file-abc', { method: 'PUT' }],
    // A non-https target is never an upload we can hold.
    ['http://localhost:9000/bucket/key', { method: 'PUT', body: 'x' }]
  ];
  for (const [url, init] of passers) await sandbox.fetch(url, init);

  assert.equal(meshAsked, false, 'not one of these may reach the desktop app');
  assert.equal(netCalls.length, passers.length, 'every one passed through untouched');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0, 'and none of them warned');
});

test('upload: the scope is bounded by the PAGE, not by the destination', async () => {
  // The blast radius is the existing catalog and nothing wider: the shim only
  // runs on a page the catalog names, and the upload scope refuses to act
  // unless that is true. This is what stops the fix from becoming "hold every
  // cross-origin PUT in the browser".
  let meshAsked = false;
  const { sandbox, netCalls } = makeWorld(() => { meshAsked = true; return allowVerdict; }, OFF_SURFACE_PAGE);
  await sandbox.fetch(STORAGE_PUT, { method: 'PUT', body: 'file bytes' });
  assert.equal(meshAsked, false, 'an off-catalog page may not widen what we hold');
  assert.equal(netCalls.length, 1);
});

test('upload: fail-closed — no verdict blocks the upload, and says it found nothing', async () => {
  const { sandbox, netCalls, logs, deliver } = makeWorld(() => new Promise(() => {}));
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 1000 } });
  await assert.rejects(
    sandbox.fetch(STORAGE_PUT, { method: 'PUT', body: 'file bytes' }),
    (e) => {
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=unavailable\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0, 'the file never left');
  assert.match(assertBlocked(logs, 'verdict-timeout', 'unavailable'), /\bscope=upload\b/);
});

test('upload: an unexaminable attachment is blocked, never replaced with a placeholder', async () => {
  // Withholding swaps an unexaminable attachment for an inert 1×1 image so the
  // rest of a chat prompt still ships. Here the attachment IS the whole body:
  // withholding would PUT a 69-byte placeholder into the bucket, the site would
  // record a successful upload of the user's file, and the model would be shown
  // a blank square — with nobody told. Nothing left the machine either way;
  // this way we can say so.
  const { sandbox, netCalls, logs } = makeWorld(() => {
    const v = rebuiltVerdict(
      ['PUT /file-abc123 HTTP/1.1', 'Host: files.oaiusercontent.com', 'content-type: image/png'],
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      0
    );
    v.receipt.reason = '1 image withheld (could not be examined)';
    v.receipt.unchecked = false;
    v.receipt.unscreened = [pngUnscreened];
    return v;
  });

  await assert.rejects(
    sandbox.fetch(STORAGE_PUT, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: 'realbytes' }),
    (e) => {
      assert.match(e.message, /could not be examined, so it was not uploaded/);
      assert.match(e.message, /Nothing left your machine/);
      assert.match(e.message, /\bkind=unsupported\b/);
      assert.match(e.message, /\breason=upload-withheld\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0, 'no placeholder was uploaded in the file’s place');
  assertBlocked(logs, 'upload-withheld', 'unsupported');
});

test('upload: a body the request commits to by checksum is blocked rather than re-sent redacted', async () => {
  // A rebuilt body under the original Content-MD5 earns the storage provider's
  // own opaque error, which reads to the user as "the site is broken".
  const { sandbox, netCalls, logs } = makeWorld(() => rebuiltVerdict(
    ['PUT /file-abc123 HTTP/1.1', 'Host: files.oaiusercontent.com', 'content-type: text/csv'],
    Buffer.from('name,[REDACTED]\n'),
    1
  ));

  await assert.rejects(
    sandbox.fetch(STORAGE_PUT, {
      method: 'PUT',
      headers: { 'content-type': 'text/csv', 'content-md5': 'Q2hlY2tJbnRlZ3JpdHk9' },
      body: 'name,jane@example.com\n'
    }),
    (e) => {
      assert.match(e.message, /commits to the original bytes with a checksum/);
      assert.match(e.message, /Nothing left your machine/);
      assert.match(e.message, /\breason=upload-integrity-locked\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0);
  assertBlocked(logs, 'upload-integrity-locked', 'unsupported');
});

test('upload: UNSIGNED-PAYLOAD is not a checksum commitment, so a redact still ships', async () => {
  // SigV4 sends `x-amz-content-sha256: UNSIGNED-PAYLOAD` on a browser upload,
  // which commits to nothing. Treating it as a commitment would block every
  // redacted S3 upload for no reason at all.
  const rebuiltBody = Buffer.from('name,[REDACTED]\n');
  const { sandbox, netCalls } = makeWorld(() => rebuiltVerdict(
    ['PUT /file-abc123 HTTP/1.1', 'Host: files.oaiusercontent.com', 'content-type: text/csv'],
    rebuiltBody,
    1
  ));

  await sandbox.fetch(STORAGE_PUT, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    body: 'name,jane@example.com\n'
  });
  assert.equal(netCalls.length, 1);
  assert.deepEqual(Buffer.from(netCalls[0][1].body), rebuiltBody, 'the screened file is what was uploaded');
});

test('upload: a redacted file with no integrity commitment is uploaded screened', async () => {
  const rebuiltBody = Buffer.from('name,[REDACTED]\n');
  const { sandbox, netCalls, logs } = makeDebugWorld(() => rebuiltVerdict(
    ['PUT /file-abc123 HTTP/1.1', 'Host: files.oaiusercontent.com', 'content-type: text/csv'],
    rebuiltBody,
    3
  ));
  await sandbox.fetch(STORAGE_PUT, {
    method: 'PUT', headers: { 'content-type': 'text/csv' }, body: 'name,jane@example.com\n'
  });
  assert.equal(netCalls.length, 1);
  assert.deepEqual(Buffer.from(netCalls[0][1].body), rebuiltBody);
  assert.match(assertReason(logs, 'redact', 'debug'), /\bscope=upload\b.*\bredactedCount=3\b/);
});

test('upload: the user’s fail-open window still applies, and still says so out loud', async () => {
  // The one sanctioned way content leaves unscreened is not the extension's
  // decision to make, on this path or any other.
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'allow', redactedCount: 0, unchecked: true, unscreened: [pdfUnscreened] }
  }));
  await sandbox.fetch(STORAGE_PUT, { method: 'PUT', body: 'file bytes' });
  assert.equal(netCalls.length, 1);
  const line = assertReason(logs, 'allow-unchecked', 'warn');
  assert.match(line, /\bscope=upload\b/);
  assert.match(line, /\bbecause=user-fail-open-window\b/);
});

test('upload: an XHR PUT is held and screened too', async () => {
  const captured = [];
  const { sandbox } = makeXhrWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('PUT', `${STORAGE_PUT}?X-Amz-Signature=sig`, true);
  xhr.setRequestHeader('Content-Type', 'application/pdf');
  xhr.send('file bytes');

  await waitFor(() => xhr.sent.length === 1);
  assert.deepEqual(xhr.sent, ['file bytes']);
  const raw = rawOf(captured[0]).toString('utf8');
  assert.match(raw, /^PUT \/file-abc123 HTTP\/1\.1\r\n/);
  assert.ok(!raw.includes('Signature'), `the pre-signed credential crossed the seam:\n${raw}`);
});

test('upload: an XHR whose attachment could not be examined aborts rather than uploading a placeholder', async () => {
  const { sandbox, logs } = makeXhrWorld(() => {
    const v = rebuiltVerdict(
      ['PUT /file-abc123 HTTP/1.1', 'Host: files.oaiusercontent.com', 'content-type: image/png'],
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
    v.receipt.unchecked = false;
    v.receipt.unscreened = [pngUnscreened];
    return v;
  });

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('PUT', STORAGE_PUT, true);
  xhr.setRequestHeader('Content-Type', 'image/png');
  xhr.send('realbytes');

  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, [], 'no placeholder was uploaded');
  assert.deepEqual(xhr.events, ['error', 'loadend'], 'and the page was told, not left waiting');
  assertBlocked(logs, 'upload-withheld', 'unsupported');
});

test('upload: an XHR to an ordinary third-party host is untouched', async () => {
  const { sandbox, logs } = makeXhrWorld(() => allowVerdict);
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://o123.ingest.sentry.io/api/1/envelope/', true);
  xhr.send('{"event":1}');
  assert.deepEqual(xhr.sent, ['{"event":1}']);
  assert.equal(xhr.aborted, false);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

// ── frames with no url of their own ────────────────────────────────
//
// `all_frames` injects into frames whose OWN url matches `matches`. A frame
// with no matchable url — `about:blank`, `about:srcdoc`, `blob:` — got no
// hooks at all, so a page could reach a pristine `fetch` through one. The
// manifest now declares `match_origin_as_fallback` / `match_about_blank`, and
// these tests pin what the shim must do once it IS injected there: resolve the
// request against the base the frame inherited from its creator, and recognise
// that creator as the AI surface it is.

// A frame whose location has an opaque path. `document` exists only in these
// worlds — every other test in this file leaves it undefined, which exercises
// the shim's guard for a realm that has none.
//
// The two origins are separate facts and the enforce channel depends on the
// pair, so each caller states both (measured in a browser, not assumed):
//   `origin`         what `location.origin` reads — the origin of the frame's
//                    URL. 'null' for `about:blank`, `about:srcdoc` and `data:`;
//                    the creator's real origin for `blob:`.
//   `documentOrigin` the origin the frame's DOCUMENT actually has, which is
//                    what postMessage judges a targetOrigin against. Inherited
//                    from the creator for `about:blank` / `about:srcdoc` /
//                    `blob:`; opaque ('null') for `data:` and for anything
//                    sandboxed without `allow-same-origin`.
function makeFrameWorld(onCapture, href, baseURI, { origin = 'null', documentOrigin = 'null', ...extra } = {}) {
  return makeWorld(onCapture, {
    location: { href, origin },
    document: { baseURI },
    ...extra
  }, { documentOrigin });
}

test('frame: an about:blank child of an AI page screens its relative requests', async () => {
  const captured = [];
  const { sandbox } = makeFrameWorld(
    (msg) => { captured.push(msg.requestB64); return allowVerdict; },
    'about:blank',
    'https://chat.openai.com/c/abc',
    { documentOrigin: 'https://chat.openai.com' }
  );

  // `location.href` is `about:blank`, which cannot serve as a base — so this
  // used to resolve to nothing and fail closed as `scope-unresolvable`. The
  // browser resolves it against the inherited base, and so must we.
  await sandbox.fetch('/backend-api/conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"prompt":"secret"}'
  });

  assert.equal(captured.length, 1, 'the request must be held and screened, not guessed at');
  const { head } = splitRaw(rawOf(captured[0]));
  assert.match(head, /^POST \/backend-api\/conversation HTTP\/1\.1\r\nHost: chat\.openai\.com\r\n/);
});

test('frame: an about:srcdoc child counts as its creator for the upload scope', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeFrameWorld(
    (msg) => { captured.push(msg.requestB64); return allowVerdict; },
    'about:srcdoc',
    'https://chat.openai.com/',
    { documentOrigin: 'https://chat.openai.com' }
  );

  // The cross-origin upload scope is bounded by the INITIATOR. A frame with no
  // host of its own has no initiator to read off `location`, so this path was
  // dead in exactly the frames an upload widget is most likely to live in.
  await sandbox.fetch('https://storage.example.com/bucket/key?X-Amz-Signature=abc', {
    method: 'PUT',
    body: 'curriculum vitae'
  });

  assert.equal(captured.length, 1, 'a cross-origin PUT from an AI-created frame is held');
  const { head } = splitRaw(rawOf(captured[0]));
  assert.match(head, /^PUT \/bucket\/key HTTP\/1\.1\r\n/, 'and its pre-signed credential is dropped');
  assert.equal(netCalls.length, 1);
});

test('frame: a blob: frame reads its creator off its own url', async () => {
  const captured = [];
  const { sandbox } = makeFrameWorld(
    (msg) => { captured.push(msg.requestB64); return allowVerdict; },
    'blob:https://chat.openai.com/8f3c-uuid',
    'blob:https://chat.openai.com/8f3c-uuid',
    // A blob: URL's origin IS the creating origin, on the location and on the
    // document alike — the one frame here whose channel was never broken.
    { origin: 'https://chat.openai.com', documentOrigin: 'https://chat.openai.com' }
  );

  await sandbox.fetch('https://storage.example.com/bucket/key', {
    method: 'PUT',
    body: 'attachment bytes'
  });

  assert.equal(captured.length, 1, 'blob: has no hostname but its origin still names the creator');
});

// ── the channel back out of an opaque-origin frame ─────────────────
//
// Injecting into these frames is only half the job: the shim has to be able to
// ASK. The capture goes out on `window.postMessage`, and the targetOrigin it
// used to pass — `location.origin` — is unusable in exactly the frames the
// manifest widened injection into. Two distinct failures, both fatal and
// neither reported as itself:
//   'null' (an opaque-origin frame's `location.origin`) is truthy, so the old
//     `|| '*'` never fired, and it is not a parseable URL, so postMessage
//     threw and every held request blocked as `verdict-channel-failed` —
//     advising a reload of a frame whose origin is opaque by construction;
//   a real origin string on a SANDBOXED frame parses fine and matches nothing,
//     because the document's origin is opaque, so the message vanished and the
//     request blocked 45 s later as `verdict-timeout`, blaming a desktop app
//     that had answered nothing because it was never asked.

test('frame: a data: frame’s opaque origin no longer kills the verdict channel', async () => {
  const captured = [];
  // Both origins opaque — the case where nothing about the frame can supply a
  // usable targetOrigin, and the only correct answer is not to name one.
  const { sandbox, netCalls, logs } = makeFrameWorld(
    (msg) => { captured.push(msg.requestB64); return allowVerdict; },
    'data:text/html,<script>fetch(…)</script>',
    'data:text/html,<script>fetch(…)</script>',
    { origin: 'null', documentOrigin: 'null' }
  );

  await sandbox.fetch(AI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"prompt":"secret"}'
  });

  assert.equal(captured.length, 1, 'the request is held and screened');
  assert.equal(netCalls.length, 1, 'and the verdict releases it');
  assert.ok(!findLine(logs, 'verdict-channel-failed'),
    'an opaque origin is not a dead channel — there was nobody to reload');
});

test('frame: a sandboxed frame’s real-looking origin does not swallow the verdict', async () => {
  // The subcase that predates `match_about_blank`: a `sandbox="allow-scripts"`
  // frame pointed at a catalog URL is injected by plain `all_frames`. Its
  // `location.origin` is the REAL origin, so nothing throws — the message is
  // just never delivered, and the old code had no way to notice.
  const captured = [];
  const { sandbox, netCalls, logs, deliver } = makeFrameWorld(
    (msg) => { captured.push(msg.requestB64); return allowVerdict; },
    'https://chat.openai.com/c/abc',
    'https://chat.openai.com/c/abc',
    { origin: 'https://chat.openai.com', documentOrigin: 'null' }
  );
  // So the regression this pins fails in a second rather than in 45.
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 1000 } });

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"prompt":"secret"}' });

  assert.equal(captured.length, 1, 'the request is held and screened');
  assert.equal(netCalls.length, 1, 'and the verdict releases it');
  assert.ok(!findLine(logs, 'verdict-timeout'),
    'a dropped message must not read as a screener that never answered');
});

test('frame: a data: frame gets the host scope and no upload scope', async () => {
  // What such a frame does NOT get, stated where it can be checked. `data:`
  // documents do not inherit their creator's base URL the way `about:blank`
  // and `about:srcdoc` do — `document.baseURI` is the data: URL itself — so
  // PAGE_HOST is '' and the initiator-scoped upload path cannot fire there.
  // The AI-host scope still does, because it reads the REQUEST's host.
  const captured = [];
  const { sandbox, netCalls, logs } = makeFrameWorld((msg) => {
    captured.push(msg.requestB64);
    return allowVerdict;
  }, 'data:text/html,<p>x', 'data:text/html,<p>x', {
    origin: 'null', documentOrigin: 'null', SONOMOS_DEBUG: true
  });

  await sandbox.fetch('https://storage.example.com/bucket/key?X-Amz-Signature=abc', {
    method: 'PUT',
    body: 'curriculum vitae'
  });

  assert.equal(captured.length, 0, 'no initiator to scope an upload on');
  assert.equal(netCalls.length, 1, 'so it goes out untouched');
  assertReason(logs, 'not-in-scope', 'debug');
});

test('frame: a frame created by a NON-catalog page gets no upload scope', async () => {
  // The direction that would be worse: inheriting a base must not turn every
  // opaque frame into an AI surface.
  const captured = [];
  const { sandbox, netCalls, logs } = makeDebugWorld((msg) => {
    captured.push(msg.requestB64);
    return allowVerdict;
  }, {
    location: { href: 'about:blank', origin: 'null' },
    document: { baseURI: 'https://example.com/embed' }
  });

  await sandbox.fetch('https://storage.example.com/bucket/key', {
    method: 'PUT',
    body: 'somebody else’s file'
  });

  assert.equal(captured.length, 0, 'nothing was held');
  assert.equal(netCalls.length, 1, 'and it went out untouched');
  assertReason(logs, 'not-in-scope', 'debug');
});

test('frame: a <base> tag cannot move an ordinary page out of scope', async () => {
  // `location.href` is tried FIRST and the fallback only runs when it throws.
  // A page that points `<base>` somewhere else keeps being scoped by its
  // location — the more closed reading of the two.
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; }, {
    document: { baseURI: 'https://evil.example/' }
  });

  await sandbox.fetch('/backend-api/conversation', { method: 'POST', body: '{"prompt":"x"}' });

  assert.equal(captured.length, 1, 'still held');
  const { head } = splitRaw(rawOf(captured[0]));
  assert.match(head, /\r\nHost: chat\.openai\.com\r\n/, 'and still scoped by the location');
});

// ── the catalog's host rule, driven through the real shim ──────────
//
// `isAiHost` is an inline copy of the shared host rule, so it is
// pinned here the way the browser exercises it: by whether a bodied request to
// each spelling is actually HELD. shared/constants.js `hostMatches` is the
// same rule as a function, and tests/constants.test.js pins that; this is the
// half that proves the shim's copy has not drifted from it.

async function heldSpelling(host) {
  let held = false;
  const { sandbox } = makeWorld(() => { held = true; return allowVerdict; });
  try {
    await sandbox.fetch(`https://${host}/backend-api/conversation`, {
      method: 'POST',
      body: '{"prompt":"x"}'
    });
  } catch { /* a block still counts as "in scope" — held is what we assert */ }
  return held;
}

test('scope: every catalog spelling of a surface is held', async () => {
  // SONOMOS_WEB_HOSTS in this harness is ['chat.openai.com', 'chatgpt.com'].
  for (const spelling of [
    'chat.openai.com',
    'CHAT.OpenAI.COM',      // case-insensitive, both sides
    'chat.openai.com.',     // the absolute spelling is the same host
    'www.chatgpt.com',      // a subdomain is the same surface
    'deep.nested.chatgpt.com'
  ]) {
    assert.equal(await heldSpelling(spelling), true, `${spelling} must be held`);
  }
});

test('scope: a host the catalog does not name is never held', async () => {
  for (const stranger of [
    'notchatgpt.com',                 // the prefix trick the dot boundary stops
    'chatgpt.com.evil.example',       // a suffix, not a parent
    'openai.com',                     // a parent of an entry is not an entry
    'example.com'
  ]) {
    assert.equal(await heldSpelling(stranger), false, `${stranger} must NOT be held`);
  }
});

// ── fetchLater(): the sendBeacon hole, one API later ───────────────
//
// The Deferred Fetch API queues a request the page need not stay alive for.
// It answers synchronously, the browser sends on its own schedule and the
// response is discarded — so there is no point at which a verdict could be
// applied. Unholdable and in scope is the same thing as unscreenable, and gets
// the same answer the beacon gets: refuse it.

function makeFetchLaterWorld(extraGlobals = {}) {
  const laterCalls = [];
  const world = makeDebugWorld(() => allowVerdict, {
    fetchLater: (...args) => { laterCalls.push(args); return { activated: false }; },
    ...extraGlobals
  });
  return { ...world, laterCalls };
}

test('fetchLater: an in-scope deferred fetch carrying data is refused', () => {
  const { sandbox, laterCalls, logs } = makeFetchLaterWorld();

  assert.throws(
    () => sandbox.fetchLater(AI_URL, { method: 'POST', body: '{"prompt":"my ssn is …"}' }),
    blockedError,
    'the queue must be refused, never silently accepted'
  );
  assert.equal(laterCalls.length, 0, 'nothing was queued');
  assertBlocked(logs, 'uncapturable-deferred-fetch', 'unsupported');
});

test('fetchLater: the refusal says which transport, not what was in it', () => {
  const { sandbox, logs } = makeFetchLaterWorld();
  try {
    sandbox.fetchLater(`${AI_URL}?q=my-secret-prompt`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-live-secret' },
      body: 'patient name: Jane Roe'
    });
  } catch { /* expected */ }
  const line = assertBlocked(logs, 'uncapturable-deferred-fetch', 'unsupported');
  assert.match(line, /\bvia=fetch-later\b/);
  assert.doesNotMatch(line, /Jane Roe|sk-live-secret|my-secret-prompt/,
    'no body, header value or query string may reach the console');
});

// The beacon hook's defect, one API later: scope here is the catalog
// MINUS the user's own disable set, not the bare catalog.
test('fetchLater: a deferred fetch to a surface the user switched off is delegated', () => {
  const { sandbox, laterCalls, deliver } = makeFetchLaterWorld();
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });
  sandbox.fetchLater(AI_URL, { method: 'POST', body: '{"q":1}' });
  assert.equal(laterCalls.length, 1, 'the user turned this surface off');
});

test('fetchLater: a bodyless deferred fetch is delegated untouched', () => {
  const { sandbox, laterCalls } = makeFetchLaterWorld();
  const result = sandbox.fetchLater(AI_URL, { method: 'POST' });
  assert.equal(laterCalls.length, 1, 'nothing to scan → not ours to refuse');
  assert.equal(result.activated, false, 'and the real FetchLaterResult comes back');
});

test('fetchLater: a deferred fetch to a host we do not cover is delegated untouched', () => {
  const { sandbox, laterCalls } = makeFetchLaterWorld();
  sandbox.fetchLater('https://telemetry.example.com/collect', {
    method: 'POST',
    body: 'page=chat&ms=120'
  });
  assert.equal(laterCalls.length, 1);
});

test('fetchLater: a cross-origin object write from an AI page is refused too', () => {
  // Unlike a beacon — which is always a POST and cannot carry a request
  // header — a deferred fetch can be a PUT, so the initiator-scoped upload
  // path is meaningful here and is applied.
  const { sandbox, laterCalls, logs } = makeFetchLaterWorld();
  assert.throws(
    () => sandbox.fetchLater('https://storage.example.com/bucket/key?X-Amz-Signature=abc', {
      method: 'PUT',
      body: 'curriculum vitae'
    }),
    blockedError
  );
  assert.equal(laterCalls.length, 0);
  const line = assertBlocked(logs, 'uncapturable-deferred-fetch', 'unsupported');
  assert.match(line, /\bscope=upload\b/);
  assert.doesNotMatch(line, /bucket|key|Signature/, 'the object key is the user’s filename');
});

test('fetchLater: an ordinary third-party POST is NOT refused — the false-positive floor', () => {
  // The upload predicate is conjunctive and narrow on purpose. Refusing every
  // third-party POST an AI page makes would break the page for no gain.
  const { sandbox, laterCalls } = makeFetchLaterWorld();
  sandbox.fetchLater('https://analytics.example.com/e', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: '{"event":"send_clicked"}'
  });
  assert.equal(laterCalls.length, 1, 'analytics is not an object write');
});

test('fetchLater: a bodied deferred fetch we cannot even address is refused', () => {
  const { sandbox, laterCalls, logs } = makeFetchLaterWorld();
  assert.throws(
    () => sandbox.fetchLater(unresolvable(), { method: 'POST', body: 'data' }),
    blockedError
  );
  assert.equal(laterCalls.length, 0);
  assertBlocked(logs, 'scope-unresolvable', 'unsupported');
});

test('fetchLater: a page without the API is left alone', () => {
  // The hook must not conjure the API where the browser has none — a page
  // feature-detecting `window.fetchLater` would then take a path it cannot
  // complete.
  const { sandbox } = makeWorld(() => allowVerdict);
  assert.equal(sandbox.fetchLater, undefined);
});

// ── surfaces the user switched off ─────────────────────────────────
//
// The desktop app's subtractive override, arriving as SONOMOS_CONFIG (native
// messaging host → service worker → content script). The host's half of that
// exchange lives with the Locke desktop app, not in this repository.

test('a disabled surface passes through untouched instead of being screened', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; });

  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false, 'a surface the user switched off must not be held or screened');
  assert.equal(netCalls.length, 1, 'the original request goes out untouched');
});

test('a surface that is still on is screened exactly as before', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; });

  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['perplexity.ai'] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true, 'disabling one surface must not disable the rest');
});

test('disabling a parent covers its subdomains, matching the catalog host rule', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; });

  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['openai.com'] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false, 'chat.openai.com is below openai.com');
  assert.equal(netCalls.length, 1);
});

test('an empty array is a real answer and puts the surface back in scope', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; });

  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: [] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

test('a config without the key leaves an applied set alone', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; });

  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });
  // A push whose storage read failed carries only the other knobs. It must not
  // read as "nothing is disabled" and quietly re-scope a surface.
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 30000 } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false);
});

test('the set is subtractive: no config can put a non-catalog host in scope', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; });

  // Whatever a page or a rogue file puts here, scope is still AI_HOSTS minus
  // the set — never plus anything.
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['example.com', 'not-a-host', 42] } });
  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  assert.equal(meshAsked, false);
  assert.equal(netCalls.length, 1);

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  assert.equal(meshAsked, true, 'a catalog host absent from the set stays screened');
});

test('until config arrives every catalog surface is screened', async () => {
  let meshAsked = false;
  const { sandbox } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {}, { settleConfig: false });

  // No SONOMOS_CONFIG delivered at all — the fully-screening state.
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

// ── the page-start race for the disable set ────────────────────────
//
// The shim installs at document_start; the config cannot arrive until the
// isolated world has read storage. Everything below is about the requests a
// page fires in that gap, where "is this surface off?" has no answer yet.

test('a request made before the config lands passes through once the surface turns out to be off', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {}, { settleConfig: false });

  // The page's first request, issued with disabledHosts still empty — the
  // moment at which a switched-off surface used to be held and screened, and
  // blocked outright whenever the desktop app was down.
  const inFlight = sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });
  await inFlight;

  assert.equal(meshAsked, false, 'a surface the user switched off is never asked about, however early the request');
  assert.equal(netCalls.length, 1, 'the original request goes out untouched');
  assert.equal(netCalls[0][1].body, '{"q":1}', 'and with the body the page wrote');
});

test('a request made before the config lands is screened when the surface is still on', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {}, { settleConfig: false });

  const inFlight = sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['perplexity.ai'] } });
  await inFlight;

  assert.equal(meshAsked, true, 'waiting for the answer must not become a way of skipping the screen');
  assert.equal(netCalls.length, 1, 'released because the verdict said allow');
});

test('a config that never lands still screens: the wait fails closed', async () => {
  let meshAsked = false;
  const { sandbox, netCalls } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {}, { settleConfig: false });

  // Nothing ever delivers SONOMOS_CONFIG — a torn-down isolated world, a
  // storage read that never answers. Running out the wait must resolve to "in
  // scope", never to "send it unscreened", and must not hang the page either.
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true, 'no answer about the disable set is not permission to skip screening');
  assert.equal(netCalls.length, 1);
});

test('XHR: a send made before the config lands is released when the surface is off', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeXhrWorld(() => { meshAsked = true; return allowVerdict; }, { settleConfig: false });

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['chat.openai.com'] } });

  await waitFor(() => xhr.sent.length === 1);
  assert.equal(meshAsked, false);
  assert.deepEqual(xhr.sent, ['{"q":"hi"}'], 'the held body is released exactly as the page wrote it');
  assert.equal(xhr.aborted, false);
});

test('an out-of-scope host never waits for the config', async () => {
  let meshAsked = false;
  const { sandbox, netCalls } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {}, { settleConfig: false });

  // The disable set is subtractive, so it can never say anything about a host
  // the catalog does not name. Waiting on it here would put a page-start pause
  // on every third-party request an AI page makes.
  const before = Date.now();
  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  const outOfScopeMs = Date.now() - before;

  assert.equal(netCalls.length, 1, 'released immediately, untouched');
  assert.equal(meshAsked, false);
  assert.ok(outOfScopeMs < 100, `out-of-scope request must not wait on config (took ${outOfScopeMs}ms)`);

  // The same world, same missing config: a catalog host DOES wait, which is
  // what makes the line above an assertion about scope rather than about a
  // wait that never happens.
  const inScopeAt = Date.now();
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  const inScopeMs = Date.now() - inScopeAt;

  assert.equal(meshAsked, true);
  assert.ok(inScopeMs > outOfScopeMs, `an in-scope request waits for the first config (took ${inScopeMs}ms)`);
});

// ── which surface a capture is attributed to ────────────────────────────
//
// The catalog id travels with the capture so the desktop app can say WHERE
// PII was caught. Without it every browser capture reaches the Dashboard
// unattributed and renders as "unknown" — which is what Gemini did.

test('provider: a capture names the catalog id of the host it is going to', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; });

  await sandbox.fetch(AI_URL, { method: 'POST', body: 'ssn 123-45-6789' });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].provider, 'openai');
});

test('provider: a subdomain is attributed to the entry it belongs to', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; });

  await sandbox.fetch('https://deep.nested.chatgpt.com/api/x', {
    method: 'POST',
    body: 'ssn 123-45-6789'
  });

  assert.equal(captured[0].provider, 'openai');
});

// One company owns several surfaces, and the catalog lists them separately
// (`www.google.com` is search; `gemini.google.com` is the assistant). A
// shortest-match rule would file Gemini under whichever entry iterated first.
test('provider: the most specific catalog entry wins', async () => {
  const captured = [];
  const { sandbox } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    {
      location: {
        href: 'https://gemini.google.com/app',
        origin: 'https://gemini.google.com',
        hostname: 'gemini.google.com'
      },
      SONOMOS_WEB_HOSTS: ['www.google.com', 'gemini.google.com'],
      SONOMOS_WEB_PROVIDERS: {
        'www.google.com': 'search',
        'gemini.google.com': 'google'
      }
    }
  );

  await sandbox.fetch('https://gemini.google.com/_/BardChatUi/data/x', {
    method: 'POST',
    body: 'ssn 123-45-6789'
  });

  assert.equal(captured.length, 1, 'the Gemini prompt reached the desktop app');
  assert.equal(captured[0].provider, 'google', 'Gemini is not Google Search');
});

// The upload scope PUTs to object storage, which is in nobody's catalog. The
// page we are running in is the surface the user is actually sending to, so
// the attachment lands on the same row as the prompt it went with.
test('provider: a cross-origin upload is attributed to the page it came from', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; });

  await sandbox.fetch(STORAGE_PUT, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: Uint8Array.from([0x25, 0x50, 0x44, 0x46])
  });

  assert.equal(captured.length, 1, 'the attachment reached the desktop app');
  assert.equal(captured[0].provider, 'openai');
});

// A build whose generated globals predate the map must still capture — it just
// cannot say where from. Claiming a provider it does not know would put a
// guess into the user's evidence; absence renders as "unknown", which is true.
test('provider: none is claimed when the generated map is missing', async () => {
  const captured = [];
  const { sandbox } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { SONOMOS_WEB_PROVIDERS: undefined }
  );

  await sandbox.fetch(AI_URL, { method: 'POST', body: 'ssn 123-45-6789' });

  assert.equal(captured.length, 1, 'screening is unaffected');
  assert.equal(captured[0].provider, null);
});

// ── path scoping ──────────────────────────────────────────────────────────
//
// The outage these pin: with chatgpt.com injected but unscoped, the shim held
// EVERY request on the host. `/unauth-mweb/sentinel/chat-requirements/finalize`
// carries an opaque proof-of-work payload that cannot be examined, so it
// failed closed, ChatGPT never got its chat-requirements token, and the site
// reported itself unreachable — while the popup still read "Connected".
//
// Both directions matter. A change that stops holding the conversation POST is
// a silent PII leak; a change that starts holding sentinel is an outage.

const CHATGPT_PATHS = {
  SONOMOS_CAPTURE_PATHS: {
    'chatgpt.com': [
      '/backend-api/conversation',
      '/backend-api/f/conversation',
      '/backend-anon/conversation',
      '/backend-anon/f/conversation'
    ]
  },
  SONOMOS_SKIP_PATH_SEGMENTS: [['event_logging'], ['telemetry'], ['v1', 'models']]
};

test('paths: the prompt POST on a narrowed host is still held', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);

  for (const path of ['/backend-api/conversation', '/backend-api/f/conversation',
                      '/backend-anon/conversation', '/backend-anon/f/conversation']) {
    await sandbox.fetch(`https://chatgpt.com${path}`, { method: 'POST', body: '{"prompt":"hi"}' });
  }
  assert.equal(captured.length, 4, 'every prompt-bearing path must still be screened');
});

test('paths: sentinel, sign-in and settings on a narrowed host are NOT held', async () => {
  let meshAsked = false;
  const { sandbox, netCalls } = makeWorld(() => { meshAsked = true; return allowVerdict; }, CHATGPT_PATHS);

  const untouched = [
    '/unauth-mweb/sentinel/chat-requirements/finalize',
    '/unauth-mweb/sentinel/chat-requirements/prepare',
    '/api/auth/session',
    '/backend-api/me',
    '/backend-api/settings/user',
    '/unauth-mweb/events/performance'
  ];
  for (const path of untouched) {
    await sandbox.fetch(`https://chatgpt.com${path}`, { method: 'POST', body: '{}' });
  }
  assert.equal(meshAsked, false, 'holding any of these is what broke the site');
  assert.equal(netCalls.length, untouched.length, 'each must reach the network untouched');
});

test('paths: a pattern never acts as a prefix', async () => {
  let meshAsked = false;
  const { sandbox } = makeWorld(() => { meshAsked = true; return allowVerdict; }, CHATGPT_PATHS);
  // 3-segment reads and side-ops sit beside the 2-segment prompt POST. Equal
  // segment counts are the only thing keeping them out.
  for (const path of ['/backend-api/conversation/abc123',
                      '/backend-api/conversation/gen_title/abc123',
                      '/backend-api/conversation/message_feedback']) {
    await sandbox.fetch(`https://chatgpt.com${path}`, { method: 'POST', body: '{}' });
  }
  assert.equal(meshAsked, false, 'a longer path must not be admitted by a shorter pattern');
});

test('paths: a host with no allow-list keeps capture-everything', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);
  // chat.openai.com is in the harness host list and is NOT narrowed. Absence of
  // an allow-list must never quietly stop screening a surface nobody narrowed.
  await sandbox.fetch('https://chat.openai.com/anything/at/all', { method: 'POST', body: '{"a":1}' });
  assert.equal(captured.length, 1);
});

test('paths: the deny-list still wins inside an allow-list', async () => {
  let meshAsked = false;
  const { sandbox } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {
    SONOMOS_CAPTURE_PATHS: { 'chatgpt.com': ['/telemetry/conversation'] },
    SONOMOS_SKIP_PATH_SEGMENTS: [['telemetry']]
  });
  // A provider must not be able to re-admit telemetry by naming it.
  await sandbox.fetch('https://chatgpt.com/telemetry/conversation', { method: 'POST', body: '{}' });
  assert.equal(meshAsked, false, 'skip_path_segments is a floor no per-provider data can lift');
});

test('paths: a subdomain inherits the narrowing of its apex', async () => {
  let meshAsked = false;
  const { sandbox } = makeWorld(() => { meshAsked = true; return allowVerdict; }, CHATGPT_PATHS);
  // Or the narrowing is dodged by spelling, which is how a captured surface
  // turns into an uncaptured one.
  await sandbox.fetch('https://ab.chatgpt.com/api/auth/session', { method: 'POST', body: '{}' });
  assert.equal(meshAsked, false);
});
