// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { DEFAULTS } from '../shared/constants.js';
import {
  RELAY_FAILURES_PROVING_NO_SCREEN,
  RELAY_FAILURES_PROVING_NO_VERDICT
} from '../shared/screening.js';

// content/shim.js is a MAIN-world classic script (no exports), so we test it
// the way the browser runs it: evaluate the real source inside a vm context
// that stands in for the page — location, the generated host list, the
// original fetch (our fake "network"), and the postMessage channel the
// content script would answer on. The `onCapture` callback stands in for the
// Locke desktop app: it receives { requestB64 } and returns the SW-shaped
// verdict { ok, receipt } (or null), which we deliver back as SONOMOS_VERDICT.

const SHIM_SRC = await readFile(new URL('../content/shim.js', import.meta.url), 'utf8');

const AI_URL = 'https://chat.openai.com/backend-api/conversation';
// A ChatGPT-web turn the fail-open rule recognises (zh#370: default deny).
const CHAT_JSON = JSON.stringify({ messages: [{ content: { content_type: 'text', parts: ['hi'] } }] });
const CHAT_INIT = { method: 'POST', headers: { 'content-type': 'application/json' }, body: CHAT_JSON };

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
  const unchecked = [];  // SONOMOS_UNCHECKED tallies the shim posted
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
    // A top-level window is its own `top`. The shim reads this to tell a frame
    // from a page where `location.ancestorOrigins` is absent (Firefox); a test
    // that wants a frame overrides it through `extraGlobals`.
    get top() { return innerWindow; },
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
      if (data && data.type === 'SONOMOS_UNCHECKED') { unchecked.push(data.cause); return; }
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
  return { sandbox, netCalls, logs, deliver, unchecked };
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
  // allow → the call is released with exactly the bytes that were screened,
  // and nothing else about it changes.
  assert.equal(res.__net, true);
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], `${AI_URL}?x=1`);
  assert.equal(netCalls[0][1].method, 'POST');
  assert.equal(Buffer.from(netCalls[0][1].body).toString('utf8'), body);
  assert.equal(netCalls[0][1].headers.get('authorization'), 'Bearer t');
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
  // allow → the serialization that was screened is the one that goes out,
  // under the boundary it was screened with. Handing the FormData object back
  // to fetch would re-serialize it under a FRESH boundary, from whatever the
  // object holds by then — a second, unscreened say in what leaves.
  assert.equal(netCalls.length, 1);
  assert.deepEqual(Buffer.from(netCalls[0][1].body), body);
  assert.ok(
    head.toLowerCase().includes(`content-type: ${netCalls[0][1].headers.get('content-type')}`),
    'the released Content-Type is the screened one'
  );
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
  // A Request input is released as a Request — the constructor carries the
  // page's method, url, credentials, mode and signal across — rebuilt around
  // the screened bytes rather than around headers the page can still write to.
  const [released] = netCalls[0];
  assert.ok(released instanceof Request, 'the Request branch releases a Request');
  assert.equal(released.url, req.url);
  assert.equal(released.method, 'POST');
  assert.equal(released.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await released.arrayBuffer()), bytes);
});

// Firefox has no `Request.prototype.body`: it reads undefined for every
// Request. Gemini web posts each prompt as fetch(new Request(url, {method:
// 'POST', body})), so the shim read "no body" and let every prompt through.
// Simulate Firefox by removing the accessor from Request.prototype for the
// duration of one test.
async function asFirefox(fn) {
  const desc = Object.getOwnPropertyDescriptor(Request.prototype, 'body');
  delete Request.prototype.body;
  try { return await fn(); } finally { Object.defineProperty(Request.prototype, 'body', desc); }
}

test('Firefox: a Request-object body (no Request.body) is still screened', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  await asFirefox(async () => {
    const req = new Request(AI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'f.req=my+name+is+paul+revere'
    });
    assert.equal('body' in req, false, 'simulating a Request without .body');
    await sandbox.fetch(req);
  });
  assert.equal(captured.length, 1, 'the prompt must reach the screener');
  assert.equal(splitRaw(rawOf(captured[0])).body.toString(), 'f.req=my+name+is+paul+revere');
});

test('Firefox: a bodyless POST Request still goes out untouched', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  await asFirefox(() => sandbox.fetch(new Request(AI_URL, { method: 'POST' })));
  assert.equal(captured.length, 0);
  assert.equal(netCalls.length, 1);
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

test('redact: fetch(Request, init) resends with init honoured, not dropped', async () => {
  // fetch(new Request(url), { method: 'POST', body }) is a legal call shape:
  // init overrides the Request. The resend used to rebuild from the Request
  // alone, producing a GET with a body — a TypeError thrown outside the
  // hook's try/catch, so nothing named the block — and even when it did not
  // throw, the page's credentials/mode/signal were lost on the resend.
  const rebuiltBody = Buffer.from('{"prompt":"[REDACTED]"}');
  const { sandbox, netCalls } = makeWorld(() => rebuiltVerdict(
    ['POST /backend-api/conversation HTTP/1.1', 'Host: chat.openai.com', 'content-type: application/json'],
    rebuiltBody
  ));

  const req = new sandbox.Request(AI_URL);
  await sandbox.fetch(req, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: '{"prompt":"ssn 123-45-6789"}'
  });

  assert.equal(netCalls.length, 1);
  const [resent] = netCalls[0];
  assert.ok(resent instanceof sandbox.Request, 'the Request branch resends a Request');
  assert.equal(resent.method, 'POST');
  assert.equal(resent.credentials, 'include', 'init fields survive the resend');
  assert.equal(resent.headers.get('authorization'), 'Bearer t');
  assert.deepEqual(Buffer.from(await resent.arrayBuffer()), rebuiltBody, 'with the rebuilt body');
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
      // Must NOT claim the desktop app itself could not be reached, and since
      // the host could not connect to Locke's screening service it must NOT
      // claim the desktop app ANSWERED either (that is `bridge-dropped`).
      assert.ok(!/desktop app could not be reached/.test(e.message), e.message);
      assert.doesNotMatch(e.message, /answered/);
      assert.match(e.message, /connector could not connect to Locke’s screening service/);
      assert.match(e.message, /nothing was sent/);
      assert.match(e.message, /NOT a sensitive-data block/);
      assert.match(e.message, /\bkind=unavailable\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0);
  const line = assertBlocked(logs, 'bridge-unreachable', 'unavailable');
  assert.match(line, /\bcode=bridge-unreachable\b/);
});

// Sonomos's own sites are never held: with Locke off, blocking them blocked
// Clerk's sign-in, which is how the user gets Locke working again.
test('Sonomos hosts (*.sonomos.ai) go out untouched even when Locke is unreachable', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => {
    captured.push(msg);
    return { ok: false, code: 'bridge-unreachable', message: 'no socket' };
  });
  for (const url of [
    'https://clerk.sonomos.ai/v1/client/sign_ins',
    'https://accounts.sonomos.ai/sign-in',
    'https://sonomos.ai/contact',
  ]) {
    await sandbox.fetch(url, { method: 'POST', body: 'identifier=jane%40example.com' });
  }
  assert.equal(captured.length, 0, 'never sent for screening');
  assert.equal(netCalls.length, 3, 'all three went out');
});

test('a look-alike host (notsonomos.ai, sonomos.ai.evil.com) is still held', async () => {
  const { sandbox, netCalls } = makeWorld(() => ({ ok: false, code: 'bridge-unreachable', message: 'no socket' }));
  for (const url of ['https://notsonomos.ai/x', 'https://sonomos.ai.evil.com/x']) {
    await assert.rejects(sandbox.fetch(url, { method: 'POST', body: 'x' }), blockedError);
  }
  assert.equal(netCalls.length, 0);
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

test('a page override of Request.clone cannot alter the private snapshot', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld(msg => {
    captured.push(msg.requestB64);
    return allowVerdict;
  });
  const request = new Request(AI_URL, { method: 'POST', body: 'approved' });
  request.clone = () => { throw new Error('page clone override'); };

  await sandbox.fetch(request);

  const sent = await sentFetch(netCalls[0]);
  assert.equal(sent.bytes.toString(), 'approved');
  assert.deepEqual(sent.bytes, splitRaw(rawOf(captured[0])).body);
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
const DEFAULT_ENFORCE_CEILING_MS = 200_000;

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
  const { sandbox, netCalls, logs, deliver } = makeDebugWorld(() => { meshAsked = true; return allowVerdict; });
  // Out of scope now means a host the user switched off: every other host is
  // held for the classifier.
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['example.com'] } });

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

function makeXhrWorld(onCapture, { headerSetThrows = false, settleConfig = true, extraGlobals = {} } = {}) {
  // Minimal XHR stand-in installed BEFORE the shim runs, so the shim wraps
  // its prototype exactly as it would the real one. `dispatchEvent` records
  // what the page would have observed: a real XHR whose send() was never
  // forwarded fires nothing on abort(), so the shim raises the failure itself.
  class FakeXHR {
    constructor() {
      this.sent = []; this.setHeaders = []; this.aborted = false; this.events = [];
      // UNSENT. A real XHR carries this on the prototype as an accessor; the
      // instance field here is the same observable, and it lets the test see
      // whether the shim moved it. `eventStates` records what a handler would
      // have READ at each dispatch, which is the thing that was broken: the
      // events fired, the state they described did not exist.
      this.readyState = 0;
      this.eventStates = [];
    }
    open(method, url) { this.opened = [method, url]; this.readyState = 1; }
    setRequestHeader(name, value) {
      // A real XHR throws InvalidStateError here if the request has left the
      // OPENED state — which is exactly what defeats the rebuilt Content-Type.
      if (headerSetThrows) throw new Error('InvalidStateError');
      this.setHeaders.push([name, value]);
    }
    send(body) { this.sent.push(body); }
    abort() { this.aborted = true; }
    dispatchEvent(event) {
      this.events.push(event.type);
      this.eventStates.push(this.readyState);
      return true;
    }
  }
  return makeWorld(onCapture, { XMLHttpRequest: FakeXHR, ...extraGlobals }, { settleConfig });
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

// ── abort while we are holding the request ─────────────────────────
//
// The window between `send()` deferring and the verdict landing is the one
// place the page's own `abort()` used to do nothing at either end: the real
// abort fires no events (our wrapper never forwarded the send, so the send flag
// is unset) AND it did not stop the deferred branch, which forwarded the
// request moments later. The user pressed stop, the page reported nothing, and
// the prompt went out anyway.

test('XHR: a request the page aborts while it is held is never sent', async () => {
  let landVerdict;
  const verdict = new Promise((resolve) => { landVerdict = resolve; });
  const { sandbox, logs } = makeXhrWorld(() => verdict, { extraGlobals: { SONOMOS_DEBUG: true } });

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  xhr.abort();               // the user pressed stop while the screen was running
  landVerdict(allowVerdict); // and only then does a perfectly good verdict land

  await waitFor(() => findLine(logs, 'aborted-while-held'));
  assert.deepEqual(xhr.sent, [], 'a request the page cancelled must not be sent');
  assertReason(logs, 'aborted-while-held', 'debug');
});

test('XHR: aborting a held request completes it at DONE, and does not claim a Locke block', async () => {
  // The page is owed the completion a real abort would have given it —
  // readystatechange, abort, loadend, all observed at DONE. Not `error`, and no
  // `sonomos*` properties: this is the page's cancellation, not our refusal.
  const { sandbox } = makeXhrWorld(() => new Promise(() => {}));

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  xhr.abort();

  assert.equal(xhr.aborted, true, 'the real abort() still ran');
  assert.equal(xhr.readyState, 4);
  assert.deepEqual(xhr.events, ['readystatechange', 'abort', 'loadend']);
  assert.deepEqual(xhr.eventStates, [4, 4, 4]);
  assert.equal(xhr.sonomosBlocked, undefined, 'a cancellation is not a refusal');
});

test('XHR: an abort after the request was forwarded is the browser’s to answer', async () => {
  // Once we have handed the request on, the underlying XHR has a send flag and
  // its own abort() does the right thing. We must not synthesize a second
  // completion on top of it.
  const { sandbox } = makeXhrWorld(() => allowVerdict);

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  await waitFor(() => xhr.sent.length === 1);
  xhr.abort();

  assert.equal(xhr.aborted, true);
  assert.deepEqual(xhr.events, [], 'nothing synthesized — the browser owns this one');
});

test('XHR: a blocked request fires one completion sequence, not two', async () => {
  // blockXhr calls abort() itself, which now runs through our own wrapper. If
  // the refusal did not release the request first, the page would see the error
  // sequence and an abort sequence for the same send.
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'US SSN detected', blockCause: 'policy' } }
  ));

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.events.length >= 3);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(xhr.events, ['readystatechange', 'error', 'loadend']);
});

test('XHR: a reused object does not inherit the cancellation of the send before it', async () => {
  // `open()` is where an XHR stops describing the old request, so the abort
  // flag has to go with it — otherwise the retry a page issues on the same
  // object after cancelling is silently dropped.
  let landVerdict;
  const first = new Promise((resolve) => { landVerdict = resolve; });
  let call = 0;
  const { sandbox } = makeXhrWorld(() => (call++ === 0 ? first : allowVerdict));

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"first"}');
  xhr.abort();
  landVerdict(allowVerdict);

  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"second"}');

  await waitFor(() => xhr.sent.length === 1);
  assert.deepEqual(xhr.sent, ['{"q":"second"}'], 'only the retry goes out');
});

test('XHR: out-of-scope and bodyless sends report at debug and pass through', async () => {
  const { sandbox, logs, deliver } = makeWorld(() => allowVerdict, {
    SONOMOS_DEBUG: true,
    XMLHttpRequest: class {
      constructor() { this.sent = []; this.setHeaders = []; this.aborted = false; }
      open(method, url) { this.opened = [method, url]; }
      setRequestHeader(name, value) { this.setHeaders.push([name, value]); }
      send(body) { this.sent.push(body); }
      abort() { this.aborted = true; }
    }
  });
  deliver({ type: 'SONOMOS_CONFIG', config: { disabledWebHosts: ['example.com'] } });

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

  await sandbox.fetch(AI_URL, CHAT_INIT);

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

  await sandbox.fetch(AI_URL, CHAT_INIT);
  assert.equal(netCalls.length, 1);
  assertReason(logs, 'allow-unchecked', 'warn');
});

test('paused-by-user receipt: original is sent, debug level, not the fail-open treatment', async () => {
  const receipt = { decision: 'allow', unchecked: true, reason: 'protection paused by the user', unscreened: [] };
  const quiet = makeWorld(() => ({ ok: true, receipt }));
  await quiet.sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });
  assert.equal(quiet.netCalls.length, 1, 'original is sent');
  assert.equal(quiet.logs.length, 0, 'not LOUD: silent without debug logging');
  const { sandbox, netCalls, logs } = makeWorld(() => ({ ok: true, receipt }), { SONOMOS_DEBUG: true });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":"hi"}' });
  assert.equal(netCalls.length, 1, 'original is sent');
  const line = assertReason(logs, 'allow-paused', 'debug');
  assert.match(line, /\bbecause=user-paused\b/);
  assert.ok(!findLine(logs, 'allow-unchecked'), 'not the fail-open reason');
});

test('unchecked allow with any other reason keeps the fail-open treatment', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'allow', unchecked: true, reason: 'fail-open window', unscreened: [] }
  }));
  await sandbox.fetch(AI_URL, CHAT_INIT);
  assert.equal(netCalls.length, 1);
  assert.match(assertReason(logs, 'allow-unchecked', 'warn'), /\bbecause=user-fail-open-window\b/);
  assert.ok(!findLine(logs, 'allow-paused'));
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
      Buffer.from(CHAT_JSON.replace('hi', '[REDACTED]')),
      2
    );
    v.receipt.unchecked = true;
    v.receipt.unscreened = [pdfUnscreened];
    return v;
  });

  await sandbox.fetch(AI_URL, CHAT_INIT);
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

  await sandbox.fetch(AI_URL, CHAT_INIT);
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

// The dead channel, from the shim's side.
//
// An extension reload orphans the content script in every tab that was
// already open, so that tab relays on a channel belonging to an extension
// generation that no longer exists and blocks every in-scope request until
// the page is reloaded. The block was always right; the sentence was not.
// `verdict-missing` — what a null verdict produces, and what this used to be
// — says "the Locke extension restarted while this request was waiting.
// Reload the page and try again", which is advice that works for a sleeping
// service worker and reads as boilerplate here: nothing named the cause,
// nothing said retrying could not help, and a correct fail-closed block on a
// healthy install was indistinguishable from Locke being broken.
test('a page whose channel died with the last extension reload is told to reload it', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => (
    { ok: false, code: 'extension-reloaded', message: 'the extension was reloaded, updated or re-enabled after this page was opened' }
  ));
  await assert.rejects(
    sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }),
    (e) => {
      // The instruction, and the one word that makes it actionable: THIS
      // page. A user with several tabs open needs to know it is per-tab.
      assert.match(e.message, /[Rr]eload this page/, e.message);
      // And that retrying alone is not the fix, which is what the generic
      // sentence implied and what this user will otherwise do all afternoon.
      assert.match(e.message, /keep failing/, e.message);
      // Not a finding. The whole point of the reason vocabulary.
      assert.match(e.message, /NOT a sensitive-data block/, e.message);
      assert.match(e.message, /\bkind=unavailable\b/, e.message);
      // Nothing about the desktop app, which is not implicated and may well
      // be screening happily for every other tab — the wrong-advice shape
      // `bridge-unreachable` and `connector-not-started` were pulled out of.
      assert.ok(!/desktop app could not be reached/.test(e.message), e.message);
      assert.ok(!/[Ss]tart it/.test(e.message), e.message);
      assert.ok(!/click Allow/.test(e.message), e.message);
      return true;
    }
  );
  // The posture is unchanged: this reason exists to explain a block, never to
  // soften one.
  assert.equal(netCalls.length, 0, 'the request must still fail closed');
  assertBlocked(logs, 'extension-reloaded', 'unavailable');
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
  assert.deepEqual(xhr.events, ['readystatechange', 'error', 'loadend']);
});

// ── …and a blocked XHR must also reach DONE ─────────────────────────
//
// The event dispatch above fixed half the hang. `abort()` before `send()` was
// forwarded leaves readyState at OPENED (1), so a page whose completion signal
// is `onreadystatechange` testing `readyState === 4` — the older XHR idiom, and
// still what hand-rolled wrappers use — went on waiting through the error
// event, which it was not listening for.

test('a blocked XHR reaches DONE and says so before the error event', async () => {
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  assert.equal(xhr.readyState, 1, 'OPENED, as a real XHR is after open()');
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.events.length >= 3);
  assert.equal(xhr.readyState, 4, 'DONE — what a network-failed XHR reports');
  // Order and visible state together: `readystatechange` first, and every
  // handler — that one included — must already read 4. A state change
  // announced while the state still says OPENED is the bug with extra steps.
  assert.deepEqual(xhr.events, ['readystatechange', 'error', 'loadend']);
  assert.deepEqual(xhr.eventStates, [4, 4, 4]);
});

test('the readystatechange a blocked XHR fires is observed at DONE, with the reason set', async () => {
  // The page this whole change exists for has no `error` listener at all: its
  // only completion signal is `onreadystatechange` testing `readyState === 4`.
  //
  // WHAT THIS TEST CAN AND CANNOT SHOW, stated plainly, because the previous
  // version of it overstated. A real XMLHttpRequest invokes `onreadystatechange`
  // itself as part of dispatching the event; this fake does not implement event
  // handlers at all, so wiring the property here and calling it from a patched
  // `dispatchEvent` would be the TEST invoking the handler and then asserting
  // the handler ran. That proves nothing about the shim.
  //
  // What the shim is actually responsible for is dispatching a
  // `readystatechange` event at a point where `readyState` already reads 4 and
  // the reason is already on the object. That is what is asserted, straight off
  // the event, with no handler fabricated in between. The browser's own
  // handler-invocation is the browser's contract, not ours.
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'US SSN detected', blockCause: 'policy' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  const observed = [];
  const realDispatch = xhr.dispatchEvent.bind(xhr);
  xhr.dispatchEvent = (event) => {
    observed.push({
      type: event.type,
      readyState: xhr.readyState,
      blocked: xhr.sonomosBlocked === true
    });
    return realDispatch(event);
  };
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => observed.length >= 3);
  assert.deepEqual(
    observed[0], { type: 'readystatechange', readyState: 4, blocked: true },
    'the first event a page can see is the state change, and the state is already DONE'
  );
  assert.deepEqual(xhr.sent, [], 'and nothing was sent');
});

test('a blocked XHR still reaches DONE when its events cannot be fired', async () => {
  // An exotic XHR with no dispatchEvent: the old code returned early and left
  // readyState at OPENED, so a page polling `xhr.readyState` on a timer had no
  // signal at all. The state transition is deliberately made before the
  // dispatch guard.
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.dispatchEvent = undefined;
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.readyState === 4);
  assert.equal(xhr.readyState, 4);
  assert.deepEqual(xhr.sent, []);
});

test('the DONE state a block reports cannot be rewritten by the page', async () => {
  // Same rule as the reason properties: our account of why the request ended
  // is not something the page gets to edit into a success.
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.readyState === 4);
  try { xhr.readyState = 1; } catch { /* strict-mode assignment throws */ }
  assert.equal(xhr.readyState, 4);
  // Deliberately NOT synthesized, and this pins it: a fabricated `status` /
  // `statusText` / `responseText` would make our refusal read as a response
  // from the site's own server.
  //
  // Asserted as "the shim defined no OWN property", not as "reading it gives
  // undefined". The second is a fact about this harness — the fake XHR simply
  // has no `status` — and would keep passing if the shim started stamping
  // `status: 0` on the instance while the real XMLHttpRequest.prototype
  // accessor still answered. The own-property descriptor is the thing under
  // our control and therefore the thing worth pinning.
  for (const prop of ['status', 'statusText', 'responseText']) {
    assert.equal(
      Object.getOwnPropertyDescriptor(xhr, prop), undefined,
      `the shim must not define an own '${prop}' — that attributes our refusal to the site`
    );
  }
  // readyState, by contrast, IS ours and must be an own property.
  assert.equal(Object.getOwnPropertyDescriptor(xhr, 'readyState')?.value, 4);
});


// ── a refused XHR must not poison the next one ─────────────────────
//
// `open()` on a used XHR object is how a page RESTARTS a request — retry loops
// and jQuery-era wrappers do it routinely. blockXhr leaves own properties
// behind on purpose (the reason has to outlive the events), so without a clear
// on `open` the reused object reports DONE while the real request sits at
// OPENED. A page waiting on `readyState === 4` then reads the NEXT, legitimate
// response as complete-and-empty, and still sees our reason for a send we
// never refused.

test('a reused XHR is not left reporting DONE from the request before it', async () => {
  let verdict = { ok: true, receipt: { decision: 'block', reason: 'US SSN detected', blockCause: 'policy' } };
  const { sandbox } = makeXhrWorld(() => verdict);

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  await waitFor(() => xhr.readyState === 4);
  assert.equal(xhr.sonomosBlocked, true);

  // The page retries on the same object.
  verdict = allowVerdict;
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);

  // The shim's stamp is a NON-WRITABLE 4. On a real XHR deleting it uncovers
  // the prototype accessor again; on this fake, `open()` immediately writes its
  // own plain `readyState = 1` over the hole. Either way what must be gone is
  // the frozen 4 — assert that, not the absence of any descriptor at all, which
  // would only be a fact about the fake.
  const desc = Object.getOwnPropertyDescriptor(xhr, 'readyState');
  assert.notEqual(desc?.value, 4, 'the stale DONE must not survive into the next request');
  assert.notEqual(desc?.writable, false, 'nor the non-writable stamp that made it permanent');
  assert.equal(xhr.readyState, 1, 'the object reports the state the real XHR is in: OPENED');
  for (const prop of ['sonomosBlocked', 'sonomosBlockReason', 'sonomosBlockKind', 'sonomosBlockMessage']) {
    assert.equal(
      Object.getOwnPropertyDescriptor(xhr, prop), undefined,
      `${prop} must not survive into a request it does not describe`
    );
  }

  // And the retry is a real, allowed send — not something the stale state ate.
  xhr.send('{"q":"hi"}');
  await waitFor(() => xhr.sent.length > 0);
  assert.deepEqual(xhr.sent, ['{"q":"hi"}']);
});

test('a fresh XHR that was never blocked is untouched by the clear', async () => {
  // The clear runs on every open(), including the overwhelming majority that
  // follow no block at all. It must not disturb an ordinary object.
  const { sandbox } = makeXhrWorld(() => allowVerdict);
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  assert.equal(xhr.readyState, 1);
  assert.equal(Object.getOwnPropertyDescriptor(xhr, 'sonomosBlocked'), undefined);
  xhr.send('{"q":"hi"}');
  await waitFor(() => xhr.sent.length > 0);
  assert.deepEqual(xhr.sent, ['{"q":"hi"}']);
});

// ── a throwing page handler must not eat the events after it ───────
//
// The three dispatches shared one try. That was survivable while `error` came
// first; putting `readystatechange` in front of it meant a page handler that
// throws on the FIRST event swallowed `error` AND `loadend` — the two events
// that actually release a waiting page. The hang the sequence exists to prevent,
// reintroduced by the fix for it.

test('a handler that throws on readystatechange still gets error and loadend', async () => {
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  const realDispatch = xhr.dispatchEvent.bind(xhr);
  xhr.dispatchEvent = (event) => {
    realDispatch(event);
    // A page whose readystatechange handler throws. Its bug — but the remaining
    // events are ours to deliver.
    if (event.type === 'readystatechange') throw new Error('the page handler threw');
    return true;
  };
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.events.length >= 3);
  assert.deepEqual(
    xhr.events, ['readystatechange', 'error', 'loadend'],
    'every event still fires, in order, whatever a handler does'
  );
});

test('a handler that throws on every event does not stop the sequence', async () => {
  const { sandbox } = makeXhrWorld(() => (
    { ok: true, receipt: { decision: 'block', reason: 'pii' } }
  ));
  const xhr = new sandbox.XMLHttpRequest();
  const realDispatch = xhr.dispatchEvent.bind(xhr);
  xhr.dispatchEvent = (event) => {
    realDispatch(event);
    throw new Error('every handler throws');
  };
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');

  await waitFor(() => xhr.events.length >= 3);
  assert.deepEqual(xhr.events, ['readystatechange', 'error', 'loadend']);
  // readyState is set before any dispatch, so it survives all of it.
  assert.equal(xhr.readyState, 4);
});


// ── the two host codes whose copy blamed the wrong thing ────────────
//
// `host-panic` and `bridge-protocol-mismatch` had no RELAY_BLOCK_REASON entry,
// so both fell to `native-call-failed`, whose sentence is "the Locke desktop app
// could not be reached. Start it, then try again."
//
// In both cases the app WAS reached. `host-panic` means our own
// native-messaging host ran and then crashed; `bridge-protocol-mismatch` means
// The bridge and the host disagree about the wire version. Telling the
// user to start an app that is very likely already running is the same
// wrong-advice defect `bridge-unreachable`, `receipt-too-large` and the rest
// were pulled out of that bucket to fix — arriving again through codes added
// after the table was written.

async function blockedByRelayCode(code, message = '') {
  const { sandbox } = makeXhrWorld(() => ({ ok: false, code, message }));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  await waitFor(() => xhr.sonomosBlocked === true);
  return xhr;
}

test('a host panic does not tell the user to start an app that already ran', async () => {
  const xhr = await blockedByRelayCode('host-panic', 'handler panicked');
  assert.equal(xhr.sonomosBlockReason, 'connector-crashed');
  assert.equal(xhr.sonomosBlockKind, 'unavailable');
  const msg = xhr.sonomosBlockMessage;

  // The defect, stated as an assertion. This is the sentence it used to get.
  assert.doesNotMatch(
    msg, /could not be reached/,
    'nothing was unreachable — the host ran and then crashed'
  );
  assert.doesNotMatch(msg, /Start it/, 'there is nothing for the user to start');

  assert.match(msg, /connector failed while handling this request/);
  assert.match(msg, /NOT a sensitive-data block/, 'or the user goes hunting for PII they never sent');
  assert.match(msg, /nothing was sent/);
  assert.match(msg, /report it/, 'a crash in our own component is a bug report, not a user action');
  assert.match(msg, /\(host-panic\)/, 'and the wire code, which is what a bug report needs');
  assert.deepEqual(xhr.sent, [], 'fail-closed: the request did not go out');
});

test('a wire-version mismatch says update, not start', async () => {
  const xhr = await blockedByRelayCode('bridge-protocol-mismatch', 'wire version 7 != 6');
  assert.equal(xhr.sonomosBlockReason, 'bridge-version-mismatch');
  assert.equal(xhr.sonomosBlockKind, 'unavailable');
  const msg = xhr.sonomosBlockMessage;

  assert.doesNotMatch(msg, /could not be reached/);
  assert.doesNotMatch(msg, /Start it/);
  // A skew is not cleared by retrying the same request, so the advice differs
  // from the panic's even though both are 'unavailable'.
  assert.match(msg, /disagree about their message format/);
  assert.match(msg, /Update or repair/);
  assert.match(msg, /NOT a sensitive-data block/);
  assert.match(msg, /\(bridge-protocol-mismatch\)/);
  assert.deepEqual(xhr.sent, []);
});

test('a relay code we genuinely cannot place still says the app was unreachable', async () => {
  // The fallback is not being removed — it is right for `bridge-error`, where
  // the port really did die. This pins that the two fixes above did not quietly
  // change the default for everything else.
  const xhr = await blockedByRelayCode('bridge-error', 'port disconnected');
  assert.equal(xhr.sonomosBlockReason, 'native-call-failed');
  assert.match(xhr.sonomosBlockMessage, /could not be reached \(bridge-error\)/);
});

test('every relay-failure code the extension records has copy written for it', async () => {
  // The drift pin, and the one test that would have caught both defects. Any
  // code shared/screening.js keeps evidence for is a code the shim will be
  // handed, so it must have a reason of its own — or be a DOCUMENTED fallback.
  //
  // `bridge-error` is the sole intentional fallback: "the desktop app could not
  // be reached" is exactly true when native messaging itself failed.
  const INTENTIONAL_FALLBACKS = new Set(['bridge-error']);
  const table = /const RELAY_BLOCK_REASON = \{([^}]*)\}/.exec(SHIM_SRC);
  assert.ok(table, 'shim.js must declare RELAY_BLOCK_REASON');
  const mapped = new Set([...table[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => m[1]));

  const known = [...RELAY_FAILURES_PROVING_NO_SCREEN, ...RELAY_FAILURES_PROVING_NO_VERDICT];
  const missing = known.filter((c) => !mapped.has(c) && !INTENTIONAL_FALLBACKS.has(c));
  assert.deepEqual(
    missing, [],
    'these relay codes would fall back to "the Locke desktop app could not be reached. ' +
    'Start it" — add a RELAY_BLOCK_REASON entry and a BLOCK_KIND sentence, or list them ' +
    'as intentional fallbacks here'
  );

  // And every reason the table names must have a sentence, or blockMessage
  // silently serves the generic "could not be screened before sending".
  const kinds = /const BLOCK_KIND = \{([\s\S]*?)\n  \};/.exec(SHIM_SRC);
  assert.ok(kinds, 'shim.js must declare BLOCK_KIND');
  for (const [, , reason] of table[1].matchAll(/'([^']+)':\s*'([^']+)'/g)) {
    assert.ok(
      kinds[1].includes(`'${reason}': [`),
      `RELAY_BLOCK_REASON maps to '${reason}' but BLOCK_KIND has no sentence for it`
    );
  }
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
  // The FIRST event a handler can see is `readystatechange`, not `error`, since
  // a blocked XHR now transitions to DONE first. The rule is unchanged and is
  // asserted across all three: whichever event a page happens to listen for,
  // the reason is already on the object by the time it runs.
  assert.deepEqual(seenAtDispatch.map((s) => s[0]), ['readystatechange', 'error', 'loadend']);
  for (const [type, blocked, reason] of seenAtDispatch) {
    assert.deepEqual([blocked, reason], [true, 'decision-block'],
      `a handler for '${type}' reading event.target must find the reason already there`);
  }
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
  // A clean allow releases the page's own call — same url, same method — with
  // the bytes that were screened. Not the page's own buffer: a typed array is
  // writable, and the verdict wait is long enough to overwrite it in.
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], STORAGE_PUT);
  assert.equal(netCalls[0][1].method, 'PUT');
  assert.deepEqual(Buffer.from(netCalls[0][1].body), Buffer.from(bytes));
  assert.notEqual(netCalls[0][1].body, bytes, 'released from a copy the page cannot reach');
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
  //
  // Since the discovery gate every bodied one IS held — for the classifier,
  // as open_web — so the floor is now "never claimed as an attachment", which
  // is what would screen them regardless of what the classifier says.
  const captured = [];
  const { sandbox, netCalls, logs } = makeDebugWorld((msg) => { captured.push(msg); return allowVerdict; });

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

  assert.equal(captured.length, passers.length - 1, 'every bodied one goes to the classifier');
  assert.ok(captured.every((m) => m.coverage === 'open_web'), 'not one may be claimed as an upload');
  assert.ok(!logs.some((l) => /\bscope=upload\b/.test(l.line)), 'nor logged as one');
  assert.equal(netCalls.length, passers.length, 'every one went out on the allow');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0, 'and none of them warned');
});

test('upload: the scope is bounded by the PAGE, not by the destination', async () => {
  // The blast radius is the existing catalog and nothing wider: the shim only
  // runs on a page the catalog names, and the upload scope refuses to act
  // unless that is true. This is what stops the fix from becoming "hold every
  // cross-origin PUT in the browser".
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, OFF_SURFACE_PAGE);
  await sandbox.fetch(STORAGE_PUT, { method: 'PUT', body: 'file bytes' });
  assert.equal(captured[0].coverage, 'open_web',
    'an off-catalog page may not claim the screen-regardless coverage');
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
      // D-30's notice, in the desktop app toast's own words.
      assert.match(e.message, /this image was blocked by your file-type setting, so it was not sent/);
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

test('upload: an unchecked allow is HELD, never sent (zh#370 default deny: an upload is not a chat turn)', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => ({
    ok: true,
    receipt: { decision: 'allow', redactedCount: 0, unchecked: true, unscreened: [pdfUnscreened] }
  }));
  await assert.rejects(sandbox.fetch(STORAGE_PUT, { method: 'PUT', body: 'file bytes' }), blockedError);
  assert.equal(netCalls.length, 0);
  const line = assertBlocked(logs, 'fail-open-file-held', 'unavailable');
  assert.match(line, /\bscope=upload\b/);
  assert.match(line, /\bcause=unchecked-pass\b/);
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
  assert.deepEqual(
    xhr.events, ['readystatechange', 'error', 'loadend'],
    'and the page was told, not left waiting'
  );
  assertBlocked(logs, 'upload-withheld', 'unsupported');
});

test('upload: an XHR to an ordinary third-party host is classified, not an upload', async () => {
  const captured = [];
  const { sandbox, logs } = makeXhrWorld((msg) => { captured.push(msg); return allowVerdict; });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://o123.ingest.sentry.io/api/1/envelope/', true);
  xhr.send('{"event":1}');
  await waitFor(() => xhr.sent.length === 1);
  assert.deepEqual(xhr.sent, ['{"event":1}']);
  assert.equal(captured[0].coverage, 'open_web');
  assert.equal(xhr.aborted, false);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

// ── POST-shaped uploads: the body says "file" (2026-10-06) ─────────
//
// Perplexity's attachments, observed in public client code
// (henrique-coder/perplexity-webui-scraper core/files.py; helallao/perplexity-ai
// client.py): /rest/uploads/create_upload_url answers an S3 POST policy, and
// the page POSTs a multipart FORM — the signing fields plus the file — to
// ppl-ai-file-upload.s3.amazonaws.com (images go to Cloudinary the same way).
// No object-write header, so the header-only predicate passed every one of
// them unscreened. What only an upload carries is the FILE in its body.

const S3_POST = 'https://ppl-ai-file-upload.s3.amazonaws.com/';

function s3PolicyForm(file, name = 'cv.txt') {
  const form = new FormData();
  form.append('key', `web/direct-files/u1/f1/${name}`);
  form.append('x-amz-credential', 'ASIAZ4TQXY3EXAMPLE7Q/20261006/us-east-1/s3/aws4_request');
  form.append('x-amz-security-token', 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJH');
  form.append('policy', 'eyJleHBpcmF0aW9uIjoiMjAyNi0xMC0wNlQwMDowMDowMFoifQ==');
  form.append('x-amz-signature', '3f1e2d4c5b6a79880716253443526170f0e1d2c3b4a59687');
  form.append('file', file, name);
  return form;
}

test('upload: a POST-policy form carrying a file is held and screened (Perplexity to S3)', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });

  await sandbox.fetch(S3_POST, { method: 'POST', body: s3PolicyForm(new Blob(['Jane Roe, SSN 078-05-1120'], { type: 'text/plain' })) });

  assert.equal(captured.length, 1, 'the form reached the desktop app');
  const raw = rawOf(captured[0]).toString('utf8');
  assert.match(raw, /^POST \/ HTTP\/1\.1\r\nHost: ppl-ai-file-upload\.s3\.amazonaws\.com\r\n/);
  assert.match(raw, /content-type: multipart\/form-data; boundary=/i);
  assert.match(raw, /Jane Roe, SSN 078-05-1120/, 'the file part itself was screened');
  assert.match(raw, /name="key"\r\n\r\nweb\/direct-files\/u1\/f1\/cv\.txt/, 'the object key (the filename) was screened');
  // The signing fields are a credential minted for this one upload, like a
  // pre-signed URL's query string: they never cross the seam, so the screener
  // cannot mask them into an upload the storage provider refuses.
  for (const name of ['x-amz-credential', 'x-amz-security-token', 'policy', 'x-amz-signature']) {
    assert.ok(!raw.includes(`name="${name}"`), `${name} crossed the seam`);
  }
  assert.ok(!raw.includes('ASIAZ4TQXY3EXAMPLE7Q'));
  assert.equal(netCalls.length, 1, 'a clean allow releases the upload');
  assert.equal(netCalls[0][0], S3_POST);
  const shipped = Buffer.from(netCalls[0][1].body).toString('utf8');
  assert.match(shipped, /ASIAZ4TQXY3EXAMPLE7Q/, 'the page\'s own signed form is what an allow releases');
  assert.match(shipped, /Jane Roe, SSN 078-05-1120/);
});

test('upload: a form with no signature field is screened whole, whatever its fields are called', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  const form = new FormData();
  form.append('timestamp', '2026-10-06 note for Jane Roe');
  form.append('api_key', 'not-a-signed-form');
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  await sandbox.fetch('https://uploads.example.net/form', { method: 'POST', body: form });
  const raw = rawOf(captured[0]).toString('utf8');
  assert.match(raw, /name="timestamp"\r\n\r\n2026-10-06 note for Jane Roe/);
  assert.match(raw, /name="api_key"/);
});

test('upload: a signed form whose screen found something is blocked, never re-sent without its signature', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => rebuiltVerdict(
    ['POST / HTTP/1.1', 'Host: ppl-ai-file-upload.s3.amazonaws.com', 'content-type: multipart/form-data; boundary=FRESH'],
    Buffer.from('--FRESH\r\nContent-Disposition: form-data; name="file"; filename="cv.txt"\r\n\r\nJane Roe, SSN SSN_ab12\r\n--FRESH--\r\n'),
    1
  ));
  await assert.rejects(
    sandbox.fetch(S3_POST, { method: 'POST', body: s3PolicyForm(new Blob(['Jane Roe, SSN 078-05-1120'], { type: 'text/plain' })) }),
    (e) => {
      assert.match(e.message, /signed form/);
      assert.match(e.message, /Nothing left your machine/);
      assert.match(e.message, /\breason=upload-signed-form\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0, 'neither the original nor a rebuilt form left');
  assertBlocked(logs, 'upload-signed-form', 'unsupported');
});

test('upload: an XHR signed form is screened without its signing fields and blocked on a redact', async () => {
  const captured = [];
  const { sandbox, logs } = makeXhrWorld((msg) => {
    captured.push(msg.requestB64);
    return rebuiltVerdict(['POST / HTTP/1.1', 'Host: ppl-ai-file-upload.s3.amazonaws.com',
      'content-type: multipart/form-data; boundary=FRESH'], Buffer.from('--FRESH--\r\n'), 1);
  });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', S3_POST, true);
  xhr.send(s3PolicyForm(new Blob(['Jane Roe, SSN 078-05-1120'], { type: 'text/plain' })));
  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, [], 'nothing was uploaded');
  assert.ok(!rawOf(captured[0]).toString('utf8').includes('x-amz-signature'), 'the signature never crossed the seam');
  assertBlocked(logs, 'upload-signed-form', 'unsupported');
});

test('upload: an image the screener withholds from a POST-policy form is blocked with the file-type-setting notice', async () => {
  const { sandbox, netCalls, logs } = makeWorld(() => {
    const v = rebuiltVerdict(['POST / HTTP/1.1', 'Host: ppl-ai-file-upload.s3.amazonaws.com',
      'content-type: multipart/form-data; boundary=FRESH'], Buffer.from('--FRESH--\r\n'), 0);
    v.receipt.unchecked = false;
    v.receipt.unscreened = [pngUnscreened];
    return v;
  });

  await assert.rejects(
    sandbox.fetch(S3_POST, { method: 'POST', body: s3PolicyForm(new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'scan.png') }),
    (e) => {
      assert.match(e.message, /this image was blocked by your file-type setting, so it was not sent/);
      assert.match(e.message, /Nothing left your machine/);
      assert.match(e.message, /\breason=upload-withheld\b/);
      return true;
    }
  );
  assert.equal(netCalls.length, 0, 'no placeholder was uploaded into the bucket');
  assertBlocked(logs, 'upload-withheld', 'unsupported');
});

test('upload: an XHR form carrying a file is held too', async () => {
  const captured = [];
  const { sandbox } = makeXhrWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://api.cloudinary.com/v1_1/pplx/image/upload', true);
  xhr.send(s3PolicyForm(new Blob(['note'], { type: 'text/plain' }), 'note.txt'));
  await waitFor(() => xhr.sent.length === 1);
  assert.equal(captured.length, 1, 'the form was screened before it left');
});

test('upload: a file POSTed to the AI host itself on a path its allow-list does not name is held', async () => {
  // A narrowed host passes every path its list does not name — right for
  // sign-in and telemetry, a leak for an upload. An upload that the catalog
  // does not recognise must fail closed, never pass.
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; }, CHATGPT_PATHS);
  const form = new FormData();
  form.append('file', new Blob(['Jane Roe 078-05-1120'], { type: 'text/plain' }), 'notes.txt');
  await sandbox.fetch('https://chatgpt.com/backend-api/files/upload_direct', { method: 'POST', body: form });
  assert.equal(captured.length, 1, 'the unlisted same-origin upload was screened');
  assert.match(rawOf(captured[0]).toString('utf8'), /^POST \/backend-api\/files\/upload_direct HTTP\/1\.1\r\nHost: chatgpt\.com\r\n/);
});

test('upload: raw file bodies by type — a typed Blob, a tus PATCH, a File — are held', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; }, { File });
  await sandbox.fetch('https://uploads.example.net/blob', { method: 'POST', body: new Blob(['%PDF-1.7'], { type: 'application/pdf' }) });
  await sandbox.fetch('https://uploads.example.net/files/abc', {
    method: 'PATCH',
    headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
    body: Uint8Array.from([1, 2, 3])
  });
  await sandbox.fetch('https://uploads.example.net/raw', { method: 'POST', body: new File(['hello'], 'hello.txt', { type: 'text/plain' }) });
  assert.equal(captured.length, 3);
});

test('upload: a form carried on a Request object, and a deferred fetch of one, are in scope too', async () => {
  const captured = [];
  let deferredSends = 0;
  const { sandbox } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; },
    { fetchLater() { deferredSends++; } });
  const form = () => {
    const f = new FormData();
    f.append('file', new Blob(['Jane Roe 078-05-1120'], { type: 'text/plain' }), 'n.txt');
    return f;
  };
  // A Request's own Content-Type (multipart, minted by the Request) stands in
  // for the body we cannot see through it.
  await sandbox.fetch(new Request('https://uploads.example.net/r', { method: 'POST', body: form() }));
  assert.equal(captured.length, 1, 'the Request-borne form was screened');
  assert.throws(() => sandbox.fetchLater('https://uploads.example.net/later', { method: 'POST', body: form() }),
    /cannot be held for screening/);
  assert.equal(deferredSends, 0, 'a deferred upload cannot be held, so it is refused');
});

test('upload: a streamed POST body cannot be looked into, so it is held and refused', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, logs } = makeWorld(() => { meshAsked = true; return allowVerdict; });
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  await assert.rejects(sandbox.fetch('https://uploads.example.net/stream', { method: 'POST', body, duplex: 'half' }));
  assert.equal(meshAsked, false);
  assert.equal(netCalls.length, 0, 'an unreadable upload never leaves');
  assert.match(assertBlocked(logs, 'uncapturable-stream', 'unsupported'), /\bscope=upload\b/);
});

test('upload: a beacon carrying a file is refused; telemetry beacons are not', () => {
  const sent = [];
  const { sandbox, logs } = makeWorld(() => allowVerdict, {
    navigator: { sendBeacon(url, data) { sent.push(url); return true; } }
  });
  const form = new FormData();
  form.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
  assert.equal(sandbox.navigator.sendBeacon('https://collector.example.net/b', form), false);
  assert.equal(sandbox.navigator.sendBeacon('https://collector.example.net/t', new Blob(['{"e":1}'], { type: 'application/json' })), true);
  assert.equal(sandbox.navigator.sendBeacon('https://collector.example.net/t', '{"e":1}'), true);
  assert.deepEqual(sent, ['https://collector.example.net/t', 'https://collector.example.net/t']);
  assert.match(assertBlocked(logs, 'uncapturable-beacon'), /\bscope=upload\b/);
});

test('upload: the body test keeps the false-positive floor — telemetry shapes are never claimed as uploads', async () => {
  // Every bodied request is classified since super PR #15, so these reach the
  // desktop app — as ordinary open-web capture, never as an upload (which the
  // guard screens regardless).
  const captured = [];
  const { sandbox, netCalls, logs } = makeDebugWorld((msg) => { captured.push(msg); return allowVerdict; });
  const strings = new FormData();
  strings.append('event', 'page_view');
  const passers = [
    ['https://o123.ingest.sentry.io/api/1/envelope/', { method: 'POST', body: new Blob(['{"e":1}'], { type: 'application/x-sentry-envelope' }) }],
    ['https://api.segment.io/v1/t', { method: 'POST', body: new Blob(['{"a":1}'], { type: 'application/json' }) }],
    ['https://browser-intake-datadoghq.com/api/v2/rum', { method: 'POST', body: new Blob(['x']) }],
    ['https://www.google-analytics.com/g/collect', { method: 'POST', body: new URLSearchParams('v=2&tid=G-1') }],
    ['https://forms.example.net/subscribe', { method: 'POST', body: strings }],
    ['https://metrics.example.net/bin', { method: 'POST', body: Uint8Array.from([1, 2, 3]) }],
    ['https://api.example.net/item/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"title":"x"}' }]
  ];
  for (const [url, init] of passers) await sandbox.fetch(url, init);
  assert.ok(captured.every((m) => m.coverage === 'open_web'), 'not one of these may be claimed as an upload');
  assert.equal(netCalls.length, passers.length);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

test('upload: on a search page that screens nothing, a file POST is classified, never claimed as an upload', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, {
    location: { href: 'https://www.google.com/', origin: 'https://www.google.com', hostname: 'www.google.com' },
    SONOMOS_WEB_HOSTS: ['chatgpt.com', 'www.google.com'],
    SONOMOS_CAPTURE_PATHS: { 'www.google.com': [] }
  });
  const form = new FormData();
  form.append('encoded_image', new Blob(['x'], { type: 'image/jpeg' }), 'photo.jpg');
  await sandbox.fetch('https://lens.google.com/v3/upload', { method: 'POST', body: form });
  assert.ok(captured.every((m) => m.coverage === 'open_web'),
    'the catalog says this surface has no screened submission path');
  assert.equal(netCalls.length, 1);
});

// ── audio and voice (Nate, 2026-10-06: "Allow audio, disclose") ─────
//
// Locke cannot screen audio until V2, so the desktop app's answer for an audio
// upload is a clean allow by default, and a block when the device setting or
// the team policy says Block. The extension does not decide that, on either
// side: it holds the upload like any other file, relays it, and obeys the
// verdict. These tests pin that the hold-and-relay path lets audio through on
// an allow with the page's own bytes, stops it on a block, and is no looser
// for video or when the desktop app cannot answer.

const DICTATION_URL = 'https://chatgpt.com/backend-api/transcribe';

function dictationForm(type = 'audio/webm', name = 'audio.webm') {
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86])], { type }), name);
  form.append('duration_seconds', '4.2');
  return form;
}

test('audio: dictation (a File in a form to an unlisted ChatGPT path) is relayed and, on a clean allow, sent as the page built it', async () => {
  const captured = [];
  const { sandbox, netCalls, logs } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; }, CHATGPT_PATHS);
  await sandbox.fetch(DICTATION_URL, { method: 'POST', body: dictationForm() });
  assert.equal(captured.length, 1, 'held and relayed, so the app (and a team policy) can decide');
  const raw = rawOf(captured[0]).toString('latin1');
  assert.match(raw, /^POST \/backend-api\/transcribe HTTP\/1\.1\r\nHost: chatgpt\.com\r\n/);
  assert.match(raw, /filename="audio\.webm"/);
  assert.match(raw, /Content-Type: audio\/webm/i);
  assert.equal(netCalls.length, 1, 'allowed: the upload leaves');
  const shipped = Buffer.from(netCalls[0][1].body);
  assert.ok(shipped.includes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86])), 'the clip itself went out unchanged');
  assert.match(shipped.toString('latin1'), /filename="audio\.webm"/);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

test('audio: a raw recorder blob and an XHR form are relayed and released the same way', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  await sandbox.fetch('https://uploads.example.net/voice', {
    method: 'POST', body: new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm;codecs=opus' })
  });
  await sandbox.fetch('https://uploads.example.net/voice-ogg', {
    method: 'POST', headers: { 'content-type': 'audio/ogg' }, body: Uint8Array.from([0x4f, 0x67, 0x67, 0x53])
  });
  assert.equal(captured.length, 2);
  assert.equal(netCalls.length, 2);

  const xhrCaptured = [];
  const world = makeXhrWorld((msg) => { xhrCaptured.push(msg.requestB64); return allowVerdict; });
  const xhr = new world.sandbox.XMLHttpRequest();
  xhr.open('POST', DICTATION_URL, true);
  xhr.send(dictationForm('audio/mp4', 'audio.m4a'));
  await waitFor(() => xhr.sent.length === 1);
  assert.equal(xhrCaptured.length, 1);
  assert.equal(xhr.aborted, false);
});

test('audio: when the desktop app says Block (device setting or team policy) the upload never leaves, fetch and XHR', async () => {
  const block = () => ({ ok: true, receipt: { decision: 'block', reason: '1 item(s) could not be examined (file: audio/webm)', redactedCount: 0 } });
  const { sandbox, netCalls, logs } = makeWorld(block, CHATGPT_PATHS);
  await assert.rejects(sandbox.fetch(DICTATION_URL, { method: 'POST', body: dictationForm() }), blockedError);
  assert.equal(netCalls.length, 0);
  assert.match(assertBlocked(logs, 'decision-block', 'policy'), /file: audio\/webm/);

  const world = makeXhrWorld(block);
  const xhr = new world.sandbox.XMLHttpRequest();
  xhr.open('POST', DICTATION_URL, true);
  xhr.send(dictationForm());
  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, [], 'the blocked clip was not uploaded');
});

test('audio: the extension adds no pass of its own — a desktop app that cannot answer still blocks it', async () => {
  const { sandbox, netCalls } = makeWorld(() => ({ ok: false, code: 'no-bridge', message: 'not found' }), CHATGPT_PATHS);
  await assert.rejects(sandbox.fetch(DICTATION_URL, { method: 'POST', body: dictationForm() }));
  assert.equal(netCalls.length, 0);
});

test('audio: video and other unreadable files are held exactly as before, and a block verdict stops them', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => {
    captured.push(msg.requestB64);
    return { ok: true, receipt: { decision: 'block', reason: '1 item(s) could not be examined (file: video/mp4)', redactedCount: 0 } };
  }, CHATGPT_PATHS);
  for (const [type, name] of [['video/mp4', 'clip.mp4'], ['application/pdf', 'doc.pdf'], ['application/octet-stream', 'blob.bin']]) {
    await assert.rejects(sandbox.fetch(DICTATION_URL, { method: 'POST', body: dictationForm(type, name) }), blockedError, type);
  }
  assert.equal(captured.length, 3, 'every one was held and relayed');
  assert.equal(netCalls.length, 0);
});

test('pre-consent: a form carrying a file is in upload scope by its TYPE alone', async () => {
  let captures = 0;
  const { sandbox } = makeWorld(() => { captures++; return allowVerdict; }, { navigator: { userAgent: 'Chrome/130.0 Edg/130.0' } });
  await assert.rejects(sandbox.fetch(S3_POST, { method: 'POST', body: s3PolicyForm(new Blob(['private'], { type: 'text/plain' })) }), /Data sharing/);
  assert.equal(captures, 0);
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
  // Since the discovery gate it is still HELD — as open_web, for the
  // classifier — just never claimed as a catalog attachment.
  const captured = [];
  const { sandbox, netCalls } = makeFrameWorld((msg) => {
    captured.push(msg);
    return allowVerdict;
  }, 'data:text/html,<p>x', 'data:text/html,<p>x', {
    origin: 'null', documentOrigin: 'null', SONOMOS_DEBUG: true
  });

  await sandbox.fetch('https://storage.example.com/bucket/key?X-Amz-Signature=abc', {
    method: 'PUT',
    body: 'curriculum vitae'
  });

  assert.equal(captured.length, 1, 'held for the classifier');
  assert.equal(captured[0].coverage, 'open_web', 'no initiator to scope an upload on');
  assert.equal(netCalls.length, 1, 'released on the allow');
});

test('frame: a frame created by a NON-catalog page gets no upload scope', async () => {
  // The direction that would be worse: inheriting a base must not turn every
  // opaque frame into an AI surface.
  const captured = [];
  const { sandbox, netCalls } = makeDebugWorld((msg) => {
    captured.push(msg);
    return allowVerdict;
  }, {
    location: { href: 'about:blank', origin: 'null' },
    document: { baseURI: 'https://example.com/embed' }
  });

  await sandbox.fetch('https://storage.example.com/bucket/key', {
    method: 'PUT',
    body: 'somebody else’s file'
  });

  assert.equal(captured.length, 1, 'held for the classifier, like any request');
  assert.equal(captured[0].coverage, 'open_web', 'but never as a catalog attachment');
  assert.equal(netCalls.length, 1);
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

async function coverageOf(host) {
  let coverage = null;
  const { sandbox } = makeWorld((msg) => { coverage = msg.coverage; return allowVerdict; });
  await sandbox.fetch(`https://${host}/backend-api/conversation`, {
    method: 'POST',
    body: '{"prompt":"x"}'
  });
  return coverage;
}

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

// Every host is held now (the discovery gate); what the catalog still decides
// is the coverage hint. A stranger that could pass for a catalog surface must
// not borrow its `capture_path`, and a catalog spelling must not lose it.
test('scope: a host the catalog does not name is held as open_web', async () => {
  for (const stranger of [
    'notchatgpt.com',                 // the prefix trick the dot boundary stops
    'chatgpt.com.evil.example',       // a suffix, not a parent
    'openai.com',                     // a parent of an entry is not an entry
    'example.com'
  ]) {
    assert.equal(await heldSpelling(stranger), true, `${stranger} must be held for the classifier`);
    assert.equal(await coverageOf(stranger), 'open_web', `${stranger} is not a catalog surface`);
  }
  for (const spelling of ['chat.openai.com', 'CHAT.OpenAI.COM', 'www.chatgpt.com']) {
    assert.equal(await coverageOf(spelling), 'capture_path', `${spelling} is a catalog surface`);
  }
});

test('scope: an open-web capture claims no provider, even from a catalog page', async () => {
  // The harness page is chat.openai.com. Its analytics POST to a third party
  // is not OpenAI traffic; only SCOPE.UPLOAD may borrow the page's provider.
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; });
  await sandbox.fetch('https://analytics.example/collect', { method: 'POST', body: '{"e":1}' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].provider, null);
  assert.equal(captured[0].coverage, 'open_web');
});

test('scope: a non-http(s) target is not held', async () => {
  let held = false;
  const { sandbox, netCalls } = makeWorld(() => { held = true; return allowVerdict; });
  await sandbox.fetch('ftp://files.example/x', { method: 'POST', body: 'x' });
  assert.equal(held, false);
  assert.equal(netCalls.length, 1);
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

test('a request made before the config lands passes through once the admin allowlist excludes the provider', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS, { settleConfig: false }
  );

  // Same race as the disable set, other half of the chokepoint: the allowlist
  // arrives in the same config, and the re-check after the wait used to ask
  // only about disabledWebHosts — so an excluded provider's first POST was
  // held and screened, and blocked outright with the desktop app down.
  const inFlight = sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['anthropic'] } });
  await inFlight;

  assert.equal(meshAsked, false, 'a provider the admin excluded is never asked about, however early the request');
  assert.equal(netCalls.length, 1, 'the original request goes out untouched');
  assert.equal(netCalls[0][1].body, '{"q":1}');
});

test('XHR: a send made before the config lands is released when the admin allowlist excludes the provider', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeXhrWorld(
    () => { meshAsked = true; return allowVerdict; }, { settleConfig: false, extraGlobals: TWO_PROVIDERS }
  );

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://chat.openai.com/api/chat', true);
  xhr.send('{"q":"hi"}');
  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['anthropic'] } });

  await waitFor(() => xhr.sent.length === 1);
  assert.equal(meshAsked, false);
  assert.deepEqual(xhr.sent, ['{"q":"hi"}']);
  assert.equal(xhr.aborted, false);
});

test('a bodyless request never waits for the config', async () => {
  let meshAsked = false;
  const { sandbox, netCalls } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {}, { settleConfig: false });

  // Every host is in scope now, so the page-start wait is paid by any BODIED
  // request in a page's opening quarter-second. A bodyless one has nothing to
  // hold and must not pay it.
  const before = Date.now();
  await sandbox.fetch('https://example.com/api');
  const bodylessMs = Date.now() - before;

  assert.equal(netCalls.length, 1, 'released immediately, untouched');
  assert.equal(meshAsked, false);
  assert.ok(bodylessMs < 100, `a bodyless request must not wait on config (took ${bodylessMs}ms)`);

  // The same world, same missing config: a bodied one DOES wait, which is
  // what makes the line above an assertion about scope rather than about a
  // wait that never happens.
  const inScopeAt = Date.now();
  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  const inScopeMs = Date.now() - inScopeAt;

  assert.equal(meshAsked, true);
  assert.ok(inScopeMs > bodylessMs, `an in-scope request waits for the first config (took ${inScopeMs}ms)`);
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
  // Attachment bytes do not look like an AI request; left to the classifier
  // they would go unscreened. A catalog page's upload is screened regardless.
  assert.equal(captured[0].coverage, 'capture_path');
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

// ── path scoping → coverage ───────────────────────────────────────────────
//
// The outage these used to pin: with chatgpt.com injected but unscoped, the
// shim held EVERY request on the host and sent it to a screener that could not
// examine sentinel's opaque proof-of-work, so it failed closed and ChatGPT
// reported itself unreachable.
//
// Since the discovery gate (super PR #15) every request is held and the
// guard's classifier decides; the path allow-list now says how much the
// classifier is trusted, via `coverage`. A prompt path is `capture_path`
// (screened regardless); sentinel and sign-in are `catalog_host` (classified
// first, so they come back a plain allow without a screen). Both directions
// still matter: a prompt path demoted to `catalog_host` would let the
// classifier skip a screen it must not skip.

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

test('paths: the prompt POST on a narrowed host is a capture path', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);

  for (const path of ['/backend-api/conversation', '/backend-api/f/conversation',
                      '/backend-anon/conversation', '/backend-anon/f/conversation']) {
    await sandbox.fetch(`https://chatgpt.com${path}`, { method: 'POST', body: '{"prompt":"hi"}' });
  }
  assert.equal(captured.length, 4, 'every prompt-bearing path must still be screened');
  assert.deepEqual(captured.map((m) => m.coverage), Array(4).fill('capture_path'));
});

test('paths: sentinel, sign-in and settings go to the classifier as catalog_host', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);

  const offPath = [
    '/unauth-mweb/sentinel/chat-requirements/finalize',
    '/unauth-mweb/sentinel/chat-requirements/prepare',
    '/api/auth/session',
    '/backend-api/me',
    '/backend-api/settings/user',
    '/unauth-mweb/events/performance'
  ];
  for (const path of offPath) {
    await sandbox.fetch(`https://chatgpt.com${path}`, { method: 'POST', body: '{}' });
  }
  assert.deepEqual(captured.map((m) => m.coverage), Array(offPath.length).fill('catalog_host'),
    'held for the classifier, never claimed as a prompt path');
  assert.equal(netCalls.length, offPath.length, 'a plain allow releases each one');
});

test('paths: a pattern never acts as a prefix', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);
  // 3-segment reads and side-ops sit beside the 2-segment prompt POST. Equal
  // segment counts are the only thing keeping them off the capture path.
  for (const path of ['/backend-api/conversation/abc123',
                      '/backend-api/conversation/gen_title/abc123',
                      '/backend-api/conversation/message_feedback']) {
    await sandbox.fetch(`https://chatgpt.com${path}`, { method: 'POST', body: '{}' });
  }
  assert.deepEqual(captured.map((m) => m.coverage), Array(3).fill('catalog_host'),
    'a longer path must not be admitted by a shorter pattern');
});

test('paths: a host with no allow-list keeps capture-everything', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);
  // chat.openai.com is in the harness host list and is NOT narrowed. Absence of
  // an allow-list must never quietly demote a surface nobody narrowed.
  await sandbox.fetch('https://chat.openai.com/anything/at/all', { method: 'POST', body: '{"a":1}' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].coverage, 'capture_path');
});

test('paths: the deny-list still wins inside an allow-list', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, {
    SONOMOS_CAPTURE_PATHS: { 'chatgpt.com': ['/telemetry/conversation'] },
    SONOMOS_SKIP_PATH_SEGMENTS: [['telemetry']]
  });
  // A provider must not be able to re-admit telemetry by naming it.
  await sandbox.fetch('https://chatgpt.com/telemetry/conversation', { method: 'POST', body: '{}' });
  assert.equal(captured[0].coverage, 'catalog_host',
    'skip_path_segments is a floor no per-provider data can lift');
});

test('paths: a subdomain inherits the narrowing of its apex', async () => {
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, CHATGPT_PATHS);
  // Or the narrowing is dodged by spelling.
  await sandbox.fetch('https://ab.chatgpt.com/api/auth/session', { method: 'POST', body: '{}' });
  assert.equal(captured[0].coverage, 'catalog_host');
});

// ── unscreened surfaces: a host narrowed to NOTHING ───────────────────────
//
// The catalog declares the `search` entry (www.google.com, www.bing.com,
// search.brave.com, duckduckgo.com, kagi.com, you.com) `web_screening: "none"`:
// no screened submission path, because what a user types there leaves as a
// top-level navigation. The generator never read that field, so the shim held
// EVERY bodied request on those hosts — a Google Maps or Flights XHR, an
// account POST, a `/gen_204` telemetry beacon — relaying each through a fresh
// native-host process, and BLOCKING each one when the desktop app was not
// running. The generator now emits an EMPTY allow-list for them, and these
// tests pin what the shim does with it.
//
// The empty list is honoured on the unscreened surface's OWN pages only. The
// hosts stay in SONOMOS_WEB_HOSTS because that list is the request-TARGET
// scope set: duck.ai's chat XHRs target duckduckgo.com, so a `[]` that applied
// to every request would silently unscreen a bodied chat the catalog says is
// screened. Both directions are pinned below.

const UNSCREENED = {
  SONOMOS_WEB_HOSTS: ['chat.openai.com', 'chatgpt.com', 'duck.ai', 'duckduckgo.com', 'www.google.com', 'www.bing.com'],
  SONOMOS_WEB_PROVIDERS: {
    'chat.openai.com': 'openai', 'chatgpt.com': 'openai',
    'duck.ai': 'duckduckgo', 'duckduckgo.com': 'search',
    'www.google.com': 'search', 'www.bing.com': 'search'
  },
  SONOMOS_CAPTURE_PATHS: {
    'chatgpt.com': ['/backend-api/conversation'],
    'duckduckgo.com': [],
    'www.google.com': [],
    'www.bing.com': []
  },
  SONOMOS_SKIP_PATH_SEGMENTS: [['telemetry']]
};

const pageAt = (host, path = '/') => ({
  location: { href: `https://${host}${path}`, origin: `https://${host}`, hostname: host }
});

test('unscreened: a POST on a search host’s own page goes to the classifier as catalog_host', async () => {
  // The discovery gate (super PR #15) reverses the passthrough these hosts got:
  // every request goes to the guard's classifier now, and the empty list only
  // demotes them to `catalog_host` — classified, screened only if it looks
  // like AI. With no desktop app the request is refused like any other
  // (fail-closed unless the user opened a fail-open window); that is the
  // trade the gate makes, and why the coverage hint exists at all.
  const captured = [];
  const { sandbox, netCalls } = makeDebugWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { ...UNSCREENED, ...pageAt('www.google.com', '/maps') }
  );

  const res = await sandbox.fetch('https://www.google.com/gen_204?atyp=i&ei=abc', {
    method: 'POST', body: 'ei=abc&s=web'
  });

  assert.equal(captured.length, 1, 'held for the classifier');
  assert.equal(captured[0].coverage, 'catalog_host', 'never claimed as a prompt path');
  assert.equal(netCalls.length, 1, 'a plain allow releases it');
  assert.ok(res && res.__net, 'the page gets the network’s own response');
});

test('unscreened: a bodied fetch and XHR on www.bing.com are classified, not screened outright', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeXhrWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { extraGlobals: { ...UNSCREENED, ...pageAt('www.bing.com', '/search?q=x') } }
  );

  await sandbox.fetch('https://www.bing.com/fd/ls/lsp.aspx', {
    method: 'POST', headers: { 'content-type': 'text/xml' }, body: '<ClientInstRequest/>'
  });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://www.bing.com/rewardsapp/reportActivity', true);
  xhr.send('{"activity":"x"}');
  await waitFor(() => xhr.sent.length === 1);

  assert.deepEqual(captured.map((m) => m.coverage), ['catalog_host', 'catalog_host']);
  assert.equal(netCalls.length, 1, 'the fetch reached the network');
  assert.deepEqual(xhr.sent, ['{"activity":"x"}'], 'the XHR was forwarded, not aborted');
  assert.equal(xhr.aborted, false);
});

test('unscreened: a beacon on a search host is sent, not refused', async () => {
  // Beacons cannot be held, so an in-scope one is REFUSED — which on
  // www.google.com meant every telemetry beacon on the page was dropped and a
  // warning logged for it, on a surface where nothing is screened.
  const beacons = [];
  const { sandbox, logs } = makeWorld(() => allowVerdict, {
    ...UNSCREENED,
    ...pageAt('www.google.com'),
    SONOMOS_DEBUG: true,
    navigator: { sendBeacon(url, data) { beacons.push([url, data]); return true; } }
  });

  assert.equal(sandbox.navigator.sendBeacon('https://www.google.com/gen_204', 'ei=abc'), true);
  assert.equal(beacons.length, 1, 'the beacon reached the network');
  assertReason(logs, 'not-in-scope', 'debug');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

test('unscreened: the prompt POST on a screened host is still held (regression guard)', async () => {
  // The same world holds a real allow-list beside the empty ones. Reading `[]`
  // as "nothing is narrowed" anywhere would be a silent PII leak on chatgpt.com;
  // reading a short list as `[]` would be an outage. Both must stay distinct.
  const captured = [];
  const { sandbox } = makeWorld((msg) => { captured.push(msg); return allowVerdict; }, UNSCREENED);

  await sandbox.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: '{"prompt":"hi"}' });
  await sandbox.fetch('https://chat.openai.com/anything', { method: 'POST', body: '{"prompt":"hi"}' });

  assert.equal(captured.length, 2, 'an allow-listed path, and a host with no list, are both held');
  assert.deepEqual(captured.map((m) => m.provider), ['openai', 'openai']);
});

test('unscreened: a declined path on a screened host still reports by=paths', async () => {
  // The narrowing diagnostic now speaks only where the path still decides
  // something on its own: an unholdable beacon, which off a capture path is
  // sent rather than refused.
  const { sandbox, logs } = makeDebugWorld(() => allowVerdict, {
    ...UNSCREENED,
    navigator: { sendBeacon() { return true; } }
  });
  assert.equal(sandbox.navigator.sendBeacon('https://chatgpt.com/api/auth/session', '{}'), true);
  const line = assertReason(logs, 'path-not-screened', 'debug');
  assert.match(line, /\bby=paths\b/, 'a short list and an empty list are different narrowings');
});

test('unscreened: chat from a screened page to an unscreened host is still held', async () => {
  // THE reason those hosts stay in web_hosts. duck.ai is a screened chat whose
  // XHRs target duckduckgo.com, which the catalog files under `search`. The
  // empty list on duckduckgo.com is about duckduckgo.com's own pages; it must
  // not reach across to a different surface's prompt.
  const captured = [];
  const { sandbox } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { ...UNSCREENED, ...pageAt('duck.ai', '/?q=hello') }
  );

  await sandbox.fetch('https://duckduckgo.com/duckchat/v1/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"messages":[{"role":"user","content":"my ssn is 123-45-6789"}]}'
  });

  assert.equal(captured.length, 1, 'Duck.ai’s prompt must still be screened');
  assert.equal(captured[0].provider, 'search', 'attributed by target, as every capture is');
  const { head } = splitRaw(rawOf(captured[0].requestB64));
  assert.match(head, /^POST \/duckchat\/v1\/chat HTTP\/1\.1\r\nHost: duckduckgo\.com\r\n/);
});

test('unscreened: a prompt sent FROM an unscreened page TO a screened host is still held', async () => {
  // The empty list is a statement about the target host's own surface, not a
  // page-wide switch: a www.google.com page that POSTs to chatgpt.com's prompt
  // endpoint is sending a prompt to ChatGPT, and that is screened.
  const captured = [];
  const { sandbox } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { ...UNSCREENED, ...pageAt('www.google.com') }
  );
  await sandbox.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: '{"prompt":"hi"}' });
  assert.equal(captured.length, 1);
});

test('unscreened: a subdomain of an unscreened host inherits the empty list on its own pages', async () => {
  // Same rule as every other narrowing — most specific entry wins, and a
  // subdomain with no entry of its own takes its apex's. `maps.google.com` is
  // not in the catalog; `www.google.com`'s own subdomains are the case.
  const captured = [];
  const { sandbox, netCalls } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { ...UNSCREENED, ...pageAt('accounts.www.google.com') }
  );
  await sandbox.fetch('https://accounts.www.google.com/signin', { method: 'POST', body: 'email=a@b.c' });
  assert.equal(captured[0].coverage, 'catalog_host');
  assert.equal(netCalls.length, 1);
});

test('unscreened: a frame with no host of its own takes its creator’s answer', async () => {
  // An about:blank child of duck.ai has no host on `location`; PAGE_HOST falls
  // back to the inherited base, which is the surface that made the frame. A
  // chat POST from inside it to duckduckgo.com must be a capture path exactly
  // as it is from the top-level page …
  const captured = [];
  const held = makeFrameWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    'about:blank', 'https://duck.ai/',
    { documentOrigin: 'https://duck.ai', ...UNSCREENED }
  );
  await held.sandbox.fetch('https://duckduckgo.com/duckchat/v1/chat', { method: 'POST', body: '{"q":1}' });
  assert.equal(captured[0].coverage, 'capture_path', 'a child frame of a screened page is still screened');

  // … and a child of www.google.com inherits the demotion its creator gets.
  const passedCaptured = [];
  const passed = makeFrameWorld(
    (msg) => { passedCaptured.push(msg); return allowVerdict; },
    'about:blank', 'https://www.google.com/maps',
    { documentOrigin: 'https://www.google.com', ...UNSCREENED }
  );
  await passed.sandbox.fetch('https://www.google.com/maps/preview/place', { method: 'POST', body: 'x=1' });
  assert.equal(passedCaptured[0].coverage, 'catalog_host');
  assert.equal(passed.netCalls.length, 1);
});

test('unscreened: the deny-list still wins, and the diagnostic says it was the deny-list', async () => {
  // skip_path_segments is a global floor. From a duck.ai page the empty list
  // on duckduckgo.com would have made this a capture path; the deny-list
  // demotes it to catalog_host, and the beacon diagnostic must say so rather
  // than blame a narrowing that never got consulted.
  const captured = [];
  const { sandbox, logs, netCalls } = makeDebugWorld(
    (msg) => { captured.push(msg); return allowVerdict; },
    { ...UNSCREENED, ...pageAt('duck.ai'), navigator: { sendBeacon() { return true; } } }
  );
  await sandbox.fetch('https://duckduckgo.com/telemetry/event', { method: 'POST', body: '{}' });
  assert.equal(netCalls.length, 1);
  assert.equal(captured[0].coverage, 'catalog_host');
  assert.equal(sandbox.navigator.sendBeacon('https://duckduckgo.com/telemetry/event', '{}'), true);
  const line = assertReason(logs, 'path-not-screened', 'debug');
  assert.match(line, /\bhost=duckduckgo\.com\b/);
  assert.match(line, /\bby=deny-list\b/);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

// ── surfaces an ADMIN policy excluded (managed `allowedProviders`) ──
//
// `managed-schema.json` declared this key and `shared/constants.js` merged it
// into settings, while no runtime code read it: an admin could push it,
// `getSettings()` would hand it back, and every catalog surface carried on
// being screened regardless. A policy knob that does nothing is worse than an
// absent one, because a deployment review reads it as a control. These tests
// are what makes it real.
//
// Same shape as `disabledWebHosts` above and deliberately so — SUBTRACTIVE,
// arriving on the same SONOMOS_CONFIG channel, decided in the same
// `isScreenedHost` chokepoint — but the opposite polarity, which is exactly
// where the interesting mistakes are: an EMPTY allowlist has to mean
// "everything", where an empty disable set means "nothing".

// Two providers, so "allow one, exclude the other" is expressible at all.
const TWO_PROVIDERS = {
  SONOMOS_WEB_HOSTS: ['chat.openai.com', 'chatgpt.com', 'claude.ai'],
  SONOMOS_WEB_PROVIDERS: {
    'chat.openai.com': 'openai',
    'chatgpt.com': 'openai',
    'claude.ai': 'anthropic'
  }
};

test('policy: a provider the allowlist omits passes through untouched', async () => {
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['anthropic'] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false, 'openai is not on the policy allowlist');
  assert.equal(netCalls.length, 1, 'the original request goes out untouched');
});

test('policy: a provider the allowlist names is screened exactly as before', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['openai'] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

test('policy: the allowlist covers every host of the provider it names', async () => {
  const captured = [];
  const { sandbox, deliver } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['openai'] } });
  await sandbox.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: '{"q":1}' });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(captured.length, 2, 'a provider id is not a hostname — it covers all of that provider');
});

test('policy: an EMPTY allowlist means no restriction, not "screen nothing"', async () => {
  // The mistake this test exists for: reading `[]` as an empty Set of allowed
  // providers would turn a cleared policy into a total, silent loss of
  // coverage — every surface unscreened, nothing in the console, and nothing
  // in the popup a user would read as a failure.
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: [] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

test('policy: clearing an applied allowlist puts the surface back in scope', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['anthropic'] } });
  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: [] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

test('policy: a config without the key leaves an applied allowlist alone', async () => {
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['anthropic'] } });
  // A push whose managed read failed carries only the other knobs. It must not
  // read as "no policy" and quietly re-scope a surface the admin excluded.
  deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 30000 } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false);
});

test('policy: ids are matched case-insensitively and trimmed', async () => {
  // Managed policy is hand-authored JSON pushed by an MDM. A stray space or a
  // capital letter costing an enterprise its screening would be a bad way to
  // find that out.
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['  OpenAI '] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

test('policy: the allowlist only subtracts catalog providers — open web still goes to the classifier', async () => {
  const captured = [];
  const { sandbox, netCalls, deliver } = makeWorld(
    (msg) => { captured.push(msg); return allowVerdict; }, TWO_PROVIDERS
  );

  // Whatever an admin — or a page forging this message — puts here, it can
  // only take catalog providers out of scope. It cannot promote a host to a
  // capture path, and an unattributable host is never excluded by it.
  deliver({
    type: 'SONOMOS_CONFIG',
    config: { allowedProviders: ['openai', 'example-corp', 'not-a-provider', 42] }
  });
  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].coverage, 'open_web', 'naming it in the list does not promote it');
  assert.equal(captured[0].provider, null);
  assert.equal(netCalls.length, 1);

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  assert.equal(captured.length, 2, 'the catalog provider named in the list stays screened');
});

test('policy: an allowlist naming nothing the catalog knows screens nothing, and says so', async () => {
  // The typo case, and the reason the enum in managed-schema.json is pinned to
  // the catalog by a test below. It fails toward LESS coverage, which is the
  // direction that costs protection — so it has to be visible. The debug line
  // names the applied policy rather than counting it, which is what lets an
  // admin see "we shipped `claude-ai` and the catalog says `anthropic`".
  let meshAsked = false;
  const { sandbox, netCalls, deliver, logs } = makeDebugWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['claude-ai'] } });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false);
  assert.equal(netCalls.length, 1);
  const applied = logs.filter((l) => l.line.includes('config-applied'));
  assert.ok(applied.length >= 1);
  assert.ok(
    applied.at(-1).line.includes('claude-ai'),
    'the applied policy must be nameable from the console, not just counted'
  );
});

test('policy: a catalog host with no provider mapping stays screened', async () => {
  // An allowlist may only exclude what it can NAME. A catalog entry the
  // generator did not attribute is unattributable here too, and the safe
  // answer is to keep screening it: wrong in the direction that costs a held
  // request, never in the direction that lets a body out.
  let meshAsked = false;
  const { sandbox, deliver } = makeWorld(() => { meshAsked = true; return allowVerdict; }, {
    SONOMOS_WEB_HOSTS: ['chat.openai.com', 'orphan.example'],
    SONOMOS_WEB_PROVIDERS: { 'chat.openai.com': 'openai' }
  });

  deliver({ type: 'SONOMOS_CONFIG', config: { allowedProviders: ['anthropic'] } });
  await sandbox.fetch('https://orphan.example/api', { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, true);
});

test('policy: a surface the user disabled stays disabled even when the policy allows it', async () => {
  // Two subtractive sets, and neither may re-admit what the other removed.
  let meshAsked = false;
  const { sandbox, netCalls, deliver } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS
  );

  deliver({
    type: 'SONOMOS_CONFIG',
    config: { allowedProviders: ['openai'], disabledWebHosts: ['chat.openai.com'] }
  });
  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });

  assert.equal(meshAsked, false);
  assert.equal(netCalls.length, 1);
});

test('policy: until config arrives, an allowlist has not narrowed anything', async () => {
  // The page-start race, from the policy side. The wait can only ever REMOVE a
  // host from scope; running out of it resolves to "screened", which is the
  // fully-protective answer.
  let meshAsked = false;
  const { sandbox } = makeWorld(
    () => { meshAsked = true; return allowVerdict; }, TWO_PROVIDERS, { settleConfig: false }
  );

  await sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' });
  assert.equal(meshAsked, true, 'no policy yet means every catalog surface is screened');
});

// The enum an admin writes against and the ids the shim matches have to be the
// same list, and nothing generates one from the other. Before this change they
// were not: the schema offered `claude-ai`, `gemini`, `phind` and thirty-odd
// API-endpoint names, none of which the catalog has ever used, so every value
// the schema suggested would have excluded the surface it named.
test('policy: the managed-schema enum is exactly the catalog ids that have web hosts', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../managed-schema.json', import.meta.url), 'utf8')
  );
  const catalog = JSON.parse(
    await readFile(new URL('../shared/ai-surfaces.json', import.meta.url), 'utf8')
  );

  const declared = schema.properties.allowedProviders.items.enum;
  const screenable = catalog.providers
    .filter((p) => Array.isArray(p.web_hosts) && p.web_hosts.length > 0)
    .map((p) => p.id);

  assert.deepEqual(
    [...declared].sort(),
    [...screenable].sort(),
    'an id in the schema that the catalog does not have silently narrows scope to nothing; ' +
      'a catalog provider missing from the schema is one an admin cannot keep'
  );
});

test('a hung host is not reported as one the user needs to start', async () => {
  // Found by the drift pin above, not by hand: `native-timeout` was falling
  // through to `native-call-failed` too. The browser DID start the host — it is
  // stuck, so "Start it" sends the user to launch a process that already exists.
  const xhr = await blockedByRelayCode('native-timeout');
  assert.equal(xhr.sonomosBlockReason, 'connector-no-answer');
  assert.equal(xhr.sonomosBlockKind, 'unavailable');
  assert.doesNotMatch(xhr.sonomosBlockMessage, /Start it/);
  assert.match(xhr.sonomosBlockMessage, /did not answer in time/);
  assert.match(xhr.sonomosBlockMessage, /NOT a sensitive-data block/);
  // Deliberately NOT reusing `verdict-timeout`: that is the shim's own ceiling
  // one hop further out, and a support log must be able to tell which hop gave
  // up. Same observation, different component.
  assert.notEqual(xhr.sonomosBlockReason, 'verdict-timeout');
});

async function sentFetch(call) {
  const request = new Request(...call);
  return { request, bytes: Buffer.from(await request.arrayBuffer()) };
}

for (const configWait of [false, true]) {
  test(`snapshot: fetch freezes mutable body, headers and options before ${configWait ? 'configuration' : 'verdict'} wait`, async () => {
    let answer;
    const captured = [];
    const { sandbox, netCalls, deliver } = makeWorld(msg => {
      captured.push(msg.requestB64);
      return new Promise(resolve => { answer = resolve; });
    }, {}, { settleConfig: !configWait });
    const body = new URLSearchParams({ prompt: 'approved' });
    const init = { method: 'POST', headers: { 'x-version': 'approved' }, body, credentials: 'include' };
    const pending = sandbox.fetch(AI_URL, init);
    if (!configWait) await waitFor(() => answer);
    body.set('prompt', 'unscreened');
    init.body = 'replacement';
    init.headers['x-version'] = 'changed';
    init.credentials = 'omit';
    if (configWait) {
      deliver({ type: 'SONOMOS_CONFIG', config: {} });
      await waitFor(() => answer);
    }
    answer(allowVerdict);
    await pending;
    const sent = await sentFetch(netCalls[0]);
    assert.equal(sent.bytes.toString(), 'prompt=approved');
    assert.deepEqual(sent.bytes, splitRaw(rawOf(captured[0])).body);
    assert.equal(sent.request.headers.get('x-version'), 'approved');
    assert.equal(sent.request.credentials, 'include');
  });
}

test('snapshot: fetch FormData releases the exact screened boundary and file bytes', async () => {
  let answer;
  let captured;
  const { sandbox, netCalls } = makeWorld(msg => {
    captured = splitRaw(rawOf(msg.requestB64));
    return new Promise(resolve => { answer = resolve; });
  });
  const form = new FormData();
  form.append('prompt', 'approved');
  form.append('file', new Blob([new Uint8Array([0, 255, 13, 10])]), 'unicode-ß.bin');
  const pending = sandbox.fetch(AI_URL, { method: 'POST', body: form });
  await waitFor(() => answer);
  form.set('prompt', 'unscreened');
  answer(allowVerdict);
  await pending;
  const sent = await sentFetch(netCalls[0]);
  assert.deepEqual(sent.bytes, captured.body);
  assert.ok(captured.head.toLowerCase().includes('content-type: ' + sent.request.headers.get('content-type')));
});

test('snapshot: Request init headers replace rather than merge the original headers', async () => {
  let captured;
  const { sandbox, netCalls } = makeWorld(msg => {
    captured = splitRaw(rawOf(msg.requestB64));
    return allowVerdict;
  });
  const request = new Request(AI_URL, {
    method: 'POST', headers: { 'x-old': 'must-not-be-screened' }, body: 'approved'
  });
  await sandbox.fetch(request, { headers: { 'x-new': 'current' } });
  const sent = await sentFetch(netCalls[0]);
  assert.equal(sent.request.headers.get('x-old'), null);
  assert.doesNotMatch(captured.head, /x-old/i);
  assert.match(captured.head, /x-new: current/);
});

test('snapshot: XHR copies a mutable buffer before the configuration wait', async () => {
  const captures = [];
  const { sandbox, deliver } = makeXhrWorld(msg => { captures.push(msg.requestB64); return allowVerdict; }, { settleConfig: false });
  const bytes = new Uint8Array([1, 2, 3]);
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', AI_URL);
  xhr.send(bytes);
  bytes.fill(9);
  deliver({ type: 'SONOMOS_CONFIG', config: {} });
  await waitFor(() => xhr.sent.length);
  assert.deepEqual(Buffer.from(xhr.sent[0]), Buffer.from([1, 2, 3]));
  assert.deepEqual(splitRaw(rawOf(captures[0])).body, Buffer.from([1, 2, 3]));
});

test('snapshot: a bodyless fetch cannot gain an unscreened body during the configuration wait', async () => {
  const { sandbox, netCalls, deliver } = makeWorld(() => allowVerdict, {}, { settleConfig: false });
  const init = { method: 'GET', credentials: 'include' };
  const pending = sandbox.fetch(AI_URL, init);

  init.method = 'POST';
  init.body = 'unscreened';
  init.credentials = 'omit';
  deliver({ type: 'SONOMOS_CONFIG', config: {} });

  await pending;
  const sent = new Request(...netCalls[0]);
  assert.equal(sent.method, 'GET');
  assert.equal(sent.body, null);
  assert.equal(sent.credentials, 'include');
});

test('snapshot: a page-owned RequestInfo object cannot retarget an approved fetch', async () => {
  let answer;
  const { sandbox, netCalls } = makeWorld(() => new Promise(resolve => { answer = resolve; }));
  const target = { href: AI_URL };
  const input = { toString: () => target.href };
  const pending = sandbox.fetch(input, { method: 'POST', body: 'approved' });
  await waitFor(() => answer);

  target.href = 'https://example.com/unscreened';
  answer(allowVerdict);

  await pending;
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], AI_URL);
});

test('snapshot: inherited RequestInit fields are frozen before the verdict wait', async () => {
  let answer;
  const { sandbox, netCalls } = makeWorld(() => new Promise(resolve => { answer = resolve; }));
  const inherited = {
    method: 'POST',
    headers: { 'x-version': 'approved' },
    body: new URLSearchParams({ prompt: 'approved' }),
    credentials: 'include'
  };
  const init = Object.create(inherited);
  const pending = sandbox.fetch(AI_URL, init);
  await waitFor(() => answer);

  inherited.method = 'PUT';
  inherited.headers['x-version'] = 'changed';
  inherited.body.set('prompt', 'unscreened');
  inherited.credentials = 'omit';
  answer(allowVerdict);

  await pending;
  const sent = await sentFetch(netCalls[0]);
  assert.equal(sent.request.method, 'POST');
  assert.equal(sent.request.credentials, 'include');
  assert.equal(sent.request.headers.get('x-version'), 'approved');
  assert.equal(sent.bytes.toString(), 'prompt=approved');
});

test('snapshot: a Request input is privately captured before the configuration wait', async () => {
  let answer;
  const captured = [];
  const { sandbox, netCalls, deliver } = makeWorld(msg => {
    captured.push(msg.requestB64);
    return new Promise(resolve => { answer = resolve; });
  }, {}, { settleConfig: false });
  const input = new Request(AI_URL, {
    method: 'POST', headers: { 'x-version': 'approved' }, body: 'approved'
  });
  const pending = sandbox.fetch(input);

  assert.equal(input.bodyUsed, true, 'native fetch takes ownership of a Request body before returning');
  input.headers.set('x-version', 'changed');
  deliver({ type: 'SONOMOS_CONFIG', config: {} });
  await waitFor(() => answer);
  answer(allowVerdict);

  await pending;
  const sent = await sentFetch(netCalls[0]);
  assert.equal(sent.request.headers.get('x-version'), 'approved');
  assert.equal(sent.bytes.toString(), 'approved');
  assert.deepEqual(sent.bytes, splitRaw(rawOf(captured[0])).body);
});

test('snapshot: invalid RequestInit is rejected without reaching the network', async () => {
  const { sandbox, netCalls } = makeWorld(() => allowVerdict);
  const input = new Request(AI_URL, {
    method: 'POST', headers: { 'x-old': 'must-not-send' }, body: 'approved'
  });

  await assert.rejects(sandbox.fetch(input, { headers: null }), { name: 'TypeError' });
  assert.equal(netCalls.length, 0);
});

for (const decision of ['allow', 'block']) {
  test(`generation: stale XHR ${decision} cannot affect a reopened successor`, async () => {
    const answers = [];
    const { sandbox } = makeXhrWorld(() => new Promise(resolve => answers.push(resolve)));
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', AI_URL);
    xhr.send('old');
    await waitFor(() => answers.length === 1);
    xhr.open('POST', AI_URL + '?successor');
    xhr.send('new');
    await waitFor(() => answers.length === 2);
    answers[0]({ ok: true, receipt: { decision, redactedCount: 0 } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(xhr.sent.length, 0, 'old result must neither send nor abort the successor');
    assert.equal(xhr.aborted, false);
    assert.equal(xhr.sonomosBlocked, undefined);
    answers[1](allowVerdict);
    await waitFor(() => xhr.sent.length === 1);
    assert.equal(Buffer.from(xhr.sent[0]).toString(), 'new');
  });
}

test('generation: a stale asynchronous XHR failure cannot block a reopened successor', async () => {
  const answers = [];
  const { sandbox } = makeXhrWorld(() => new Promise(resolve => answers.push(resolve)));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', AI_URL);
  xhr.send('old');
  await waitFor(() => answers.length === 1);

  xhr.open('POST', AI_URL + '?successor');
  xhr.send('new');
  await waitFor(() => answers.length === 2);
  answers[0]({ get ok() { throw new Error('asynchronous verdict failure'); } });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(xhr.sent.length, 0);
  assert.equal(xhr.aborted, false);
  assert.equal(xhr.sonomosBlocked, undefined);
  answers[1](allowVerdict);
  await waitFor(() => xhr.sent.length === 1);
  assert.equal(Buffer.from(xhr.sent[0]).toString(), 'new');
});

test('generation: held XHR rejects second send and header changes like a native active request', async () => {
  let answer;
  const { sandbox } = makeXhrWorld(() => new Promise(resolve => { answer = resolve; }));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', AI_URL);
  xhr.send('approved');
  await waitFor(() => answer);
  assert.throws(() => xhr.send('unscreened'), { name: 'InvalidStateError' });
  assert.throws(() => xhr.setRequestHeader('x-late', 'unscreened'), { name: 'InvalidStateError' });
  answer(allowVerdict);
  await waitFor(() => xhr.sent.length === 1);
});

test('consent refusal blocks with consent guidance, not a desktop outage', async () => {
  const xhr = await blockedByRelayCode('data-consent-required');
  assert.equal(xhr.sonomosBlockReason, 'data-consent-required');
  assert.match(xhr.sonomosBlockMessage, /Data sharing/);
  assert.match(xhr.sonomosBlockMessage, /uninstall.*reload/i);
});

for (const userAgent of ['Mozilla/5.0 Firefox/140.0', 'Mozilla/5.0 Chrome/130.0 Edg/130.0']) {
  test(`consent blocks ${userAgent} before body serialization and resumes/revokes in the existing tab`, async () => {
    let captures = 0, serializations = 0;
    class PrivateForm extends FormData {
      forEach(...args) { serializations++; return super.forEach(...args); }
      *entries() { serializations++; yield* super.entries(); }
      [Symbol.iterator]() { serializations++; return super[Symbol.iterator](); }
    }
    const { sandbox, netCalls, deliver } = makeWorld(() => { captures++; return allowVerdict; }, { navigator: { userAgent } });
    const body = new PrivateForm(); body.append('health', 'private');
    await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body }), /Data sharing/);
    assert.equal(captures, 0);
    assert.equal(serializations, 0);
    assert.equal(netCalls.length, 0);
    await sandbox.fetch('https://outside.example/status', { method: 'POST', body });
    assert.equal(netCalls.length, 1, 'out-of-scope browsing remains usable');
    assert.equal(serializations, 0, 'out-of-scope content is not inspected either');
    deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: true } });
    await sandbox.fetch(AI_URL, { method: 'POST', body: 'allowed' });
    assert.equal(captures, 1);
    deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: false } });
    await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'private again' }), /Data sharing/);
    assert.equal(captures, 1);
  });
}

test('Edge XHR does not copy headers or serialize a body before consent', async () => {
  let captures = 0;
  const { sandbox, deliver } = makeXhrWorld(() => { captures++; return allowVerdict; }, { extraGlobals: { navigator: { userAgent: 'Chrome/130.0 Edg/130.0' } } });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', AI_URL, true);
  xhr.setRequestHeader('Authorization', 'private');
  assert.equal(xhr.__sonomos.headers.authorization, undefined);
  xhr.send('private health information');
  assert.equal(xhr.sonomosBlockReason, 'data-consent-required');
  assert.equal(captures, 0);
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: true } });
  xhr.open('POST', AI_URL, true);
  xhr.send('allowed');
  await waitFor(() => xhr.sent.length === 1);
  assert.equal(captures, 1);
});

test('pre-consent upload classification reads header names without reading any values', async () => {
  let reads = 0, deferredSends = 0;
  const headers = { 'x-goog-upload-command': 'upload' };
  Object.defineProperty(headers, 'authorization', { enumerable: true, get() { reads++; return 'secret'; } });
  const { sandbox } = makeWorld(() => allowVerdict, { navigator: { userAgent: 'Chrome/130.0 Edg/130.0' }, fetchLater() { deferredSends++; } });
  await assert.rejects(sandbox.fetch('https://storage.example/upload', { method: 'POST', headers, body: 'private' }), /Data sharing/);
  assert.equal(reads, 0);
  assert.throws(() => sandbox.fetchLater('https://storage.example/upload', { method: 'POST', headers, body: 'private' }));
  assert.equal(reads, 0);
  assert.equal(deferredSends, 0);
});

test('pre-consent XHR object-write POST remains in scope without storing header values', () => {
  const { sandbox } = makeXhrWorld(() => allowVerdict, { extraGlobals: { navigator: { userAgent: 'Chrome/130.0 Edg/130.0' } } });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://storage.example/upload', true);
  xhr.setRequestHeader('x-goog-upload-command', 'private-metadata');
  xhr.send('private health data');
  assert.equal(xhr.sent.length, 0);
  assert.equal(xhr.sonomosBlockReason, 'data-consent-required');
  assert.ok(!JSON.stringify(xhr.__sonomos.headers).includes('private-metadata'));
});

test('revoke then regrant during body serialization cannot resurrect an old fetch', async () => {
  let release, captures = 0;
  class DeferredResponse extends Response {
    async arrayBuffer() { await new Promise(resolve => { release = resolve; }); return super.arrayBuffer(); }
  }
  const { sandbox, deliver, netCalls } = makeWorld(() => { captures++; return allowVerdict; }, { navigator: { userAgent: 'Firefox/140.0' }, Response: DeferredResponse });
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: true } });
  const pending = sandbox.fetch(AI_URL, { method: 'POST', body: new Blob(['private']) });
  await waitFor(() => release);
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: false } });
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: true } });
  release();
  await assert.rejects(pending, /Data sharing/);
  assert.equal(captures, 0);
  assert.equal(netCalls.length, 0);
});

test('revoke then regrant during body serialization cannot resurrect an old XHR', async () => {
  let release, captures = 0;
  class DeferredResponse extends Response {
    async arrayBuffer() { await new Promise(resolve => { release = resolve; }); return super.arrayBuffer(); }
  }
  const { sandbox, deliver } = makeXhrWorld(() => { captures++; return allowVerdict; }, { extraGlobals: { navigator: { userAgent: 'Firefox/140.0' }, Response: DeferredResponse } });
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: true } });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', AI_URL, true); xhr.send(new Blob(['private']));
  await waitFor(() => release);
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: false } });
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: true } });
  release();
  await waitFor(() => xhr.sent.length || xhr.aborted);
  assert.equal(captures, 0);
  assert.equal(xhr.sent.length, 0);
  assert.equal(xhr.sonomosBlockReason, 'data-consent-required');
});

test('pre-consent scope recognizes iterable HeadersInit without coercing header values', async () => {
  let reads = 0, deferredSends = 0;
  const secret = { toString() { reads++; return 'private'; } };
  const headers = new Map([['x-goog-upload-command', secret], ['authorization', secret]]);
  const { sandbox, netCalls } = makeWorld(() => allowVerdict, { navigator: { userAgent: 'Chrome/130.0 Edg/130.0' }, fetchLater() { deferredSends++; } });
  await assert.rejects(sandbox.fetch('https://storage.example/upload', { method: 'POST', headers, body: 'private' }), /Data sharing/);
  assert.throws(() => sandbox.fetchLater('https://storage.example/upload', { method: 'POST', headers, body: 'private' }));
  assert.equal(reads, 0);
  assert.equal(netCalls.length, 0);
  assert.equal(deferredSends, 0);
});

test('pre-consent classification never consumes single-use header iterators', async () => {
  let iterations = 0, deferredSends = 0;
  function* once() { iterations++; yield ['content-type', 'application/json']; yield ['authorization', 'private']; }
  const headers = once();
  const { sandbox, netCalls } = makeWorld(() => allowVerdict, { navigator: { userAgent: 'Firefox/140.0' }, fetchLater() { deferredSends++; } });
  await assert.rejects(sandbox.fetch('https://outside.example/status', { method: 'POST', headers, body: 'private' }));
  assert.throws(() => sandbox.fetchLater('https://outside.example/status', { method: 'POST', headers, body: 'private' }));
  assert.equal(iterations, 0);
  assert.equal(netCalls.length, 0);
  assert.equal(deferredSends, 0);
});

test('pre-consent XHR keeps only routing metadata, not query credentials', () => {
  const { sandbox } = makeXhrWorld(() => allowVerdict, { extraGlobals: { navigator: { userAgent: 'Firefox/140.0' } } });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://user:secret@storage.example/upload?token=private#health', true);
  assert.equal(xhr.__sonomos.url.search, '');
  assert.equal(xhr.__sonomos.url.hash, '');
  assert.equal(xhr.__sonomos.url.username, '');
  assert.equal(xhr.__sonomos.url.password, '');
  assert.equal(xhr.__sonomos.url.pathname, '/upload');
});

// ── images (Nate, 2026-10-06: images and NSFW are V1.X) ─────────────
//
// Image screening is dormant in V1: the desktop app answers a clean allow for
// an image by default (sent unscreened) and a block when the device setting or
// the team policy says Block. The extension, as with audio, holds the upload,
// relays it and obeys; it never decides.

function imageForm(type = 'image/png', name = 'screenshot.png') {
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type }), name);
  return form;
}

test('images: an upload is relayed and, on the allow the app gives by default, sent as the page built it', async () => {
  const captured = [];
  const { sandbox, netCalls, logs } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; }, CHATGPT_PATHS);
  await sandbox.fetch(DICTATION_URL, { method: 'POST', body: imageForm() });
  assert.equal(captured.length, 1, 'held and relayed, so the app (and a team policy) can decide');
  assert.match(rawOf(captured[0]).toString('latin1'), /Content-Type: image\/png/i);
  assert.equal(netCalls.length, 1, 'allowed: the image leaves, unscreened');
  assert.ok(Buffer.from(netCalls[0][1].body).includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'the image itself went out unchanged');
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
});

test('images: when the desktop app says Block the image never leaves, and the notice names the file-type setting', async () => {
  const block = () => ({ ok: true, receipt: { decision: 'block', reason: '1 item(s) could not be examined (file: image/png)', redactedCount: 0 } });
  const { sandbox, netCalls } = makeWorld(block, CHATGPT_PATHS);
  await assert.rejects(sandbox.fetch(DICTATION_URL, { method: 'POST', body: imageForm() }), blockedError);
  assert.equal(netCalls.length, 0);
});

test('images: the extension adds no pass of its own, a desktop app that cannot answer still blocks it', async () => {
  const { sandbox, netCalls } = makeWorld(() => ({ ok: false, code: 'no-bridge', message: 'not found' }), CHATGPT_PATHS);
  await assert.rejects(sandbox.fetch(DICTATION_URL, { method: 'POST', body: imageForm() }));
  assert.equal(netCalls.length, 0);
});

// ── the discovery gate without consent, and for unholdable sends ───
//
// Every request goes to the classifier now — but only when it CAN. Without the
// user's data-sharing consent, and for a synchronous XHR that cannot be held,
// nothing can reach the classifier, so only the old scope (a capture path) is
// refused; everything the gate added passes untouched rather than breaking
// every site the browser opens.

test('discovery gate: without consent, open-web and catalog_host sends pass; capture paths are refused', async () => {
  let captures = 0;
  const { sandbox, netCalls, deliver } = makeWorld(() => { captures++; return allowVerdict; },
    { navigator: { userAgent: 'Firefox/140.0' } });
  deliver({ type: 'SONOMOS_CONFIG', config: { dataSharingAllowed: false } });

  await sandbox.fetch('https://example.com/api', { method: 'POST', body: '{"q":1}' });
  assert.equal(netCalls.length, 1, 'open web: released untouched');

  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: '{"q":1}' }), /Data sharing/);
  assert.equal(netCalls.length, 1, 'the capture path never left');
  assert.equal(captures, 0, 'nothing reached the desktop app without consent');
});

test('discovery gate: a synchronous XHR off a capture path is released, on one it is refused', async () => {
  let captures = 0;
  const { sandbox } = makeXhrWorld(() => { captures++; return allowVerdict; });

  const off = new sandbox.XMLHttpRequest();
  off.open('POST', 'https://example.com/api', false);
  off.send('{"q":1}');
  assert.deepEqual(off.sent, ['{"q":1}'], 'cannot be held, so cannot be classified — released');

  const on = new sandbox.XMLHttpRequest();
  on.open('POST', AI_URL, false);
  on.send('{"q":1}');
  assert.equal(on.sent.length, 0, 'a capture path keeps the old refusal');
  assert.equal(on.sonomosBlockReason, 'uncapturable-sync-xhr');
  assert.equal(captures, 0);
});

// ── the desktop app's fail-open window (reqs 221-223) ──────────────
//
// One window, governing every "screening could not complete" block. Learned
// only from the config push; closed by default, when absent, and once expired.

const openWindow = (ms = 60_000) => ({ failOpenActive: true, failOpenUntilMs: Date.now() + ms });
const expiredWindow = () => ({ failOpenActive: true, failOpenUntilMs: Date.now() - 1 });
const BIG = 'x'.repeat(8 * 1024 * 1024 + 1);

async function timeoutWorld(window) {
  const w = makeWorld(() => new Promise(() => {}));
  w.deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 1000, ...(window || {}) } });
  return w;
}

test('fail-open: verdict timeout sends the original and tallies it when the window is active', async () => {
  const { sandbox, netCalls, unchecked } = await timeoutWorld(openWindow());
  await sandbox.fetch(AI_URL, CHAT_INIT);
  assert.equal(netCalls.length, 1);
  assert.deepEqual(unchecked, ['verdict-timeout']);
});

test('fail-open: verdict timeout still blocks when closed, absent, or expired', async () => {
  for (const window of [{ failOpenActive: false, failOpenUntilMs: Date.now() + 60_000 }, null, expiredWindow()]) {
    const { sandbox, netCalls, logs, unchecked } = await timeoutWorld(window);
    await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
    assert.equal(netCalls.length, 0);
    assert.equal(unchecked.length, 0);
    assertBlocked(logs, 'verdict-timeout');
  }
});

test('fail-open: a window that lapses after the push closes by itself', async () => {
  const { sandbox, netCalls, deliver } = makeWorld(() => null);
  deliver({ type: 'SONOMOS_CONFIG', config: { failOpenActive: true, failOpenUntilMs: Date.now() + 50 } });
  await sandbox.fetch(AI_URL, CHAT_INIT);
  assert.equal(netCalls.length, 1);
  await new Promise((r) => setTimeout(r, 80));
  await assert.rejects(sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(netCalls.length, 1);
});

test('fail-open: dead channel and unavailability relay codes follow the window', async () => {
  const dead = makeWorld(() => allowVerdict, { postMessage: () => { throw new Error('channel gone'); } });
  dead.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  await dead.sandbox.fetch(AI_URL, CHAT_INIT);
  assert.equal(dead.netCalls.length, 1);

  for (const code of ['bridge-unreachable', 'no-bridge', 'screening-timeout', 'extension-reloaded', 'native-timeout']) {
    const open = makeWorld(() => ({ ok: false, code }));
    open.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    await open.sandbox.fetch(AI_URL, CHAT_INIT);
    assert.equal(open.netCalls.length, 1, code);
    assert.deepEqual(open.unchecked, [`relay-${code}`]);
    const closed = makeWorld(() => ({ ok: false, code }));
    await assert.rejects(closed.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
    assert.equal(closed.netCalls.length, 0, code);
  }
  const closedDead = makeWorld(() => allowVerdict, { postMessage: () => { throw new Error('channel gone'); } });
  await assert.rejects(closedDead.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
});

test('fail-open: NOT governed - consent, malformed verdicts and guard decisions still block in an open window', async () => {
  const verdicts = [
    { ok: false, code: 'data-consent-required' },
    { ok: false, code: 'bad-request' },
    { ok: true },                                      // malformed: no receipt
    { ok: true, receipt: { decision: 'redact' } },     // redact missing request
    { ok: true, receipt: {} },                         // decision missing
    { ok: true, receipt: { decision: 'block', reason: 'found a key' } }
  ];
  for (const verdict of verdicts) {
    const w = makeWorld(() => verdict);
    w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    await assert.rejects(w.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
    assert.equal(w.netCalls.length, 0);
    assert.equal(w.unchecked.length, 0);
  }
});

test('fail-open: oversize, stream and unreadable bodies are HELD in an open window (zh#370), and block as before otherwise', async () => {
  const bodies = [
    BIG,
    new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }),
    { toString() { throw new Error('nope'); } }
  ];
  for (const body of bodies) {
    // Unreadable, so it cannot be proven file-free: held even under fail-open.
    const open = makeWorld(() => allowVerdict);
    open.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    await assert.rejects(open.sandbox.fetch(AI_URL, { method: 'POST', body, duplex: 'half' }), blockedError);
    assert.equal(open.netCalls.length, 0);
    assert.equal(open.unchecked.length, 0, 'nothing was sent unchecked');
    const line = assertBlocked(open.logs, 'fail-open-file-held', 'unavailable');
    assert.match(line, /\bcause=uncapturable-/);

    const expired = makeWorld(() => allowVerdict);
    expired.deliver({ type: 'SONOMOS_CONFIG', config: expiredWindow() });
    await assert.rejects(expired.sandbox.fetch(AI_URL, { method: 'POST', body, duplex: 'half' }), blockedError);
    assert.equal(expired.netCalls.length, 0);
    assert.equal(expired.unchecked.length, 0);
    assert.ok(!findLine(expired.logs, 'fail-open-file-held'), 'window closed: the old reason, not the new one');
  }
});

// ── fail-open never sends a possible file (zh#370) ──────────────────────

const multipartFile = () => imageForm();
const dataUrlJson = () => JSON.stringify({ q: 'look', image: 'data:image/png;base64,iVBORw0KGgo=' });
const FILE_BODIES = { multipart: multipartFile, 'json data-url': dataUrlJson };
const TEXT_BODY = () => CHAT_JSON;

// Each outage, as the world options that produce it.
const OUTAGES = {
  'verdict timeout': { onCapture: () => new Promise(() => {}), cause: 'verdict-timeout', closedReason: 'verdict-timeout', config: { enforceTimeoutMs: 1000 } },
  'channel failed': { onCapture: () => allowVerdict, globals: { postMessage: () => { throw new Error('channel gone'); } }, cause: 'verdict-channel-failed', closedReason: 'verdict-channel-failed', tallyUnobservable: true },
  'verdict missing': { onCapture: () => null, cause: 'verdict-missing', closedReason: 'verdict-missing' },
  'relay no-bridge': { onCapture: () => ({ ok: false, code: 'no-bridge' }), cause: 'relay-no-bridge', closedReason: 'connector-not-started' },
  'relay bridge-error': { onCapture: () => ({ ok: false, code: 'bridge-error' }), cause: 'relay-bridge-error', closedReason: 'native-call-failed' }
};

function outageWorld(outage, window) {
  const w = makeWorld(outage.onCapture, outage.globals || {});
  w.deliver({ type: 'SONOMOS_CONFIG', config: { ...(outage.config || {}), ...(window || {}) } });
  return w;
}

test('fail-open: a request that may carry a file is HELD on every outage, with the file reason', async () => {
  for (const [outName, outage] of Object.entries(OUTAGES)) {
    for (const [bodyName, mk] of Object.entries(FILE_BODIES)) {
      const w = outageWorld(outage, openWindow());
      await assert.rejects(w.sandbox.fetch(AI_URL, { method: 'POST', body: mk() }), blockedError, `${outName} / ${bodyName}`);
      assert.equal(w.netCalls.length, 0, `${outName} / ${bodyName}: nothing sent`);
      assert.equal(w.unchecked.length, 0, `${outName} / ${bodyName}: not an unchecked send`);
      const line = assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
      assert.match(line, new RegExp(`\\bcause=${outage.cause}\\b`), outName);
      assert.ok(!findLine(w.logs, 'unchecked-fail-open'), outName);
    }
  }
});

test('fail-open: a recognised chat turn still fails open exactly as before, tallied', async () => {
  for (const [outName, outage] of Object.entries(OUTAGES)) {
    const w = outageWorld(outage, openWindow());
    await w.sandbox.fetch(AI_URL, CHAT_INIT);
    assert.equal(w.netCalls.length, 1, outName);
    // A dead channel cannot carry the tally message either; the log line proves it.
    if (!outage.tallyUnobservable) assert.deepEqual(w.unchecked, [outage.cause], outName);
    assertReason(w.logs, 'unchecked-fail-open', 'warn');
    assert.ok(!findLine(w.logs, 'fail-open-file-held'), outName);
  }
});

test('fail-open OFF: file and text requests block on every outage with the same reasons as before', async () => {
  for (const [outName, outage] of Object.entries(OUTAGES)) {
    for (const mk of [multipartFile, dataUrlJson, TEXT_BODY]) {
      const w = outageWorld(outage, null);
      await assert.rejects(w.sandbox.fetch(AI_URL, { method: 'POST', body: mk() }), blockedError, outName);
      assert.equal(w.netCalls.length, 0, outName);
      assert.equal(w.unchecked.length, 0, outName);
      assertBlocked(w.logs, outage.closedReason, 'unavailable');
      assert.ok(!findLine(w.logs, 'fail-open-file-held'), outName);
    }
  }
});

test('fail-open: the host\'s file-held receipt gets the file sentence; an old host\'s infrastructure block still blocks', async () => {
  const held = 'Locke could not screen this request and it is not a plain chat message — held back (fail-open only sends recognised prompt-only chat messages unchecked)';
  const w = makeWorld(() => ({ ok: true, receipt: { decision: 'block', blockCause: 'infrastructure', reason: held, redactedCount: 0, unchecked: false } }));
  w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  await assert.rejects(w.sandbox.fetch(AI_URL, { method: 'POST', body: multipartFile() }),
    (e) => blockedError(e) && /only sends plain chat messages/.test(e.message));
  assert.equal(w.netCalls.length, 0);
  assert.equal(w.unchecked.length, 0);
  assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');

  // An older host answers a generic infrastructure block: still a block.
  const old = makeWorld(() => ({ ok: true, receipt: { decision: 'block', blockCause: 'infrastructure', reason: 'screening unavailable' } }));
  old.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  await assert.rejects(old.sandbox.fetch(AI_URL, { method: 'POST', body: multipartFile() }), blockedError);
  assert.equal(old.netCalls.length, 0);
  assertBlocked(old.logs, 'screening-unavailable', 'unavailable');

  // And a host that sends the reason as a relay error code never opens the window.
  const code = makeWorld(() => ({ ok: false, code: 'fail-open-file-held' }));
  code.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  await assert.rejects(code.sandbox.fetch(AI_URL, CHAT_INIT), blockedError);
  assert.equal(code.netCalls.length, 0);
  assert.equal(code.unchecked.length, 0);
});

test('fail-open: an uncapturable async XHR body is held; a sync XHR is held; closed window keeps the old reasons', async () => {
  for (const open of [true, false]) {
    const w = makeXhrWorld(() => allowVerdict);
    if (open) w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    const a = new w.sandbox.XMLHttpRequest();
    a.open('POST', 'https://chat.openai.com/api/chat', true);
    a.send(BIG);
    await waitFor(() => a.aborted);
    assert.deepEqual(a.sent, []);
    assert.equal(a.sonomosBlockReason, open ? 'fail-open-file-held' : 'uncapturable-oversize');
    const s = new w.sandbox.XMLHttpRequest();
    s.open('POST', 'https://chat.openai.com/api/chat', false);
    s.send('{"q":"hi"}');
    assert.deepEqual(s.sent, []);
    assert.equal(s.sonomosBlockReason, open ? 'fail-open-file-held' : 'uncapturable-sync-xhr');
    assert.equal(w.unchecked.length, 0);
  }
});

test('fail-open: a beacon and a deferred fetch are held, not sent', async () => {
  const b = makeBeaconWorld();
  b.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  assert.equal(b.sandbox.navigator.sendBeacon('https://chat.openai.com/ces/v1/t', '{"prompt":"x"}'), false);
  assert.deepEqual(b.beacons, []);
  assert.equal(b.unchecked.length, 0);
  assertBlocked(b.logs, 'fail-open-file-held');

  const f = makeFetchLaterWorld();
  f.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  assert.throws(() => f.sandbox.fetchLater(AI_URL, { method: 'POST', body: '{"q":1}' }), blockedError);
  assert.equal(f.laterCalls.length, 0);
  assert.equal(f.unchecked.length, 0);
  assertBlocked(f.logs, 'fail-open-file-held');
});

// ── releasableUnderFailOpen: the cross-repo contract (zh#370, default deny) ─
// A port of Proxy src/fail_open_shape.rs; the cases below are that file's Rust
// tests, same inputs and same expectations. The shim is a classic script, so
// the function is lifted out of its source between the markers.
const releasable = (() => {
  const m = /\/\/ <releasableUnderFailOpen>\n([\s\S]*?)\/\/ <\/releasableUnderFailOpen>/.exec(SHIM_SRC);
  assert.ok(m, 'markers present');
  return new Function(m[1] + '; return releasableUnderFailOpen;')();
})();

const MAX_RELEASABLE_BODY = 6 * 1024 * 1024;
const MAX_OPAQUE_STRING = 4096;
const MAX_OPAQUE_ARRAY = 64;

function req(method, host, path, ct, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
    (ct != null ? `content-type: ${ct}\r\n` : '') + `Content-Length: ${b.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head), b]);
}
const jreq = (method, host, path, body) => req(method, host, path, 'application/json', JSON.stringify(body));
const anth = (body) => jreq('POST', 'api.anthropic.com', '/v1/messages?beta=true', body);
const b64n = (n) => 'QUJD'.repeat(Math.floor(n / 4) + 1).slice(0, n);
const CLAUDE_AI = '/api/organizations/o-1/chat_conversations/c-1/completion';
const GEMINI = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const formEnc = (s) => [...Buffer.from(s)].map((b) =>
  (/[A-Za-z0-9\-_.]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : b === 32 ? '+' : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
function geminiBody(turn) {
  const inner = [turn, ['en'], null, ...Array(90).fill(null)];
  return `f.req=${formEnc(JSON.stringify([null, JSON.stringify(inner)]))}&at=AJvLN6M`;
}
const repeat = (s, n) => s.repeat(n);

test('releasableUnderFailOpen: every surface\'s prompt-only turn is released (known_prompt_only_turns_are_released)', () => {
  const cases = [
    anth({ model: 'm', max_tokens: 1, stream: true,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Read', input_schema: { properties: { file_path: { type: 'string' } } } }],
      metadata: { user_id: 'u' },
      messages: [
        { role: 'user', content: 'hi, my SSN is 123-45-6789' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'hm', signature: b64n(2000) },
          { type: 'redacted_thinking', data: b64n(1200) },
          { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a.pdf' } }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't', content: 'ssh-rsa AAAA data:image/png;base64, ...' },
          { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x' }, { type: 'tool_reference', tool_name: 'WebSearch' }] },
          { type: 'text', text: 'go on' }] }] }),
    jreq('POST', 'api.anthropic.com', '/v1/messages/count_tokens',
      { model: 'm', messages: [{ role: 'user', content: 'foo' }] }),
    jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'the sky is blue', timezone: 'UTC',
      attachments: [], files: [], sync_sources: [],
      tools: [{ name: 'x', input_schema: { properties: { file: { enum: ['file'] } } } }],
      create_conversation_params: { name: '', is_temporary: false } }),
    jreq('POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/title',
      { message_content: 'the sky is blue', recent_titles: ['a'] }),
    jreq('POST', 'chatgpt.com', '/backend-api/f/conversation', {
      action: 'next', model: 'auto', parent_message_id: 'client-created-root',
      client_contextual_info: { app_name: 'chatgpt.com' },
      messages: [{ author: { role: 'user', metadata: {} }, content: { content_type: 'text', parts: ['the sky is blue'] },
        id: '8e07', metadata: { automation_creation_attribution: { origin: 'conversation' } } }],
      supported_encodings: ['v1'] }),
    jreq('POST', 'chatgpt.com', '/backend-api/f/conversation/prepare',
      { action: 'next', model: 'auto', attachment_mime_types: [] }),
    req('POST', 'gemini.google.com', `${GEMINI}?bl=x&_reqid=1`, 'application/x-www-form-urlencoded;charset=UTF-8',
      geminiBody(['the sky is blue', 0, null, null, null, null, 0])),
    jreq('POST', 'duck.ai', '/duckchat/v1/chat', { model: 'gpt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'the sky is blue' }] }, { role: 'assistant', content: 'ok' }],
      durableStream: { publicKey: { n: b64n(342) } } }),
    jreq('POST', 'api.openai.com', '/v1/chat/completions', { model: 'g',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: '1', content: 'out' }] }),
    jreq('POST', 'api.openai.com', '/v1/responses', { model: 'g', input: 'the sky is blue' }),
    req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', null, JSON.stringify({
      type: 'response.create', model: 'g', instructions: 'i',
      tools: [{ type: 'function', name: 'read_file' }], include: ['reasoning.encrypted_content'],
      input: [
        { type: 'additional_tools', role: 'developer', tools: [{ name: 'x' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'gAAAA' + b64n(1200) },
        { type: 'function_call', call_id: 'c', name: 'exec', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: 'done' }] })),
    jreq('POST', 'generativelanguage.googleapis.com', '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'ok', thoughtSignature: b64n(900) }] }],
        systemInstruction: { parts: [{ text: 's' }] } })
  ];
  cases.forEach((raw, i) => assert.equal(releasable(raw), true, `case ${i}: ${raw.toString('utf8').slice(0, 200)}`));
});

test('releasableUnderFailOpen: attachments and unknown shapes are all held (attachments_and_unknown_shapes_are_held)', () => {
  const pdf = b64n(4000);
  const small = b64n(64);
  const bare = (head, body = '{"messages":[]}') => Buffer.from(head + '\r\n\r\n' + body);
  const cases = [
    ['unknown host', jreq('POST', 'api.example', '/v1/messages', { messages: [] })],
    ['unknown route', jreq('POST', 'api.anthropic.com', '/v1/files', {})],
    ['GET', req('GET', 'api.anthropic.com', '/v1/messages', null, '')],
    ['PUT text upload', req('PUT', 'api.anthropic.com', '/v1/messages', 'text/plain', 'Jane Doe 123-45-6789')],
    ['docx', req('POST', 'api.anthropic.com', '/v1/messages', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK')],
    ['svg', req('POST', 'api.anthropic.com', '/v1/messages', 'image/svg+xml', '<svg/>')],
    ['xml', req('POST', 'api.anthropic.com', '/v1/messages', 'application/xml', '<a/>')],
    ['multipart boundary holding json', req('POST', 'api.anthropic.com', '/v1/messages', 'multipart/form-data; boundary=json-xml-1', '--json-xml-1--')],
    ['json with a foreign parameter', req('POST', 'api.anthropic.com', '/v1/messages', 'application/json; boundary=x', '{"messages":[]}')],
    ['no content-type (Guard drift)', req('POST', 'api.anthropic.com', '/v1/messages', null, '{"messages":[{"role":"user","content":"hi"}]}')],
    ['gzip', bare('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-encoding: gzip', '{}')],
    ['bare LF head', Buffer.from('POST /v1/messages HTTP/1.1\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')],
    ['space before colon', bare('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type : application/json')],
    ['two content-types', bare('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Type: application/pdf')],
    ['two hosts', bare('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nHost: evil\r\ncontent-type: application/json')],
    ['other port', jreq('POST', 'api.anthropic.com:8443', '/v1/messages', { messages: [] })],
    ['not json', req('POST', 'api.anthropic.com', '/v1/messages', 'application/json', '{nope')],
    ['anthropic image', anth({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: small } }] }] })],
    ['anthropic document', anth({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }] }] })],
    ['anthropic file id', anth({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }] }] })],
    ['tool reference with content', anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_reference', tool_name: 'x', data: 'y' }] }] }] })],
    ['tool reference name too long', anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_reference', tool_name: 'x'.repeat(257) }] }] }] })],
    ['image inside a tool result', anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { data: small } }] }] }] })],
    ['signature key abuse', anth({ signature: pdf, messages: [{ role: 'user', content: 'hi' }] })],
    ['signature on a text block', anth({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', signature: pdf }] }] })],
    ['split base64 runs', anth({ x: Array.from({ length: 20 }, () => b64n(500)), messages: [{ role: 'user', content: 'hi' }] })],
    ['number array', anth({ x: Array.from({ length: 400 }, (_, i) => i), messages: [{ role: 'user', content: 'hi' }] })],
    ['unknown message key', anth({ messages: [{ role: 'user', content: 'hi', file: pdf }] })],
    ['unknown anthropic parameter', anth({ container: 'c', messages: [{ role: 'user', content: 'hi' }] })],
    ['anthropic mcp servers', anth({ mcp_servers: [], messages: [{ role: 'user', content: 'hi' }] })],
    ['anthropic unknown role', anth({ messages: [{ role: 'tool', content: 'hi' }] })],
    ['openai prediction', jreq('POST', 'api.openai.com', '/v1/chat/completions', { prediction: { type: 'content', content: 'x' }, messages: [{ role: 'user', content: 'hi' }] })],
    ['responses unknown parameter', jreq('POST', 'api.openai.com', '/v1/responses', { input: 'hi', attachments_blob: 'x' })],
    ['gemini api cachedContent', jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { cachedContent: 'cachedContents/1', contents: [{ parts: [{ text: 'hi' }] }] })],
    ['claude.ai extracted_content', jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'summarize', attachments: [{ file_name: 'p.csv', extracted_content: 'Jane Doe 123-45-6789' }] })],
    ['claude.ai file ids', jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'x', files: ['84aa'] })],
    ['claude.ai upload route', req('POST', 'claude.ai', '/api/organizations/o/conversations/c/wiggle/upload-file', 'multipart/form-data; boundary=x', '--x--')],
    ['claude.ai attachment under another key', jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'x', pasted_attachment: { content: 'Jane' } })],
    ['chatgpt multimodal', jreq('POST', 'chatgpt.com', '/backend-api/f/conversation', { messages: [{ content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'file-service://x' }, 'hi'] } }] })],
    ['chatgpt metadata attachments', jreq('POST', 'chatgpt.com', '/backend-api/f/conversation', { messages: [{ content: { content_type: 'text', parts: ['hi'] }, metadata: { attachments: [{ id: 'file-1', name: 'a.pdf' }] } }] })],
    ['chatgpt prepare with files picked', jreq('POST', 'chatgpt.com', '/backend-api/f/conversation/prepare', { attachment_mime_types: ['application/pdf'] })],
    ['chatgpt files route', jreq('POST', 'chatgpt.com', '/backend-api/files', { file_name: 'a.pdf' })],
    ['gemini attachment', req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded;charset=UTF-8',
      geminiBody(['the sky is blue', 0, null, [[['/upload/x', 3, null, 'text/plain', 'id'], 'the sky is blue.txt']], null, null, 0]))],
    ['gemini extra form field', req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', `${geminiBody(['hi'])}&file=${pdf}`)],
    ['gemini processSession', req('POST', 'geminiweb-pa.clients6.google.com', '/v1/processSession', 'application/x-www-form-urlencoded', 'req0___data__=x')],
    ['duck inline small file', jreq('POST', 'duck.ai', '/duckchat/v1/chat', { messages: [{ role: 'user', content: 'see file', parts: [{ type: 'file', content: small, mimeType: 'text/plain' }] }] })],
    ['duck image part', jreq('POST', 'duck.ai', '/duckchat/v1/chat', { messages: [{ role: 'user', content: [{ type: 'image', image: `data:image/png;base64,${small}` }] }] })],
    ['openai image_url', jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] })],
    ['openai file part', jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: small } }] }] })],
    ['responses input_file', jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ role: 'user', content: [{ type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,AA' }] }] })],
    ['responses input_image', req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', null, JSON.stringify({ type: 'response.create', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] }] }))],
    ['ws not response.create', req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', null, JSON.stringify({ type: 'session.update', input: 'hi' }))],
    ['ws binary', Buffer.concat([Buffer.from('WS-SEND /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'), Buffer.from([0xff, 0xfe, 0, 1])])],
    ['ws over the cap', req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', null, JSON.stringify({ type: 'response.create', input: 'x'.repeat(MAX_RELEASABLE_BODY) }))],
    ['gemini api inlineData', jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ inlineData: { mimeType: 'application/pdf', data: small } }, { text: 'hi' }] }] })],
    ['gemini api fileData', jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ fileData: { fileUri: 'https://x/files/1' } }] }] })],
    ['gemini api upload', jreq('POST', 'generativelanguage.googleapis.com', '/upload/v1/files', { file: { display_name: 'a.pdf' } })]
  ];
  assert.equal(cases.length, 57, 'every Rust case is ported');
  for (const [name, raw] of cases) assert.equal(releasable(raw), false, `${name} must be held`);
});

test('releasableUnderFailOpen: framing edges, 6 MiB cap +/- 1 (framing_edges)', () => {
  const ok = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(releasable(jreq('POST', 'api.anthropic.com:443', '/v1/messages?beta=true', ok)), true);
  assert.equal(releasable(req('POST', 'api.anthropic.com', '/v1/messages', 'Application/JSON; charset=UTF-8', JSON.stringify(ok))), true);
  assert.equal(releasable(Buffer.from('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-encoding: identity\r\n\r\n{"messages":[]}')), true);
  const bad = [
    'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n',
    'POST /v1/messages HTTP/1.0\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}',
    'POST http://api.anthropic.com/v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}',
    'POST /v1/messages HTTP/1.1\r\ncontent-type: application/json\r\n\r\n{"messages":[]}',
    'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n{"messages":[]}',
    'POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nno colon here\r\ncontent-type: application/json\r\n\r\n{"messages":[]}',
    'POST /v1/messages HTTP/1.1 extra\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}'
  ].map((s) => Buffer.from(s));
  bad.push(Buffer.concat([Buffer.from('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n'), Buffer.from([0xff])]));
  for (const b of bad) assert.equal(releasable(b), false, b.toString('latin1'));
  const base = '{"messages":[{"role":"user","content":""}]}';
  const pad = (n) => `{"messages":[{"role":"user","content":"${'a'.repeat(n - base.length)}"}]}`;
  assert.equal(releasable(req('POST', 'api.anthropic.com', '/v1/messages', 'application/json', pad(MAX_RELEASABLE_BODY))), true);
  assert.equal(releasable(req('POST', 'api.anthropic.com', '/v1/messages', 'application/json', pad(MAX_RELEASABLE_BODY + 1))), false);
});

test('releasableUnderFailOpen: opaque limits, deny keys, the per-request budget (opaque_limits_and_deny_keys)', () => {
  const chat = (extra) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/f/conversation',
    { messages: [{ content: { content_type: 'text', parts: ['hi'] } }], x: extra }));
  assert.equal(chat('a '.repeat(MAX_OPAQUE_STRING / 2)), true);
  assert.equal(chat(`${'a '.repeat(MAX_OPAQUE_STRING / 2)} `), false);
  // A bare base64 run is a file's bytes from 512 on; any other character and it is not a run.
  assert.equal(chat('Q'.repeat(511)), true);
  assert.equal(chat('Q'.repeat(512)), false);
  assert.equal(chat('Q'.repeat(512) + '+/-_='), false);
  assert.equal(chat('Q'.repeat(512) + '!'), true);
  assert.equal(chat(' data:text/plain;base64,QQ=='), false);
  assert.equal(chat('DATA:x;BASE64,QQ'), false);
  assert.equal(chat('data: not a uri'), true);
  assert.equal(chat('see ;base64, in the docs'), true);
  assert.equal(chat(Array(MAX_OPAQUE_ARRAY).fill(1)), true);
  assert.equal(chat(Array(MAX_OPAQUE_ARRAY + 1).fill(1)), false);
  assert.equal(chat({ deep: { image_url: 'x' } }), false);
  // An empty attachment-ish setting is not an attachment.
  assert.equal(chat({ files: [], image: null, upload: false, blob: '' }), true);
  // Non-empty ones are, whatever the value type (0 and true are not empty).
  for (const v of [0, true, 'x', [0], { a: 1 }]) assert.equal(chat({ files: v }), false, JSON.stringify(v));
  // deny_key, by what it does to a request: each of these names an attachment.
  for (const k of ['Attachments', 'FILE_ids', 'inlineData', 'extracted_x', 'audio', 'video', 'media_type',
    'base64', 'dataUrl', 'data_url', 'documents', 'blob', 'upload', 'images']) {
    assert.equal(chat({ [k]: 'v' }), false, k);
  }
  for (const k of ['signature', 'prompt', 'metadata', 'kind', 'data']) assert.equal(chat({ [k]: 'v' }), true, k);
  // Many short strings, each under every per-item limit, past the total.
  const chunks = Array.from({ length: 10 }, () => 'a '.repeat(1000));
  assert.equal(chat(chunks.slice(0, 3)), true);
  assert.equal(chat(chunks.slice(0, 5)), false);
  assert.equal(chat({ a: chunks.slice(0, 2), b: chunks.slice(0, 3) }), false);
  assert.equal(chat(Array.from({ length: 40 }, () => Array(60).fill(255))), false);
  // The budget is per request, not per call history.
  assert.equal(chat(chunks.slice(0, 3)), true);
  // Object keys spend their length; scalars spend 8 (8192 / 8 = 1024 numbers fit, spread under the array cap).
  const keys = Object.fromEntries(Array.from({ length: 90 }, (_, i) => ['k'.repeat(200) + i, 1]));
  assert.equal(chat(keys), false, 'keys count against the budget');
  const nums = Array.from({ length: 15 }, () => Array(64).fill(1)); // 960 numbers = 7680 + nothing else
  assert.equal(chat(nums), true);
  const nums2 = Array.from({ length: 20 }, () => Array(64).fill(1)); // 1280 numbers = 10240 > budget
  assert.equal(chat(nums2), false);
});

test('releasableUnderFailOpen: form decoding of the Gemini token, as the Rust decoder does', () => {
  const g = (at) => releasable(req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded',
    geminiBody(['hi']).replace('at=AJvLN6M', `at=${at}`)));
  assert.equal(g('a%2Bb+c'), true);
  assert.equal(g('%zz'), false);
  assert.equal(g('%4'), false);
  assert.equal(g('%ff'), false, 'decodes to non UTF-8');
  assert.equal(g('%C3%A9'), true, 'a valid multi-byte escape');
  assert.equal(g('%+f'), true, 'u8::from_str_radix takes one leading +');
  assert.equal(g('%-1'), false);
  assert.equal(g('x'.repeat(MAX_OPAQUE_STRING)), true);
  assert.equal(g('x'.repeat(MAX_OPAQUE_STRING + 1)), false);
  // Two f.req fields, or no f.req, or an empty body.
  const one = geminiBody(['hi']);
  assert.equal(releasable(req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', `${one}&${one.split('&')[0]}`)), false);
  assert.equal(releasable(req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', 'at=x')), false);
  assert.equal(releasable(req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', '')), false);
  // The turn: a string then scalars; the outer first member null; the form media type exact.
  const raw = (outer) => req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', `f.req=${formEnc(JSON.stringify(outer))}`);
  const inner = (turn, ...o) => JSON.stringify([turn, ...o]);
  assert.equal(releasable(raw([null, inner(['hi', 1, null, true])])), true);
  assert.equal(releasable(raw([1, inner(['hi'])])), false, 'first member must be null');
  assert.equal(releasable(raw([null])), false);
  assert.equal(releasable(raw([null, 5])), false, 'inner must be a string');
  assert.equal(releasable(raw([null, inner(['hi', []])])), false);
  assert.equal(releasable(raw([null, inner(['hi', 'two'])])), false);
  assert.equal(releasable(raw([null, inner([1, 'hi'])])), false);
  assert.equal(releasable(raw([null, inner([])])), false);
  assert.equal(releasable(raw([null, '[]'])), false);
  assert.equal(releasable(raw([null, inner(['hi'], { image: 'x' })])), false, 'others are opaque');
  assert.equal(releasable(raw([null, inner(['hi']), { file: 'x' }])), false, 'outer rest is opaque');
  assert.equal(releasable(req('POST', 'gemini.google.com', GEMINI, 'application/json', geminiBody(['hi']))), false);
});

test('releasableUnderFailOpen: routes (routes)', () => {
  const gem = (p) => releasable(jreq('POST', 'generativelanguage.googleapis.com', p, { contents: [{ parts: [{ text: 'hi' }] }] }));
  assert.equal(gem('/v1beta/models/gemini-2.5-flash:generateContent'), true);
  assert.equal(gem('/v1/models/g:countTokens'), true);
  assert.equal(gem('/v1/models/g:streamGenerateContent'), true);
  assert.equal(gem('/v1/models/g:embedContent'), false);
  assert.equal(gem('/v1/models/:generateContent'), false);
  assert.equal(gem('/v1/tunedModels/g:generateContent'), false);
  assert.equal(gem('/v1/models/g:generateContent/x'), false);
  assert.equal(gem('/upload/v1/models/g:generateContent'), false);
  assert.equal(gem('/x1/models/g:generateContent'), false, 'version must start with v');
  assert.equal(gem('/v1/models/g'), false);
  const cl = (p) => [{ prompt: 'x' }, { message_content: 'x' }].some((b) => releasable(jreq('POST', 'claude.ai', p, b)));
  assert.equal(cl('/api/organizations/o/chat_conversations/c/completion'), true);
  assert.equal(cl('/api/organizations/o/chat_conversations/c/retry_completion'), true);
  assert.equal(cl('/api/organizations/o/chat_conversations/c/title'), true);
  assert.equal(cl('/api/organizations/o/chat_conversations/c/completion/x'), false);
  assert.equal(cl('/api/organizations/o/conversations/c/completion'), false);
  assert.equal(cl('/api/organizations//chat_conversations/c/completion'), false);
  assert.equal(cl('/api/organizations/o/chat_conversations//completion'), false);
  assert.equal(cl('/api/organizations/o/chat_conversations/c/upload'), false);
  assert.equal(cl('/api/organizations/o/chat_conversations/c'), false);
  // Per-route body rules: retry may omit the prompt, completion may not; title has its own keys.
  const c = (leaf, b) => releasable(jreq('POST', 'claude.ai', `/api/organizations/o/chat_conversations/c/${leaf}`, b));
  assert.equal(c('retry_completion', {}), true);
  assert.equal(c('completion', {}), false);
  assert.equal(c('retry_completion', { prompt: null }), true);
  assert.equal(c('title', { message_content: 'x', recent_titles: [1] }), false);
  assert.equal(c('title', { message_content: 'x', recent_titles: Array(65).fill('a') }), false);
  assert.equal(c('title', { message_content: 'x', extra: 1 }), false);
  // chatgpt's prepare may not carry messages; the codex WS route is WS-SEND only on chatgpt.com.
  assert.equal(releasable(jreq('POST', 'chatgpt.com', '/backend-api/conversation/prepare', { messages: [] })), false);
  assert.equal(releasable(jreq('POST', 'chatgpt.com', '/backend-api/conversation', { messages: [] })), false, 'empty messages');
  assert.equal(releasable(jreq('POST', 'chat.openai.com', '/backend-api/codex/responses', { input: 'hi' })), true);
  assert.equal(releasable(req('WS-SEND', 'chat.openai.com', '/backend-api/codex/responses', null, '{"type":"response.create","input":"hi"}')), false);
  assert.equal(releasable(req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', null, '{"type":"response.create","input":"hi"}')), true);
  assert.equal(releasable(req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', 'text/plain', '{"type":"response.create","input":"hi"}')), false);
  assert.equal(releasable(jreq('POST', 'duckduckgo.com', '/duckchat/v1/chat', { messages: [{ role: 'user', content: 'hi' }] })), true);
});

test('releasableUnderFailOpen: per-surface params and block edges that Rust pins', () => {
  const M = [{ role: 'user', content: 'hi' }];
  const oa = (extra) => releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: M, ...extra }));
  assert.equal(oa({ temperature: 1 }), true);
  assert.equal(oa({ modalities: ['audio'] }), false);
  assert.equal(oa({ audio: { voice: 'x' } }), false);
  const rs = (extra) => releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'hi', ...extra }));
  assert.equal(rs({ reasoning: { effort: 'low' }, store: false }), true);
  assert.equal(rs({ container: 'x' }), false);
  const ge = (extra) => releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ text: 'hi' }] }], ...extra }));
  assert.equal(ge({ generationConfig: { temperature: 1 } }), true);
  assert.equal(ge({ cachedContent: 'x' }), false);
  assert.equal(ge({ contents: [{ parts: [{}] }] }), false, 'an empty part');
  assert.equal(ge({ contents: [{ role: 'user', extra: 1, parts: [{ text: 'a' }] }] }), false);
  const an = (extra) => releasable(anth({ messages: M, ...extra }));
  assert.equal(an({ thinking: { type: 'enabled', budget_tokens: 5 }, thread: { id: 't' } }), true);
  assert.equal(an({ system: 'text' }), true);
  assert.equal(an({ system: [{ type: 'text', text: 'a' }] }), true);
  assert.equal(an({ system: [{ type: 'image' }] }), false);
  assert.equal(an({ system: 5 }), false);
  assert.equal(an({ tools: [{ name: 't', input_schema: { image: 'a '.repeat(4500) } }] }), true, 'tool definitions are authored JSON: free text and keys');
  assert.equal(an({ tool_choice: { type: 'auto', file: 'x' } }), true, 'tool_choice is skipped');
  assert.equal(an({ stop_sequences: ['a'.repeat(5000)] }), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'tool_use', name: 'x', input: [] }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'tool_use', name: 'x', input: { a: 'a '.repeat(4500) } }] }] })), true, 'what the model wrote');
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 't', signature: 5 }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 't', extra: 1 }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'redacted_thinking', data: 5 }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', image: 'x' } }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a', citations: [] }] }] })), true);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'text', text: 5 }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: null }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true }] }] })), true);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', extra: 1 }] }] })), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: 5 }] })), false);
  assert.equal(releasable(anth({ messages: 'x' })), false);
  assert.equal(releasable(anth([])), false);
  assert.equal(releasable(anth({ messages: [{ role: 'user', content: 'hi', cache: { image: 'x' } }] })), false);
  // chat completions
  const cc = (m) => releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [m] }));
  assert.equal(cc({ role: 'assistant', refusal: 'no', content: [{ type: 'refusal', refusal: 'no' }] }), true);
  assert.equal(cc({ role: 'user', content: [{ type: 'text', text: 'a', extra: 1 }] }), false);
  assert.equal(cc({ role: 1, content: 'a' }), false);
  assert.equal(cc({ role: 'user', content: 5 }), false);
  assert.equal(cc({ role: 'assistant', tool_calls: 'x' }), false);
  assert.equal(cc({ role: 'assistant', tool_calls: [{ id: '1', function: { name: 'f', arguments: 5 } }] }), false);
  assert.equal(cc({ role: 'assistant', tool_calls: [{ id: '1', function: null }] }), false);
  assert.equal(cc({ role: 'assistant', tool_calls: [{ id: '1', custom: { input: 'x' } }] }), true);
  assert.equal(cc({ role: 'assistant', tool_calls: [{ id: '1', bad: 1 }] }), false);
  assert.equal(cc({ role: 'assistant', tool_calls: [{ id: '1', function: { name: 'f', file: 'x' } }] }), false);
  // responses
  const ri = (item) => releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [item] }));
  assert.equal(ri({ role: 'user', content: 'hi' }), true, 'easy message (no type)');
  assert.equal(ri({ type: 7, role: 'user', content: 'hi' }), true, 'a non-string type reads as untyped');
  assert.equal(ri({ type: 'message', role: 1, content: 'hi' }), false);
  assert.equal(ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a', annotations: [{ file: 'x' }] }] }), false);
  assert.equal(ri({ type: 'message', role: 'user', content: [{ type: 'input_image', text: 'a' }] }), false);
  assert.equal(ri({ type: 'message', role: 'user' }), false);
  assert.equal(ri({ type: 'configuration_update', reasoning: { effort: 'low' } }), true);
  assert.equal(ri({ type: 'configuration_update', reasoning: { file: 'x' } }), false);
  assert.equal(ri({ type: 'configuration_update', other: 1 }), false);
  assert.equal(ri({ type: 'reasoning', summary: [], content: null, encrypted_content: null }), true);
  assert.equal(ri({ type: 'reasoning', summary: 5 }), false);
  assert.equal(ri({ type: 'reasoning', encrypted_content: 5 }), false);
  assert.equal(ri({ type: 'function_call', name: 'a', arguments: null }), true);
  assert.equal(ri({ type: 'function_call', name: 5 }), false);
  assert.equal(ri({ type: 'local_shell_call', action: { command: ['ls'] } }), true);
  assert.equal(ri({ type: 'local_shell_call', action: { blob: 'x' } }), false);
  assert.equal(ri({ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_text', text: 'x' }] }), true);
  assert.equal(ri({ type: 'function_call_output', call_id: 'c', output: 5 }), false);
  assert.equal(ri({ type: 'additional_tools', tools: [{ big: 'a '.repeat(4500) }] }), true);
  assert.equal(ri({ type: 'additional_tools', extra: 1 }), false);
  assert.equal(ri({ type: 'input_file' }), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 5 })), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'a', instructions: 5 })), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'a', instructions: null })), true);
  // duck
  const dk = (m, extra) => releasable(jreq('POST', 'duck.ai', '/duckchat/v1/chat', { messages: [m], ...extra }));
  assert.equal(dk({ role: 'system', content: 'a' }), false);
  assert.equal(dk({ role: 'user', content: 'a', extra: 1 }), false);
  assert.equal(dk({ role: 'user', content: [{ type: 'text', text: 'a', extra: 1 }] }), false);
  assert.equal(dk({ role: 'user', content: 5 }), false);
  assert.equal(dk({ role: 'user', content: 'a' }, { attachment: 'x' }), false);
  // chatgpt message edges
  const cg = (m) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/conversation', { messages: [m] }));
  assert.equal(cg({ content: { content_type: 'text', parts: ['a'], extra: 1 } }), false);
  assert.equal(cg({ content: { content_type: 'text', parts: [1] } }), false);
  assert.equal(cg({ content: { content_type: 'text', parts: 'a' } }), false);
  assert.equal(cg({ content: 'a' }), false);
  assert.equal(cg(5), false);
  assert.equal(cg({ content: { content_type: 'text', parts: ['a'] }, id: 'a'.repeat(5000) }), false);
});

test('releasableUnderFailOpen: header and body parsing the way Rust reads them', () => {
  const head = (extra) => Buffer.from(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n${extra}\r\n\r\n{"messages":[{"role":"user","content":"hi"}]}`);
  const ct = 'content-type: application/json';
  assert.equal(releasable(head(ct)), true);
  assert.equal(releasable(head(`${ct}; charset="utf-8"`)), true);
  assert.equal(releasable(head(`${ct};`)), true, 'an empty parameter');
  assert.equal(releasable(head(`${ct}; charset=latin1`)), false);
  assert.equal(releasable(head(`${ct}\r\nContent-Encoding: `)), true, 'an empty encoding is none');
  assert.equal(releasable(head(`${ct}\r\nContent-Encoding: br`)), false);
  assert.equal(releasable(head(`${ct}\r\nTransfer-Encoding: identity`)), false);
  assert.equal(releasable(head(`${ct}\r\nX-Odd: a\rb`)), false, 'a bare CR inside a line');
  assert.equal(releasable(head(`${ct}\r\n: nameless`)), false);
  assert.equal(releasable(head(`${ct}\r\nX_Under: 1`)), false, 'underscore is not in a header name');
  assert.equal(releasable(head(`${ct}\r\nX-Ok: a:b:c`)), true);
  assert.equal(releasable(head(`${ct}\r\nHOST: api.anthropic.com`)), false, 'Host twice, any case');
  assert.equal(releasable(head('CONTENT-TYPE:   APPLICATION/JSON  ')), true, 'values trim and fold');
  assert.equal(releasable(Buffer.from('POST /v1/messages#frag HTTP/1.1\r\nHost: API.Anthropic.COM:443\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')), true);
  assert.equal(releasable(Buffer.from('POST /v1/messages?x#y HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')), true);
  assert.equal(releasable(Buffer.from('POST /v1/messages/ HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')), false);
  assert.equal(releasable(Buffer.from('POST  /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')), false, 'two spaces make four parts');
  assert.equal(releasable(Buffer.from('POST /v1/messages HTTP/1.1\r\nHost: :443\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')), false, 'an empty host');
  assert.equal(releasable(Buffer.from('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com:80\r\ncontent-type: application/json\r\n\r\n{"messages":[]}')), false);
  assert.equal(releasable(Buffer.from('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n{"messages":[]}')), false, 'no blank line');
  // The body is UTF-8 only, BOM included; the head too.
  const body = '{"messages":[{"role":"user","content":"hi"}]}';
  assert.equal(releasable(req('POST', 'api.anthropic.com', '/v1/messages', 'application/json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]))), false, 'BOM');
  assert.equal(releasable(Buffer.concat([Buffer.from('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nX: '), Buffer.from([0xff]), Buffer.from('\r\ncontent-type: application/json\r\n\r\n' + body)])), false, 'non UTF-8 head');
  // Not Uint8Array-like at all.
  assert.equal(releasable(null), false);
  assert.equal(releasable('POST / HTTP/1.1'), false);
  // serde_json parity: what serde would refuse, we refuse.
  const chat = (b) => releasable(req('POST', 'chatgpt.com', '/backend-api/f/conversation', 'application/json', b));
  const msg = '"messages":[{"content":{"content_type":"text","parts":["hi"]}}]';
  assert.equal(chat(`{${msg}}`), true);
  assert.equal(chat(`{${msg},"x":1e999}`), false, 'a number that overflows a double');
  assert.equal(chat(`{${msg},"x":"\\ud800"}`), false, 'a lone surrogate escape');
  assert.equal(chat(`{${msg},"x":"\\ud83d\\ude00"}`), true, 'a surrogate pair');
  assert.equal(chat(`{${msg},"\\udc00":1}`), false, 'in a key');
  assert.equal(chat(`{${msg},"x":${'['.repeat(127)}${']'.repeat(127)}}`), false, 'array 127 deep + the object is 128 levels');
  assert.equal(chat(`{${msg},"x":${'['.repeat(126)}${']'.repeat(126)}}`), true, '127 levels is the most serde reads');
  assert.equal(chat(`{${msg},${msg}}`), false, 'duplicate keys hold, whatever the values');
  assert.equal(chat(`{${msg},"messages":[{"content":{"content_type":"multimodal_text","parts":[]}}]}`), false, 'duplicate keys hold');
  assert.equal(chat(`{${msg},"__proto__":{"image":"x"}}`), false, '__proto__ is an ordinary key');
  assert.equal(chat(`{${msg},"__proto__":"a"}`), true);
  assert.equal(chat(`${'  \n'}{${msg}}  `), true);
  assert.equal(chat(`{${msg}} x`), false);
  assert.equal(chat(`{${msg},}`), false);
  // Byte length, not UTF-16 length, against MAX_OPAQUE_STRING: a 3-byte char x1365 = 4095, x1366 = 4098.
  const euro = String.fromCharCode(0x20ac);
  assert.equal(chat(`{${msg},"x":"${euro.repeat(1365)}"}`), true);
  assert.equal(chat(`{${msg},"x":"${euro.repeat(1366)}"}`), false);
  assert.equal(chat(`{${msg},"x":"${'😀'.repeat(1024)}"}`), true, '4 bytes each = 4096');
  assert.equal(chat(`{${msg},"x":"${'😀'.repeat(1025)}"}`), false);
  // Budget is in bytes: key x (1) + 2 x 4095 + 1 = 8192 passes, one more byte holds (2730 chars would not).
  const e = euro.repeat(1365);
  assert.equal(chat(`{${msg},"x":["${e}","${e}","a"]}`), true);
  assert.equal(chat(`{${msg},"x":["${e}","${e}","a","a"]}`), false);
  // A non-ASCII key is held as an attachment key.
  assert.equal(chat(`{${msg},"${euro}":1}`), false);
});

// ── Locke signed out: only a request nobody called AI may pass ─────────────
//
// The bug (manual test 2026-10-12): since super PR #15 every bodied request on
// every site is held, and with Locke off `decide()` blocked all of them — every
// login, form and POST, including Clerk's sign-in call, so the user could not
// even sign back in to Locke.
//
// The rule, after two adversarial reviews: the pass happens ONLY when Locke is
// DELIBERATELY signed out. The native host says so with the relay code
// `locke-signed-out` (its connect failed AND the desktop app's capture lease
// says signed-out AND no team lock). `no-bridge` and `bridge-unreachable` do
// NOT pass: "unreachable" cannot be told from "crashed mid-screen". Even on
// `locke-signed-out` only `open_web` passes, from a readable page that is not
// an AI surface or API host and has no AI ancestor frame, to a destination
// that is not a catalog API host and not loopback/private/local, with the
// generated API-host list loaded, and never an upload.

const OPEN_WEB_URL = 'https://accounts.example.com/signin/v2/challenge';
// A third-party Clerk tenant: Sonomos's own clerk.sonomos.ai is never held at all.
const CLERK_URL = 'https://clerk.example-app.com/v1/client/sign_ins';
const GOOGLE_LOGIN_URL = 'https://accounts.google.com/v3/signin/_/AccountsSignInUi/data/batchexecute';
const CATALOG_HOST_URL = 'https://chatgpt.com/backend-api/me'; // off CHATGPT_PATHS's capture paths
const CAPTURE_PATH_URL = 'https://chatgpt.com/backend-api/conversation';
const SIGNED_OUT = 'locke-signed-out';
const NO_PASS_CODES = ['no-bridge', 'bridge-unreachable'];
const SIGNED_OUT_COPY = /Locke is signed out.*Sign in to the Locke desktop app, then try again/;

// The REAL generated catalog (web hosts, providers, capture paths, API hosts),
// not the harness's two-host stand-in: AI API hosts read `open_web` (they are
// not web surfaces), and an AI page can hand a prompt to a host the catalog
// never names.
const GENERATED = (() => {
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../content/web-surfaces.generated.js', import.meta.url), 'utf8'), ctx);
  return ctx;
})();
function realCatalogGlobals(pageHref, { ancestors, base, noApi = false, emptyApi = false, framed = false, referrer } = {}) {
  let loc;
  try {
    const u = new URL(pageHref);
    loc = { href: u.href, origin: u.origin, hostname: u.hostname };
  } catch {
    loc = { href: pageHref, origin: 'null', hostname: '' };
  }
  if (ancestors) loc.ancestorOrigins = ancestors;
  const g = {
    location: loc,
    SONOMOS_WEB_HOSTS: [...GENERATED.SONOMOS_WEB_HOSTS],
    SONOMOS_WEB_PROVIDERS: { ...GENERATED.SONOMOS_WEB_PROVIDERS },
    SONOMOS_CAPTURE_PATHS: JSON.parse(JSON.stringify(GENERATED.SONOMOS_CAPTURE_PATHS)),
    SONOMOS_SKIP_PATH_SEGMENTS: JSON.parse(JSON.stringify(GENERATED.SONOMOS_SKIP_PATH_SEGMENTS))
  };
  if (!noApi) g.SONOMOS_API_HOSTS = emptyApi ? [] : [...GENERATED.SONOMOS_API_HOSTS];
  if (base !== undefined || referrer !== undefined) {
    g.document = { ...(base !== undefined ? { baseURI: base } : {}), ...(referrer !== undefined ? { referrer } : {}) };
  }
  // The harness's `window.top` is the window itself unless a test says otherwise.
  if (framed) g.top = {};
  return g;
}
const REVIEW_PROMPT = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Patient Jane Roe SSN 078-05-1120' }] });
const NON_AI_PAGE = 'https://www.sonomos.ai/';
const BYOK = 'https://chat.example-byok.app/';
const down = (code) => () => ({ ok: false, code, message: 'down' });
// Run one POST through fetch; resolves 'SENT' | 'BLOCKED' and the world.
async function fetchOutcome(code, globals, url, init = { method: 'POST', body: REVIEW_PROMPT }) {
  const w = makeDebugWorld(down(code), globals);
  let outcome;
  try { await w.sandbox.fetch(url, init); outcome = w.netCalls.length ? 'SENT' : 'no-net'; }
  catch (e) { outcome = blockedError(e) ? 'BLOCKED' : `ERR:${e.message}`; }
  return { outcome, w };
}

test('locke-signed-out: open_web from a non-AI page sends the original (Clerk, Google login), under its own reason', async () => {
  const captured = [];
  const w = makeDebugWorld((msg) => {
    captured.push(msg);
    return { ok: false, code: SIGNED_OUT, message: 'signed out' };
  }, realCatalogGlobals(NON_AI_PAGE));
  for (const url of [OPEN_WEB_URL, CLERK_URL, GOOGLE_LOGIN_URL]) {
    await w.sandbox.fetch(url, { method: 'POST', body: 'user=a&pass=b' });
  }
  assert.deepEqual(captured.map((m) => m.coverage), ['open_web', 'open_web', 'open_web']);
  assert.equal(w.netCalls.length, 3, 'all three logins went out');
  assert.equal(w.netCalls[0][0], OPEN_WEB_URL);
  const line = assertReason(w.logs, 'locke-unreachable-unclassified', 'debug');
  assert.match(line, /\bcode=locke-signed-out\b/);
  assert.match(line, /\bcoverage=open_web\b/);
  // Distinguishable from a screened allow and from the user's fail-open window.
  assert.ok(!findLine(w.logs, 'allow'));
  assert.ok(!findLine(w.logs, 'unchecked-fail-open'));
  assert.equal(w.unchecked.length, 0, 'not tallied as an unchecked send: it was never judged AI');
});

test('locke-signed-out: an open_web XHR is released too', async () => {
  const w = makeXhrWorld(down(SIGNED_OUT), { extraGlobals: realCatalogGlobals(NON_AI_PAGE) });
  const xhr = new w.sandbox.XMLHttpRequest();
  xhr.open('POST', CLERK_URL, true);
  xhr.send('a=b');
  await waitFor(() => xhr.sent.length === 1);
  assert.deepEqual(xhr.sent, ['a=b']);
  assert.equal(xhr.aborted, false);
  assert.ok(!w.logs.some((l) => l.level === 'warn'), 'a pass is not a warning');
});

test('no-bridge and bridge-unreachable BLOCK open_web, fetch and XHR (reverses ea36703/56dffaa)', async () => {
  for (const code of NO_PASS_CODES) {
    const captured = [];
    const w = makeDebugWorld((msg) => { captured.push(msg); return { ok: false, code, message: 'down' }; },
      realCatalogGlobals(NON_AI_PAGE));
    for (const url of [OPEN_WEB_URL, CLERK_URL, GOOGLE_LOGIN_URL]) {
      await assert.rejects(w.sandbox.fetch(url, { method: 'POST', body: 'a=b' }), blockedError, `${code} ${url}`);
    }
    assert.deepEqual(captured.map((m) => m.coverage), ['open_web', 'open_web', 'open_web'], code);
    assert.equal(w.netCalls.length, 0, code);
    assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'), code);

    const x = makeXhrWorld(down(code), { extraGlobals: realCatalogGlobals(NON_AI_PAGE) });
    const xhr = new x.sandbox.XMLHttpRequest();
    xhr.open('POST', CLERK_URL, true);
    xhr.send('a=b');
    await waitFor(() => xhr.aborted);
    assert.deepEqual(xhr.sent, [], code);
  }
  // And the words: no-bridge still says the connector did not start;
  // bridge-unreachable keeps the sentence it had at 470d493.
  const nb = await blockedByRelayCode('no-bridge');
  assert.equal(nb.sonomosBlockReason, 'connector-not-started');
  const bu = await blockedByRelayCode('bridge-unreachable');
  assert.equal(bu.sonomosBlockReason, 'bridge-unreachable');
});

test('bridge-dropped blocks with the "try again shortly" copy bridge-unreachable had at 470d493', async () => {
  const xhr = await blockedByRelayCode('bridge-dropped', 'eof');
  assert.equal(xhr.sonomosBlockReason, 'bridge-dropped');
  assert.equal(xhr.sonomosBlockKind, 'unavailable');
  assert.match(xhr.sonomosBlockMessage,
    /the Locke desktop app answered, but it could not reach its screening service — this is NOT a sensitive-data block\. Try again shortly; if it keeps happening, restart Locke\./);
  assert.doesNotMatch(xhr.sonomosBlockMessage, /Start it/);
  assert.deepEqual(xhr.sent, []);
  // Also on open_web from a non-AI page: Locke was reached, so nothing passes.
  const { outcome, w } = await fetchOutcome('bridge-dropped', realCatalogGlobals(NON_AI_PAGE), OPEN_WEB_URL);
  assert.equal(outcome, 'BLOCKED');
  assert.equal(w.netCalls.length, 0);
  assertBlocked(w.logs, 'bridge-dropped');
});

test('locke-signed-out: catalog_host, capture_path and upload block with the signed-out copy', async () => {
  // catalog_host (an AI host off its prompt paths) — and, since 2026-10-16,
  // a same-host upload off those paths is `capture_path`: a user's file on
  // the AI host itself never goes to the classifier (SP14: claude.ai moved
  // its attach button and every .txt left raw). Both block here all the same.
  {
    const captured = [];
    const w = makeDebugWorld((msg) => { captured.push(msg); return { ok: false, code: SIGNED_OUT, message: 'x' }; }, CHATGPT_PATHS);
    await assert.rejects(w.sandbox.fetch(CATALOG_HOST_URL, { method: 'POST', body: '{}' }), blockedError);
    await assert.rejects(w.sandbox.fetch(DICTATION_URL, { method: 'POST', body: dictationForm() }), blockedError);
    assert.deepEqual(captured.map((m) => m.coverage), ['catalog_host', 'capture_path']);
    assert.equal(w.netCalls.length, 0);
    assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'));
    const line = assertBlocked(w.logs, 'locke-signed-out');
    assert.match(line, /kind=unavailable/);
  }
  // capture_path
  {
    const w = makeWorld(down(SIGNED_OUT), CHATGPT_PATHS);
    await assert.rejects(w.sandbox.fetch(CAPTURE_PATH_URL, { method: 'POST', body: '{"prompt":"x"}' }),
      (e) => blockedError(e) && SIGNED_OUT_COPY.test(e.message));
    assert.equal(w.netCalls.length, 0);
    const d = makeWorld(down(SIGNED_OUT));
    await assert.rejects(d.sandbox.fetch(AI_URL, { method: 'POST', body: 'x' }), blockedError);
    assert.equal(d.netCalls.length, 0);
  }
  // SCOPE.UPLOAD, fetch and XHR
  {
    const form = () => s3PolicyForm(new Blob(['Jane Roe, SSN 078-05-1120'], { type: 'text/plain' }));
    const w = makeWorld(down(SIGNED_OUT));
    await assert.rejects(w.sandbox.fetch(S3_POST, { method: 'POST', body: form() }),
      (e) => blockedError(e) && SIGNED_OUT_COPY.test(e.message));
    assert.equal(w.netCalls.length, 0);
    assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'));
    const world = makeXhrWorld(down(SIGNED_OUT));
    const xhr = new world.sandbox.XMLHttpRequest();
    xhr.open('POST', S3_POST, true);
    xhr.send(form());
    await waitFor(() => xhr.aborted);
    assert.deepEqual(xhr.sent, []);
    assert.equal(xhr.sonomosBlockReason, 'locke-signed-out');
    assert.match(xhr.sonomosBlockMessage, SIGNED_OUT_COPY);
  }
  // The same on every no-pass code: catalog hosts never pass.
  for (const code of NO_PASS_CODES) {
    const w = makeDebugWorld(down(code), CHATGPT_PATHS);
    await assert.rejects(w.sandbox.fetch(CATALOG_HOST_URL, { method: 'POST', body: '{}' }), blockedError, code);
    assert.equal(w.netCalls.length, 0, code);
  }
});

test('locke-signed-out: the copy is honest and the code is in the evidence lists', () => {
  assert.match(SHIM_SRC, /'locke-signed-out': \['unavailable',\s*'Locke is signed out, so this request could not be screened/);
  assert.ok(RELAY_FAILURES_PROVING_NO_SCREEN.includes('locke-signed-out'));
  assert.ok(RELAY_FAILURES_PROVING_NO_VERDICT.includes('bridge-dropped'));
  assert.deepEqual(/const UNREACHABLE_RELAY_CODES = new Set\(\[([^\]]*)\]\)/.exec(SHIM_SRC)[1].trim(), "'locke-signed-out', 'locke-not-set-up'");
});

// `locke-not-set-up`: the service worker's code for a browser that has never
// reached the desktop app (a fresh store install). Same narrow pass as
// signed-out: logins and checkouts work, AI traffic still blocks, and the
// block names the missing app.
const NOT_SET_UP = 'locke-not-set-up';
const NOT_SET_UP_COPY = /Locke isn’t set up in this browser yet.*sonomos\.ai\/downloads/;

test('locke-not-set-up: open_web from a non-AI page sends the original, under its own reason', async () => {
  const w = makeDebugWorld(down(NOT_SET_UP), realCatalogGlobals(NON_AI_PAGE));
  for (const url of [OPEN_WEB_URL, GOOGLE_LOGIN_URL]) {
    await w.sandbox.fetch(url, { method: 'POST', body: 'user=a&pass=b' });
  }
  assert.equal(w.netCalls.length, 2, 'both logins went out');
  const line = assertReason(w.logs, 'locke-unreachable-unclassified', 'debug');
  assert.match(line, /\bcode=locke-not-set-up\b/);
  assert.match(line, /\bbecause=locke-not-set-up-not-ai\b/);
});

test('locke-not-set-up: AI hosts, AI pages and uploads still block, and the copy says where to get the app', async () => {
  {
    const w = makeWorld(down(NOT_SET_UP), CHATGPT_PATHS);
    await assert.rejects(w.sandbox.fetch(CAPTURE_PATH_URL, { method: 'POST', body: '{"prompt":"x"}' }),
      (e) => blockedError(e) && NOT_SET_UP_COPY.test(e.message));
    await assert.rejects(w.sandbox.fetch(CATALOG_HOST_URL, { method: 'POST', body: '{}' }), blockedError);
    assert.equal(w.netCalls.length, 0);
  }
  {
    const { outcome } = await fetchOutcome(NOT_SET_UP, realCatalogGlobals(NON_AI_PAGE), 'https://api.openai.com/v1/chat/completions');
    assert.equal(outcome, 'BLOCKED', 'a catalog API host never passes');
  }
  {
    const { outcome } = await fetchOutcome(NOT_SET_UP, realCatalogGlobals('https://chatgpt.com/'), OPEN_WEB_URL);
    assert.equal(outcome, 'BLOCKED', 'an AI page never passes');
  }
  {
    const { outcome } = await fetchOutcome(NOT_SET_UP, realCatalogGlobals(NON_AI_PAGE), 'http://127.0.0.1:11434/api/chat');
    assert.equal(outcome, 'BLOCKED', 'a local model never passes');
  }
  {
    const form = () => s3PolicyForm(new Blob(['Jane Roe, SSN 078-05-1120'], { type: 'text/plain' }));
    const w = makeWorld(down(NOT_SET_UP));
    await assert.rejects(w.sandbox.fetch(S3_POST, { method: 'POST', body: form() }), blockedError);
    assert.equal(w.netCalls.length, 0);
  }
});

test('locke-not-set-up: the code is in the evidence lists and plain no-bridge still blocks open_web', async () => {
  assert.ok(RELAY_FAILURES_PROVING_NO_SCREEN.includes(NOT_SET_UP));
  const { outcome } = await fetchOutcome('no-bridge', realCatalogGlobals(NON_AI_PAGE), OPEN_WEB_URL);
  assert.equal(outcome, 'BLOCKED');
});

test('catalog API hosts block from a non-AI page, both codes (reviewer finding 1)', async () => {
  const targets = [
    'https://api.openai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://openrouter.ai/api/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke',
    'https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/model/x/invoke',
    'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l:predict',
    'https://api.openai.com%2e/v1/chat/completions',
    'https://CHATGPT.COM/backend-api/me', 'https://chatgpt.com./backend-api/me',
    'https://api.individual.githubcopilot.com/chat/completions'
  ];
  for (const code of [SIGNED_OUT, ...NO_PASS_CODES]) {
    for (const url of targets) {
      const { outcome, w } = await fetchOutcome(code, realCatalogGlobals(NON_AI_PAGE), url);
      assert.equal(outcome, 'BLOCKED', `${code} ${url}`);
      assert.equal(w.netCalls.length, 0, `${code} ${url}`);
      assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'), url);
    }
  }
  // Same rule on the XHR path.
  const x = makeXhrWorld(down(SIGNED_OUT), { extraGlobals: realCatalogGlobals(NON_AI_PAGE) });
  const xhr = new x.sandbox.XMLHttpRequest();
  xhr.open('POST', 'https://api.openai.com/v1/chat/completions', true);
  xhr.send(REVIEW_PROMPT);
  await waitFor(() => xhr.aborted);
  assert.deepEqual(xhr.sent, []);
});

test('a wildcard api host does not over-match (the label rule)', async () => {
  const { outcome } = await fetchOutcome(SIGNED_OUT, realCatalogGlobals(NON_AI_PAGE),
    'https://bucket.s3.us-east-1.amazonaws.com/x', { method: 'POST', body: 'a=b' });
  assert.equal(outcome, 'SENT');
});

test('a missing or empty SONOMOS_API_HOSTS list refuses the pass (round 2 a)', async () => {
  for (const opt of [{ noApi: true }, { emptyApi: true }]) {
    for (const code of [SIGNED_OUT, ...NO_PASS_CODES]) {
      const { outcome, w } = await fetchOutcome(code, realCatalogGlobals(BYOK, opt), 'https://api.openai.com/v1/chat/completions');
      assert.equal(outcome, 'BLOCKED', `${code} ${JSON.stringify(opt)}`);
      assert.equal(w.netCalls.length, 0);
    }
    // Even a login from a plain page: no list, no pass.
    const { outcome } = await fetchOutcome(SIGNED_OUT, realCatalogGlobals(NON_AI_PAGE, opt), CLERK_URL, { method: 'POST', body: 'a=b' });
    assert.equal(outcome, 'BLOCKED', JSON.stringify(opt));
  }
});

// ── same-host uploads off the allow-list (SP14, 2026-10-16) ─────────
//
// claude.ai moved its attach button from /api/{org}/upload to
// /api/organizations/{org}/conversations/{conv}/wiggle/upload-file. With the
// old path alone in the catalog the shim filed that POST as `catalog_host`,
// the guard's classifier read a 300-byte multipart as not-AI, and every .txt
// attachment reached Anthropic unredacted. Two things close it: the catalog
// names the new path (vendored here), and a file-bearing POST to a catalog
// host on ANY unlisted path is upload scope — the header comment's promise,
// now kept — so the next rename cannot reopen the hole.
const CLAUDE_ORG = '8d3a1c7e-0000-4f00-9c00-abcdef012345';
const CLAUDE_CONV = '1f2e3d4c-1111-4a00-8b00-0123456789ab';
function claudeAttachForm() {
  const form = new FormData();
  form.append('file', new Blob(['Name: Jane Doe\nSSN: 312-45-6789\n'], { type: 'text/plain' }), 'ssn.txt');
  return form;
}
test('claude.ai: the moved attachment upload is a capture path, not a classifier call', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((m) => { captured.push(m); return allowVerdict; }, realCatalogGlobals('https://claude.ai/chat/1'));
  await sandbox.fetch(`https://claude.ai/api/organizations/${CLAUDE_ORG}/conversations/${CLAUDE_CONV}/wiggle/upload-file`,
    { method: 'POST', body: claudeAttachForm() });
  assert.equal(captured.length, 1, 'held and relayed');
  assert.equal(captured[0].coverage, 'capture_path', 'the catalog names this path: screened regardless');
  assert.equal(captured[0].provider, 'anthropic');
  const { head } = splitRaw(rawOf(captured[0].requestB64));
  assert.match(head, /^POST \/api\/organizations\/[0-9a-f-]+\/conversations\/[0-9a-f-]+\/wiggle\/upload-file HTTP\/1\.1\r\nHost: claude\.ai\r\n/);
  assert.equal(netCalls.length, 1, 'an allow releases it');
});
test('claude.ai: a file-bearing POST to a path the allow-list does NOT name is still upload scope', async () => {
  const captured = [];
  const { sandbox } = makeWorld((m) => { captured.push(m); return allowVerdict; }, realCatalogGlobals('https://claude.ai/chat/1'));
  // The next rename, before any catalog catches up with it.
  await sandbox.fetch(`https://claude.ai/api/organizations/${CLAUDE_ORG}/conversations/${CLAUDE_CONV}/attachments/put`,
    { method: 'POST', body: claudeAttachForm() });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].coverage, 'capture_path', 'a user file on the AI host itself never goes to the classifier');
  assert.equal(captured[0].provider, 'anthropic', 'borrowed from the page, as for cross-origin uploads');
});
test('claude.ai: a bodied JSON POST off the allow-list keeps its catalog_host coverage', async () => {
  const captured = [];
  const { sandbox } = makeWorld((m) => { captured.push(m); return allowVerdict; }, realCatalogGlobals('https://claude.ai/chat/1'));
  // Sign-in, settings and conversation reads must keep classifying, not
  // screening: field-agnostic redaction there breaks authentication.
  await sandbox.fetch(`https://claude.ai/api/organizations/${CLAUDE_ORG}/chat_conversations/${CLAUDE_CONV}/current_leaf_message_uuid`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"uuid":"x"}' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].coverage, 'catalog_host', 'no file, not a prompt path: the classifier decides');
});
test('a POST from an AI page to a host the catalog never names blocks (reviewer finding 2)', async () => {
  const bytes = () => new TextEncoder().encode('Jane Roe 078-05-1120');
  const cases = [
    ['chatgpt Sentry', 'https://chatgpt.com/c/1', 'https://o33249.ingest.sentry.io/api/123/envelope/', { method: 'POST', body: REVIEW_PROMPT }],
    ['claude Segment', 'https://claude.ai/chat/1', 'https://api.segment.io/v1/t', { method: 'POST', body: REVIEW_PROMPT, headers: { 'content-type': 'application/json' } }],
    ['chatgpt S3 Uint8Array', 'https://chatgpt.com/c/1', 'https://bucket.s3.amazonaws.com/upload?X-Amz-Signature=x', { method: 'POST', body: bytes() }],
    ['chatgpt PUT presigned', 'https://chatgpt.com/c/1', 'https://files.oaiusercontent.com/file-abc?sig=1', { method: 'PUT', body: 'Jane Roe 078-05-1120' }],
    ['claude untyped Blob', 'https://claude.ai/chat/1', 'https://storage.example-cdn.net/u', { method: 'POST', body: new Blob(['Jane Roe 078-05-1120']) }],
    ['aistudio clients6 RPC', 'https://aistudio.google.com/prompts/new',
      'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent',
      { method: 'POST', body: REVIEW_PROMPT, headers: { 'content-type': 'application/json+protobuf' } }],
    ['duck.ai telemetry', 'https://duck.ai/chat', 'https://improving.duckduckgo.com/t/x', { method: 'POST', body: REVIEW_PROMPT }]
  ];
  for (const code of [SIGNED_OUT, ...NO_PASS_CODES]) {
    for (const [name, page, url, init] of cases) {
      const { outcome, w } = await fetchOutcome(code, realCatalogGlobals(page), url, init);
      assert.equal(outcome, 'BLOCKED', `${code} ${name}`);
      assert.equal(w.netCalls.length, 0, `${code} ${name}`);
      assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'), name);
    }
  }
});

test('a page whose host is a catalog API host blocks (openrouter.ai/chat, round 2 c)', async () => {
  for (const code of [SIGNED_OUT, ...NO_PASS_CODES]) {
    const { outcome } = await fetchOutcome(code, realCatalogGlobals('https://openrouter.ai/chat'),
      'https://us.i.posthog.com/e/');
    assert.equal(outcome, 'BLOCKED', code);
  }
});

test('an opaque data: frame, or a frame built by an AI page, blocks (round 2 b)', async () => {
  const frames = [
    ['data: iframe', realCatalogGlobals('data:text/html,<p>x', { base: 'data:text/html,<p>x' })],
    ['about:srcdoc in chatgpt', realCatalogGlobals('about:srcdoc', { base: 'https://chatgpt.com/c/1' })],
    ['about:blank in claude', realCatalogGlobals('about:blank', { base: 'https://claude.ai/chat/1' })],
    ['blob: frame from chatgpt', realCatalogGlobals('blob:https://chatgpt.com/0b1c', { base: 'blob:https://chatgpt.com/0b1c' })]
  ];
  for (const code of [SIGNED_OUT, ...NO_PASS_CODES]) {
    for (const [name, globals] of frames) {
      const { outcome, w } = await fetchOutcome(code, globals, 'https://o1.ingest.sentry.io/api/1/envelope/');
      assert.equal(outcome, 'BLOCKED', `${code} ${name}`);
      assert.equal(w.netCalls.length, 0, `${code} ${name}`);
    }
  }
});

test('an artifact or sandbox frame inside an AI page blocks via ancestorOrigins (round 2 d)', async () => {
  const frames = [
    ['Claude artifact', 'https://www.claudeusercontent.com/?domain=claude.ai', ['https://claude.ai']],
    ['ChatGPT sandbox', 'https://abc.web-sandbox.oaiusercontent.com/', ['https://chatgpt.com']],
    ['nested two deep', 'https://third-party.example/embed', ['https://www.example.com', 'https://aistudio.google.com']],
    ['opaque ancestor', 'https://third-party.example/embed', ['null']],
    ['API-host ancestor', 'https://third-party.example/embed', ['https://openrouter.ai']]
  ];
  for (const code of [SIGNED_OUT, ...NO_PASS_CODES]) {
    for (const [name, page, ancestors] of frames) {
      const { outcome, w } = await fetchOutcome(code, realCatalogGlobals(page, { ancestors }), 'https://api.example-anything.com/collect');
      assert.equal(outcome, 'BLOCKED', `${code} ${name}`);
      assert.equal(w.netCalls.length, 0, `${code} ${name}`);
    }
  }
  // An ordinary embed (no AI ancestor) is an ordinary page.
  const ok = await fetchOutcome(SIGNED_OUT, realCatalogGlobals('https://js.stripe.com/v3/m-outer.html',
    { ancestors: ['https://shop.example.com'] }), 'https://m.stripe.com/6', { method: 'POST', body: 'a=b' });
  assert.equal(ok.outcome, 'SENT');
});

// Firefox has no `location.ancestorOrigins`. A frame there is told from a page by
// `window.top !== window`, and its parent by `document.referrer`.
test('Firefox: with no ancestorOrigins, any framed page refuses the pass (F1, F3, F5, F8, nested)', async () => {
  const frames = [
    ['F1 Claude artifact frame', 'https://www.claudeusercontent.com/?domain=claude.ai', 'https://claude.ai/', 'https://api.example-anything.com/collect'],
    ['F3 ChatGPT sandbox frame', 'https://abc.web-sandbox.oaiusercontent.com/', 'https://chatgpt.com/c/1', 'https://api.example-anything.com/collect'],
    ['F5 Stripe frame in ChatGPT', 'https://js.stripe.com/v3/m-outer.html', 'https://chatgpt.com/', 'https://m.stripe.com/6'],
    ['F8 third-party frame in Gemini', 'https://x.scf.usercontent.goog/', 'https://gemini.google.com/app', 'https://y.example.com/c'],
    ['frame in an API-host page', 'https://third-party.example/embed', 'https://openrouter.ai/chat', 'https://y.example.com/c'],
    // No referrer at all (a no-referrer policy, a sandbox): cannot be ruled out.
    ['framed, empty referrer', 'https://third-party.example/embed', '', 'https://y.example.com/c'],
    ['framed, no document', 'https://third-party.example/embed', undefined, 'https://y.example.com/c']
  ];
  for (const [name, page, referrer, url] of frames) {
    const { outcome, w } = await fetchOutcome(SIGNED_OUT, realCatalogGlobals(page, { framed: true, referrer }), url);
    assert.equal(outcome, 'BLOCKED', name);
    assert.equal(w.netCalls.length, 0, name);
    assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'), name);
  }
  // A throwing `window.top` counts as framed.
  // (The shim reads it per request, so it can start throwing after load.)
  const tw = makeDebugWorld(down(SIGNED_OUT), realCatalogGlobals('https://third-party.example/embed', { referrer: '' }));
  Object.defineProperty(tw.sandbox, 'top', { get() { throw new Error('SecurityError'); }, configurable: true });
  await assert.rejects(tw.sandbox.fetch('https://y.example.com/c', { method: 'POST', body: REVIEW_PROMPT }), blockedError, 'window.top throws');
  assert.equal(tw.netCalls.length, 0);
  // Without the full chain an ordinary referrer proves nothing: a nested or
  // self-navigated frame inside chatgpt shows its ordinary parent. So even an
  // ordinary embed with an ordinary referrer is refused (fail closed).
  const nested = await fetchOutcome(SIGNED_OUT, realCatalogGlobals('https://js.stripe.com/v3/m-outer.html', { framed: true, referrer: 'https://shop.example.com/cart' }),
    'https://m.stripe.com/6', { method: 'POST', body: 'a=b' });
  assert.equal(nested.outcome, 'BLOCKED');
  // A TOP-LEVEL page in Firefox can still pass whatever its referrer (sonomos.ai -> Clerk),
  // including a referrer that is an AI surface (the user followed a link from chatgpt.com).
  for (const referrer of [undefined, '', 'https://chatgpt.com/c/1']) {
    const top = await fetchOutcome(SIGNED_OUT, realCatalogGlobals(NON_AI_PAGE, { referrer }), CLERK_URL, { method: 'POST', body: 'a=b' });
    assert.equal(top.outcome, 'SENT', `top-level, referrer ${referrer}`);
  }
  // Where the browser does give ancestorOrigins it wins: no referrer is needed.
  const chrome = await fetchOutcome(SIGNED_OUT, realCatalogGlobals('https://js.stripe.com/v3/m-outer.html', { framed: true, referrer: '', ancestors: ['https://shop.example.com'] }),
    'https://m.stripe.com/6', { method: 'POST', body: 'a=b' });
  assert.equal(chrome.outcome, 'SENT');
});

test('IPv6 and local-name rows N1-N5 block (RFC 8215, SIIT, site-local, .corp, .home) and public neighbours do not', async () => {
  const blocked = [
    'http://[64:ff9b:1::a00:5]:11434/api/generate',   // N1 NAT64 local-use /48
    'http://[64:ff9b:1:ffff::1]/x',                    // anywhere in that /48
    'http://[::ffff:0:127.0.0.1]:11434/api/generate', // N2 SIIT
    'http://[::ffff:0:10.0.0.5]/x',
    'http://[fec0::1]:11434/api/generate',            // N3 site-local
    'http://[feff::1]/x',                              // top of fec0::/10
    'http://gpu.corp:11434/api/generate',             // N4
    'http://llm.home:11434/api/generate',             // N5
    'http://nas.private/x'
  ];
  for (const url of blocked) {
    for (const code of [SIGNED_OUT, 'no-bridge']) {
      const { outcome, w } = await fetchOutcome(code, realCatalogGlobals(BYOK), url);
      assert.equal(outcome, 'BLOCKED', `${code} ${url}`);
      assert.equal(w.netCalls.length, 0, `${code} ${url}`);
    }
  }
  // SIIT and mapped forms are judged by the address they embed; the rest of
  // the neighbourhood is ordinary.
  for (const url of ['http://[::ffff:0:8.8.8.8]/x', 'http://[64:ff9b::808:808]/x', 'http://[fe00::1]/x',
    'http://[64:ff9c::1]/x', 'http://corp.example.com/x', 'http://home.example.com/x', 'http://private.example.com/x']) {
    const { outcome } = await fetchOutcome(SIGNED_OUT, realCatalogGlobals(NON_AI_PAGE), url, { method: 'POST', body: 'a=b' });
    assert.equal(outcome, 'SENT', url);
  }
});

test('loopback, private and local-network targets block (self-hosted models, round 2 e)', async () => {
  const targets = [
    'http://127.0.0.1:11434/api/generate', 'http://localhost:11434/api/chat',
    'http://foo.localhost:8080/v1/chat/completions', 'http://127.1.2.3/x', 'http://127.1:11434/x',
    'http://2130706433:11434/x', 'http://0x7f000001:11434/x', 'http://0177.0.0.1:11434/x',
    'http://[::1]:11434/api/chat', 'http://[::]:11434/x', 'http://10.0.0.5:8000/v1', 'http://172.16.4.2/x',
    'http://172.31.255.1/x', 'http://192.168.1.20:11434/api', 'http://169.254.169.254/latest',
    'http://[fc00::1]/x', 'http://[fd7a:115c:a1e0::1]:11434/x', 'http://[fe80::1]/x',
    'http://[::ffff:127.0.0.1]:11434/x', 'http://[::ffff:10.0.0.5]/x', 'http://[::127.0.0.1]:11434/x',
    'http://[64:ff9b::a00:5]:11434/x', 'http://0.0.0.0:11434/x', 'http://0:11434/x',
    // CGNAT 100.64/10 (Tailscale)
    'http://100.64.0.1/x', 'http://100.101.102.103:11434/x', 'http://100.127.255.254/x',
    // single-label names and local-network suffixes
    'http://gpu-box:11434/api/generate', 'http://ollama:11434/x', 'http://ollama.local:11434/x', 'http://box.lan/x',
    'http://host.docker.internal:11434/x', 'http://nas.intranet/x', 'http://pc.localdomain/x',
    'http://printer.home.arpa/x', 'http://box.tail1234.ts.net:11434/x', 'http://localhost.:11434/x'
  ];
  for (const url of targets) {
    for (const code of [SIGNED_OUT, 'no-bridge']) {
      const { outcome, w } = await fetchOutcome(code, realCatalogGlobals(NON_AI_PAGE), url);
      assert.equal(outcome, 'BLOCKED', `${code} ${url}`);
      assert.equal(w.netCalls.length, 0, `${code} ${url}`);
    }
  }
  // Public neighbours of those ranges are ordinary sites.
  for (const url of ['http://172.32.0.1/x', 'http://172.15.0.1/x', 'http://8.8.8.8/x', 'http://100.63.0.1/x',
    'http://100.128.0.1/x', 'http://[2001:db8::1]/x', 'http://intranet.example.com/x', 'http://local.example.com/x']) {
    const { outcome } = await fetchOutcome(SIGNED_OUT, realCatalogGlobals(NON_AI_PAGE), url, { method: 'POST', body: 'a=b' });
    assert.equal(outcome, 'SENT', url);
  }
});

test('locke-signed-out: outcomes where Locke was reached, or signed-out is unproven, still block open_web', async () => {
  const blocked = [
    ['screening-timeout', { ok: false, code: 'screening-timeout', message: 'deadline' }],
    ['native-timeout', { ok: false, code: 'native-timeout' }],
    ['bridge-error', { ok: false, code: 'bridge-error', message: 'Native host has exited.' }],
    ['bridge-dropped', { ok: false, code: 'bridge-dropped' }],
    ['no-bridge', { ok: false, code: 'no-bridge' }],
    ['bridge-unreachable', { ok: false, code: 'bridge-unreachable' }],
    ['receipt-too-large', { ok: false, code: 'receipt-too-large' }],
    ['host-panic', { ok: false, code: 'host-panic' }],
    ['bridge-protocol-mismatch', { ok: false, code: 'bridge-protocol-mismatch' }],
    ['extension-reloaded', { ok: false, code: 'extension-reloaded' }],
    ['bridge-empty', { ok: false, code: 'bridge-empty' }],
    ['bridge-unknown-response', { ok: false, code: 'bridge-unknown-response' }],
    ['data-consent-required', { ok: false, code: 'data-consent-required' }],
    ['an unknown code', { ok: false, code: 'something-new' }],
    ['a null verdict', null],
    ['a real guard block', { ok: true, receipt: { decision: 'block', reason: 'found a key', redactedCount: 0 } }],
    ['an infrastructure block receipt', { ok: true, receipt: { decision: 'block', blockCause: 'infrastructure', reason: 'screener unavailable' } }],
    ['a malformed receipt', { ok: true }]
  ];
  for (const [name, verdict] of blocked) {
    const { sandbox, netCalls, logs } = makeWorld(() => verdict, realCatalogGlobals(NON_AI_PAGE));
    await assert.rejects(sandbox.fetch(OPEN_WEB_URL, { method: 'POST', body: 'x' }), blockedError, name);
    assert.equal(netCalls.length, 0, name);
    assert.ok(!findLine(logs, 'locke-unreachable-unclassified'), name);
  }
  // An unknown code gets the generic "could not be reached" copy, not the signed-out one.
  const unknown = await blockedByRelayCode('something-new');
  assert.equal(unknown.sonomosBlockReason, 'native-call-failed');
});

test('a plain verdict timeout on open_web still blocks (a hang does not prove signed out)', async () => {
  const w = makeWorld(() => new Promise(() => {}), realCatalogGlobals(NON_AI_PAGE));
  w.deliver({ type: 'SONOMOS_CONFIG', config: { enforceTimeoutMs: 1000 } });
  await assert.rejects(w.sandbox.fetch(OPEN_WEB_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(w.netCalls.length, 0);
  assertBlocked(w.logs, 'verdict-timeout');
});

test('a dead channel on open_web still blocks', async () => {
  const w = makeWorld(() => allowVerdict, { ...realCatalogGlobals(NON_AI_PAGE), postMessage: () => { throw new Error('channel gone'); } });
  await assert.rejects(w.sandbox.fetch(OPEN_WEB_URL, { method: 'POST', body: 'x' }), blockedError);
  assert.equal(w.netCalls.length, 0);
});

test('the user fail-open window keeps its own reason and tally', async () => {
  for (const code of [SIGNED_OUT, 'no-bridge', 'bridge-unreachable', 'bridge-dropped']) {
    const w = makeWorld(() => ({ ok: false, code, message: 'down' }));
    w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    await w.sandbox.fetch(AI_URL, CHAT_INIT);
    assert.equal(w.netCalls.length, 1, code);
    assert.deepEqual(w.unchecked, [`relay-${code}`], code);
    assertReason(w.logs, 'unchecked-fail-open', 'warn');
    assert.ok(!findLine(w.logs, 'locke-unreachable-unclassified'), code);
    // Default deny: an unrecognised destination is held even in the window.
    await assert.rejects(w.sandbox.fetch(OPEN_WEB_URL, { method: 'POST', body: 'x' }), blockedError);
    assert.equal(w.netCalls.length, 1, code);
  }
});

// ── a prompt carried in the URL (Google AI Mode) ───────────────────

const FOLIF = 'https://chat.openai.com/async/folif?udm=50&q=My+name+is+Jane+Doe&ei=abc';

test('a bodyless fetch with a query goes to the guard as is, empty body', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  await sandbox.fetch(FOLIF);
  assert.equal(captured.length, 1);
  const { head, body } = splitRaw(rawOf(captured[0]));
  assert.match(head, /^GET \/async\/folif\?udm=50&q=My\+name\+is\+Jane\+Doe&ei=abc HTTP\/1\.1\r\nHost: chat\.openai\.com/);
  assert.equal(body.length, 0);
  // allow → released untouched, at the page's own URL.
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], FOLIF);
});

test('a guard redaction of a URL query releases the rewritten URL, same endpoint', async () => {
  const { sandbox, netCalls } = makeWorld(() => rebuiltVerdict(
    ['GET /async/folif?udm=50&q=My+name+is+PER_9qpk+Doe&ei=abc HTTP/1.1', 'Host: chat.openai.com'], ''));
  await sandbox.fetch(FOLIF, { credentials: 'include' });
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], 'https://chat.openai.com/async/folif?udm=50&q=My+name+is+PER_9qpk+Doe&ei=abc');
  assert.equal(netCalls[0][1].credentials, 'include', 'the page\'s other fetch fields survive');
});

test('a URL rewrite that changes the endpoint is refused, never followed', async () => {
  const { sandbox, netCalls } = makeWorld(() => rebuiltVerdict(
    ['GET /elsewhere?q=x HTTP/1.1', 'Host: chat.openai.com'], ''));
  await assert.rejects(sandbox.fetch(FOLIF), blockedError);
  assert.equal(netCalls.length, 0);
});

test('a bodyless query passes as today when the guard cannot answer', async () => {
  const { sandbox, netCalls } = makeWorld(() => ({ ok: false, code: 'native-call-failed', message: 'down' }));
  await sandbox.fetch(FOLIF);
  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0][0], FOLIF);
});

test('a bodyless query is stopped by a guard content block', async () => {
  const { sandbox, netCalls } = makeWorld(() => ({ ok: true, receipt: { decision: 'block', reason: 'policy' } }));
  await assert.rejects(sandbox.fetch(FOLIF), blockedError);
  assert.equal(netCalls.length, 0);
});

test('a bodyless fetch without a query never reaches the guard', async () => {
  const captured = [];
  const { sandbox, netCalls } = makeWorld((msg) => { captured.push(msg.requestB64); return allowVerdict; });
  await sandbox.fetch('https://chat.openai.com/async/folif');
  await sandbox.fetch('https://chat.openai.com/x?');
  assert.equal(captured.length, 0);
  assert.equal(netCalls.length, 2);
});

// ── zh#370 default deny, through the real hooks ────────────────────────────
//
// Every case below is driven through the shim's fetch / WebSocket hook with a
// real SONOMOS_CONFIG window; the screener is down (timeout or relay outage).

const CC_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_COMPLETION = 'https://claude.ai/api/organizations/o/chat_conversations/c/completion';
const JSON_CT = { 'content-type': 'application/json' };
const FO_OUTAGES = {
  'verdict timeout': { onCapture: () => new Promise(() => {}), config: { enforceTimeoutMs: 1000 }, cause: 'verdict-timeout', closed: 'verdict-timeout' },
  'relay no-bridge': { onCapture: () => ({ ok: false, code: 'no-bridge' }), cause: 'relay-no-bridge', closed: 'connector-not-started' }
};
function foWorld(outage, window = openWindow(), page = 'https://chat.openai.com/') {
  const w = makeWorld(outage.onCapture, realCatalogGlobals(page));
  w.deliver({ type: 'SONOMOS_CONFIG', config: { ...(outage.config || {}), ...(window || {}) } });
  return w;
}
// One request, one outage, window open or closed; resolves what happened.
async function foRun(outage, url, init, window = openWindow()) {
  const w = foWorld(outage, window);
  let outcome = 'SENT';
  try { await w.sandbox.fetch(url, init); } catch (e) { outcome = blockedError(e) ? 'BLOCKED' : `ERR ${e.message}`; }
  return { w, outcome };
}
const jsonInit = (body, extra = {}) => ({ method: 'POST', headers: JSON_CT, body: JSON.stringify(body), ...extra });
const small64 = b64n(64);

// The review's leak list: each shipped under the byte heuristic.
const LEAKS = {
  'svg content-type': [CC_URL, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><text>Jane Doe 123-45-6789</text></svg>' }],
  'xml content-type': [CC_URL, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: '<a>Jane Doe 123-45-6789</a>' }],
  'text/plain PUT upload': [STORAGE_PUT, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'Jane Doe 123-45-6789' }],
  'base64 split into <512 chunks in a JSON array': [CC_URL, jsonInit({ x: Array.from({ length: 20 }, () => b64n(500)), messages: [{ role: 'user', content: 'hi' }] })],
  'number array': [CC_URL, jsonInit({ x: Array.from({ length: 400 }, (_, i) => i % 256), messages: [{ role: 'user', content: 'hi' }] })],
  'small duck.ai inline file': ['https://duckduckgo.com/duckchat/v1/chat', jsonInit({ messages: [{ role: 'user', content: 'see file', parts: [{ type: 'file', content: small64, mimeType: 'text/plain' }] }] })],
  'small Anthropic inline image': [CC_URL, jsonInit({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: small64 } }] }] })],
  'claude.ai attachments extracted_content': [CLAUDE_COMPLETION, jsonInit({ prompt: 'summarize', attachments: [{ file_name: 'p.csv', extracted_content: 'Jane Doe 123-45-6789' }] })],
  'signature-key abuse': [CC_URL, jsonInit({ signature: b64n(4000), messages: [{ role: 'user', content: 'hi' }] })],
  'no Content-Type UTF-8 body': [CC_URL, { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: 'Jane Doe' }] })) }],
  'multipart boundary containing xml/json': [CC_URL, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=json-xml-1' }, body: '--json-xml-1\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nJane Doe 123-45-6789\r\n--json-xml-1--' }]
};

test('fail-open default deny: every leak on the review list is HELD, on a verdict timeout and on a relay outage', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    await Promise.all(Object.entries(LEAKS).map(async ([name, [url, init]]) => {
      const { w, outcome } = await foRun(outage, url, init);
      const label = `${oname} / ${name}`;
      assert.equal(outcome, 'BLOCKED', label);
      assert.equal(w.netCalls.length, 0, `${label}: nothing sent`);
      assert.equal(w.unchecked.length, 0, `${label}: not tallied as an unchecked send`);
      const line = assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
      assert.match(line, new RegExp(`\\bcause=${outage.cause}\\b`), label);
      assert.ok(!findLine(w.logs, 'unchecked-fail-open'), label);
    }));
  }
});

test('fail-open OFF: the leak list blocks exactly as on main (the outage\'s own reason, never the held one)', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    await Promise.all(Object.entries(LEAKS).map(async ([name, [url, init]]) => {
      for (const window of [null, expiredWindow()]) {
        const { w, outcome } = await foRun(outage, url, init, window);
        assert.equal(outcome, 'BLOCKED', `${oname} / ${name}`);
        assert.equal(w.netCalls.length, 0);
        assertBlocked(w.logs, outage.closed, 'unavailable');
        assert.ok(!findLine(w.logs, 'fail-open-file-held'), `${oname} / ${name}`);
      }
    }));
  }
});

// What the user actually types into an agent: Claude Code carries data: URLs,
// JWTs and ssh keys in tool results, thinking signatures and so on.
// Built when the tests run, so no token-shaped literal sits in the repo. Same
// shape as a real one: an HS256 header, a small payload, a 43-character signature.
const JWT = ['{"alg":"HS256","typ":"JWT"}', '{"sub":"1234567890"}', 'fail-open test fixture, not real']
  .map((part) => Buffer.from(part).toString('base64url'))
  .join('.');
const CLAUDE_CODE_TURN = {
  model: 'claude-x', max_tokens: 64000, stream: true,
  system: [{ type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'Read', description: 'reads a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  metadata: { user_id: 'user_abc' },
  messages: [
    { role: 'user', content: 'look at the logo' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'ok', signature: b64n(1800) }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `<img src="data:image/png;base64,iVBORw0KGgo="> token ${JWT} key ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host` }] }] }
  ]
};
const FO_TURNS = {
  'Claude Code turn (api.anthropic.com)': [CC_URL, jsonInit(CLAUDE_CODE_TURN)],
  'ChatGPT web text turn': ['https://chatgpt.com/backend-api/f/conversation', jsonInit({
    action: 'next', model: 'auto', messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [`data:image/png;base64,AAAA ${JWT}`] }, id: 'm1', metadata: {} }] })],
  'Gemini StreamGenerate form turn': ['https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=x&_reqid=1',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: geminiBody(['the sky is blue', 0, null, null, null, null, 0]) }],
  'claude.ai completion': [CLAUDE_COMPLETION, jsonInit({ prompt: 'hello', timezone: 'UTC', attachments: [], files: [], sync_sources: [] })]
};

test('fail-open default deny: recognised chat turns are still SENT unchecked and tallied (no over-blocking)', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    await Promise.all(Object.entries(FO_TURNS).map(async ([name, [url, init]]) => {
      const { w, outcome } = await foRun(outage, url, init);
      const label = `${oname} / ${name}`;
      assert.equal(outcome, 'SENT', label);
      assert.equal(w.netCalls.length, 1, label);
      assert.deepEqual(w.unchecked, [outage.cause], label);
      assertReason(w.logs, 'unchecked-fail-open', 'warn');
      assert.ok(!findLine(w.logs, 'fail-open-file-held'), label);
    }));
  }
});

test('fail-open OFF: the same chat turns block with the outage\'s own reason', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    await Promise.all(Object.entries(FO_TURNS).map(async ([name, [url, init]]) => {
      const { w, outcome } = await foRun(outage, url, init, null);
      assert.equal(outcome, 'BLOCKED', `${oname} / ${name}`);
      assert.equal(w.unchecked.length, 0);
      assertBlocked(w.logs, outage.closed, 'unavailable');
    }));
  }
});

// A fake WebSocket the shim can patch, as tests/shim-websocket.test.js does.
function fakeWebSocketClass() {
  return class FakeWebSocket {
    constructor(url) { this._url = url; this.wire = []; this.closes = []; }
    get url() { return this._url; }
    get readyState() { return 1; }
    get bufferedAmount() { return 0; }
    send(data) { this.wire.push(data); }
    close(code, reason) { this.closes.push({ code, reason }); }
    dispatchEvent() { return true; }
  };
}
const CODEX_WS = 'wss://chatgpt.com/backend-api/codex/responses';
const wsFrame = (extra = '') => JSON.stringify({ type: 'response.create', model: 'g', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `hi${extra}` }] }] });

test('fail-open default deny: a WebSocket frame is released only if it is a known chat frame under 6 MiB', async () => {
  const sendOne = async (outage, payload, window = openWindow()) => {
    const WebSocket = fakeWebSocketClass();
    const w = makeWorld(outage.onCapture, { ...realCatalogGlobals('https://chatgpt.com/'), WebSocket });
    w.deliver({ type: 'SONOMOS_CONFIG', config: { ...(outage.config || {}), ...(window || {}) } });
    const ws = new w.sandbox.WebSocket(CODEX_WS);
    try { ws.send(payload); } catch { /* a refused send may throw */ }
    await new Promise((r) => setTimeout(r, 1500));
    return { w, ws };
  };
  const outage = FO_OUTAGES['verdict timeout'];
  const okFrame = await sendOne(outage, wsFrame());
  assert.equal(okFrame.ws.wire.length, 1, 'a known chat frame fails open');
  assert.deepEqual(okFrame.w.unchecked, ['verdict-timeout']);
  const big = await sendOne(outage, wsFrame('x'.repeat(MAX_RELEASABLE_BODY)));
  assert.equal(big.ws.wire.length, 0, 'a frame over 6 MiB never leaves');
  assert.equal(big.w.unchecked.length, 0);
  assertBlocked(big.w.logs, 'fail-open-file-held', 'unavailable');
  const unknown = await sendOne(outage, JSON.stringify({ type: 'session.update', input: 'hi' }));
  assert.equal(unknown.ws.wire.length, 0, 'not a chat frame');
  assertBlocked(unknown.w.logs, 'fail-open-file-held', 'unavailable');
  const closed = await sendOne(outage, wsFrame(), null);
  assert.equal(closed.ws.wire.length, 0, 'window closed: blocks as on main');
  assert.ok(!findLine(closed.w.logs, 'fail-open-file-held'));
});

// ── never trust an unchecked pass (mixed versions) ─────────────────────────

const CLAUDE_TURN_JSON = JSON.stringify({ prompt: 'hi', attachments: [], files: [] });
const uncheckedAllow = { ok: true, receipt: { decision: 'allow', redactedCount: 0, unchecked: true, reason: 'passed unchecked', unscreened: [pdfUnscreened] } };
const PAUSED = 'protection paused by the user';

async function recv(verdict, url, init, window) {
  const w = makeWorld(() => verdict, realCatalogGlobals('https://chat.openai.com/'));
  if (window) w.deliver({ type: 'SONOMOS_CONFIG', config: window });
  let outcome = 'SENT';
  try { await w.sandbox.fetch(url, init); } catch (e) { outcome = blockedError(e) ? 'BLOCKED' : `ERR ${e.message}`; }
  return { w, outcome };
}

test('mixed versions: an unchecked allow for a non-chat request is HELD, with fail-open on or off', async () => {
  const uploads = [
    [AI_URL, { method: 'POST', body: imageForm() }],
    [CC_URL, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b' }, body: '--b\r\nContent-Disposition: form-data; name="f"; filename="a.pdf"\r\n\r\n%PDF\r\n--b--' }],
    [STORAGE_PUT, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: 'file bytes' }],
    [CC_URL, jsonInit({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: small64 } }] }] })],
    ['https://chat.openai.com/backend-api/files', jsonInit({ file_name: 'a.pdf' })]
  ];
  for (const window of [openWindow(), null, expiredWindow()]) {
    for (const [url, init] of uploads) {
      const { w, outcome } = await recv(uncheckedAllow, url, init, window);
      assert.equal(outcome, 'BLOCKED', `${url} window=${!!window}`);
      assert.equal(w.netCalls.length, 0, `${url}: nothing sent`);
      const line = assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
      assert.match(line, /\bcause=unchecked-pass\b/);
      assert.ok(!findLine(w.logs, 'allow-unchecked'));
      assert.equal(w.unchecked.length, 0);
    }
  }
  // Inferred from the items alone, with no flag: the same.
  const inferred = { ok: true, receipt: { decision: 'allow', redactedCount: 0, unscreened: [pdfUnscreened] } };
  const { w, outcome } = await recv(inferred, AI_URL, { method: 'POST', body: imageForm() }, openWindow());
  assert.equal(outcome, 'BLOCKED');
  assert.equal(w.netCalls.length, 0);
  assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
});

test('mixed versions: an unchecked allow for a known chat turn is sent with allow-unchecked', async () => {
  for (const window of [openWindow(), null]) {
    const { w, outcome } = await recv(uncheckedAllow, CLAUDE_COMPLETION, { method: 'POST', headers: JSON_CT, body: CLAUDE_TURN_JSON }, window);
    assert.equal(outcome, 'SENT');
    assert.equal(w.netCalls.length, 1);
    assertReason(w.logs, 'allow-unchecked', 'warn');
    assert.ok(!findLine(w.logs, 'fail-open-file-held'));
  }
});

test('mixed versions: an unchecked redact is judged on the REBUILT bytes', async () => {
  const rebuilt = (url, ct, body) => {
    const u = new URL(url);
    const v = rebuiltVerdict([`POST ${u.pathname} HTTP/1.1`, `Host: ${u.host}`, `content-type: ${ct}`], Buffer.from(body), 1);
    v.receipt.unchecked = true;
    v.receipt.unscreened = [pdfUnscreened];
    return v;
  };
  for (const window of [openWindow(), null]) {
    // A rebuilt upload: held, nothing sent, the original is not sent either.
    const up = await recv(rebuilt(AI_URL, 'multipart/form-data; boundary=x', '--x\r\nfilename="a.pdf"\r\n\r\nPDF\r\n--x--'),
      AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, window);
    assert.equal(up.outcome, 'BLOCKED', `window=${!!window}`);
    assert.equal(up.w.netCalls.length, 0);
    assert.match(assertBlocked(up.w.logs, 'fail-open-file-held', 'unavailable'), /\bcause=unchecked-pass\b/);
    assert.ok(!findLine(up.w.logs, 'redact-unchecked'));
    // A rebuilt known chat turn: the redaction is applied.
    const body = CHAT_JSON.replace('hi', '[REDACTED]');
    const ok = await recv(rebuilt(AI_URL, 'application/json', body), AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, window);
    assert.equal(ok.outcome, 'SENT');
    assert.equal(ok.w.netCalls.length, 1);
    assert.deepEqual(Buffer.from(ok.w.netCalls[0][1].body), Buffer.from(body));
    assertReason(ok.w.logs, 'redact-unchecked', 'warn');
    // Undecodable rebuilt bytes: held.
    const bad = await recv({ ok: true, receipt: { decision: 'redact', unchecked: true, redactedCount: 1, requestB64: '!!!not base64!!!' } },
      AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, window);
    assert.equal(bad.outcome, 'BLOCKED');
    assert.equal(bad.w.netCalls.length, 0);
  }
  // A redact that is NOT marked unchecked is a screened result: applied, never re-judged.
  const screened = rebuiltVerdict(['POST /backend-api/conversation HTTP/1.1', 'Host: chat.openai.com', 'content-type: multipart/form-data; boundary=x'], Buffer.from('--x--'), 1);
  const s = await recv(screened, AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, openWindow());
  assert.equal(s.w.netCalls.length, 1, 'a fully screened redaction is applied');
});

test('mixed versions: the user\'s pause is never re-judged', async () => {
  const paused = { ok: true, receipt: { decision: 'allow', unchecked: true, reason: PAUSED, unscreened: [] } };
  for (const window of [openWindow(), null]) {
    const { w, outcome } = await recv(paused, AI_URL, { method: 'POST', body: imageForm() }, window);
    assert.equal(outcome, 'SENT', `window=${!!window}`);
    assert.equal(w.netCalls.length, 1);
    assert.ok(!findLine(w.logs, 'fail-open-file-held'));
  }
  const up = await recv(paused, STORAGE_PUT, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: 'file bytes' }, null);
  assert.equal(up.outcome, 'SENT');
  // Paused, but with unscreened items on it: not the pause exemption.
  const odd = { ok: true, receipt: { decision: 'allow', unchecked: true, reason: PAUSED, unscreened: [pdfUnscreened] } };
  const held = await recv(odd, AI_URL, { method: 'POST', body: imageForm() }, null);
  assert.equal(held.outcome, 'BLOCKED');
});

test('fail-open: the bridge\'s hold receipt maps to fail-open-file-held; the retired wording no longer does', async () => {
  const reason = 'Locke could not screen this request and it is not a plain chat message — held back (fail-open only sends recognised prompt-only chat messages unchecked)';
  const receipt = (r) => ({ ok: true, receipt: { decision: 'block', blockCause: 'infrastructure', reason: r, redactedCount: 0, unchecked: false } });
  const a = await recv(receipt(reason), AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, null);
  assert.equal(a.outcome, 'BLOCKED');
  assertBlocked(a.w.logs, 'fail-open-file-held', 'unavailable');
  const old = await recv(receipt('Locke could not screen this request and it may carry a file — held back (files are never sent unchecked, even under fail-open)'),
    AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, null);
  assert.equal(old.outcome, 'BLOCKED');
  assertBlocked(old.w.logs, 'screening-unavailable', 'unavailable');
});

test('fail-open: the held copy says default deny in plain words', async () => {
  const { w } = await foRun(FO_OUTAGES['relay no-bridge'], CC_URL, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg/>' });
  let msg = '';
  try { await w.sandbox.fetch(CC_URL, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg/>' }); } catch (e) { msg = e.message; }
  assert.match(msg, /With fail-open on, Locke only sends plain chat messages to AI sites it recognises, so this one was held\. Remove any attachment to send now, or wait until screening is back\./);
  assert.ok(!/may include a file/.test(msg));
});

test('fail-open: a bodyless URL-query send still fails open on our own failure, tallied (unchanged)', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    const w = foWorld(outage, openWindow());
    await w.sandbox.fetch(FOLIF);
    assert.equal(w.netCalls.length, 1, oname);
    assert.deepEqual(w.unchecked, [outage.cause], oname);
  }
  // An unchecked redact of a query is its rewritten request line: applied, as before.
  const rewritten = rebuiltVerdict(['GET /async/folif?udm=50&q=My+name+is+%5BNAME%5D&ei=abc HTTP/1.1', 'Host: chat.openai.com'], Buffer.alloc(0), 1);
  rewritten.receipt.unchecked = true;
  const w = makeWorld(() => rewritten);
  await w.sandbox.fetch(FOLIF);
  assert.equal(w.netCalls.length, 1);
  assert.match(String(w.netCalls[0][0]), /%5BNAME%5D/);
});

test('releasableUnderFailOpen: the settings budget is exact (8192 passes, 8193 holds)', () => {
  const chat = (extra) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/f/conversation',
    { messages: [{ content: { content_type: 'text', parts: ['hi'] } }], x: extra }));
  // key "x" costs 1; strings cost their bytes (spaced, so not a base64 run).
  const full = 'a '.repeat(2048); // 4096 bytes
  assert.equal(chat([full, 'a '.repeat(2047) + 'a']), true, '1 + 4096 + 4095 = 8192');
  assert.equal(chat([full, full]), false, '8193');
  // Scalars cost 8: 1023 numbers + key "x" (1) = 8185; 1024 numbers = 8193.
  const nums = (n) => Array.from({ length: Math.ceil(n / 64) }, (_, i) => Array(Math.min(64, n - i * 64)).fill(7));
  assert.equal(chat(nums(1023)), true);
  assert.equal(chat(nums(1024)), false);
});

test('releasableUnderFailOpen: more edges the first mutation pass left alive', () => {
  const OK = { messages: [{ role: 'user', content: 'hi' }] };
  // Duplicate content-types, whichever order, are held (last-wins would read JSON).
  const two = (a, b) => Buffer.from(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: ${a}\r\nContent-Type: ${b}\r\n\r\n${JSON.stringify(OK)}`);
  assert.equal(releasable(two('application/json', 'application/json')), false);
  assert.equal(releasable(two('text/plain', 'application/json')), false);
  // Media type is exactly application/json.
  for (const m of ['application/vnd.api+json', 'text/json', 'application/ld+json', 'application/jsonl']) {
    assert.equal(releasable(req('POST', 'api.anthropic.com', '/v1/messages', m, JSON.stringify(OK))), false, m);
  }
  // An unparseable body is held even where an empty object would pass (retry may omit the prompt).
  assert.equal(releasable(req('POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/retry_completion', 'application/json', '{nope')), false);
  assert.equal(releasable(req('POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/retry_completion', 'application/json', '{}')), true);
  // Methods: only POST (and WS-SEND on the Codex route).
  for (const method of ['PUT', 'PATCH', 'GET', 'DELETE', 'post']) {
    assert.equal(releasable(req(method, 'api.anthropic.com', '/v1/messages', 'application/json', JSON.stringify(OK))), false, method);
    assert.equal(releasable(req(method, 'api.openai.com', '/v1/chat/completions', 'application/json', JSON.stringify(OK))), false, method);
    assert.equal(releasable(req(method, 'claude.ai', CLAUDE_AI, 'application/json', '{"prompt":"x"}')), false, method);
    assert.equal(releasable(req(method, 'chatgpt.com', '/backend-api/f/conversation', 'application/json', '{"messages":[{"content":{"content_type":"text","parts":["a"]}}]}')), false, method);
  }
  // Paths: the right host with another route is held, on every host.
  assert.equal(releasable(req('POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute', 'application/x-www-form-urlencoded', geminiBody(['hi']))), false);
  assert.equal(releasable(jreq('POST', 'duck.ai', '/duckchat/v1/status', { messages: [{ role: 'user', content: 'hi' }] })), false);
  assert.equal(releasable(jreq('POST', 'duckduckgo.com', '/anything', { messages: [{ role: 'user', content: 'hi' }] })), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/files', { purpose: 'x' })), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/images/generations', {})), false);
  // Allowlists are decisive on their own: an unknown, innocent-looking parameter holds.
  assert.equal(releasable(anth({ ...OK, mystery: 'x' })), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { ...OK, mystery: 'x' })), false);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'hi', mystery: 'x' })), false);
  assert.equal(releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ text: 'hi' }] }], mystery: 'x' })), false);
  // ...and the parameters real clients send are known.
  assert.equal(releasable(anth({ ...OK, safeguards: { a: 1 }, thread: { id: 't' }, diagnostics: { x: 1 }, context_management: { edits: [] }, output_config: { effort: 'high' }, service_tier: 'auto' })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'hi', generate: false, client_metadata: { a: 'b' }, access_programs: ['x'], prompt_cache_key: 'k', previous_response_id: 'r', text: { verbosity: 'low' } })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { ...OK, stream_options: { include_usage: true }, response_format: { type: 'text' }, store: false })), true);
  assert.equal(releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ text: 'hi' }] }], toolConfig: { a: 1 }, safetySettings: [{ category: 'x' }], labels: { a: 'b' } })), true);
  // claude.ai sync_sources is not an attachment-named key, so it needs its own check.
  assert.equal(releasable(jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'x', sync_sources: [{ type: 'gdrive', id: '1' }] })), false);
  // Gemini web: a '+' is a space (structural spaces make '+' in the JSON otherwise).
  const spaced = `f.req=${formEnc(`[null, ${JSON.stringify(JSON.stringify([['hi', 0]]))}]`)}`;
  assert.equal(releasable(req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', spaced)), true);
  assert.equal(releasable(req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded', spaced.replace(/\+/g, '%2B'))), false, '%2B stays a plus sign');
  // Nested part types.
  const dk = (p) => releasable(jreq('POST', 'duck.ai', '/duckchat/v1/chat', { messages: [{ role: 'user', content: [p] }] }));
  assert.equal(dk({ type: 'text', text: 'a' }), true);
  assert.equal(dk({ type: 'file', text: 'a' }), false);
  const cc = (m) => releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [m] }));
  assert.equal(cc({ role: 'user', content: [{ type: 'input_audio' }] }), false);
  assert.equal(cc({ role: 'user', content: [{ type: 'text', text: 'x' }] }), true);
  assert.equal(cc({ role: 'user', content: [{ type: 'text' }] }), false, 'a part must carry a string text');
  assert.equal(cc({ role: 'user', content: 'a', weird: 'x' }), false);
  // Responses: ids and unknown keys are settings; reasoning content must be text parts or null.
  const ri = (item) => releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [item] }));
  assert.equal(ri({ type: 'message', role: 'user', content: 'a', id: 'a'.repeat(5000) }), false);
  assert.equal(ri({ type: 'function_call_output', call_id: 'c', output: 'a', id: 'a'.repeat(5000) }), false);
  assert.equal(ri({ type: 'function_call_output', call_id: 'c', output: 'a', id: 'ok' }), true);
  assert.equal(ri({ type: 'reasoning', content: [{ type: 'x', file: 'y' }] }), false);
  assert.equal(ri({ type: 'reasoning', content: [{ type: 'text', text: 'y' }] }), true);
  // Gemini API: systemInstruction is a content, the other params are settings.
  const ge = (extra) => releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ text: 'hi' }] }], ...extra }));
  assert.equal(ge({ systemInstruction: { parts: [{ inlineData: { data: 'x' } }] } }), false);
  assert.equal(ge({ systemInstruction: 'text' }), false);
  assert.equal(ge({ generationConfig: { stopSequences: ['a'.repeat(5000)] } }), false);
  // U+0085 is trimmed by Rust's trim(); U+FEFF is not.
  const hv = (v) => releasable(Buffer.from(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type:${v}\r\n\r\n${JSON.stringify(OK)}`));
  assert.equal(hv('\u0085application/json\u0085'), true);
  assert.equal(hv(' application/json　'), true);
  assert.equal(hv('﻿application/json'), false);
  assert.equal(hv('application/json​'), false);
});

// ── round 2 of the zh#370 review: the Rust `round_two_review` and the changed
// `opaque_limits_and_deny_keys` lines, same inputs, same expectations ───────
const MAX_MODEL_TOKEN = 256 * 1024;
const MAX_AUTHORED = 1024 * 1024;
const MAX_ITEM_OPAQUE = 4 * 1024;
const MAX_QUERY = 2048;
const MAX_OPAQUE_BASE64 = 512;
const FORM = 'application/x-www-form-urlencoded';

test('releasableUnderFailOpen: round_two_review (Rust) - Gemini function calls and responses', () => {
  const pdf = b64n(4000);
  const g3 = (b) => jreq('POST', 'generativelanguage.googleapis.com',
    '/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse', b);
  const call = (part) => g3({ contents: [{ role: 'model', parts: [part] }] });
  assert.equal(releasable(call({ functionCall: { name: 'weather', args: { city: 'Oslo' } } })), true);
  assert.equal(releasable(call({ functionResponse: { name: 'weather', response: { temp: 3, text: 'cold' }, parts: [{ text: 'ok' }] } })), true);
  const held = {
    'functionResponse.parts inlineData': { functionResponse: { name: 'f', response: {}, parts: [{ inlineData: { mimeType: 'application/pdf', data: pdf } }] } },
    'functionResponse.response inlineData': { functionResponse: { name: 'f', response: { inlineData: { mimeType: 'application/pdf', data: pdf } } } },
    'functionResponse.response nested blob': { functionResponse: { name: 'f', response: { result: { mime_type: 'image/png', data: b64n(64) } } } },
    'functionCall.args file': { functionCall: { name: 'f', args: { file: b64n(MAX_OPAQUE_STRING) } } },
    'functionCall.args data uri': { functionCall: { name: 'f', args: { x: 'data:application/pdf;base64,QQ==' } } },
    'functionCall args not object': { functionCall: { name: 'f', args: 'x' } },
    'functionCall extra key': { functionCall: { name: 'f', args: {}, blob: 'x' } },
    'functionCall no name': { functionCall: { args: {} } },
    'functionCall not object': { functionCall: 'f' },
    'functionResponse extra key': { functionResponse: { name: 'f', response: {}, x: 1 } },
    'functionResponse part extra key': { functionResponse: { name: 'f', parts: [{ text: 'x', y: 1 }] } },
    'functionResponse part not text': { functionResponse: { name: 'f', parts: [{ text: 1 }] } },
    'functionResponse parts not array': { functionResponse: { name: 'f', parts: { text: 'x' } } },
    'functionResponse response string': { functionResponse: { name: 'f', response: 'x' } },
    'functionResponse no name': { functionResponse: { response: {} } },
    'thought not a bool': { text: 'x', thought: 'x' },
    'thoughtSignature too long': { text: 'x', thoughtSignature: 'Q'.repeat(MAX_MODEL_TOKEN + 1) }
  };
  for (const [name, part] of Object.entries(held)) assert.equal(releasable(call(part)), false, `${name} must be held`);
  assert.equal(releasable(call({ text: 'x', thoughtSignature: 'Q'.repeat(MAX_MODEL_TOKEN) })), true);
  assert.equal(releasable(g3({ contents: [], tools: [{ x: { inlineData: { data: 'QQ' } } }] })), false);
  assert.equal(releasable(g3({ contents: [], tools: [{ functionDeclarations: [{ name: 'f',
    parameters: { properties: { mimeType: { type: 'string' }, data: { type: 'string' } } } }] }] })), true);
  // Function call id and response settings.
  assert.equal(releasable(call({ functionCall: { name: 'f', args: {}, id: 1 } })), false);
  assert.equal(releasable(call({ functionCall: { name: 'f', args: {}, id: 'c1' } })), true);
  assert.equal(releasable(call({ functionResponse: { name: 'f', response: {}, willContinue: { file: 'x' } } })), false);
  assert.equal(releasable(call({ functionResponse: { name: 'f', response: {}, willContinue: true } })), true);
});

test('releasableUnderFailOpen: round_two_review (Rust) - Codex outputs, per-item budgets, long histories', () => {
  const codex = (items) => req('WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', null,
    JSON.stringify({ type: 'response.create', input: items }));
  const md = { turn_id: 't', create_time: 1.5, content_item_kinds: ['tool.output'] };
  assert.equal(releasable(codex([{ type: 'custom_tool_call_output', call_id: 'c', output: 'done', internal_chat_message_metadata_passthrough: md }])), true);
  assert.equal(releasable(codex([{ type: 'custom_tool_call_output', call_id: 'c', output: 'done',
    internal_chat_message_metadata_passthrough: { x: 'a '.repeat(MAX_ITEM_OPAQUE) } }])), false);
  const long = Array.from({ length: 300 }, (_, i) => ({ type: 'message', id: `msg_${String(i).padStart(40, '0')}`, role: 'user',
    content: [{ type: 'input_text', text: 'x' }], internal_chat_message_metadata_passthrough: md }));
  assert.equal(releasable(codex(long)), true, '300 items are not one budget');
  const cc = Array.from({ length: 300 }, (_, i) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${String(i).padStart(40, '0')}`,
    name: 'Bash', input: { command: 'ls' }, cache_control: { type: 'ephemeral' } }] }));
  assert.equal(releasable(anth({ messages: cc })), true);
  const am = (m) => anth({ messages: [m] });
  const half = 'a '.repeat(1100);
  assert.equal(releasable(codex([{ type: 'reasoning', id: half, status: half }])), false);
  assert.equal(releasable(codex([{ type: 'message', role: 'user', content: 'x', internal_chat_message_metadata_passthrough: { x: half, y: half } }])), false);
  assert.equal(releasable(am({ role: 'user', content: 'hi', output_config: { x: half, y: half } })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: half, name: 'n', input: {}, cache_control: { x: half } }] })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: 'a '.repeat(1900), name: 'n', input: {} }] })), true);
  const blocks = Array.from({ length: 10 }, () => ({ type: 'tool_use', id: 'a '.repeat(400), name: 'n', input: {} }));
  assert.equal(releasable(am({ role: 'assistant', content: blocks })), true, 'each block has its own budget');
  assert.equal(releasable(codex([{ type: 'additional_tools', tools: [{ x: 'data:x;base64,QQ' }] }])), false);
  assert.equal(releasable(codex([{ type: 'additional_tools', tools: [], id: 'a '.repeat(MAX_ITEM_OPAQUE) }])), false);
  const enc = (n) => codex([{ type: 'reasoning', encrypted_content: 'Q'.repeat(n) }]);
  assert.equal(releasable(enc(MAX_MODEL_TOKEN)), true);
  assert.equal(releasable(enc(MAX_MODEL_TOKEN + 1)), false);
  assert.equal(releasable(codex([{ type: 'reasoning', x: 1 }])), false);
});

test('releasableUnderFailOpen: round_two_review (Rust) - authored JSON, tool defs, model tokens', () => {
  const am = (m) => anth({ messages: [m] });
  const use = (input) => am({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input }] });
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Write',
    input: { file_path: '/a.txt', content: 'a '.repeat(100000) } }] })), true);
  const heldInputs = {
    'data uri': { x: 'data:image/png;base64,iVBOR' },
    'inline image': { image_url: { url: 'https://x/y.png' } },
    'bare base64': { x: b64n(MAX_OPAQUE_STRING) },
    'source blob': { source: { type: 'base64', media_type: 'application/pdf', data: 'QQ' } },
    'non-ascii key': { 'fıle': 'x' },
    'over the cap': { x: 'a '.repeat(MAX_AUTHORED / 2 + 1) },
    'many keys over the cap': Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [String(i).padStart(60, '0'), null]))
  };
  for (const [name, input] of Object.entries(heldInputs)) assert.equal(releasable(use(input)), false, `tool_use.input ${name} must be held`);
  assert.equal(releasable(use({ x: b64n(MAX_OPAQUE_STRING - 1), image_url: '', inlineData: null })), true);
  // tools / tool_choice walked on every surface.
  assert.equal(releasable(anth({ messages: [], tools: [{ name: 'x', input_schema: {}, x: 'data:a;base64,QQ' }] })), false);
  assert.equal(releasable(anth({ messages: [], tool_choice: { type: 'tool', name: b64n(MAX_OPAQUE_STRING) } })), false);
  assert.equal(releasable(jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'x', tools: [{ input_file: 'x' }] })), false);
  const cc = (b) => releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', b));
  assert.equal(cc({ messages: [], tools: [{ function: { name: 'f', description: 'data:x;base64,QQ' } }] }), false);
  assert.equal(cc({ messages: [], tool_choice: { x: 'data:x;base64,QQ' } }), false);
  assert.equal(cc({ messages: [], functions: [{ input_image: 'x' }] }), false);
  const rs = (b) => releasable(jreq('POST', 'api.openai.com', '/v1/responses', b));
  assert.equal(rs({ input: 'hi', tools: [{ x: 'data:x;base64,QQ' }] }), false);
  assert.equal(rs({ input: 'hi', tool_choice: { x: 'data:x;base64,QQ' } }), false);
  // Numbers spend, blobs need a MIME string and a non-empty data string.
  assert.equal(releasable(use({ x: Array(MAX_AUTHORED / 8 + 1).fill(1) })), false);
  assert.equal(releasable(use({ x: Array(1000).fill(1) })), true);
  assert.equal(releasable(use({ mimeType: { type: 'string' }, data: 'x' })), true);
  assert.equal(releasable(use({ mimeType: 'image/png', data: '' })), true);
  assert.equal(releasable(use({ mimeType: 'application/json', data: { x: 1 } })), true);
  assert.equal(releasable(use({ MimeType: 'image/png', data: 'x' })), false);
  // Signatures and redacted thinking.
  const sig = (n) => am({ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'Q'.repeat(n) }] });
  assert.equal(releasable(sig(MAX_MODEL_TOKEN)), true);
  assert.equal(releasable(sig(MAX_MODEL_TOKEN + 1)), false);
  const red = (n) => am({ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'Q'.repeat(n) }] });
  assert.equal(releasable(red(MAX_MODEL_TOKEN)), true);
  assert.equal(releasable(red(MAX_MODEL_TOKEN + 1)), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'redacted_thinking', data: 5 }] })), false);
  const big = { x: 'a '.repeat(MAX_ITEM_OPAQUE) };
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'thinking', thinking: 't', cache_control: big }] })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'd', cache_control: big }] })), false);
  assert.equal(releasable(am({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a '.repeat(MAX_ITEM_OPAQUE), content: 'x' }] })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: 'a '.repeat(MAX_ITEM_OPAQUE), name: 'n', input: {} }] })), false);
});

test('releasableUnderFailOpen: round_two_review (Rust) - query, chat parts, duplicate keys, unicode keys, ChatGPT pointers, Gemini upload refs', () => {
  const hi = { messages: [{ role: 'user', content: 'hi' }] };
  const q = (query) => jreq('POST', 'api.anthropic.com', `/v1/messages?${query}`, hi);
  assert.equal(releasable(q('beta=true&x=&&y')), true);
  assert.equal(releasable(q(`x=${'a'.repeat(MAX_QUERY)}`)), false);
  assert.equal(releasable(q(`x=${b64n(MAX_OPAQUE_BASE64)}`)), false);
  assert.equal(releasable(q('file=cv.pdf')), false);
  assert.equal(releasable(q('file=')), true);
  assert.equal(releasable(q('x=%zz')), false);
  assert.equal(releasable(q('%zz=1')), false);
  assert.equal(releasable(q('x=data:a;base64,QQ')), false);
  assert.equal(releasable(jreq('POST', 'api.anthropic.com', '/v1/messages#frag', hi)), true);
  // Query cap and the fragment cut.
  assert.equal(releasable(q(`x=${'a+'.repeat(1000)}`)), true);
  assert.equal(releasable(q(`x=${'a+'.repeat(1100)}`)), false);
  assert.equal(releasable(jreq('POST', 'api.anthropic.com', `/v1/messages?x=1#${'a'.repeat(3000)}`, hi)), true);
  // A non-string chat-completions part.
  const cc1 = (part) => releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [{ role: 'user', content: [part] }] }));
  assert.equal(cc1({ type: 'text', text: 'x' }), true);
  assert.equal(cc1({ type: 'text', text: { image_url: 'x' } }), false);
  assert.equal(cc1({ type: 'text', text: ['x'] }), false);
  assert.equal(cc1({ type: 'refusal', refusal: { x: 1 } }), false);
  assert.equal(cc1({ type: 'text', text: 'x', refusal: 'y' }), false);
  assert.equal(cc1({ type: 'refusal', refusal: 'y', text: 'x' }), false);
  // Duplicate keys, anywhere.
  const dup = (body) => req('POST', 'api.anthropic.com', '/v1/messages', 'application/json', body);
  assert.equal(releasable(dup('{"messages":[{"role":"user","content":"hi"}]}')), true);
  assert.equal(releasable(dup('{"messages":[{"role":"user","content":"hi"}],"messages":[]}')), false);
  assert.equal(releasable(dup('{"messages":[{"role":"user","content":"hi","content":[{"type":"image"}]}]}')), false);
  assert.equal(releasable(dup('{"messages":[{"role":"user","content":[{"type":"tool_use","id":"t","name":"n","input":{"a":1,"a":2}}]}]}')), false);
  assert.equal(releasable(dup('{"messages":[],"x":1e999}')), false);
  const gw = (outer) => releasable(req('POST', 'gemini.google.com', GEMINI, FORM, `f.req=${formEnc(outer)}&at=x`));
  assert.equal(gw(JSON.stringify([null, '[["hi"],{"a":1,"a":2}]'])), false, 'inner f.req');
  assert.equal(gw('[null,"[[\\"hi\\"]]",{"a":1,"a":2}]'), false, 'outer f.req');
  assert.equal(gw('[null,"[[\\"hi\\"]]",{"a":1,"b":2}]'), true);
  // Unicode keys fold to attachment keys somewhere: held.
  const web = (extra) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/f/conversation',
    { messages: [{ content: { content_type: 'text', parts: ['hi'] } }], x: extra }));
  assert.equal(web({ 'FİLE': 'x' }), false);
  assert.equal(web({ 'ｆｉｌｅ': 'x' }), false);
  assert.equal(web({ ok_key: 'x' }), true);
  // ChatGPT asset pointers and selected sources.
  const cg = (meta) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/conversation',
    { messages: [{ content: { content_type: 'text', parts: ['hi'] }, metadata: meta }] }));
  assert.equal(cg({ selected_sources: [], asset_pointer: '' }), true);
  assert.equal(cg({ selected_sources: ['drive'] }), false);
  assert.equal(cg({ x: { asset_pointer: 'file-service://file-1' } }), false);
  // Gemini web: an upload reference in a non-turn slot.
  const slot = (other) => releasable(req('POST', 'gemini.google.com', GEMINI, FORM,
    `f.req=${formEnc(JSON.stringify([null, JSON.stringify([['hi'], other])]))}`));
  assert.equal(slot(['c_9cf48bd306a5cf08', null, 1]), true);
  assert.equal(slot([[['/contrib_service/ttl_1d/abc', 3]]]), false);
  assert.equal(slot(['x', 'application/pdf']), false);
  assert.equal(slot({ k: 'Image/PNG' }), false);
  for (const t of ['image/', 'text/', 'audio/', 'video/', 'font/', 'model/', 'application/']) assert.equal(slot([`${t}x`]), false, t);
  assert.equal(slot(['imag/x', 'applications/x', 'x/image/']), true, 'prefixes are exact');
});

test('releasableUnderFailOpen: round 2 boundaries - budgets, authored JSON, tokens, data URIs, base64 runs', () => {
  const chat = (extra) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/f/conversation',
    { messages: [{ content: { content_type: 'text', parts: ['hi'] } }], x: extra }));
  const cmsg = (extra) => releasable(jreq('POST', 'chatgpt.com', '/backend-api/f/conversation',
    { messages: [{ content: { content_type: 'text', parts: ['hi'] }, ...extra }] }));
  const am = (m) => anth({ messages: [m] });
  const use = (input) => am({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input }] });
  // The per-item budget is exactly 4096: key a (1) + 4094 + key b (1) + 0 passes, one more byte holds.
  const s4094 = 'a '.repeat(2047);
  assert.equal(cmsg({ a: s4094, b: '' }), true);
  assert.equal(cmsg({ a: s4094, b: 'x' }), false);
  // ...and a nested item restores the enclosing item's budget, not a fresh one.
  const big = (n) => 'a '.repeat(n / 2);
  assert.equal(releasable(am({ role: 'user', content: [{ type: 'tool_result', tool_use_id: big(4000), content: [{ type: 'text', text: 'x' }],
    cache_control: { x: big(2000) } }] })), false, 'tool_result: 4000 + 2000 in one item');
  // Each text block of a tool result has its own budget.
  const parts = Array.from({ length: 10 }, () => ({ type: 'text', text: 'x', cache_control: { x: big(800) } }));
  assert.equal(releasable(am({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: parts }] })), true);
  // Each chatgpt / chat-completions message and Gemini function response has its own budget.
  const many = (mk) => Array.from({ length: 20 }, mk);
  assert.equal(releasable(jreq('POST', 'chatgpt.com', '/backend-api/f/conversation',
    { messages: many(() => ({ content: { content_type: 'text', parts: ['hi'] }, id: big(600) })) })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions',
    { messages: many(() => ({ role: 'user', content: 'hi', name: big(600) })) })), true);
  assert.equal(releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1beta/models/g:generateContent',
    { contents: [{ role: 'user', parts: many(() => ({ functionResponse: { name: 'f', response: {}, id: big(600) } })) }] })), true);
  // The authored budget is exactly MAX_AUTHORED: key k (1) + the string.
  assert.equal(releasable(use({ k: 'a '.repeat(MAX_AUTHORED / 2 - 1) + 'a' })), true, '1 + (MAX - 1)');
  assert.equal(releasable(use({ k: 'a '.repeat(MAX_AUTHORED / 2) })), false, '1 + MAX');
  // Every inline-data container is held with a value, in any case; empty is fine.
  for (const k of ['inlinedata', 'inline_data', 'filedata', 'file_data', 'image_url', 'imageurl', 'input_image', 'input_file', 'input_audio', 'b64_json']) {
    for (const key of [k, k.toUpperCase(), k[0].toUpperCase() + k.slice(1)]) {
      assert.equal(releasable(use({ x: { [key]: 'v' } })), false, key);
      assert.equal(releasable(use({ x: { [key]: { a: 1 } } })), false, key);
      assert.equal(releasable(use({ x: { [key]: '' } })), true, `${key} empty`);
    }
  }
  // A blob: any MIME key beside a non-empty data string; neither alone.
  for (const k of ['mimetype', 'mime_type', 'media_type', 'mediatype', 'MimeType', 'MEDIA_TYPE']) {
    assert.equal(releasable(use({ [k]: 'image/png', data: 'QQ' })), false, k);
    assert.equal(releasable(use({ [k]: 'image/png' })), true, `${k} alone`);
    assert.equal(releasable(use({ [k]: 5, data: 'QQ' })), true, `${k} not a string`);
    assert.equal(releasable(use({ [k]: null, data: 'QQ' })), true, `${k} null`);
  }
  assert.equal(releasable(use({ data: 'QQ' })), true);
  assert.equal(releasable(use({ mimeType: 'image/png', Data: 'QQ' })), true, 'data is an exact key');
  assert.equal(releasable(use({ mimeType: 'image/png', data: ['QQ'] })), true);
  assert.equal(releasable(use({ x: [{ mimeType: 'image/png', data: 'QQ' }] })), false, 'a blob inside an array');
  assert.equal(releasable(use({ x: [b64n(4095)] })), true);
  assert.equal(releasable(use({ x: [b64n(4096)] })), false);
  assert.equal(releasable(use({ x: ['é'] })), true);
  assert.equal(releasable(use({ 'é': 'x' })), false, 'latin-1 key');
  assert.equal(releasable(use({ '': 'x', '\u0080': 1 })), false, 'U+0080 key');
  // Model tokens count bytes, not characters; null and absent are fine, a number is not.
  const sig = (v) => am({ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: v }] });
  assert.equal(releasable(sig('é'.repeat(MAX_MODEL_TOKEN / 2))), true);
  assert.equal(releasable(sig('é'.repeat(MAX_MODEL_TOKEN / 2 + 1))), false);
  assert.equal(releasable(sig(null)), true);
  assert.equal(releasable(sig(5)), false);
  const red = (b) => am({ role: 'assistant', content: [{ type: 'redacted_thinking', ...b }] });
  assert.equal(releasable(red({ data: 'x' })), true);
  assert.equal(releasable(red({ data: null })), false, 'redacted data must be a string');
  assert.equal(releasable(red({})), false);
  const gsig = (v) => jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [{ parts: [{ text: 'x', thoughtSignature: v }] }] });
  assert.equal(releasable(gsig(null)), true);
  assert.equal(releasable(gsig(5)), false);
  assert.equal(releasable(gsig('é'.repeat(MAX_MODEL_TOKEN / 2 + 1))), false);
  // data URIs: a prefix then ;base64, - JS and Rust trim differently (U+0085 yes, U+FEFF no).
  assert.equal(chat('data;base64,QQ'), true, 'no colon');
  assert.equal(chat('database;base64,QQ'), true);
  assert.equal(chat('data:x base64,QQ'), true, 'no semicolon');
  assert.equal(chat('data:x;base64'), true, 'no comma');
  assert.equal(chat('data:x;BASE64,QQ'), false);
  assert.equal(chat('\u0085data:x;base64,QQ'), false, 'U+0085 is trimmed');
  assert.equal(chat('﻿data:x;base64,QQ'), true, 'U+FEFF is not');
  assert.equal(chat('\t\n data:x;base64,QQ'), false);
  assert.equal(chat('x data:x;base64,QQ'), true, 'the prefix is at the start');
  // Base64 runs: every alphabet member, from 512 on.
  for (const run of ['0123456789'.repeat(52), 'q'.repeat(512), 'Q'.repeat(512), '+'.repeat(512), '/'.repeat(512), '-'.repeat(512), '_'.repeat(512), '='.repeat(512)]) {
    assert.equal(chat(run), false, run.slice(0, 12));
    assert.equal(chat(run.slice(0, 511)), true, `${run.slice(0, 12)} one short`);
    assert.equal(chat(`${run} `), true);
    assert.equal(chat(`${run}é`), true);
  }
});

test('releasableUnderFailOpen: round 2 boundaries - query, duplicate keys, parts, upload refs', () => {
  const hi = { messages: [{ role: 'user', content: 'hi' }] };
  const q = (query) => jreq('POST', 'api.anthropic.com', `/v1/messages?${query}`, hi);
  assert.equal(releasable(q(`x=${'a+'.repeat(1023)}`)), true, '2048 bytes');
  assert.equal(releasable(q(`x=${'a+'.repeat(1023)}a`)), false, '2049 bytes');
  assert.equal(releasable(q(`x=${'é'.repeat(1024)}`)), false, 'bytes, not characters');
  assert.equal(releasable(q(`x=${'é'.repeat(1023)}`)), true);
  assert.equal(releasable(q('file')), true, 'no = is an empty value');
  assert.equal(releasable(q('x')), true);
  assert.equal(releasable(q('x=1?file=cv')), true, 'the first ? starts the query');
  assert.equal(releasable(q('x=1#file=cv')), true, 'a fragment is cut');
  assert.equal(releasable(q('FILE=')), true);
  assert.equal(releasable(q('a=1&file=%63v')), false, 'values are decoded');
  assert.equal(releasable(q('f%69le=cv')), false, 'keys are decoded');
  assert.equal(releasable(q('x=1&&&')), true);
  assert.equal(releasable(q('x=%zz&file=')), false, 'a bad escape in any pair');
  assert.equal(releasable(q('x=1;file=cv')), true, '; is not a separator');
  // The path is cut at ? then #: a ? after the # is in the fragment.
  assert.equal(releasable(jreq('POST', 'api.anthropic.com', '/v1/messages#a?b', hi)), true);
  assert.equal(releasable(jreq('POST', 'api.anthropic.com', '/v1/messages#a?file=cv', hi)), false, 'the query still reads what follows the first ?');
  // Duplicate keys: escapes, strings holding quotes, arrays of equal strings, nesting.
  const dup = (body) => releasable(req('POST', 'api.anthropic.com', '/v1/messages', 'application/json', body));
  assert.equal(dup('{"messages":[],"\\u006dessages":[]}'), false, 'an escaped spelling of the same key');
  assert.equal(dup('{"messages":[],"model":"x\\"y","model":"z"}'), false, 'after a string holding an escaped quote');
  assert.equal(dup('{"messages":[],"a":"x\\"y","b":1,"b":2}'), false);
  assert.equal(dup('{"messages":[],"stop_sequences":["a","a"],"model":"m"}'), true, 'equal strings in an array are not keys');
  assert.equal(dup('{"messages":[],"metadata":{"a":1},"thread":{"a":2}}'), true, 'the same key in two objects');
  assert.equal(dup('{"messages":[],"metadata":{"a":{"a":1}}}'), true, 'a key inside its own value');
  assert.equal(dup('{"messages":[],"metadata":{"a":1,"b":{"x":1},"a":2}}'), false, 'a repeat after a nested object');
  assert.equal(dup('{"messages":[],"metadata":{"a":[1,{"b":1}],"a":2}}'), false, 'a repeat after a nested array');
  assert.equal(dup('{"messages":[],"metadata":{"a":"x","a":"x"}}'), false, 'equal values');
  assert.equal(dup('{"messages":[],"metadata":{"a":1,"A":2}}'), true, 'case-sensitive');
  // Chat-completions parts and function-call settings.
  const cc = (m) => releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [m] }));
  assert.equal(cc({ role: 'user', content: ['x'] }), false, 'a part that is not an object');
  assert.equal(cc({ role: 'user', content: [null] }), false);
  assert.equal(cc({ role: 'user', content: [{ type: 'text', text: 'x' }, 5] }), false);
  assert.equal(cc({ role: 'user', content: [{ type: 'text' }] }), false);
  assert.equal(cc({ role: 'user', content: [{ type: 'refusal' }] }), false);
  assert.equal(cc({ role: 'user', content: [{ type: 'refusal', refusal: 'x' }] }), true);
  assert.equal(cc({ role: 'user', content: [{ type: 'text', text: 'x', extra: 1 }] }), false);
  assert.equal(cc({ role: 'user', content: [{ type: 'other', text: 'x' }] }), false);
  const call = (calls) => cc({ role: 'assistant', content: null, tool_calls: calls });
  assert.equal(call([{ id: 'c', type: 'function', function: { name: 'f', arguments: big4k() } }]), true, 'arguments are not settings');
  assert.equal(call(Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'f', arguments: '{}' } }))), true);
  assert.equal(call([{ id: 'c', type: 'function', function: { name: 'f', arguments: 5 } }]), false);
  const gc = (part) => releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1beta/models/g:generateContent', { contents: [{ role: 'model', parts: [part] }] }));
  assert.equal(gc({ functionCall: { name: 'f', args: {}, id: null } }), true, 'a null id');
  assert.equal(gc({ functionCall: { name: 'f' } }), true, 'absent args');
  assert.equal(gc({ functionCall: { name: 'f', args: null } }), false);
  assert.equal(gc({ functionResponse: { name: 'f', response: {}, scheduling: 'SILENT' } }), true);
  assert.equal(gc({ functionResponse: { name: 'f', response: {}, id: 'x' } }), true);
  assert.equal(gc({ functionResponse: { name: 'f' } }), true, 'absent response');
  assert.equal(gc({ functionResponse: { name: 'f', response: null } }), false);
  assert.equal(gc({ functionResponse: { name: 'f', parts: [] } }), true);
  assert.equal(gc({ functionResponse: { name: 'f', parts: [5] } }), false);
  assert.equal(gc({ functionResponse: { name: 'f', parts: [null] } }), false);
  assert.equal(gc({ functionResponse: { name: 'f', parts: ['x'] } }), false);
  assert.equal(gc({ functionResponse: { name: 'f', id: 'a '.repeat(MAX_ITEM_OPAQUE) } }), false, 'the id is a setting');
  assert.equal(gc({ functionResponse: { name: 'f', willContinue: 'a '.repeat(MAX_ITEM_OPAQUE) } }), false);
  assert.equal(gc({ thought: true, text: 'x' }), true);
  assert.equal(gc({ thought: null, text: 'x' }), false);
  // Chat-completions tool_choice and Responses tool definitions are authored JSON, not settings.
  const big5000 = 'a '.repeat(2500);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [], tool_choice: { type: 'function', function: { name: 'f' }, note: big5000 } })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [], tools: [{ type: 'function', function: { name: 'f', description: big5000 } }] })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [], functions: [{ name: 'f', description: big5000 }] })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'x', tool_choice: { type: 'function', note: big5000 } })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: 'x', tools: [{ type: 'function', description: big5000 }] })), true);
  assert.equal(releasable(anth({ ...hi, tool_choice: { type: 'auto', note: big5000 } })), true);
  assert.equal(releasable(jreq('POST', 'claude.ai', CLAUDE_AI, { prompt: 'x', tools: [{ d: big5000 }] })), true);
  assert.equal(releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent', { contents: [], tools: [{ d: big5000 }] })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ type: 'additional_tools', tools: [{ d: big5000 }] }] })), true);
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ type: 'additional_tools', tools: [], extra: 1 }] })), false, 'additional_tools settings are held to the settings rule');
  assert.equal(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ type: 'additional_tools', tools: [], id: big5000 }] })), false);
  // Responses items: reasoning, outputs.
  const ri = (item) => releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [item] }));
  assert.equal(ri({ type: 'reasoning', encrypted_content: null }), true);
  assert.equal(ri({ type: 'reasoning', encrypted_content: 5 }), false);
  assert.equal(ri({ type: 'reasoning', id: 'x', status: 'completed' }), true);
  assert.equal(ri({ type: 'reasoning', id: big5000 }), false);
  assert.equal(ri({ type: 'reasoning', status: { file: 'x' } }), false);
  assert.equal(ri({ type: 'function_call_output', call_id: 'c', output: 'x', internal_chat_message_metadata_passthrough: { a: 'b' } }), true);
  assert.equal(ri({ type: 'function_call_output', call_id: 'c', output: 'x', internal_chat_message_metadata_passthrough: big5000 }), false);
  assert.equal(ri({ type: 'local_shell_call_output', call_id: 'c', output: 'x', other: 1 }), false);
  // tool_use / tool_result settings are settings.
  const am = (m) => anth({ messages: [m] });
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: big5000, name: 'n', input: {} }] })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: {}, caller: { file: 'x' } }] })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: {}, cache_control: { x: big5000 } }] })), false);
  assert.equal(releasable(am({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n' }] })), false, 'input is required');
  assert.equal(releasable(am({ role: 'user', content: [{ type: 'tool_result', tool_use_id: big5000, content: 'x' }] })), false);
  assert.equal(releasable(am({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x', is_error: { file: 'x' } }] })), false);
  assert.equal(releasable(am({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x', is_error: true }] })), true);
  // Gemini web: a prompt may look like a path or a MIME type; only the other slots are searched.
  const gw = (turn, other) => releasable(req('POST', 'gemini.google.com', GEMINI, FORM,
    `f.req=${formEnc(JSON.stringify([null, JSON.stringify([turn, other])]))}`));
  assert.equal(gw(['/start the day'], ['en']), true);
  assert.equal(gw(['text/plain is a type'], ['en']), true);
  assert.equal(gw(['hi'], ['en', { a: ['x', ['application/pdf']] }]), false, 'nested in an object in an array');
  assert.equal(gw(['hi'], ['en', { a: 'IMAGE/x' }]), false);
  assert.equal(gw(['hi'], ['applications/x', 'images/x', 'texts/x', 'audios/x', 'videos/x', 'fonts/x', 'models/x', 'x/image/', 'application', 'image']), true, 'exact prefixes');
  assert.equal(gw(['hi'], ['İmage/x']), true, 'an unrelated unicode letter is not a prefix');
  assert.equal(gw(['hi'], { k: { j: '/up' } }), false);
});

function big4k() { return 'a '.repeat(2500); }

// ── round 2 through the real fetch hook (verdict timeout + relay outage) ────
const G3_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent';
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CHATGPT_URL = 'https://chatgpt.com/backend-api/conversation';
const HI = { messages: [{ role: 'user', content: 'hi' }] };
const g3Call = (part) => jsonInit({ contents: [{ role: 'model', parts: [part] }] });
const R2_HELD = {
  'Gemini 3 functionResponse.parts inlineData PDF': [G3_URL, g3Call({ functionResponse: { name: 'f', response: {}, parts: [{ inlineData: { mimeType: 'application/pdf', data: b64n(4000) } }] } })],
  'Gemini functionResponse.response.inlineData': [G3_URL, g3Call({ functionResponse: { name: 'f', response: { inlineData: { mimeType: 'application/pdf', data: b64n(4000) } } } })],
  'Gemini functionCall.args.file b64': [G3_URL, g3Call({ functionCall: { name: 'f', args: { file: b64n(4096) } } })],
  'duplicate key, LAST value benign': [CC_URL, { method: 'POST', headers: JSON_CT, body: '{"messages":[{"role":"user","content":[{"type":"image","source":{}}]}],"messages":[{"role":"user","content":"hi"}]}' }],
  'FİLE key': [CHATGPT_URL, jsonInit({ messages: [{ content: { content_type: 'text', parts: ['hi'] } }], 'FİLE': 'Jane Doe 123-45-6789' })],
  'ChatGPT asset_pointer': [CHATGPT_URL, jsonInit({ messages: [{ content: { content_type: 'text', parts: ['hi'] }, metadata: { x: { asset_pointer: 'file-service://file-1' } } }] })],
  'ChatGPT selected_sources': [CHATGPT_URL, jsonInit({ messages: [{ content: { content_type: 'text', parts: ['hi'] }, metadata: { selected_sources: ['drive'] } }] })],
  'query string carrying base64': [`${CC_URL}?x=${b64n(600)}`, jsonInit(HI)],
  'non-string chat part': ['https://api.openai.com/v1/chat/completions', jsonInit({ messages: [{ role: 'user', content: [{ type: 'text', text: { file: 'x' } }] }] })]
};

test('fail-open round 2: the review\'s new leaks are HELD, on a verdict timeout and on a relay outage', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    for (const [name, [url, init]] of Object.entries(R2_HELD)) {
      const r = await foRun(outage, url, init);
      assert.equal(r.outcome, 'BLOCKED', `${oname}: ${name}`);
      assert.equal(r.w.netCalls.length, 0, `${oname}: ${name}`);
      assert.equal(r.w.unchecked.length, 0, `${oname}: ${name}`);
      assertBlocked(r.w.logs, 'fail-open-file-held', 'unavailable');
    }
  }
});

test('fail-open round 2: a Codex tool output carrying internal_chat_message_metadata_passthrough is SENT', async () => {
  const body = { type: 'response.create', input: [{ type: 'custom_tool_call_output', call_id: 'c', output: 'done',
    internal_chat_message_metadata_passthrough: { turn_id: 't', create_time: 1.5, content_item_kinds: ['tool.output'] } }] };
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    const r = await foRun(outage, CODEX_URL, jsonInit(body));
    assert.equal(r.outcome, 'SENT', oname);
    assert.equal(r.w.netCalls.length, 1, oname);
    assert.deepEqual(r.w.unchecked, [outage.cause], oname);
  }
  // Control: the same frame with a file-ish key in the metadata is held.
  const bad = structuredClone(body);
  bad.input[0].internal_chat_message_metadata_passthrough.asset_pointer = 'file-service://f';
  assert.equal((await foRun(FO_OUTAGES['verdict timeout'], CODEX_URL, jsonInit(bad))).outcome, 'BLOCKED');
});

test('decide() holds by default: a caller that forgets the releasable argument gets a hold', () => {
  assert.match(SHIM_SRC, /function decide\(res, coverage, scope, url, releasable = false, bodyless = false\)/);
  assert.ok(!/releasable = true/.test(SHIM_SRC.replace('if (bodyless) releasable = true;', '')), 'no other default or override');
});

test('fail-open: an upload-scope request is held even when its bytes look like a chat turn (fetch and XHR)', async () => {
  const TITLE = 'https://claude.ai/api/organizations/o/chat_conversations/c/title';
  const body = JSON.stringify({ message_content: 'hi' });
  const marked = { 'content-type': 'application/json', 'x-goog-upload-protocol': 'resumable' };
  // Sanity: unmarked, the same bytes are a known turn and fail open.
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    const plain = await foRun(outage, TITLE, { method: 'POST', headers: JSON_CT, body });
    assert.equal(plain.outcome, 'SENT', `${oname} unmarked`);
    const up = await foRun(outage, TITLE, { method: 'POST', headers: marked, body });
    assert.equal(up.outcome, 'BLOCKED', `${oname} upload-marked`);
    assert.equal(up.w.netCalls.length, 0);
    assert.equal(up.w.unchecked.length, 0);
    const line = assertBlocked(up.w.logs, 'fail-open-file-held', 'unavailable');
    assert.match(line, /\bscope=upload\b/);
  }
  // XHR: same rule, same caller shape.
  const xhrRun = async (method, url, headers, payload) => {
    const w = makeXhrWorld(() => ({ ok: false, code: 'no-bridge' }), { extraGlobals: realCatalogGlobals('https://chat.openai.com/') });
    w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    const x = new w.sandbox.XMLHttpRequest();
    x.open(method, url, true);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.send(payload);
    await waitFor(() => x.aborted || x.sent.length === 1);
    return { x, w };
  };
  const sent = await xhrRun('POST', CC_URL, JSON_CT, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(sent.x.sent.length, 1, 'a known turn fails open over XHR');
  assert.deepEqual(sent.w.unchecked, ['relay-no-bridge']);
  const svg = await xhrRun('POST', CC_URL, { 'content-type': 'image/svg+xml' }, '<svg/>');
  assert.deepEqual(svg.x.sent, []);
  assert.equal(svg.x.sonomosBlockReason, 'fail-open-file-held');
  const put = await xhrRun('PUT', STORAGE_PUT, { 'content-type': 'application/pdf' }, 'file bytes');
  assert.deepEqual(put.x.sent, []);
  assert.equal(put.x.sonomosBlockReason, 'fail-open-file-held');
  const upMarked = await xhrRun('POST', TITLE, marked, body);
  assert.deepEqual(upMarked.x.sent, [], 'upload scope, though the bytes read as a chat turn');
  assert.equal(upMarked.x.sonomosBlockReason, 'fail-open-file-held');
  assert.equal(upMarked.w.unchecked.length, 0);
});

test('mixed versions: a redact whose rebuilt request cannot be decoded is held as an unchecked pass, not a malformed redact', async () => {
  for (const window of [openWindow(), null]) {
    const bad = await recv({ ok: true, receipt: { decision: 'redact', unchecked: true, redactedCount: 1, requestB64: '!!!not base64!!!' } },
      AI_URL, { method: 'POST', headers: JSON_CT, body: CHAT_JSON }, window);
    assert.equal(bad.outcome, 'BLOCKED');
    assert.match(assertBlocked(bad.w.logs, 'fail-open-file-held', 'unavailable'), /\bcause=unchecked-pass\b/);
  }
});

// ── round 3 of the zh#370 review: a tool's output text carrying a file ────
// Port of the Rust `tool_output_text_carrying_a_file_is_held`.

test('releasableUnderFailOpen: tool output text carrying a file is held (tool_output_text_carrying_a_file_is_held)', () => {
  const blob = 'QUJD'.repeat(MAX_OPAQUE_STRING / 4);
  const under = 'QUJD'.repeat(MAX_OPAQUE_STRING / 4 - 1);
  const uri = `data:application/pdf;base64,${blob}`;
  const shortUri = 'data:application/pdf;base64,JVBERi0x';
  const prose = `lockfile:\n${'a b '.repeat(5000)}\nsha512: ${under}`;
  const tr = (content) => anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }] }] });
  for (const [ok, c] of [
    [true, prose], [true, under], [true, `see ${shortUri} in the source`], [false, `see ${uri}`], [false, blob], [false, uri],
    [true, [{ type: 'text', text: under }]], [false, [{ type: 'text', text: blob }]],
    [false, [{ type: 'text', text: 'x' }, { type: 'text', text: uri }]],
    [true, [{ type: 'tool_reference', tool_name: 'x' }]], [false, 1]
  ]) {
    assert.equal(releasable(tr(c)), ok, `tool_result ${JSON.stringify(c).slice(0, 60)}`);
  }
  assert.ok(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] }] })));
  assert.ok(releasable(anth({ messages: [{ role: 'user', content: [{ type: 'text', text: blob }] }] })), 'a prompt is not tool text');
  const fr = (t) => jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent',
    { contents: [{ parts: [{ functionResponse: { name: 'f', response: {}, parts: [{ text: t }] } }] }] });
  assert.ok(releasable(fr(under)));
  assert.ok(!releasable(fr(blob)));
  assert.ok(!releasable(fr(uri)));
  const out = (o) => jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ type: 'custom_tool_call_output', call_id: 'c', output: o }] });
  assert.ok(releasable(out(under)));
  assert.ok(!releasable(out(blob)));
  assert.ok(!releasable(out(uri)));
  assert.ok(releasable(out([{ type: 'input_text', text: under }])));
  assert.ok(!releasable(out([{ type: 'input_text', text: 'x' }, { type: 'input_text', text: blob }])));
  assert.ok(!releasable(out([{ type: 'input_image', text: 'x' }])), 'output parts keep their shape check');
  assert.ok(!releasable(out(1)));
  assert.ok(!releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ type: 'function_call_output', call_id: 'c', output: blob }] })));
  assert.ok(releasable(jreq('POST', 'api.openai.com', '/v1/responses', { input: [{ role: 'user', content: blob }] })));
  const tool = (role, c) => jreq('POST', 'api.openai.com', '/v1/chat/completions', { messages: [{ role, tool_call_id: '1', content: c }] });
  assert.ok(releasable(tool('tool', under)));
  assert.ok(!releasable(tool('tool', blob)));
  assert.ok(!releasable(tool('function', uri)));
  assert.ok(releasable(tool('function', shortUri)));
  assert.ok(!releasable(tool('tool', [{ type: 'text', text: blob }])));
  assert.ok(releasable(tool('tool', [{ type: 'text', text: under }])));
  assert.ok(releasable(tool('tool', null)));
  assert.ok(releasable(tool('user', blob)));
  assert.ok(releasable(tool('assistant', [{ type: 'refusal', refusal: blob }])));
});

const R3_HELD = {
  'Anthropic tool_result of pure base64 (800 KB)': [CC_URL, jsonInit({ messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't', content: 'UEsDBBQAAAAIAA'.repeat(800000 / 14) }] }] })],
  'Anthropic tool_result text part of pure base64': [CC_URL, jsonInit({ messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'UEsDBBQAAAAIAA'.repeat(1000) }] }] }] })],
  'Gemini functionResponse.parts text of pure base64 (500 KB)': [G3_URL, g3Call({ functionResponse: { name: 'read', response: {},
    parts: [{ text: 'JVBERi0xLjcK'.repeat(500000 / 12) }] } })],
  'Codex custom_tool_call_output of pure base64': [CODEX_URL, jsonInit({ type: 'response.create', input: [
    { type: 'custom_tool_call_output', call_id: 'c', output: 'JVBERi0xLjcK'.repeat(1000) }] })],
  'Codex function_call_output of pure base64': [CODEX_URL, jsonInit({ type: 'response.create', input: [
    { type: 'function_call_output', call_id: 'c', output: 'JVBERi0xLjcK'.repeat(1000) }] })],
  'OpenAI tool-role message of a data URI': ['https://api.openai.com/v1/chat/completions', jsonInit({ messages: [
    { role: 'tool', tool_call_id: '1', content: `data:application/pdf;base64,${'JVBERi0xLjcK'.repeat(400)}` }] })]
};

test('fail-open round 3: tool output text carrying a file is HELD, on a verdict timeout and on a relay outage', async () => {
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    for (const [name, [url, init]] of Object.entries(R3_HELD)) {
      const r = await foRun(outage, url, init);
      assert.equal(r.outcome, 'BLOCKED', `${oname}: ${name}`);
      assert.equal(r.w.netCalls.length, 0, `${oname}: ${name}`);
      assert.equal(r.w.unchecked.length, 0, `${oname}: ${name}`);
      assertBlocked(r.w.logs, 'fail-open-file-held', 'unavailable');
    }
  }
});

test('fail-open round 3: ordinary tool text (a lockfile with hashes) is still SENT', async () => {
  const lockfile = `integrity sha512-${'QUJD'.repeat(20)} resolved https://x\n`.repeat(200);
  for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
    const r = await foRun(outage, CC_URL, jsonInit({ messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't', content: lockfile }] }] }));
    assert.equal(r.outcome, 'SENT', oname);
    assert.deepEqual(r.w.unchecked, [outage.cause], oname);
  }
});

// ── round 3b of the zh#370 review: an encoded run ANYWHERE in tool output ──
// Port of the Rust `an_encoded_run_anywhere_in_tool_output_is_held`.

test('releasableUnderFailOpen: an encoded run anywhere in tool output is held (an_encoded_run_anywhere_in_tool_output_is_held)', () => {
  const b64 = 'JVBERi0xLjcK7b+IRl8Dre0pqxTCVufYUFZ5GjhDIMQ0lWhy'.repeat(200);
  const wrap = (sep, w) => b64.match(new RegExp(`.{1,${w}}`, 'g')).join(sep);
  const hex = '255044462d312e370aedbf88465f03'.repeat(150);
  const tr = (c) => anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: c }] }] });
  for (const [name, text] of [
    ['trailing newline', `${b64}\n`], ['leading space', ` ${b64}`], ['prefix text', `Here is the file:\n${b64}`],
    ['glued prefix', `out:${b64}`], ['wrapped 76, LF', wrap('\n', 76)], ['wrapped 76, CRLF', wrap('\r\n', 76)],
    ['wrapped 64 by spaces', wrap(' ', 64)], ['wrapped by blank lines', wrap('\n\n', 76)],
    ['text before a data uri', `see: data:application/pdf;base64,${b64}`],
    ['leading whitespace data uri', `  \n data:application/pdf;base64,${b64}`],
    ['hex with a prefix', `hex:\n${hex}`], ['hex pure', hex],
    ['wrapped with a short last line', `${wrap('\n', 76)}\nQUJD`]
  ]) {
    assert.ok(!releasable(tr(text)), `${name} must be held`);
  }
  const chunks = b64.match(/.{1,3000}/g);
  assert.ok(!releasable(tr(chunks.map((c) => ({ type: 'text', text: c })))), 'parts');
  assert.ok(!releasable(anth({ messages: [{ role: 'user', content: chunks.map((c) => ({ type: 'tool_result', tool_use_id: 't', content: c })) }] })), 'results');
  assert.ok(!releasable(jreq('POST', 'generativelanguage.googleapis.com', '/v1/models/g:generateContent',
    { contents: [{ parts: [{ functionResponse: { name: 'f', parts: chunks.map((c) => ({ text: c })) } }] }] })), 'gemini parts');
  const ok = [
    'QUJD'.repeat(MAX_OPAQUE_STRING / 4 - 1),
    `${'QUJD'.repeat(600)}.${'QUJD'.repeat(600)}`,
    'the quick brown fox jumps over the lazy dog '.repeat(200),
    `integrity sha512-${'QUJD'.repeat(20)} resolved https://x\n`.repeat(300),
    `${'QUJD'.repeat(500)} ${'QUJD'.repeat(400)}`.replaceAll('QUJDQUJD', 'QUJD QUJD'),
    `${'QUJD'.repeat(800)}\nthe end\n${'QUJD'.repeat(800)}`
  ];
  ok.forEach((text, i) => assert.ok(releasable(tr(text)), `ok case ${i} must go out`));
  const exact = 'Q'.repeat(MAX_OPAQUE_STRING);
  assert.ok(!releasable(tr(exact.match(/.{1,16}/g).join('\n'))));
  assert.ok(releasable(tr(exact.slice(1).match(/.{1,16}/g).join('\n'))));
  const lines = (w, n) => Array(n).fill('Q'.repeat(w)).join('\n');
  assert.ok(releasable(tr(lines(15, 600))));
  assert.ok(!releasable(tr(lines(16, 300))));
  assert.ok(!releasable(tr(wrap('\t', 76))));
  assert.ok(!releasable(tr(`${b64}. done`)));
  for (const sep of ['/', '=', '-', '_', '+']) {
    assert.ok(!releasable(tr(Array(50).fill('Q'.repeat(90)).join(sep))), sep);
  }
  assert.ok(releasable(tr(Array(50).fill('Q'.repeat(90)).join('.'))));
  assert.ok(releasable(tr(Array(50).fill('Q'.repeat(90)).join('é'))), 'a non-ASCII character ends a run');
  const half = tr('QUJD'.repeat(600));
  assert.ok(releasable(half) && releasable(half), 'each request scans afresh');
});

// The re-check's 18 c6 repros, through the real fetch hook, on a verdict
// timeout and on a relay outage. Built here at full size.
{
  const B = 'JVBERi0xLjcK7b+IRl8Dre0pqxTCVufYUFZ5GjhDIMQ0lWhy'.repeat(16700);
  const HEX = '255044462d312e370aedbf88465f03'.repeat(20000);
  const wrap76 = (sep) => B.match(/.{1,76}/g).join(sep);
  const chunks = B.slice(0, 800000).match(/.{1,4000}/g);
  const tr = (c) => [CC_URL, jsonInit({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: c }] }] })];
  const codex = (o) => [CODEX_URL, jsonInit({ type: 'response.create', input: [{ type: 'function_call_output', call_id: 'c', output: o }] })];
  const toolRole = (c) => ['https://api.openai.com/v1/chat/completions', jsonInit({ messages: [{ role: 'tool', tool_call_id: '1', content: c }] })];
  const C6 = {
    'R1 gemini part 500k b64': () => [G3_URL, g3Call({ functionResponse: { name: 'r', response: {}, parts: [{ text: B.slice(0, 500000) }] } })],
    'R2 tool_result 800k b64': () => tr(B),
    'R3 tool_result prefix text': () => tr(`Here is the file:\n${B}`),
    'R4 tool_result trailing newline': () => tr(`${B}\n`),
    'R5 tool_result leading space': () => tr(` ${B}`),
    'R6 tool_result mime wrapped': () => tr(`${wrap76('\n')}\n`),
    'R7 tool_result wrapped 76 spaces': () => tr(wrap76(' ')),
    'R8 tool_result text before data uri': () => tr(`see: data:application/pdf;base64,${B}`),
    'R9 tool_result leading ws data uri': () => tr(`  \n data:application/pdf;base64,${B}`),
    'R10 tool_result parts chunks': () => tr(chunks.map((c) => ({ type: 'text', text: c }))),
    'R11 many tool results': () => [CC_URL, jsonInit({ messages: [{ role: 'user', content: chunks.map((c) => ({ type: 'tool_result', tool_use_id: 't', content: c })) }] })],
    'R12 gemini parts chunks': () => [G3_URL, g3Call({ functionResponse: { name: 'r', response: {}, parts: chunks.map((c) => ({ text: c })) } })],
    'R13 codex fco prefix': () => codex(`cat out:\n${B}`),
    'R14 chat tool role prefix': () => toolRole(`out:\n${B}`),
    'R15 codex fco pure': () => codex(B),
    'R16 chat tool role pure': () => toolRole(B),
    'R17 hex prefix': () => tr(`hex:\n${HEX}`),
    'R18 hex pure': () => tr(HEX)
  };
  for (const [name, build] of Object.entries(C6)) {
    test(`fail-open round 3b (c6): ${name} is HELD, on a verdict timeout and on a relay outage`, async () => {
      const [url, init] = build();
      for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
        const r = await foRun(outage, url, init);
        assert.equal(r.outcome, 'BLOCKED', `${oname}: ${name}`);
        assert.equal(r.w.netCalls.length, 0, `${oname}: ${name}`);
        assert.equal(r.w.unchecked.length, 0, `${oname}: ${name}`);
        assertBlocked(r.w.logs, 'fail-open-file-held', 'unavailable');
      }
    });
  }
}

// ── round 3c of the zh#370 review: a wrapped file inside line decorations ──
// Port of the Rust `a_wrapped_file_inside_line_decorations_is_held`.

test('releasableUnderFailOpen: a wrapped file inside line decorations is held (a_wrapped_file_inside_line_decorations_is_held)', () => {
  const b64 = 'JVBERi0xLjcK5+7nYV7zXzDkm0guFcrnUAcgHhJhew/tp+Fkd5b/AivqjtAqgqF1kw8jN8'.repeat(100);
  const lines = b64.match(/.{1,76}/g);
  const tr = (c) => anth({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: c }] }] });
  const each = (f, sep) => lines.map((l, i) => f(i, l)).join(sep);
  const pad6 = (n) => String(n).padStart(6, ' ');
  for (const [name, text] of [
    ['Read arrows', each((i, l) => `${pad6(i + 1)}→${l}`, '\n')],
    ['cat -n tabs', each((i, l) => `${pad6(i + 1)}\t${l}`, '\n')],
    ['N\\t unpadded', each((i, l) => `${i + 1}\t${l}`, '\n')],
    ['short line every 50', each((i, l) => (i % 50 === 49 ? `${l}\nok` : l), '\n')],
    ['# after every line', each((_, l) => `${l}\n#`, '\n')],
    ['blank lines', each((_, l) => `${l}\n`, '\n')],
    ['literal backslash-n', lines.join('\\n')],
    ['short token per line', each((_, l) => `${l} x`, '\n')],
    ['quoted lines', each((_, l) => `"${l}",`, '\n')],
    ['single quoted', each((_, l) => `'${l}'`, '\n')],
    ['pipe table', each((_, l) => `| ${l} |`, '\n')],
    ['Read arrows + quotes', each((i, l) => `${pad6(i + 1)}→  "${l}",`, '\n')],
    ['CRLF + numbers', each((i, l) => `${i + 1}\t${l}\r`, '\n')]
  ]) {
    assert.ok(!releasable(tr(text)), `${name} must be held`);
  }
  const read = (body) => body.map((l, i) => `${pad6(i + 1)}→${l}`).join('\n');
  const h = (i) => `${String(i).padStart(86, '0')}==`;
  const range = (n) => [...Array(n).keys()];
  const lockJson = range(2000).flatMap((i) => [`    "node_modules/p${i}": {`,
    `      "resolved": "https://registry.npmjs.org/p${i}/-/p${i}-1.0.0.tgz",`, `      "integrity": "sha512-${h(i)}",`, '    },']);
  const yarn = range(2000).flatMap((i) => [`p${i}@^1.0.0:`, '  version "1.0.0"', `  integrity sha512-${h(i)}`, '']);
  const gosum = range(3000).map((i) => `github.com/org/module${i} v1.${i}.0 h1:${h(i).slice(0, 43)}=`);
  const cargo = range(2000).flatMap((i) => ['[[package]]', `name = "crate${i}"`, `checksum = "${i.toString(16).padStart(64, '0')}"`, '']);
  const cert = range(40).map((i) => `MIIH${String(i).padStart(60, '0')}`);
  const pem = range(6).flatMap((n) => [`# CA ${n}`, '-----BEGIN CERTIFICATE-----', ...cert, '-----END CERTIFICATE-----']);
  const map = [`{"version":3,"mappings":"${'AAAA,SAASA,CAAC;'.repeat(5000)}","sources":["a.js"]}`];
  const min = ['!function(e){var t={};function n(r){if(t[r])return t[r].exports}}(this);'.repeat(2000)];
  for (const [name, body] of [['package-lock', lockJson], ['yarn.lock', yarn], ['go.sum', gosum], ['Cargo.lock', cargo],
    ['PEM chain', pem], ['sourcemap', map], ['minified', min]]) {
    assert.ok(releasable(tr(read(body))), `${name} (Read) must go out`);
    assert.ok(releasable(tr(body.join('\n'))), `${name} (raw) must go out`);
  }
  const encLines = (n, f) => Array(n).fill(f('Q'.repeat(64))).join('\n');
  assert.ok(releasable(tr(encLines(63, (l) => l))));
  assert.ok(!releasable(tr(encLines(64, (l) => `"${l}"`))));
  assert.ok(releasable(tr(encLines(63, (l) => `"${l}"`))));
  assert.ok(!releasable(tr(encLines(64, (l) => `${l} abcd`))));
  assert.ok(releasable(tr(encLines(64, (l) => `${l} abcde`))));
  assert.ok(!releasable(tr(encLines(64, (l) => `${l} ab cd`))));
  const withEvery = (filler) => range(64).map(() => `${'Q'.repeat(64)}\n${filler}`).join('\n');
  assert.ok(!releasable(tr(withEvery('####'))));
  assert.ok(releasable(tr(withEvery('#####'))));
  assert.ok(releasable(tr(withEvery('Q Q Q Q Q'))));
  // Non-ASCII counts in UTF-8 bytes, as in Rust: 'é' is 2, '→' is 3.
  assert.ok(!releasable(tr(withEvery('##é'))));
  assert.ok(releasable(tr(withEvery('###é'))));
  assert.ok(releasable(tr(withEvery('##\u2192'))));
  assert.ok(!releasable(tr(withEvery('#\u2192'))));
  assert.ok(releasable(tr(encLines(64, (l) => `${l};`))));
  assert.ok(releasable(tr(encLines(64, (l) => `${l}é`))));
  assert.ok(releasable(tr(encLines(64, (l) => `${l}→`))), 'a 3-byte character counts as 3 other bytes');
  assert.ok(releasable(tr(encLines(64, (l) => `12345 ${l}`))));
  assert.ok(releasable(tr(encLines(64, (l) => `x1234\t${l}`))));
  assert.ok(!releasable(tr(encLines(64, (l) => `x123\t${l}`))));
  assert.ok(!releasable(tr(encLines(64, (l) => `12\t ${l}`))));
  const armoured = range(64).map((i) => (i % 32 === 31 ? '  -----END X-----' : 'Q'.repeat(64))).join('\n');
  assert.ok(releasable(tr(armoured)));
  assert.ok(!releasable(tr(encLines(64, (l) => `${l}\\`))));
  const q = 'Q'.repeat(64);
  assert.ok(!releasable(tr(Array(64).fill(q).join('\\n####\\n'))));
  assert.ok(!releasable(tr(range(64).map((i) => `${10000 + i}\t${q}`).join('\n'))));
  assert.ok(releasable(tr(encLines(64, (l) => `→${l}`))));
  const quoted = (w, n) => Array(n).fill(`"${'Q'.repeat(w)}"`).join('\n');
  assert.ok(!releasable(tr(quoted(16, 256))));
  assert.ok(releasable(tr(quoted(15, 400))));
  for (const armour of ['-----QQQQQQQQQQQQQQQQQQQQQQQQQQQQ', '   -----QQQQQQQQQQQQQQQQQQQQQQQQQQQQ']) {
    const text = range(96).map((i) => (i % 48 === 47 ? armour : `"${q}"`)).join('\n');
    assert.ok(releasable(tr(text)), armour);
  }
});

// The re-check's c7 repros that must hold, through the real fetch hook.
{
  const B = 'JVBERi0xLjcK5+7nYV7zXzDkm0guFcrnUAcgHhJhew/tp+Fkd5b/AivqjtAqgqF1kw8jN8'.repeat(11400);
  const L = B.match(/.{1,76}/g);
  const pad6 = (n) => String(n).padStart(6, ' ');
  const C7 = {
    'S01 short line every 50 lines': () => L.map((l, i) => (i % 50 === 49 ? `${l}\nok` : l)).join('\n'),
    'S02 short line after every line': () => L.map((l) => `${l}\n#`).join('\n'),
    'S08 literal backslash-n': () => L.join('\\n'),
    'S11 line numbers cat -n': () => L.map((l, i) => `${pad6(i + 1)}\t${l}`).join('\n'),
    'S11b line numbers Read': () => L.map((l, i) => `${pad6(i + 1)}→${l}`).join('\n'),
    'S12 short token then line': () => L.map((l) => `${l} x`).join('\n'),
    'S13 quoted lines json': () => L.map((l) => `"${l}",`).join('\n'),
    'S14 pipe table': () => L.map((l) => `| ${l} |`).join('\n')
  };
  for (const [name, build] of Object.entries(C7)) {
    test(`fail-open round 3c (c7): ${name} is HELD, on a verdict timeout and on a relay outage`, async () => {
      const init = jsonInit({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: build() }] }] });
      for (const [oname, outage] of Object.entries(FO_OUTAGES)) {
        const r = await foRun(outage, CC_URL, init);
        assert.equal(r.outcome, 'BLOCKED', `${oname}: ${name}`);
        assert.equal(r.w.netCalls.length, 0, `${oname}: ${name}`);
        assert.equal(r.w.unchecked.length, 0, `${oname}: ${name}`);
        assertBlocked(r.w.logs, 'fail-open-file-held', 'unavailable');
      }
    });
  }
}

// ── zh#370 round 4: a real send goes out, request by request ────────────────
// SP35: ChatGPT web under fail-open with the guard down showed "Unknown error":
// its sentinel calls were held, so it never posted the turn. Each covered
// surface's real send (2026-11 captures: routes, keys and sizes as seen; ids,
// tokens and text replaced), mirrored from Proxy src/fail_open_shape.rs
// `flows`, whose bytes the Rust and this rule judge alike (parity run).
const R4 = (() => {
  const token = (n) => 'gAAAAAB0x+Yz/9_Kq-W='.repeat(Math.ceil(n / 20)).slice(0, n);
  const CONV = '73eba90a-0bc2-808a-a672-dbfd7ae862a8';
  const ORG = '5c10de80-1b07-4305-bbd3-a4ff70118284';
  const post = (host, path, body) => jreq('POST', host, path, body);
  const ws = (host, path, body) => Buffer.from(`WS-SEND ${path} HTTP/1.1\r\nHost: ${host}\r\n\r\n${JSON.stringify(body)}`);
  const form = (s) => formEnc(s);
  const batch = (calls) => req('POST', 'gemini.google.com',
    `/_/BardChatUi/data/batchexecute?rpcids=${calls.map((c) => c[0]).join(',')}&source-path=%2Fapp&bl=boq_assistant-bard-web-server_20251105.08_p0&f.sid=-6232847293947283&hl=en-US&_reqid=154321&rt=c`,
    'application/x-www-form-urlencoded;charset=UTF-8',
    `f.req=${form(JSON.stringify([calls.map(([id, args]) => [id, args, null, 'generic'])]))}&at=AJvLN6M3vJkZ%3A1794200025282`);
  const streamGenerate = (turn) => req('POST', 'gemini.google.com',
    '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20251105.08_p0&f.sid=-1&hl=en-US&_reqid=2&rt=c',
    'application/x-www-form-urlencoded;charset=UTF-8',
    `f.req=${form(JSON.stringify([null, JSON.stringify([turn, ['en-US'], ['c_1', 'r_2', 'rc_3'], ...Array(60).fill(null)])]))}&at=AJvLN6M3vJkZ%3A1794200025282`);
  const chatgpt = (surface, base, file) => {
    const steps = [
      ['sentinel prepare', post('chatgpt.com', `${base}/sentinel/chat-requirements/prepare`, { p: token(611) }), true],
      ['sentinel finalize', post('chatgpt.com', `${base}/sentinel/chat-requirements/finalize`,
        { prepare_token: token(4280), proofofwork: `${token(631)}~S`, turnstile: token(3316) }), true],
      ['conversation init', post('chatgpt.com', `${base}/conversation/init`, { conversation_id: CONV, conversation_origin: null,
        gizmo_id: null, requested_default_model: null, system_hints: null, timezone: 'Atlantic/Reykjavik', timezone_offset_min: 0 }), true]
    ];
    const prepare = { client_prepare_state: 'sent', action: 'next', model: 'gpt-6', parent_message_id: 'client-created-root',
      timezone: 'Atlantic/Reykjavik', timezone_offset_min: 0, is_do_not_remember: false,
      local_function_names: ['local.continue_in_work'], client_prepare_dispatch: 'debounced', client_prepare_source: 'composer_editor_state' };
    const message = { author: { metadata: {}, name: null, role: 'user' }, channel: null,
      content: { content_type: 'text', parts: ['the sky is blue'] }, create_time: 1794200025.282, end_turn: null,
      id: '8e07d1c2-0000-4000-8000-000000000001',
      metadata: { automation_creation_attribution: { origin: 'conversation', flow_id: '8e07d1c2-0000-4000-8000-000000000002' } },
      recipient: 'all', status: 'finished_successfully', update_time: null, weight: 1 };
    if (file) {
      steps.push(['file create (name and size)', post('chatgpt.com', `${base}/files`, { file_name: 'notes.txt', file_size: 34,
        use_case: 'my_files', timezone_offset_min: 0, reset_rate_limits: false }), false]);
      steps.push(['file bytes', req('PUT', 'sdmntprwestcentralus.oaiusercontent.com',
        '/files/f250ee33-9087-8cf6-bcba-9da44104b379/raw?se=x&sig=y', 'text/csv', 'name,ssn\nAda,123-45-6789\n'), false]);
      prepare.attachment_mime_types = ['text/csv'];
      message.metadata.attachments = [{ id: 'file-1', mime_type: 'text/csv', name: 'notes.csv', size: 34, source: 'local' }];
    }
    steps.push(['conversation prepare', post('chatgpt.com', `${base}/f/conversation/prepare`, prepare), !file]);
    steps.push(['conversation (the turn)', post('chatgpt.com', `${base}/f/conversation`, { turn_attribution: { turn_trigger: 'composer' },
      action: 'next', model: 'gpt-6', parent_message_id: 'client-created-root', timezone: 'Atlantic/Reykjavik', timezone_offset_min: 0,
      is_do_not_remember: false, client_contextual_info: { app_name: 'chatgpt.com', has_web_push_capabilities: true,
        web_push_notification_permission: 'default' }, local_function_names: ['local.continue_in_work'], messages: [message],
      supported_encodings: ['v1'], genui_state_snapshots: [], client_prepare_state: 'success' }), !file]);
    steps.push(['live updates socket', ws('ws.chatgpt.com', '/p13/ws/user/gwoq-xA3yg4ebFrRtY0xZWRD3yfaf?verify=5948779522-5hruiFiLUkF', [
      { command: { presence: { state: 'foreground', type: 'presence' }, type: 'connect' }, id: 1 },
      { command: { topic_id: 'conversations', type: 'subscribe' }, id: 2 },
      { command: { type: 'presence', state: 'background', metadata: { codex_usage_push: true, codex_usage_client: 'electron' } }, id: 3 }]), true]);
    return { surface, steps };
  };
  const claudeAi = (file) => {
    const steps = [];
    let files = [];
    if (file) {
      steps.push(['attachment upload', req('POST', 'claude.ai', `/api/organizations/${ORG}/conversations/${CONV}/wiggle/upload-file`,
        'multipart/form-data; boundary=b', '--b\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nAda 123-45-6789\r\n--b--\r\n'), false]);
      files = ['f1e2d3c4-0000-4000-8000-000000000003'];
    }
    steps.push(['completion (the turn)', post('claude.ai', `/api/organizations/${ORG}/chat_conversations/${CONV}/completion`, {
      prompt: 'the sky is blue', timezone: 'Atlantic/Reykjavik', locale: 'en-US', model: 'claude-haiku-5-5', effort: 'high',
      thinking_mode: 'auto', tools: [{ name: 'web_search', type: 'web_search_v0' }],
      turn_message_uuids: { human_message_uuid: 'a', assistant_message_uuid: 'b' }, attachments: [], files, sync_sources: [],
      completion_request_id: 'c', rendering_mode: 'messages', create_conversation_params: { name: '', model: 'claude-haiku-5-5',
        include_conversation_preferences: true, paprika_mode: 'auto', compass_mode: null, tool_search_mode: 'auto',
        is_temporary: false, enabled_imagine: true } }), !file]);
    steps.push(['title', post('claude.ai', `/api/organizations/${ORG}/chat_conversations/${CONV}/title`,
      { message_content: 'the sky is blue', recent_titles: [] }), true]);
    return { surface: 'claude.ai (JSON completion, before 2026-11-11)', steps };
  };
  // Protobuf, for claude.ai's Connect RPC (Proxy `flows::pv`/`pl`).
  const PB = (() => {
    const varint = (x) => { const o = []; for (;;) { const b = x % 128; x = Math.floor(x / 128); if (x === 0) { o.push(b); return Buffer.from(o); } o.push(b | 0x80); } };
    const pv = (n, x) => Buffer.concat([varint(n * 8), varint(x)]);
    const pl = (n, b) => { const v = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([varint(n * 8 + 2), varint(v.length), v]); };
    const cat = (...xs) => Buffer.concat(xs.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
    const RPC = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/';
    const CRED = '/claudeai-rpc/anthropic.claudeai_b2b.v1.ConsoleService/ListAgentCredentialApprovalRequests';
    const rpcReq = (path, ct, body) => req('POST', 'claude.ai', path, ct, Buffer.from(body));
    const envelope = (m) => { const h = Buffer.alloc(5); h.writeUInt32BE(m.length, 1); return Buffer.concat([h, m]); };
    const header = (version, followUp) => {
      const caps = cat(...[1, 2, 3, 6, 8, 10, 22, 24, 28, 33, 57].map((n) => pv(n, 1)));
      const parts = [];
      if (version != null) parts.push(pl(1, cat(pl(1, 'sess_0123456789abcdef'), pv(2, version))));
      parts.push(pl(2, CONV), pv(3, 3), pl(7, caps), pl(14, 'en-US'));
      if (version != null) parts.push(pl(15, Buffer.from(Array.from({ length: 32 }, (_, i) => ((i * 37) & 0xff) ^ 0xa5))));
      if (followUp) parts.push(pv(19, 1));
      return cat(...parts);
    };
    const settings = () => {
      const tools = cat(...['0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6:web_fetch-0123456789abcdef0123456789abcdef',
        '0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6:search_papers-fedcba9876543210fedcba9876543210',
        '6f7e8d9c-aba9-4c8d-9e7f-605142332415:create_file-00112233445566778899aabbccddeeff'].map((k) => pl(1, cat(pl(1, k), pv(2, 1)))));
      return pl(1, cat(pv(1, 1), pv(7, 1), pl(8, tools), pv(10, 0), pv(14, 1), pl(16, 'auto'), pl(17, 'low')));
    };
    return { varint, pv, pl, cat, RPC, CRED, rpcReq, envelope, header, settings };
  })();
  // claude.ai's send over Connect RPC, in the page's order (LibreWolf HAR,
  // 2026-11-22; ids, nonce, tool keys and text replaced). With a file, the
  // follow-up carries the .txt inline as sendMessage field 15.
  const claudeAiRpc = (file) => {
    const { pv, pl, cat, RPC, CRED, rpcReq, envelope, header, settings } = PB;
    const first = cat(pl(1, header(1, false)), pl(2, cat(pl(1, '2c5526fd-0000-4000-8000-000000000001'),
      pl(2, '2c5526fd-0000-4000-8000-000000000002'), pl(3, 'the sky is blue — ¿sí?'), pl(7, pl(2, 'claude-haiku-5-5')),
      pl(8, settings()), pl(12, 'America/Los_Angeles'), pl(13, 'en-US'), pv(18, 1), pv(21, 1), pv(54, 1))));
    const follow = [pl(1, '2c5526fd-0000-4000-8000-000000000003'), pl(2, '2c5526fd-0000-4000-8000-000000000004'),
      pl(3, 'and Germany?'), pl(12, 'America/Los_Angeles'), pl(13, 'en-US')];
    if (file) {
      follow.push(pl(15, cat(pl(1, 'notes.txt'), pv(2, 70), pl(3, 'text/plain'),
        pl(4, 'Meeting notes: Ada Lovelace, 123-45-6789, budget review Friday.'))));
    }
    follow.push(pv(18, 1), pv(54, 1), pl(57, pl(2, 'claude-haiku-5-5')), pv(59, 1));
    const followUp = cat(pl(1, header(2, true)), pl(2, cat(...follow)));
    const timeline = (resume) => {
      const caps = cat(...[[6, 1], [22, 1], [24, 1], [28, 1], [33, 1], [46, 3], [47, 1], [61, 1]].map(([n, v]) => pv(n, v)));
      const parts = [pl(1, CONV)];
      if (resume) parts.push(pl(2, pl(1, '1795417603410-0')));
      parts.push(pv(3, 1), pl(4, caps), pl(5, 'en-US'), pv(6, 1), pl(8, 'America/Los_Angeles'));
      if (resume) parts.push(pv(15, 1));
      return envelope(cat(...parts));
    };
    const viewing = (read) => cat(pl(1, CONV), pl(2, 'ae3c3b36-0000-4000-8000-000000000005'), ...(read ? [pv(3, 1)] : []));
    const localeAction = cat(pl(1, header(null, false)), pl(15, pl(1, cat(pl(12, 'America/Los_Angeles'), pl(13, 'en-US'), pv(18, 1)))));
    return { surface: 'claude.ai (Connect RPC)', steps: [
      ['new-chat defaults', rpcReq(RPC + 'GetNewConversationDefaults', 'application/proto', Buffer.alloc(0)), true],
      ['credential approvals', rpcReq(CRED, 'application/proto', pl(1, ORG)), true],
      ['send (new chat)', rpcReq(RPC + 'PerformAction', 'application/proto', first), true],
      ['viewing', rpcReq(RPC + 'ReportViewing', 'application/proto', viewing(false)), true],
      ['reply stream', rpcReq(RPC + 'StreamTimeline', 'application/connect+proto', timeline(false)), true],
      ['reply stream, resumed', rpcReq(RPC + 'StreamTimeline', 'application/connect+proto', timeline(true)), true],
      ['viewing, read', rpcReq(RPC + 'ReportViewing', 'application/proto', viewing(true)), true],
      ['locale action', rpcReq(RPC + 'PerformAction', 'application/proto', localeAction), true],
      ['send (follow-up)', rpcReq(RPC + 'PerformAction', 'application/proto', followUp), !file]] };
  };
  // Gemini web over WebChannel (since 2026-11; LibreWolf HAR 2026-11-23,
  // ids, tokens and text replaced). Proxy `flows::gemini_web_ps`. The HAR has
  // no file send: the file flow puts an image reference in the turn as a
  // field the wire never showed.
  const GPS = (() => {
    const { pv, pl, cat } = PB;
    const webchannel = (host, route, ofs, frames) => {
      let body = `count=${frames.length}`;
      if (ofs != null) body += `&ofs=${ofs}`;
      frames.forEach((f, i) => { body += `&req${i}___data__=${formEnc(f)}`; });
      return req('POST', host, `${route}?VER=8&gsessionid=UVvC2RU773Y0o_RQOn7COIOFumJxwMgsg5zop_9kpEM&SID=dRkOhyacwxs6tVtN-QQXaw&RID=56449&AID=0&zx=k3x9q2m7a1b4&t=1`,
        'application/x-www-form-urlencoded', body);
    };
    // `id` is the metadata's field 2: empty in the HAR's sends, 16 letters and
    // digits in dev.30's hold lines (Proxy `flows::gps_request_meta`).
    const request = (prompt, followUp, extra, id = '') => {
      const seed = 'FRalFnLNAAarFMS1ixRCcXqBZ-XNGCk7AEABjq4o3xGG_e98v';
      const attest = '!' + seed.repeat(60).slice(0, 2628);
      const parts = [pl(1, cat(pl(1, prompt), pv(2, 0), pv(7, 0))), pl(2, pl(1, 'en')), pl(4, attest),
        pl(5, 'ae1e0005bada03b11f840000aaaa1111'), pl(7, pv(1, 1)), pv(8, 1), pv(11, 1), pv(12, 0), pl(18, pl(1, pv(1, 2))),
        pv(19, 0), pv(28, 1), pl(31, Buffer.from([0x04, 0x1b, 0x1c, 0x10, 0x13, 0x0c])), pl(42, pv(1, 2)), pv(50, 0), pv(54, 0),
        pl(60, 'B9629E3C-5AD6-436B-8000-000000000001'), pl(62, ''), pv(68, 0), pv(69, 2)];
      if (followUp) parts.push(pl(72, cat(pl(1, 'c_0515992ff73cecd1'), pl(8, 'AwAAAAAAAAAQANM7mBjX0000000000a'))));
      parts.push(pv(92, 0), pv(97, 0), pv(99, 1));
      if (extra) parts.push(extra);
      const meta = cat(pv(1, 1), pl(2, id), pl(3, 'en'), pl(4, 'B9629E3C-5AD6-436B-8000-000000000001'));
      return pl(1, cat(pl(1, meta), pv(2, 0), pl(8, pl(5, cat(pl(1, cat(...parts)), pv(4, 1))))));
    };
    const echo = (prompt) => pl(2, cat(pv(1, 1), pl(9, pl(1, prompt))));
    const ps = (ofs, frames) => webchannel('geminiweb-pa.clients6.google.com', '/v1/processSession', ofs,
      frames.map((f) => f.toString('base64')));
    return { webchannel, request, echo, ps };
  })();
  const geminiWebPs = (file) => {
    const { pv, pl, cat } = PB;
    const settings = (id, args) => Buffer.concat([batch([[id, args]]), Buffer.from('&')]);
    const handshake = req('POST', 'geminiweb-pa.clients6.google.com',
      `/v1/processSession?VER=8&RID=56448&CVER=22&X-HTTP-Session-Id=gsessionid&%24httpHeaders=${formEnc(
        `Authorization:SAPISIDHASH 1795423918_${'0'.repeat(40)}\r\nX-Goog-AuthUser:0\r\nX-Goog-Api-Key:AIzaSyA0000000000000000000000000000000\r\nX-Server-Token:${'CAESAB'.repeat(210)}\r\nx-goog-ext-525001261-bin:${'QUJD'.repeat(59)}\r\nX-WebChannel-Content-Type:application/json+protobuf\r\n`)}&zx=k3x9q2m7a1b4&t=1`,
      'application/x-www-form-urlencoded', 'count=0');
    const image = file ? pl(3, cat(pl(1, '/contrib_service/ttl_1d/abc/photo.png'), pl(2, 'image/png'))) : null;
    const prompt = "what's the capital of France?";
    return { surface: 'Gemini web (WebChannel)', steps: [
      ['page settings', settings('L5adhe', '[[null,null,null,1],null,[87]]'), true],
      ['feature flags', settings('otAQ7b', '[1]'), true],
      ['push channel server', req('POST', 'signaler-pa.clients6.google.com', '/punctual/v1/chooseServer?key=AIzaSyA0000000000000000000000000000000',
        'application/json+protobuf', '[[null,null,null,[9,5],null,[["assistant-bard"],[null,1],[[["bard-client-sync"]]]]],null,null,0,0]'), true],
      ['push channel', GPS.webchannel('signaler-pa.clients6.google.com', '/punctual/multi-watch/channel', 0, [
        '[[[1,[null,null,null,[9,5],null,[["assistant-bard"],[null,1],[[["bard-client-sync"]]]],null,null,1],null,3]]]',
        '[[[2,[null,null,null,[9,5],null,[["assistant-bard"],[1],[[["108800000000000000001"],["async_bard"]]]],null,null,1],null,3]]]']), true],
      ['notice settings', settings('L5adhe', '[[null,null,null,"FAST_TRACK_NOTICE"],null,[94]]'), true],
      ['WebChannel handshake', handshake, true],
      ['send (new chat)', GPS.ps(0, [GPS.request(prompt, false, image), GPS.echo(prompt)]), !file],
      ['after the send', settings('PCck7e', '["r_05de0fe8463b0ef2"]'), true],
      ['acknowledgement', GPS.ps(2, [pl(4, pv(1, 1))]), true],
      ['send (follow-up)', GPS.ps(0, [GPS.request('and Germany?', true, null), GPS.echo('and Germany?')]), true],
      ['push channel credentials', req('POST', 'signaler-pa.clients6.google.com',
        '/punctual/v1/refreshCreds?key=AIzaSyA0000000000000000000000000000000&gsessionid=aiE9E1rAW1Jxvls9fIP92iTe0p05fSVOdwA5MmOnuHc',
        'application/json+protobuf', '["VddsdreZ"]'), true]] };
  };
  const geminiWeb = (file) => {
    const steps = [
      ['attestation', req('POST', 'waa-pa.clients6.google.com', '/$rpc/google.internal.waa.v1.Waa/Create', 'application/json+protobuf',
        '["yo6lewEU9mzfRAj0FajJ"]'), true],
      ['page settings RPCs', batch([['otAQ7b', '[1]'], ['ESY5D', '[null,[2,3,7,8,9,10,11,16]]'], ['CNgdBe', '[2,["en-US"],0]'],
        ['o30O0e', '[["me"],[[["person.photo","person.name","person.email"]],null,[1,7]]]']]), true],
      ['chat list', batch([['MaZiqc', '[13,null,[null,null,1,null,null,null,null,null,null,1]]'],
        ['L5adhe', '[[null,null,null,"406f92de68d6a9a7"],null,[100]]']]), true]
    ];
    let turn = ['the sky is blue', 0, null, null, null, null, 0];
    if (file) {
      steps.push(['file bytes', req('POST', 'content-push.googleapis.com', '/upload', 'text/plain', 'Ada 123-45-6789'), false]);
      turn = ['the sky is blue', 0, null, [[['/contrib_service/ttl_1d/abc/notes.txt', 1, null, 'text/plain',
        '449a3540-d5fd-4cdf-0000-000000000004'], 'notes.txt']], null, null, 0];
    }
    steps.push(['StreamGenerate (the turn)', streamGenerate(turn), !file]);
    steps.push(['after the turn', batch([['PCck7e', '["r_2debe4fba6c6c5f5"]'], ['aPya6c', '[]']]), true]);
    steps.push(['cookie rotation', post('accounts.google.com', '/RotateCookies', [658, '2195969768263241828']), true]);
    return { surface: 'Gemini web (StreamGenerate, before 2026-11)', steps };
  };
  const duckAi = (file) => ({ surface: 'duck.ai', steps: [['chat (the turn)', post('duck.ai', '/duckchat/v1/chat', {
    model: 'gpt-5-mini', metadata: { toolChoice: { NewsSearch: false, WebSearch: false } },
    messages: [{ role: 'user', content: file
      ? [{ type: 'text', text: 'the sky is blue' }, { type: 'image', mimeType: 'image/png', image: `data:image/png;base64,${b64n(800)}` }]
      : [{ type: 'text', text: 'the sky is blue' }] }], canUseTools: true, canUseApproxLocation: null }), !file]] });
  const claudeCode = (file) => {
    const user = file
      ? [{ type: 'text', text: 'what is in this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64n(4000) } }]
      : [{ type: 'text', text: 'the sky is blue' }];
    const body = { model: 'claude-opus-5-5', max_tokens: 32000, stream: true, system: [{ type: 'text', text: 'You are Claude Code.' }],
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
      metadata: { user_id: 'u' }, messages: [{ role: 'user', content: user }] };
    const get = (what, path) => [what, req('GET', 'api.anthropic.com', path, null, ''), true];
    return { surface: 'Claude Code', steps: [
      get('bootstrap', '/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-5-5'),
      get('policy limits', '/api/claude_code/policy_limits'),
      get('remote settings', '/api/claude_code/settings'),
      get('fast mode', '/api/claude_code_penguin_mode'),
      get('model selector', `/api/organizations/${ORG}/model_selector/cc`),
      ['count tokens', post('api.anthropic.com', '/v1/messages/count_tokens?beta=true', { model: 'claude-opus-5-5', messages: body.messages }), !file],
      ['messages (the turn)', post('api.anthropic.com', '/v1/messages?beta=true', body), !file]] };
  };
  const codexWs = (file) => ({ surface: 'Codex CLI (WebSocket)', steps: [['response.create (the turn)',
    ws('chatgpt.com', '/backend-api/codex/responses', { type: 'response.create', model: 'gpt-6-codex', stream: true,
      instructions: 'You are Codex.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the sky is blue' },
        ...(file ? [{ type: 'input_image', image_url: `data:image/png;base64,${b64n(4000)}` }] : [])] }],
      tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'medium', summary: 'auto' }, store: false,
      include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', text: { verbosity: 'low' } }), !file]] });
  const openaiApi = (file) => ({ surface: 'OpenAI API', steps: [
    ['chat completions', post('api.openai.com', '/v1/chat/completions', { model: 'gpt-6-mini', messages: [{ role: 'user', content: file
      ? [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64n(800)}` } }]
      : 'the sky is blue' }] }), !file],
    ['responses', post('api.openai.com', '/v1/responses', { model: 'gpt-6-mini', input: file
      ? [{ role: 'user', content: [{ type: 'input_text', text: 'summarise' }, { type: 'input_file', filename: 'notes.pdf',
        file_data: `data:application/pdf;base64,${b64n(800)}` }] }]
      : 'the sky is blue' }), !file]] });
  const geminiApi = (file) => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'the sky is blue' },
      ...(file ? [{ inlineData: { mimeType: 'application/pdf', data: b64n(800) } }] : [])] }] };
    return { surface: 'Gemini API', steps: [
      ['count tokens', post('generativelanguage.googleapis.com', '/v1beta/models/gemini-2.5-flash:countTokens', body), !file],
      ['generate (the turn)', post('generativelanguage.googleapis.com', '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', body), !file]] };
  };
  const all = (file) => [chatgpt('ChatGPT web', '/backend-api', file), chatgpt('ChatGPT web, logged out (unverified)', '/backend-anon', file),
    claudeAi(file), claudeAiRpc(file), geminiWeb(file), geminiWebPs(file), duckAi(file), claudeCode(file), codexWs(file), openaiApi(file), geminiApi(file)];
  return { plain: () => all(false), withFile: () => all(true), token, PB, GPS };
})();

test('releasableUnderFailOpen round 4: every request of a real send flow is released (every_request_of_a_real_send_flow_is_released)', () => {
  for (const { surface, steps } of R4.plain()) {
    for (const [what, raw, release] of steps) {
      assert.equal(release, true, `${surface}: ${what}`);
      assert.equal(releasable(raw), true, `${surface}: ${what} must go out under fail-open`);
    }
  }
});

test('releasableUnderFailOpen round 4: the same flow with a file holds every file-bearing request (the_same_flow_with_a_file_holds_every_file_bearing_request)', () => {
  for (const { surface, steps } of R4.withFile()) {
    assert.ok(steps.some(([, , release]) => !release), surface);
    for (const [what, raw, release] of steps) assert.equal(releasable(raw), release, `${surface}: ${what}`);
  }
});

test('releasableUnderFailOpen round 4: content-free calls are exact (content_free_calls_are_exact)', () => {
  const tok = (n) => 'Ab3+/_-='.repeat(Math.ceil(n / 8)).slice(0, n);
  const sp = '/backend-api/sentinel/chat-requirements/prepare';
  const sf = '/backend-api/sentinel/chat-requirements/finalize';
  const init = '/backend-api/conversation/init';
  const post = (h, p, b) => jreq('POST', h, p, b);
  const fin = (b) => post('chatgpt.com', sf, b);
  const baseInit = { conversation_id: null, conversation_origin: null, gizmo_id: 'g-p-6789abcdef', requested_default_model: 'gpt-6',
    system_hints: ['search'], timezone: 'Etc/GMT+5', timezone_offset_min: 300 };
  const withK = (k, v) => ({ ...baseInit, [k]: v });
  const waa = (ct, body, path = '/$rpc/google.internal.waa.v1.Waa/Create') => req('POST', 'waa-pa.clients6.google.com', path, ct, body);
  const released = [
    post('chatgpt.com', sp, { p: tok(2048) }),
    post('chat.openai.com', '/backend-anon/sentinel/chat-requirements/prepare', { p: 'x' }),
    fin({ prepare_token: tok(12288), proofofwork: tok(2048), turnstile: tok(12288) }),
    fin({ prepare_token: 't', proofofwork: null }),
    fin({ prepare_token: 't~' }),
    post('chatgpt.com', init, baseInit),
    post('chatgpt.com', init, {}),
    post('chatgpt.com', init, withK('system_hints', Array(16).fill('a'))),
    post('chatgpt.com', init, withK('gizmo_id', 'g'.repeat(64))),
    waa('application/json+protobuf', `["${tok(64)}"]`),
    post('accounts.google.com', '/RotateCookies', [1, '-12']),
    req('GET', 'api.anthropic.com', '/api/claude_code/settings', null, ''),
    req('GET', 'api.anthropic.com', '/api/organizations/o-1/model_selector/cc', null, '')
  ];
  released.forEach((raw, i) => assert.equal(releasable(raw), true, `released ${i}: ${raw.toString('utf8').slice(0, 200)}`));
  const held = [
    post('chatgpt.com', sp, { p: 'x', file: 'y' }), post('chatgpt.com', sp, { p: tok(2049) }), post('chatgpt.com', sp, { p: 'two words' }),
    post('chatgpt.com', sp, { p: '' }), post('chatgpt.com', sp, {}), post('chatgpt.com', sp, { p: 1 }), post('chatgpt.com', sp, ['x']),
    fin({ proofofwork: 'x' }), fin({ prepare_token: tok(12289) }), fin({ prepare_token: 't', proofofwork: tok(2049) }),
    fin({ prepare_token: 't', turnstile: tok(12289) }), fin({ prepare_token: 't', turnstile: 'a.b' }), fin({ prepare_token: 't', proofofwork: 'a b' }),
    fin({ prepare_token: 't', x: null }), fin('t'),
    post('chatgpt.com', '/backend-api/sentinel/chat-requirements', { p: 'x' }),
    post('chatgpt.com', '/unauth-mweb/sentinel/chat-requirements/prepare', { p: 'x' }),
    post('chatgpt.com', '/backend-apis/conversation/init', {}), post('chatgpt.net', init, {}),
    req('PUT', 'chatgpt.com', init, 'application/json', '{}'), req('POST', 'chatgpt.com', init, 'text/plain', '{}'),
    post('chatgpt.com', init, withK('attachments', [])), post('chatgpt.com', init, withK('conversation_id', 'a b')),
    post('chatgpt.com', init, withK('conversation_origin', '')), post('chatgpt.com', init, withK('gizmo_id', 'g'.repeat(65))),
    post('chatgpt.com', init, withK('requested_default_model', 1)), post('chatgpt.com', init, withK('system_hints', Array(17).fill('a'))),
    post('chatgpt.com', init, withK('system_hints', 'search')), post('chatgpt.com', init, withK('system_hints', ['a b'])),
    post('chatgpt.com', init, withK('timezone', 'America/New York')), post('chatgpt.com', init, withK('timezone', 'a\\b')),
    post('chatgpt.com', init, withK('timezone_offset_min', '0')), post('chatgpt.com', init, []),
    waa('application/json+protobuf', `["${tok(65)}"]`), waa('application/json+protobuf', '["a","b"]'), waa('application/json+protobuf', '["a b"]'),
    waa('application/json', '["a"]'), waa('application/json+protobuf', '["a"]', '/$rpc/google.internal.waa.v1.Waa/Ping'),
    post('accounts.google.com', '/RotateCookies', [1, '12a']), post('accounts.google.com', '/RotateCookies', [1, '']),
    post('accounts.google.com', '/RotateCookies', [1, '1'.repeat(33)]), post('accounts.google.com', '/RotateCookies', ['1', '12']),
    post('accounts.google.com', '/RotateCookies', [1, '12', 3]), post('accounts.google.com', '/RotateCookie', [1, '12']),
    req('GET', 'api.anthropic.com', '/api/claude_code/settings', 'application/json', '{}'),
    req('GET', 'api.anthropic.com', '/api/claude_code/metrics', null, ''), req('POST', 'api.anthropic.com', '/api/claude_code/settings', null, ''),
    req('GET', 'api.anthropic.com', '/api/organizations/o%201/model_selector/cc', null, ''),
    req('GET', 'api.anthropic.com', '/api/organizations/o/model_selector/cc/x', null, ''),
    req('GET', 'api.anthropic.com', '/api/organizations/o/model_selector/xx', null, ''),
    req('GET', 'api.anthropic.com', '/v1/messages', null, ''), req('GET', 'claude.ai', '/api/claude_code/settings', null, '')
  ];
  held.forEach((raw, i) => assert.equal(releasable(raw), false, `held ${i}: ${raw.toString('utf8').slice(0, 200)}`));
});

test('releasableUnderFailOpen round 4: Gemini web settings RPCs are exact (gemini_settings_rpcs_are_exact)', () => {
  const batch = (fReq) => req('POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute?rpcids=x&rt=c',
    'application/x-www-form-urlencoded;charset=UTF-8', `f.req=${formEnc(fReq)}&at=AJvLN6M`);
  const call = (id, args, tag) => [id, args, null, tag];
  const one = (c) => batch(JSON.stringify([[c]]));
  const maxArgs = `[${Array(1023).fill('1').join(',')}]`;
  assert.equal(maxArgs.length, 2047);
  const released = [
    one(call('otAQ7b', '[1]', 'generic')), one(call('ESY5D', maxArgs, 'generic')),
    one(call('PCck7e', '["r_2debe4fba6c6c5f5",true,-1.5,null]', '1')), one(call('cCSu7', `["${'a'.repeat(64)}"]`, '1234')),
    batch(JSON.stringify([Array(16).fill(call('aPya6c', '[]', 'generic'))]))
  ];
  released.forEach((raw, i) => assert.equal(releasable(raw), true, `released ${i}`));
  const formReq = (ct, body, path = '/_/BardChatUi/data/batchexecute') => req('POST', 'gemini.google.com', path, ct, body);
  const held = [
    one(call('hNvQHb', '[]', 'generic')), one(call('otaq7b', '[1]', 'generic')), one(call('otAQ7b', '["the sky is blue"]', 'generic')),
    one(call('otAQ7b', '[{"a":1}]', 'generic')), one(call('otAQ7b', `["${'a'.repeat(65)}"]`, 'generic')),
    one(call('otAQ7b', '["/contrib_service/x"]', 'generic')), one(call('ESY5D', `[${Array(1024).fill('1').join(',')}]`, 'generic')),
    one(call('otAQ7b', '[1', 'generic')), one(call('otAQ7b', '[1]', 'custom')), one(call('otAQ7b', '[1]', '12345')),
    one(call('otAQ7b', '[1]', '')), one(['otAQ7b', '[1]', 0, 'generic']), one(['otAQ7b', '[1]', null]),
    one(['otAQ7b', [1], null, 'generic']), batch(JSON.stringify([Array(17).fill(call('aPya6c', '[]', 'generic'))])),
    batch('[[]]'), batch(JSON.stringify([[call('aPya6c', '[]', 'generic')], []])), batch(JSON.stringify([call('aPya6c', '[]', 'generic')])),
    formReq('application/x-www-form-urlencoded', `f.req=${formEnc('[[["aPya6c","[]",null,"generic"]]]')}&x=1`),
    formReq('application/json', '[[["aPya6c","[]",null,"generic"]]]'),
    formReq('application/x-www-form-urlencoded', `f.req=${formEnc('[[["aPya6c","[]",null,"generic"]]]')}`, '/_/BardChatUi/data/batchexecutes')
  ];
  held.forEach((raw, i) => assert.equal(releasable(raw), false, `held ${i}`));
});

test('releasableUnderFailOpen round 4: ChatGPT live-update frames are exact (chatgpt_live_update_frames_are_exact)', () => {
  const frame = (path, v) => req('WS-SEND', 'ws.chatgpt.com', path, null, JSON.stringify(v));
  const path = '/p13/ws/user/gwoq-xA3yg4ebFrRtY0xZWRD3yfaf';
  const cmd = (c) => frame(path, [{ command: c, id: 7 }]);
  const p1 = { command: { type: 'presence' }, id: 1 };
  const released = [
    cmd({ type: 'presence', state: 'foreground', metadata: null }), cmd({ type: 'unsubscribe', topic_id: 'alder-conversations' }),
    cmd({ type: 'connect', presence: { state: 'background' } }), frame('/ws/user/abc', [p1]), frame(path, Array(16).fill(p1))
  ];
  released.forEach((raw, i) => assert.equal(releasable(raw), true, `released ${i}`));
  const held = [
    cmd({ type: 'message', text: 'hi' }), cmd({ type: 'send' }), cmd({ state: 'foreground' }), cmd({ type: 'presence', state: 'away' }),
    cmd({ type: 'presence', state: 1 }), cmd({ type: 'subscribe', topic_id: 'a b' }), cmd({ type: 'connect', presence: { state: 'away' } }),
    cmd({ type: 'connect', presence: { type: 'other' } }), cmd({ type: 'connect', presence: { note: 'x' } }),
    cmd({ type: 'connect', presence: 'foreground' }), cmd({ type: 'presence', metadata: { note: 'x' } }),
    cmd({ type: 'presence', metadata: { codex_usage_push: 'yes' } }), cmd({ type: 'presence', metadata: { codex_usage_client: 'a b' } }),
    cmd({ type: 'presence', metadata: 'x' }), frame(path, [{ command: { type: 'presence' }, id: '1' }]),
    frame(path, [{ command: { type: 'presence' } }]), frame(path, [{ ...p1, x: 1 }]), frame(path, [{ id: 1 }]), frame(path, [1]),
    frame(path, []), frame(path, p1), frame(path, Array(17).fill(p1)), frame('/p13/ws/user/a/b', [p1]), frame('/a/b/ws/user/c', [p1]),
    frame('/p%201/ws/user/c', [p1]), frame('/ws/user/', [p1]), frame('/ws/users/c', [p1]),
    req('WS-SEND', 'chatgpt.com', path, null, JSON.stringify([p1]))
  ];
  held.forEach((raw, i) => assert.equal(releasable(raw), false, `held ${i}`));
});

// Through the real fetch hook, on the page itself: ChatGPT web's send with
// the bridge down and the window open. Every request goes out; with a file the
// file-bearing ones are held, and each hold names its host and value-free
// route (never the query or body).
test('fail-open round 4: ChatGPT web\'s real send goes out request by request; with a file the file calls are held and named', async () => {
  const outage = { onCapture: () => ({ ok: false, code: 'bridge-error' }) };
  const toInit = (raw) => {
    const i = raw.indexOf('\r\n\r\n');
    const head = raw.subarray(0, i).toString('latin1');
    const [method, target] = head.split('\r\n')[0].split(' ');
    const host = /\r\nHost: ([^\r]+)/.exec(head)[1];
    const ct = /\r\ncontent-type: ([^\r]+)/.exec(head);
    // The body's own bytes (a protobuf one is not text).
    const body = new Uint8Array(raw.subarray(i + 4));
    return [`https://${host}${target}`, { method, headers: ct ? { 'content-type': ct[1] } : {}, body }];
  };
  for (const [file, flows] of [[false, R4.plain()], [true, R4.withFile()]]) {
    for (const { surface, steps } of flows.filter((f) => f.surface === 'ChatGPT web' || f.surface.startsWith('Gemini web') || f.surface.startsWith('claude.ai'))) {
      const page = surface.startsWith('Gemini web') ? 'https://gemini.google.com/app' : surface.startsWith('claude.ai') ? 'https://claude.ai/new' : 'https://chatgpt.com/';
      const w = makeWorld(outage.onCapture, realCatalogGlobals(page));
      w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
      for (const [what, raw, release] of steps) {
        if (raw.toString('latin1').startsWith('WS-SEND')) continue; // frames: the extractor tests above
        const [url, init] = toInit(raw);
        const sent = w.netCalls.length;
        w.logs.length = 0;
        let outcome = 'SENT';
        try { await w.sandbox.fetch(url, init); } catch (e) { outcome = blockedError(e) ? 'BLOCKED' : `ERR ${e.message}`; }
        assert.equal(outcome, release ? 'SENT' : 'BLOCKED', `${surface}${file ? ' + file' : ''}: ${what}`);
        assert.equal(w.netCalls.length, sent + (release ? 1 : 0), `${surface}: ${what}`);
        if (!release) {
          const line = assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
          const u = new URL(url);
          // Every regex metacharacter, backslash included, so the hostname is matched as text.
          const host = u.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          assert.match(line, new RegExp(`\\bhost=${host}\\b`), line);
          // The rule's template for a route it reads, else `-`.
          assert.ok(/\broute=(\/|-(\s|$))/.test(line), line);
          assert.ok(!/sig=y|123-45-6789|notes\.csv|Ada/.test(line), line);
        }
      }
    }
  }
});

test('fail-open round 4b: a hold names its route only as the rule\'s own template, never any of the path', async () => {
  const w = makeWorld(() => ({ ok: false, code: 'bridge-error' }), realCatalogGlobals('https://chatgpt.com/'));
  w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  const routeOf = (line) => (/\broute=(\S+)/.exec(line) || [])[1];
  const hold = async (url, init) => {
    w.logs.length = 0;
    await assert.rejects(w.sandbox.fetch(url, init), blockedError, url);
    return assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
  };
  // A route the rule reads, held for its body: its template.
  let line = await hold('https://chatgpt.com/backend-api/f/conversation?SECRET', jsonInit({ messages: [], file: 'SECRET' }));
  assert.match(line, /\bhost=chatgpt\.com\b/);
  assert.equal(routeOf(line), '/backend-api/f/conversation', line);
  // A route it does not read: `-`.
  line = await hold('https://chatgpt.com/backend-api/files/f250ee33-9087-8cf6-bcba-9da44104b379/uploaded?sig=SECRET',
    jsonInit({ file_name: 'SECRET.txt' }));
  assert.equal(routeOf(line), '-', line);
  // zh#370 4b: the Graph upload repro, an e-mail address in a path, an
  // SSN-shaped segment. The route names none of it. (The shim's own `path=`
  // field, on every line it writes, is pre-existing and not the route.)
  for (const [url, init] of [
    ['https://graph.microsoft.com/v1.0/users/jane.doe@contoso.com/drive/root:/Documents/Jane%20Doe%20Tax%20Return%202025.pdf:/content',
      { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7' }],
    ['https://mail.example.com/mail/u/0/jane.doe@contoso.com/send', jsonInit({ to: 'x' })],
    ['https://api.anthropic.com/api/claude_code/123-45-6789', jsonInit({ x: 1 })]
  ]) {
    line = await hold(url, init);
    assert.equal(routeOf(line), '-', line);
  }
  // A cross-origin upload names neither its path nor a route.
  line = await hold('https://sdmntprwestcentralus.oaiusercontent.com/files/x/my-secret-name.pdf?sig=1',
    { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7' });
  assert.ok(!/my-secret-name/.test(line), line);
  assert.equal(routeOf(line), '-', line);
});

test('failOpenRouteTemplate: the rule\'s own route names, and `-` for everything else (a_hold_is_labelled_by_host_and_the_rules_own_route)', () => {
  const m = /\/\/ <releasableUnderFailOpen>\n([\s\S]*?)\/\/ <\/releasableUnderFailOpen>/.exec(SHIM_SRC);
  const tpl = new Function(m[1] + '; return failOpenRouteTemplate;')();
  const named = [
    ['POST', 'api.anthropic.com', '/v1/messages', '/v1/messages'],
    ['POST', 'api.anthropic.com', '/v1/messages/count_tokens', '/v1/messages/count_tokens'],
    ['GET', 'api.anthropic.com', '/api/claude_cli/bootstrap', '/api/claude_cli/bootstrap'],
    ['GET', 'api.anthropic.com', '/api/claude_code/policy_limits', '/api/claude_code/policy_limits'],
    ['GET', 'api.anthropic.com', '/api/claude_code/settings', '/api/claude_code/settings'],
    ['GET', 'api.anthropic.com', '/api/claude_code_penguin_mode', '/api/claude_code_penguin_mode'],
    ['GET', 'api.anthropic.com', '/api/organizations/jane/model_selector/cc', '/api/organizations/:x/model_selector/cc'],
    ['GET', 'api.anthropic.com', `/api/organizations/${'o9'.repeat(32)}/model_selector/cc`, '/api/organizations/:x/model_selector/cc'],
    ['POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/completion', '/api/organizations/:x/chat_conversations/:x/completion'],
    ['POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/retry_completion', '/api/organizations/:x/chat_conversations/:x/retry_completion'],
    ['POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/title', '/api/organizations/:x/chat_conversations/:x/title'],
    ['POST', 'chatgpt.com', '/backend-api/conversation', '/backend-api/conversation'],
    ['POST', 'chatgpt.com:443', '/backend-api/conversation/prepare', '/backend-api/conversation/prepare'],
    ['POST', 'chat.openai.com', '/backend-anon/f/conversation', '/backend-anon/f/conversation'],
    ['POST', 'CHATGPT.COM', '/backend-anon/conversation/init', '/backend-anon/conversation/init'],
    ['POST', 'chatgpt.com', '/backend-api/sentinel/chat-requirements/finalize', '/backend-api/sentinel/chat-requirements/finalize'],
    ['POST', 'chatgpt.com', '/backend-api/codex/responses', '/backend-api/codex/responses'],
    ['WS-SEND', 'chatgpt.com', '/backend-api/codex/responses', '/backend-api/codex/responses'],
    ['WS-SEND', 'ws.chatgpt.com', '/ws/user/abc', '/ws/user/:x'],
    ['WS-SEND', 'ws.chatgpt.com', '/p13/ws/user/gwoq-xA3yg4ebFrRtY0xZWRD3yfaf', '/:x/ws/user/:x'],
    ['WS-SEND', 'ws.chatgpt.com', '/ws/ws/user/abc', '/:x/ws/user/:x'],
    ['POST', 'gemini.google.com', GEMINI, GEMINI],
    ['POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute', '/_/BardChatUi/data/batchexecute'],
    ['POST', 'waa-pa.clients6.google.com', '/$rpc/google.internal.waa.v1.Waa/Create', '/$rpc/google.internal.waa.v1.Waa/Create'],
    ['POST', 'accounts.google.com', '/RotateCookies', '/RotateCookies'],
    ['POST', 'duck.ai', '/duckchat/v1/chat', '/duckchat/v1/chat'],
    ['POST', 'duckduckgo.com', '/duckchat/v1/chat', '/duckchat/v1/chat'],
    ['POST', 'api.openai.com', '/v1/chat/completions', '/v1/chat/completions'],
    ['POST', 'api.openai.com', '/v1/responses', '/v1/responses'],
    ['POST', 'generativelanguage.googleapis.com', '/v1beta/models/gemini-2.5-flash:generateContent', '/:x/models/:x:generateContent'],
    ['POST', 'generativelanguage.googleapis.com', '/vJane/models/jane:streamGenerateContent', '/:x/models/:x:streamGenerateContent'],
    ['POST', 'generativelanguage.googleapis.com', '/v1/models/g:countTokens', '/:x/models/:x:countTokens']
  ];
  for (const [mt, h, p, want] of named) assert.equal(tpl(mt, h, p), want, `${mt} ${h} ${p}`);
  const dash = [
    ['GET', 'api.anthropic.com', '/v1/messages'], ['POST', 'api.anthropic.com', '/v1/messages/x'],
    ['POST', 'api.anthropic.com', '/api/claude_code/settings'], ['GET', 'api.anthropic.com', '/api/claude_code/metrics'],
    ['GET', 'api.anthropic.com', '/api/organizations/a b/model_selector/cc'],
    ['POST', 'claude.ai', '/api/organizations/o/chat_conversations/c/upload'],
    ['POST', 'claude.ai', '/api/organizations//chat_conversations/c/completion'],
    ['POST', 'claude.ai', '/api/organizations/o/conversations/c/completion'],
    ['POST', 'chatgpt.com', '/backend-api/files'], ['POST', 'chatgpt.com', '/backend-apis/conversation'],
    ['POST', 'chatgpt.com', '/unauth-mweb/conversation'], ['PUT', 'chatgpt.com', '/backend-api/conversation'],
    ['WS-SEND', 'chat.openai.com', '/backend-api/codex/responses'], ['POST', 'ws.chatgpt.com', '/ws/user/abc'],
    ['WS-SEND', 'ws.chatgpt.com', '/ws/user/a/b'], ['WS-SEND', 'ws.chatgpt.com', '/a b/ws/user/c'],
    ['POST', 'gemini.google.com', '/_/BardChatUi/data/assistant.lamda.BardFrontendService/ProcessFile'],
    ['POST', 'waa-pa.clients6.google.com', '/$rpc/google.internal.waa.v1.Waa/Ping'],
    ['POST', 'accounts.google.com', '/RotateCookie'], ['POST', 'duck.ai', '/duckchat/v1/status'],
    ['POST', 'api.openai.com', '/v1/files'], ['POST', 'generativelanguage.googleapis.com', '/v1/models/g:embedContent'],
    ['POST', 'generativelanguage.googleapis.com', '/v1/models/:generateContent'],
    ['POST', 'generativelanguage.googleapis.com', '/x1/models/g:generateContent'],
    ['POST', 'example.com', '/v1/messages'],
    ['GET', 'api.anthropic.com', `/api/organizations/${'o'.repeat(65)}/model_selector/cc`],
    ['GET', 'example.com', '/api/claude_cli/bootstrap'],
    ['POST', 'claude.ai', '/api/organizations/o/chat_conversations//completion'],
    ['WS-SEND', 'ws.chatgpt.com', '/xx/user/abc'], ['WS-SEND', 'ws.chatgpt.com', '/ws/user/a b'],
    ['POST', 'gemini.google.com', '/v1/processSession'], ['POST', 'signaler-pa.clients6.google.com', '/v1/processSession'],
    ['GET', 'geminiweb-pa.clients6.google.com', '/v1/processSession'], ['POST', 'geminiweb-pa.clients6.google.com', '/v1/processSessions'],
    ['POST', 'signaler-pa.clients6.google.com', '/punctual/multi-watch/channels'], ['POST', 'signaler-pa.clients6.google.com', '/punctual/v1/register'],
    ['GET', 'signaler-pa.clients6.google.com', '/punctual/v1/chooseServer'], ['POST', 'geminiweb-pa.clients6.google.com', '/punctual/v1/refreshCreds'],
    ['PUT', 'graph.microsoft.com', '/v1.0/users/jane.doe@contoso.com/drive/root:/Documents/Jane%20Doe%20Tax%20Return%202025.pdf:/content'],
    ['POST', 'api.anthropic.com', '/v1/users/jane.doe@contoso.com/messages'],
    ['POST', 'api.anthropic.com', '/api/claude_code/123-45-6789']
  ];
  for (const [mt, h, p] of dash) assert.equal(tpl(mt, h, p), '-', `${mt} ${h} ${p}`);
  // Every request of every real send has a name.
  for (const { surface, steps } of R4.plain()) {
    for (const [what, raw] of steps) {
      const s = raw.toString('latin1');
      const head = s.slice(0, s.indexOf('\r\n\r\n')).split('\r\n');
      const [mt, target] = head[0].split(' ');
      const h = head.slice(1).find((l) => /^host:/i.test(l)).slice(5).trim();
      assert.notEqual(tpl(mt, h, target.split(/[?#]/)[0]), '-', `${surface}: ${what}`);
    }
  }
});

test('fail-open round 4: ChatGPT\'s live-update socket keeps its presence frames; another command closes it, named', async () => {
  const run = async (frames) => {
    const WebSocket = fakeWebSocketClass();
    const w = makeWorld(() => ({ ok: false, code: 'bridge-error' }), { ...realCatalogGlobals('https://chatgpt.com/'), WebSocket });
    w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
    const ws = new w.sandbox.WebSocket('wss://ws.chatgpt.com/p13/ws/user/gwoq-xA3yg4ebFrRtY0xZWRD3yfaf?verify=5948779522-5hruiFiLUkF');
    for (const f of frames) { try { ws.send(JSON.stringify(f)); } catch { /* refused */ } }
    await waitFor(() => ws.wire.length + ws.closes.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    return { w, ws };
  };
  const ok = await run([
    [{ command: { presence: { state: 'foreground', type: 'presence' }, type: 'connect' }, id: 1 }, { command: { topic_id: 'conversations', type: 'subscribe' }, id: 2 }],
    [{ command: { type: 'presence', state: 'background', metadata: { codex_usage_push: true, codex_usage_client: 'electron' } }, id: 3 }]
  ]);
  assert.equal(ok.ws.wire.length, 2, 'both frames go out');
  assert.equal(ok.ws.closes.length, 0);
  assert.ok(!findLine(ok.w.logs, 'fail-open-file-held'));
  const other = await run([[{ command: { type: 'message', text: 'the sky is blue' }, id: 4 }]]);
  assert.equal(other.ws.wire.length, 0);
  assert.equal(other.ws.closes.length, 1);
  const line = assertBlocked(other.w.logs, 'fail-open-file-held', 'unavailable');
  assert.match(line, /\bhost=ws\.chatgpt\.com\b/);
  assert.match(line, /\broute=\/:x\/ws\/user\/:x(\s|$)/);
  assert.ok(!/verify=|the sky/.test(line), line);
});

test('releasableUnderFailOpen round 4: the caps, at their boundaries (content_free_caps_are_pinned)', () => {
  const at = (n) => req('POST', 'gemini.google.com', GEMINI, 'application/x-www-form-urlencoded',
    `${geminiBody(['hi']).split('&')[0]}&at=${'a'.repeat(n)}`);
  assert.equal(releasable(at(4096)), true);
  assert.equal(releasable(at(4097)), false);
  const rot = (n) => jreq('POST', 'accounts.google.com', '/RotateCookies', [1, '1'.repeat(n)]);
  assert.equal(releasable(rot(32)), true);
  assert.equal(releasable(rot(33)), false);
  const args = `[11${',1'.repeat(1022)}]`;
  assert.equal(args.length, 2048);
  const fReq = JSON.stringify([[['ESY5D', args, null, 'generic']]]);
  assert.equal(releasable(req('POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute', 'application/x-www-form-urlencoded',
    `f.req=${formEnc(fReq)}`)), true);
  assert.equal(releasable(req('WS-SEND', 'ws.chatgpt.com', 'ws/user/abc', null, '[{"command":{"type":"presence"},"id":1}]')), false);
  // Edges each check decides: a one-digit cookie, a timezone with a 9, a
  // numbered tag with a 0 and a 9; and array-like objects where arrays are.
  assert.equal(releasable(rot(1)), true);
  const init = (tz) => jreq('POST', 'chatgpt.com', '/backend-api/conversation/init', { timezone: tz });
  assert.equal(releasable(init('Etc/GMT+9')), true);
  const bx = (fr) => req('POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute', 'application/x-www-form-urlencoded',
    `f.req=${formEnc(fr)}`);
  assert.equal(releasable(bx('[[["otAQ7b","[1]",null,"09"]]]')), true);
  assert.equal(releasable(bx('{"0":[["aPya6c","[]",null,"generic"]],"length":1}')), false);
  assert.equal(releasable(bx('[[{"0":"aPya6c","1":"[]","2":null,"3":"generic","length":4}]]')), false);
  assert.equal(releasable(bx('[[')), false, 'an f.req that is not JSON');
  assert.equal(releasable(jreq('POST', 'accounts.google.com', '/RotateCookies', [1, '1000'])), true);
});

test('releasableUnderFailOpen round 5: claude.ai Connect RPC is exact (claude_ai_rpc_is_exact)', () => {
  const { varint, pv, pl, cat, RPC, CRED, rpcReq, envelope, header, settings } = R4.PB;
  const perform = (b) => rpcReq(RPC + 'PerformAction', 'application/proto', b);
  const rpc = (m, ct, b) => rpcReq(RPC + m, ct, b);
  const send = (extra) => perform(cat(pl(1, header(7, true)), pl(2, cat(pl(1, 'm1'), pl(2, 'm2'), pl(3, 'the sky is blue'),
    pl(7, pl(2, 'claude-haiku-5-5')), pl(8, settings()), pl(12, 'Etc/GMT+9'), pl(13, 'en-US'), pv(18, 1), pv(21, 1), pv(54, 1),
    pl(57, pl(2, 'm')), pv(59, 1), extra))));
  const withHeader = (h) => perform(cat(pl(1, h), pl(2, pl(3, 'x'))));
  const set = (extra) => perform(cat(pl(1, header(null, false)), pl(2, pl(8, pl(1, extra)))));
  const tool = (key, on) => set(pl(8, pl(1, cat(pl(1, key), pv(2, on)))));
  const timeline = (m) => rpc('StreamTimeline', 'application/connect+proto', envelope(m));
  const tlOk = cat(pl(1, 'c'), pl(2, pl(1, '1795417603410-0')), pv(3, 1), pl(4, cat(pv(46, 1023), pv(61, 0))), pl(5, 'en'), pv(6, 2),
    pl(8, 'UTC'), pv(15, 1));
  const cred = (b, ct = 'application/proto') => rpcReq(CRED, ct, b);
  const maxKey = `${'a'.repeat(80)}:${'b'.repeat(160 - 81)}`;
  const manyTools = cat(...Array.from({ length: 256 }, () => pl(1, cat(pl(1, 'k:t-1'), pv(2, 1)))));
  const released = [
    send(Buffer.alloc(0)),
    withHeader(cat(pl(2, 'c'), pv(3, 1023), pl(15, Buffer.alloc(64, 7)))),
    withHeader(pl(1, cat(pl(1, 's'), pv(2, 0xffffffff)))),
    perform(cat(pl(1, ''), pl(15, ''))),
    tool(maxKey, 0), set(pl(8, manyTools)), timeline(tlOk), timeline(Buffer.alloc(0)),
    rpc('GetNewConversationDefaults', 'application/proto', Buffer.alloc(0)),
    rpc('ReportViewing', 'application/proto', cat(pl(1, 'c'), pl(2, 'm'), pv(3, 0))),
    rpc('ReportViewing', 'application/proto', Buffer.alloc(0)),
    cred(pl(1, '5c10de80-1b07-4305-bbd3-a4ff70118284'))
  ];
  released.forEach((raw, i) => assert.equal(releasable(raw), true, `released ${i}`));
  const held = [
    send(pl(15, cat(pl(1, 'notes.txt'), pv(2, 3), pl(3, 'text/plain'), pl(4, 'abc')))),
    send(pl(4, 'x')), send(pv(60, 1)), withHeader(pv(4, 1)), withHeader(pl(7, pv(4, 1))), withHeader(pl(1, pv(3, 1))),
    set(pv(2, 1)), set(pl(8, pl(2, 'x'))),
    perform(cat(pl(1, header(null, false)), pl(3, 'x'))), perform(cat(pl(1, header(null, false)), pl(2, ''), pl(15, ''))),
    perform(pl(1, header(null, false))), perform(pl(2, pl(3, 'x'))), perform(Buffer.alloc(0)),
    send(pl(3, 'again')), withHeader(cat(pl(2, 'c'), pl(2, 'd'))),
    withHeader(pl(7, pv(1, 2))), withHeader(pv(3, 1024)), withHeader(pl(2, 'a b')), withHeader(pl(2, 'é')),
    withHeader(pl(14, 'a'.repeat(65))),
    perform(cat(pl(1, ''), pl(2, pl(12, 'America/New York')))), perform(cat(pl(1, ''), pl(2, pl(3, Buffer.from([0xff, 0xfe]))))),
    withHeader(pl(15, '')), withHeader(pl(15, Buffer.alloc(65, 7))),
    tool(`${maxKey}x`, 1), tool('k t', 1), tool('', 1), tool('k', 2), set(pl(8, cat(manyTools, pl(1, pl(1, 'k'))))),
    withHeader(pv(2, 1)), withHeader(pl(3, 'x')),
    perform(cat(pl(1, ''), Buffer.from([0x12, 0x05, 0x78]))),
    perform(cat(pl(1, ''), Buffer.from([0x10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))),
    perform(cat(pl(1, ''), varint(10), varint(0x100000000))),
    perform(cat(pl(1, ''), Buffer.from([0x10, 0x81, 0x00]))),
    perform(cat(pl(1, ''), Buffer.from([0x02, 0x00]))),
    perform(cat(pl(1, ''), Buffer.from([0x11, 0, 0, 0, 0, 0, 0, 0, 0]))),
    perform(cat(pl(1, ''), Buffer.from([0x15, 0, 0, 0, 0]))),
    perform(cat(pl(1, ''), Buffer.from([0x13, 0x14]))),
    rpcReq(RPC + 'PerformAction', 'application/json', Buffer.from('{"header":{"conversationId":"c"},"sendMessage":{"text":"the sky is blue"}}')),
    rpcReq(RPC + 'PerformAction', 'application/connect+proto', envelope(pl(1, ''))),
    rpc('StreamTimeline', 'application/proto', tlOk),
    rpc('StreamTimeline', 'application/connect+proto', cat(Buffer.from([1]), envelope(tlOk).subarray(1))),
    rpc('StreamTimeline', 'application/connect+proto', cat(envelope(tlOk), envelope(Buffer.alloc(0)))),
    rpc('StreamTimeline', 'application/connect+proto', envelope(tlOk).subarray(0, envelope(tlOk).length - 1)),
    rpc('StreamTimeline', 'application/connect+proto', Buffer.from([0, 0, 0, 0])),
    rpc('StreamTimeline', 'application/connect+proto', Buffer.from([0, 0, 0, 0, 1])),
    timeline(pl(4, pv(7, 1))), timeline(pv(7, 1)),
    rpc('GetNewConversationDefaults', 'application/proto', pv(1, 1)), rpc('GetNewConversationDefaults', 'application/json', Buffer.alloc(0)),
    rpc('ReportViewing', 'application/proto', pv(4, 1)), rpc('ReportViewing', 'application/json', Buffer.from('{}')),
    cred(Buffer.alloc(0)), cred(cat(pl(1, 'o'), pl(2, 'x'))), cred(pv(1, 1)), cred(Buffer.from('{"organizationUuid":"o"}'), 'application/json'),
    rpc('DeleteConversation', 'application/proto', pl(1, 'c')), rpc('PerformActions', 'application/proto', pl(1, '')),
    rpcReq('/claudeai-rpc/anthropic.claudeai_b2b.v1.ConsoleService/Other', 'application/proto', pl(1, 'o')),
    req('PUT', 'claude.ai', RPC + 'GetNewConversationDefaults', 'application/proto', Buffer.alloc(0)),
    req('POST', 'claude.com', RPC + 'GetNewConversationDefaults', 'application/proto', Buffer.alloc(0))
  ];
  held.forEach((raw, i) => assert.equal(releasable(raw), false, `held ${i}: ${raw.toString('latin1').slice(0, 160)}`));
  // The reader's edges: a varint cut off, a counter past 2^32-1, a length
  // past the end; a tool key's alphabet at each boundary; the shortest
  // nonce and key; an envelope past 256 bytes; credentials not as proto.
  const view = (b) => rpc('ReportViewing', 'application/proto', Buffer.from(b));
  assert.equal(releasable(view([0x18, 0x01])), true);
  assert.equal(releasable(view([0x18, 0x81])), false);
  assert.equal(releasable(view([0x0a, 0x05, 0x61])), false);
  assert.equal(releasable(withHeader(pl(1, cat(pl(1, 's'), varint(16), varint(2 ** 32))))), false);
  assert.equal(releasable(tool('09AZaz.:-_', 1)), true);
  assert.equal(releasable(tool('k', 1)), true);
  for (const c of ['/', '@', '[', '`', '{']) assert.equal(releasable(tool(`k${c}t`, 1)), false, c);
  assert.equal(releasable(withHeader(pl(15, Buffer.from([0xff])))), true);
  const long = cat(pl(1, 'c'.repeat(64)), pl(2, pl(1, '1'.repeat(64))), pl(5, 'e'.repeat(64)), pl(8, 'z'.repeat(64)),
    pl(4, cat(...[[6, 1], [22, 1], [24, 1], [28, 1], [33, 1], [46, 3], [47, 1], [61, 1]].map(([n, v]) => pv(n, v)))));
  assert.ok(long.length > 256);
  assert.equal(releasable(timeline(long)), true);
  const short = envelope(long);
  short[3] = 0;
  assert.equal(releasable(rpc('StreamTimeline', 'application/connect+proto', short)), false);
  assert.equal(releasable(cred(pl(1, 'o'), 'application/json')), false);
});

// The live failure (dev.27): claude.ai looped "Can't connect. Retrying…" under
// fail-open. Through the real fetch hook, each RPC call the page makes goes
// out with the bridge down, a .txt send is held and named by its template.
test('fail-open round 5: claude.ai\'s Connect RPC send goes out; the attachment send is held, named', async () => {
  const w = makeWorld(() => ({ ok: false, code: 'bridge-error' }), realCatalogGlobals('https://claude.ai/new'));
  w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  const go = async (raw) => {
    const i = raw.indexOf('\r\n\r\n');
    const head = raw.subarray(0, i).toString('latin1');
    const [method, target] = head.split('\r\n')[0].split(' ');
    const ct = /\r\ncontent-type: ([^\r]+)/.exec(head)[1];
    w.logs.length = 0;
    try {
      await w.sandbox.fetch(`https://claude.ai${target}`, { method, headers: { 'content-type': ct, 'connect-protocol-version': '1' },
        body: new Uint8Array(raw.subarray(i + 4)) });
      return 'SENT';
    } catch (e) { return blockedError(e) ? 'BLOCKED' : `ERR ${e.message}`; }
  };
  const flow = (f) => f.find((x) => x.surface === 'claude.ai (Connect RPC)').steps;
  for (const [what, raw] of flow(R4.plain())) assert.equal(await go(raw), 'SENT', what);
  const [, attached] = flow(R4.withFile()).find(([what]) => what === 'send (follow-up)');
  assert.equal(await go(attached), 'BLOCKED');
  const line = assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
  assert.match(line, /\broute=\/claudeai-rpc\/anthropic\.bard\.api\.v1alpha\.ConversationService\/PerformAction(\s|$)/);
  assert.ok(!/Ada|123-45-6789|notes\.txt/.test(line), line);
});

test('releasableUnderFailOpen round 5: the RPC schemas, pinned, and every field held to its kind once (claude_ai_rpc_schemas_are_pinned, each_rpc_field_holds_its_kind_once)', () => {
  const m = /\/\/ <releasableUnderFailOpen>\n([\s\S]*?)\/\/ <\/releasableUnderFailOpen>/.exec(SHIM_SRC);
  const S = new Function(m[1] + '; return FAIL_OPEN_RPC;')();
  const describe = (schema) => schema.map(([n, k, rep]) =>
    `${n}:${Array.isArray(k) ? `(${describe(k)})` : k.toLowerCase()}${rep ? '*' : ''}`).join(' ');
  assert.equal(describe(S.CAI_PERFORM),
    '1:(1:(1:word 2:count) 2:word 3:small ' +
    '7:(1:flag 2:flag 3:flag 6:flag 8:flag 10:flag 22:flag 24:flag 28:flag 33:flag 57:flag) ' +
    '14:word 15:nonce 19:flag) ' +
    '2:(1:word 2:word 3:text 7:(2:word) ' +
    '8:(1:(1:flag 7:flag 8:(1:(1:toolkey 2:flag)*) 10:small 14:small 16:word 17:word)) ' +
    '12:zone 13:word 18:small 21:small 54:flag 57:(2:word) 59:flag) ' +
    '15:(1:(12:zone 13:word 18:small))');
  assert.equal(describe(S.CAI_TIMELINE),
    '1:word 2:(1:word) 3:small 4:(6:small 22:small 24:small 28:small 33:small 46:small 47:small 61:small) ' +
    '5:word 6:small 8:zone 15:small');
  assert.equal(describe(S.CAI_REPORT_VIEWING), '1:word 2:word 3:flag');
  assert.equal(describe(S.CAI_CREDENTIALS), '1:word');

  // Every field, through its real route: its kind's values pass, another
  // kind's do not, and twice holds (the tools map's entries excepted).
  const { pv, pl, cat, RPC, CRED, rpcReq, envelope } = R4.PB;
  const values = {
    flag: [[pv, 0], [pv, 1]], small: [[pv, 2], [pv, 1023]], count: [[pv, 1024], [pv, 0xffffffff]],
    word: [[pl, 'a.b-c_9']], zone: [[pl, 'Etc/GMT+9']], text: [[pl, 'a b/c:d é'], [pl, '']],
    nonce: [[pl, Buffer.from([0xff, 0])]], toolKey: [[pl, 'k.t:x-1_2']]
  };
  const wrong = {
    flag: [[pv, 2], [pl, '1']], small: [[pv, 1024], [pl, '1']], count: [[pl, '1']],
    word: [[pl, 'a b'], [pl, 'a/b'], [pl, 'a:b'], [pl, ''], [pv, 1]], zone: [[pl, 'a b'], [pl, 'a:b'], [pv, 1]],
    text: [[pl, Buffer.from([0xff])], [pv, 1]], nonce: [[pl, ''], [pv, 1]],
    toolKey: [[pl, 'k t'], [pl, 'k/t'], [pl, ''], [pv, 1]]
  };
  const routes = [
    [S.CAI_PERFORM, (b) => rpcReq(RPC + 'PerformAction', 'application/proto', b), 'perform'],
    [S.CAI_TIMELINE, (b) => rpcReq(RPC + 'StreamTimeline', 'application/connect+proto', envelope(b)), 'timeline'],
    [S.CAI_REPORT_VIEWING, (b) => rpcReq(RPC + 'ReportViewing', 'application/proto', b), 'viewing'],
    [S.CAI_CREDENTIALS, (b) => rpcReq(CRED, 'application/proto', b), 'credentials']
  ];
  // PerformAction takes the header and exactly one action.
  const complete = (field, b) => (field === 1 ? cat(b, pl(15, '')) : cat(pl(1, ''), b));
  let checked = 0;
  const nested = (schema, build, top, path) => {
    for (const [n, k, rep] of schema) {
      if (Array.isArray(k)) {
        nested(k, (inner) => build(pl(n, inner)), top, `${path}.${n}`);
        // A message field: empty passes, a varint does not, twice only if repeated.
        assert.equal(releasable(build(pl(n, ''))), true, `${path}.${n} empty`);
        assert.equal(releasable(build(cat(pl(n, ''), pl(n, '')))), !!rep, `${path}.${n} twice`);
        assert.equal(releasable(build(pv(n, 1))), false, `${path}.${n} as a varint`);
        continue;
      }
      checked++;
      for (const [enc, v] of values[k]) {
        const one = enc(n, v);
        assert.equal(releasable(build(one)), true, `${path}.${n} takes ${k}`);
        assert.equal(releasable(build(cat(one, one))), !!rep, `${path}.${n} twice`);
      }
      for (const [enc, v] of wrong[k]) assert.equal(releasable(build(enc(n, v))), false, `${path}.${n} refuses ${k}`);
    }
  };
  for (const [schema, send, top] of routes) {
    // The field number at the top decides how a PerformAction is completed.
    nested(schema, (b) => send(top === 'perform' ? complete(b[0] >> 3, b) : b), top, top);
  }
  assert.equal(checked, 59, 'every scalar field of every message');
});

test('releasableUnderFailOpen round 6: Gemini WebChannel is exact (gemini_webchannel_is_exact, gemini_webchannel_schema_is_pinned)', () => {
  const { pv, pl, cat } = R4.PB;
  const { webchannel, request, echo } = R4.GPS;
  const m = /\/\/ <releasableUnderFailOpen>\n([\s\S]*?)\/\/ <\/releasableUnderFailOpen>/.exec(SHIM_SRC);
  const S = new Function(m[1] + '; return FAIL_OPEN_RPC;')();
  const describe = (schema) => schema.map(([n, k, rep]) =>
    `${n}:${Array.isArray(k) ? `(${describe(k)})` : k.toLowerCase()}${rep ? '*' : ''}`).join(' ');
  assert.equal(describe(S.GPS_FRAME),
    '1:(1:(1:small 2:optword 3:word 4:word) 2:small 8:(5:(1:(' +
    '1:(1:text 2:small 7:small) 2:(1:word) 4:attest 5:word 7:(1:small) 8:small 11:small ' +
    '12:small 18:(1:(1:small)) 19:small 28:small 31:nonce 42:(1:small) 50:small 54:small ' +
    '60:word 62:empty 68:small 69:small 72:(1:word 8:token) 92:small 97:small 99:small) ' +
    '4:small))) 2:(1:small 9:(1:text)) 4:(1:small)');
  const H = 'geminiweb-pa.clients6.google.com';
  const psBody = (body) => req('POST', H, '/v1/processSession?VER=8', 'application/x-www-form-urlencoded', body);
  const frame = (f) => `req0___data__=${formEnc(Buffer.from(f).toString('base64'))}`;
  const send = request('the sky is blue', false, null);
  const okFrames = [send, echo('hi'), pl(4, pv(1, 1))];
  for (const f of okFrames) assert.equal(releasable(psBody(`count=1&ofs=0&${frame(f)}`)), true);
  const heldFrames = [request('x', false, pl(3, '/contrib_service/ttl_1d/abc/photo.png')), request('x', false, pv(100, 1)),
    cat(send, echo('x')), pl(3, pv(1, 1)), Buffer.alloc(0), pl(2, pl(9, pl(1, Buffer.from([0xff])))), pl(2, pl(9, pl(2, 'x')))];
  heldFrames.forEach((f, i) => assert.equal(releasable(psBody(`count=1&${frame(f)}`)), false, `held frame ${i}`));
  const one = frame(okFrames[2]);
  const many = (n) => Array.from({ length: n }, (_, i) => `req${i}___data__=${formEnc(okFrames[2].toString('base64'))}`).join('&');
  for (const [body, want] of [
    ['count=0', true], ['count=0&', true], [`count=1&${one}&`, true], [`count=01&ofs=000000002&${one}`, true], [`${one}&count=1`, true],
    [`count=2&${one}&req1___data__=${formEnc(echo('x').toString('base64'))}`, true],
    [`count=1&ofs=2&ofs=2&${one}`, false], [`count=1&count=1&${one}`, false], [`count=2&${one}`, false], [`count=0&${one}`, false],
    [`count=1&${one}&${one}`, false], [`count=1&req1___data__=${formEnc(okFrames[2].toString('base64'))}`, false],
    [`count=1&${one.replace('req0', 'req00a')}`, false], [`count=1&${one.replace('req0', 'req123')}`, false],
    [`count=1&${one.replace('req0', 'rqe0')}`, false], [`count=1&${one}&x=1`, false], [`count=a&${one}`, false],
    [`count=100&${one}`, false], [`count=1&ofs=1234567890&${one}`, false], [`count=1&ofs=x&${one}`, false],
    [`count=17&${many(17)}`, false], [`count=16&${many(16)}`, true], ['count=1&req0___data__=%zz', false], ['', false],
    [`count=1&${one.replace('req0', 'req000')}`, false], [`count=016&${many(16)}`, false]
  ]) assert.equal(releasable(psBody(body)), want, body);
  // Base64: standard, padded, canonical.
  const b = (x) => releasable(psBody(`count=1&req0___data__=${formEnc(x)}`));
  assert.equal(b('IgIIAQ=='), true); // {4: {1: 1}}
  for (const x of ['IgIIAQ', 'IgIIAR==', 'IgIIAQ=', 'IgIIA===', 'IgII-Q==', 'IgII AQ==', 'Ig==IgIIAQ==', 'IgI=IgIIAQ==']) assert.equal(b(x), false, x);
  // Media, method, route, host.
  const f = `count=1&${one}`;
  assert.equal(releasable(req('POST', H, '/v1/processSession', 'application/json', f)), false);
  assert.equal(releasable(req('PUT', H, '/v1/processSession', 'application/x-www-form-urlencoded', f)), false);
  assert.equal(releasable(req('POST', H, '/v1/processSessions', 'application/x-www-form-urlencoded', f)), false);
  assert.equal(releasable(req('POST', 'geminiweb-pa.googleapis.com', '/v1/processSession', 'application/x-www-form-urlencoded', f)), false);
  // The handshake's query may run to 4096 on this route only.
  const q = (route, n) => `${route}?h=${'a.'.repeat(n).slice(0, n - 2)}`;
  assert.equal(releasable(req('POST', H, q('/v1/processSession', 4096), 'application/x-www-form-urlencoded', 'count=0')), true);
  assert.equal(releasable(req('POST', H, q('/v1/processSession', 4097), 'application/x-www-form-urlencoded', 'count=0')), false);
  const turn = '{"messages":[{"role":"user","content":"hi"}]}';
  assert.equal(releasable(req('POST', 'api.anthropic.com', q('/v1/messages', 2048), 'application/json', turn)), true);
  assert.equal(releasable(req('POST', 'api.anthropic.com', q('/v1/messages', 2049), 'application/json', turn)), false);
  // The push channel.
  const SIG = 'signaler-pa.clients6.google.com';
  const sig = (route, ct, body) => req('POST', SIG, route, ct, body);
  assert.equal(releasable(sig('/punctual/v1/chooseServer', 'application/json+protobuf', '[[null,[9,5],["assistant-bard"]],0]')), true);
  assert.equal(releasable(sig('/punctual/v1/refreshCreds', 'application/json+protobuf', '["VddsdreZ"]')), true);
  assert.equal(releasable(webchannel(SIG, '/punctual/multi-watch/channel', 0, ['[[[1,[null,"async_bard"],3]]]'])), true);
  for (const [route, ct, body] of [['/punctual/v1/chooseServer', 'application/json+protobuf', '["the sky is blue"]'],
    ['/punctual/v1/chooseServer', 'application/json+protobuf', '[{"a":1}]'], ['/punctual/v1/chooseServer', 'application/json', '[1]'],
    ['/punctual/v1/refreshCreds', 'application/x-www-form-urlencoded', '["a"]'], ['/punctual/v1/other', 'application/json+protobuf', '[1]'],
    ['/punctual/multi-watch/channel', 'application/json+protobuf', '[1]'],
    ['/punctual/v1/chooseServer', 'application/json+protobuf', `[${Array(1024).fill('1').join(',')}]`]]) {
    assert.equal(releasable(sig(route, ct, body)), false, `${route} ${body.slice(0, 30)}`);
  }
  assert.equal(releasable(webchannel(SIG, '/punctual/multi-watch/channel', 0, ['["a b"]'])), false);
  const atCap = `[11${',1'.repeat(1022)}]`;
  assert.equal(atCap.length, 2048);
  assert.equal(releasable(sig('/punctual/v1/chooseServer', 'application/json+protobuf', atCap)), true);
  // Every scalar field of the frame, through the real route: its kind, not
  // another, once.
  const values = { small: [[pv, 2], [pv, 1023]], word: [[pl, 'a.b-c_9']], text: [[pl, 'a b/c:d é'], [pl, '']],
    nonce: [[pl, Buffer.from([0xff, 0])]], empty: [[pl, '']], attest: [[pl, '!aZ09-_'], [pl, 'a'.repeat(8192)], ...'09AZaz!-_'.split('').map((c) => [pl, c])],
    optWord: [[pl, ''], [pl, 'a.b-c_9'], [pl, 'a'.repeat(64)], ...'09AZaz._-'.split('').map((c) => [pl, c])],
    token: [[pl, 'a.b-c_9'], [pl, 'Aw+/9a=='], [pl, 'a'.repeat(64)], ...'09AZaz._+/=-'.split('').map((c) => [pl, c])] };
  const wrong = { small: [[pv, 1024], [pl, '1']], word: [[pl, 'a b'], [pl, 'a/b'], [pl, ''], [pv, 1]],
    text: [[pl, Buffer.from([0xff])], [pv, 1]], nonce: [[pl, ''], [pv, 1]], empty: [[pl, 'a'], [pv, 0]],
    optWord: [[pl, 'a b'], [pl, 'a/b'], [pl, 'a:b'], [pl, Buffer.from([0xff])], [pl, 'a'.repeat(65)], [pv, 1], [pv, 0],
      ...'+/=,:@[`{!*~%"\n'.split('').map((c) => [pl, `a${c}`])],
    attest: [[pl, 'a.b'], [pl, 'a b'], [pl, ''], [pl, 'a'.repeat(8193)], [pv, 1], ...'/:@[`{+="'.split('').map((c) => [pl, `a${c}`])],
    token: [[pl, 'a b'], [pl, 'a:b'], [pl, 'a%2B'], [pl, ''], [pl, 'a'.repeat(65)], [pv, 1], ...',:@[`{!*~"\n'.split('').map((c) => [pl, `a${c}`])] };
  const viaFrame = (b) => psBody(`count=1&${frame(b)}`);
  let checked = 0;
  const nested = (schema, build, path) => {
    for (const [n, k] of schema) {
      if (Array.isArray(k)) {
        nested(k, (inner) => build(pl(n, inner)), `${path}.${n}`);
        assert.equal(releasable(viaFrame(build(cat(pl(n, ''), pl(n, ''))))), false, `${path}.${n} twice`);
        assert.equal(releasable(viaFrame(build(pv(n, 1)))), false, `${path}.${n} as a varint`);
        continue;
      }
      checked++;
      for (const [enc, v] of values[k]) {
        const once = enc(n, v);
        assert.equal(releasable(viaFrame(build(once))), true, `${path}.${n} takes ${k}`);
        assert.equal(releasable(viaFrame(build(cat(once, once)))), false, `${path}.${n} twice`);
      }
      for (const [enc, v] of wrong[k]) assert.equal(releasable(viaFrame(build(enc(n, v)))), false, `${path}.${n} refuses ${k}`);
    }
  };
  nested(S.GPS_FRAME, (b) => b, 'frame');
  assert.equal(checked, 35, 'every scalar field of the frame');
});

test('fail-open round 6: Gemini\'s WebChannel send goes out through the fetch hook; an image reference holds, named', async () => {
  const w = makeWorld(() => ({ ok: false, code: 'bridge-error' }), realCatalogGlobals('https://gemini.google.com/app'));
  w.deliver({ type: 'SONOMOS_CONFIG', config: openWindow() });
  const go = async (raw) => {
    const i = raw.indexOf('\r\n\r\n');
    const head = raw.subarray(0, i).toString('latin1');
    const [method, target] = head.split('\r\n')[0].split(' ');
    const host = /\r\nHost: ([^\r]+)/.exec(head)[1];
    const ct = /\r\ncontent-type: ([^\r]+)/.exec(head)[1];
    w.logs.length = 0;
    try {
      await w.sandbox.fetch(`https://${host}${target}`, { method, headers: { 'content-type': ct }, body: raw.subarray(i + 4).toString('latin1') });
      return 'SENT';
    } catch (e) { return blockedError(e) ? 'BLOCKED' : `ERR ${e.message}`; }
  };
  const flow = (f) => f.find((x) => x.surface === 'Gemini web (WebChannel)').steps;
  for (const [what, raw] of flow(R4.plain())) assert.equal(await go(raw), 'SENT', what);
  const [, withImage] = flow(R4.withFile()).find(([what]) => what === 'send (new chat)');
  assert.equal(await go(withImage), 'BLOCKED');
  const line = assertBlocked(w.logs, 'fail-open-file-held', 'unavailable');
  assert.match(line, /\bhost=geminiweb-pa\.clients6\.google\.com\b/);
  assert.match(line, /\broute=\/v1\/processSession(\s|$)/);
  assert.ok(!/photo\.png|capital/.test(line), line);
});

test('FAIL_OPEN_B64: strict standard base64, byte for byte (b64_std_is_strict)', () => {
  const m = /\/\/ <releasableUnderFailOpen>\n([\s\S]*?)\/\/ <\/releasableUnderFailOpen>/.exec(SHIM_SRC);
  const b64 = new Function(m[1] + '; return FAIL_OPEN_B64;')();
  const hex = (u) => (u === undefined ? 'undefined' : Buffer.from(u).toString('hex'));
  let seed = 7;
  for (let len = 0; len < 70; len++) {
    const bytes = Buffer.alloc(len);
    for (let i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; bytes[i] = seed % 256; }
    assert.equal(hex(b64(bytes.toString('base64'))), bytes.toString('hex'), `len ${len}`);
  }
  const all = Buffer.from([...Array(256).keys()]);
  assert.equal(hex(b64(all.toString('base64'))), all.toString('hex'));
  for (const t of [[0xff, 0xff, 0xff], [0x01, 0xff, 0xff], [0x00, 0xff, 0xff], [0xfe, 0xff, 0xfe]]) {
    const bytes = Buffer.from(t);
    assert.equal(hex(b64(bytes.toString('base64'))), bytes.toString('hex'), bytes.toString('hex'));
  }
  assert.equal(hex(b64('AZaz09+/')), Buffer.from('AZaz09+/', 'base64').toString('hex'));
  for (const c of ['@', '[', '`', '{', ':', '-', '_', '.', ' ', '\n', 'é']) {
    assert.equal(b64(`AA${c}A`), undefined, JSON.stringify(c));
  }
  for (const x of ['A', 'AA', 'AAA', 'AAAAA', '=AAA', 'A=AA', 'AA=A', 'A===', '====', 'AA==AAAA', 'AAA=AAAA',
    'AB==', 'AAB=', 'AA=B']) assert.equal(b64(x), undefined, x);
  assert.equal(hex(b64('AA==')), '00');
  assert.equal(hex(b64('AAA=')), '0000');
  assert.equal(hex(b64('AQ==')), '01');
  assert.equal(hex(b64('AAE=')), '0001');
  assert.equal(hex(b64('')), '');
});

test('releasableUnderFailOpen round 8: Gemini\'s request metadata takes an id or none (gemini_request_metadata_takes_an_id_or_none)', () => {
  const { webchannel, request, echo } = R4.GPS;
  const send = (followUp, id) => webchannel('geminiweb-pa.clients6.google.com', '/v1/processSession', 0,
    [request('hi there', followUp, null, id), echo('hi there')].map((f) => f.toString('base64')));
  for (const followUp of [false, true]) {
    for (const id of ['', '0515992ff73cecd1', 'c_0515992ff73cecd1', 'a'.repeat(64)]) {
      assert.equal(releasable(send(followUp, id)), true, `${followUp} ${id}`);
    }
    for (const id of ['0515992f f73cecd1', '/contrib_service/a.png', 'image/png', 'a:b', 'a'.repeat(65), Buffer.alloc(16, 0xff)]) {
      assert.equal(releasable(send(followUp, id)), false, `${followUp} ${id}`);
    }
  }
});

test('releasableUnderFailOpen round 8: the calls dev.30 held as Gemini\'s page loaded are listed (gemini_page_load_calls_are_listed)', () => {
  const FORM = 'application/x-www-form-urlencoded';
  const be = (calls) => releasable(req('POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute?rpcids=x', FORM,
    `f.req=${formEnc(JSON.stringify([calls]))}&at=x`));
  for (const id of ['FQjvN', 'UQJUK', 'Ub3MPb', 'VVSn5c', 'VxUbXb']) {
    assert.equal(be([[id, '[]', null, 'generic']]), true, id);
    assert.equal(be([[id, '["the sky is blue"]', null, 'generic']]), false, `${id} with a sentence`);
  }
  assert.equal(be([['NkpXw', '[]', null, 'generic']]), false);
  // One unlisted call holds the batch, wherever it sits.
  assert.equal(be([['L5adhe', '[]', null, 'generic'], ['NkpXw', '[]', null, 'generic'], ['otAQ7b', '[1]', null, 'generic']]), false);
  const m = /\/\/ <releasableUnderFailOpen>\n([\s\S]*?)\/\/ <\/releasableUnderFailOpen>/.exec(SHIM_SRC);
  const listed = /const GEMINI_RPCS = \[([\s\S]*?)\];/.exec(m[1])[1].match(/'[^']+'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(listed, [
    'CNgdBe', 'DYBcR', 'ESY5D', 'FQjvN', 'GPRiHf', 'I4z33b', 'K4WWud', 'L5adhe', 'MaZiqc', 'PCck7e', 'Te6DCf', 'UQJUK',
    'Ub3MPb', 'VVSn5c', 'VxUbXb', 'aPya6c', 'cCSu7', 'cYRIkd', 'ku4Jyf', 'maGuAc', 'o30O0e', 'otAQ7b', 'ozz5Z', 'sJBwce', 'whPPme'
  ]);
});

test('releasableUnderFailOpen round 6 review: Gemini\'s `at` at most once, as `f.req` (single_deviations_from_a_released_turn_are_held)', () => {
  const FORM = 'application/x-www-form-urlencoded';
  const freq = geminiBody(['hi']).split('&')[0];
  const sg = (body) => releasable(req('POST', 'gemini.google.com', GEMINI, FORM, body));
  assert.equal(sg(freq), true);
  assert.equal(sg(`${freq}&at=AJvLN6M`), true);
  assert.equal(sg(`${freq}&at=AJvLN6M&at=AJvLN6M`), false);
  assert.equal(sg(`${freq}&at=a&at=b`), false);
  assert.equal(sg(`at=a&at=b&${freq}`), false);
  const otaq = `f.req=${formEnc(JSON.stringify([[['otAQ7b', '[1]', null, 'generic']]]))}`;
  const be = (body) => releasable(req('POST', 'gemini.google.com', '/_/BardChatUi/data/batchexecute?rpcids=otAQ7b&rt=c', FORM, body));
  assert.equal(be(otaq), true);
  assert.equal(be(`${otaq}&at=a&`), true);
  assert.equal(be(`at=a&${otaq}`), true);
  assert.equal(be(`${otaq}&at=a&at=a`), false);
  assert.equal(be(`at=a&${otaq}&at=b&`), false);
  // The reviewer's repro: 200 tokens of 4000 base64 each on batchexecute.
  const chunk = 'QUJD'.repeat(1000);
  assert.equal(be(`${otaq}${`&at=${chunk}`.repeat(200)}`), false);
  assert.equal(sg(`${freq}${`&at=${'x'.repeat(4000)}`.repeat(100)}`), false);
});
