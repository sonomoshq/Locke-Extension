// Copyright © 2026 Sonomos, Inc. All rights reserved.
//
// The WebSocket send hook in content/shim.js. Grok web sends every chat prompt
// as a WebSocket text frame on wss://grok.com/ws/mgw/, so these tests replay
// recorded (scrubbed) Grok frames through the real shim source, the way
// tests/shim.test.js does for fetch: the shim runs in a vm context standing in
// for the page, a fake WebSocket stands in for the browser's, and `onCapture`
// stands in for the guard behind the content script.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SHIM_SRC = await readFile(new URL('../content/shim.js', import.meta.url), 'utf8');
const GROK = JSON.parse(await readFile(new URL('./fixtures/grok-ws-send.json', import.meta.url), 'utf8'));
const GROK_URL = GROK.frames[0].url;

// A WebSocket the shim can patch: accessors on the prototype like the real one,
// and a record of what actually went out on the wire.
function makeFakeWebSocket() {
  return class FakeWebSocket {
    constructor(url) {
      this._url = url;
      this._ready = 1; // OPEN unless a test says otherwise
      this._buffered = 0;
      this.wire = [];
      this.closes = [];
      this.events = [];
    }
    get url() { return this._url; }
    get readyState() { return this._ready; }
    get bufferedAmount() { return this._buffered; }
    send(data) {
      if (this._ready === 0) {
        const e = new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
        e.name = 'InvalidStateError';
        throw e;
      }
      if (this._ready !== 1) {
        this._buffered += typeof data === 'string' ? Buffer.byteLength(data) : (data.byteLength ?? data.size ?? 0);
        return;
      }
      this.wire.push(data);
    }
    close(code, reason) {
      this.closes.push({ code, reason });
      if (this._ready < 2) this._ready = 2;
    }
    dispatchEvent(e) { this.events.push(e.type); return true; }
  };
}

function makeWorld(onCapture, { page = 'https://grok.com/', config = {}, extra = {}, postMessage = null } = {}) {
  const listeners = [];
  const logs = [];
  const captures = [];
  const unchecked = [];
  let inner = null;
  const record = (level) => (...args) => { logs.push({ level, line: args.join(' ') }); };
  const u = new URL(page);
  const WebSocket = makeFakeWebSocket();
  const sandbox = {
    location: { href: u.href, origin: u.origin, hostname: u.hostname },
    SONOMOS_WEB_HOSTS: ['grok.com', 'chatgpt.com'],
    SONOMOS_WEB_PROVIDERS: { 'grok.com': 'xai', 'chatgpt.com': 'openai' },
    get top() { return inner; },
    URL, TextEncoder, TextDecoder, btoa, atob,
    Response, Request, Headers, FormData, Blob, URLSearchParams, ReadableStream, Event, DOMException,
    setTimeout, clearTimeout,
    console: { log: record('log'), warn: record('warn'), debug: record('debug'), error: record('error') },
    fetch: async () => ({ __net: true }),
    WebSocket,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: postMessage || ((data) => {
      if (data && data.type === 'SONOMOS_UNCHECKED') { unchecked.push(data.cause); return; }
      if (!data || data.type !== 'SONOMOS_CAPTURE') return;
      captures.push(data);
      Promise.resolve(onCapture(data, captures.length - 1)).then((verdict) => {
        const event = { source: inner, data: { type: 'SONOMOS_VERDICT', callId: data.callId, verdict } };
        for (const fn of listeners) fn(event);
      });
    }),
    ...extra
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  inner = vm.runInContext('window', sandbox);
  vm.runInContext(SHIM_SRC, sandbox, { filename: 'content/shim.js' });
  for (const fn of listeners) fn({ source: inner, data: { type: 'SONOMOS_CONFIG', config } });
  return { WebSocket, captures, logs, unchecked };
}

const allow = { ok: true, receipt: { decision: 'allow', redactedCount: 0 } };
const block = { ok: true, receipt: { decision: 'block', reason: 'ssn found', blockCause: 'policy' } };

function redactTo(rawRequestHead, body) {
  const raw = Buffer.concat([Buffer.from(rawRequestHead + '\r\n\r\n'), Buffer.from(body)]);
  return { ok: true, receipt: { decision: 'redact', redactedCount: 1, requestB64: raw.toString('base64') } };
}

function splitCapture(capture) {
  const raw = Buffer.from(capture.requestB64, 'base64');
  const i = raw.indexOf('\r\n\r\n');
  assert.ok(i > 0, 'capture has a head/body split');
  return { head: raw.subarray(0, i).toString('utf8').split('\r\n'), body: raw.subarray(i + 4) };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, 'timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const bytesOf = (v) => Buffer.from(v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength) : v);

// ── replay: the recorded Grok prompt frames ──────────────────────────────

test('replay: all five recorded Grok prompt frames reach the guard as WS-SEND and are released in order', async () => {
  assert.equal(GROK.frames.length, 5);
  const { WebSocket, captures } = makeWorld(() => allow);
  const ws = new WebSocket(GROK_URL);
  for (const f of GROK.frames) assert.equal(ws.send(f.frame), undefined);
  assert.equal(ws.wire.length, 0, 'nothing leaves before its verdict');
  await waitFor(() => ws.wire.length === 5);
  assert.equal(captures.length, 5);
  captures.forEach((c, i) => {
    const { head, body } = splitCapture(c);
    assert.equal(head[0], 'WS-SEND /ws/mgw/?uid=00000000-0000-4000-8000-0000000000ff HTTP/1.1');
    assert.equal(head[1], 'Host: grok.com');
    assert.equal(head.length, 2, 'no invented headers');
    assert.equal(body.toString('utf8'), GROK.frames[i].frame);
    assert.equal(c.provider, 'xai');
    assert.equal(c.coverage, 'capture_path');
  });
  assert.deepEqual(ws.wire, GROK.frames.map((f) => f.frame), 'original text frames, original order');
});

test('replay: a Grok frame carrying PII goes out redacted, still as a text frame', async () => {
  const pii = GROK.frames[0].frame.replace('the sky is blue', 'my SSN is 123-45-6789');
  const clean = pii.replace('123-45-6789', '[SSN_1]');
  const { WebSocket } = makeWorld(() => redactTo('WS-SEND /ws/mgw/ HTTP/1.1\r\nHost: grok.com', clean));
  const ws = new WebSocket(GROK_URL);
  ws.send(pii);
  await waitFor(() => ws.wire.length === 1);
  assert.equal(typeof ws.wire[0], 'string');
  assert.equal(ws.wire[0], clean);
  assert.ok(!ws.wire[0].includes('123-45-6789'));
});

test('replay: a Grok frame the guard blocks never leaves; the socket errors and closes, later frames dropped', async () => {
  const pii = GROK.frames[0].frame.replace('the sky is blue', 'my SSN is 123-45-6789');
  const { WebSocket, logs } = makeWorld((c, i) => (i === 0 ? block : allow));
  const ws = new WebSocket(GROK_URL);
  ws.send(pii);
  ws.send(GROK.frames[1].frame);
  await waitFor(() => ws.closes.length === 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ws.wire, []);
  assert.deepEqual(ws.events, ['error']);
  assert.deepEqual(ws.closes, [{ code: 4403, reason: 'blocked by Sonomos' }]);
  assert.equal(ws.sonomosBlocked, true);
  assert.equal(ws.sonomosBlockReason, 'decision-block');
  assert.ok(logs.some((l) => l.level === 'warn' && /reason=decision-block\b/.test(l.line) && /via=websocket/.test(l.line)));
  assert.ok(!logs.some((l) => l.line.includes('123-45-6789')), 'no content on the console');
});

// ── ordering and the socket staying usable ───────────────────────────────

test('frames are released in send order even when verdicts arrive out of order', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const { WebSocket, captures } = makeWorld((c, i) => gates[i].promise);
  const ws = new WebSocket(GROK_URL);
  ws.send('one'); ws.send('two'); ws.send('three');
  await waitFor(() => captures.length === 3); // screened concurrently, not one at a time
  gates[2].resolve(allow);
  gates[1].resolve(allow);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ws.wire, [], 'nothing overtakes the first frame');
  gates[0].resolve(allow);
  await waitFor(() => ws.wire.length === 3);
  assert.deepEqual(ws.wire, ['one', 'two', 'three']);
});

test('while a frame waits, send() keeps returning and bufferedAmount counts the held bytes', async () => {
  const gate = deferred();
  const { WebSocket } = makeWorld(() => gate.promise);
  const ws = new WebSocket(GROK_URL);
  assert.equal(ws.send('héllo'), undefined); // 6 UTF-8 bytes
  assert.equal(ws.send(new Uint8Array([1, 2, 3])), undefined);
  assert.equal(ws.bufferedAmount, 9);
  assert.equal(ws.readyState, 1, 'still OPEN');
  gate.resolve(allow);
  await waitFor(() => ws.wire.length === 2);
  assert.equal(ws.bufferedAmount, 0);
});

test('an unscreened frame sent behind a held one queues behind it rather than overtaking', async () => {
  const gate = deferred();
  const { WebSocket, captures } = makeWorld(() => gate.promise, { config: { disabledWebHosts: ['grok.com'] } });
  // grok.com switched off: frames pass straight through, synchronously.
  const off = new WebSocket(GROK_URL);
  off.send('direct');
  assert.deepEqual(off.wire, ['direct']);
  assert.equal(captures.length, 0);
  // A screened socket with an empty-frame (nothing to screen) behind a held frame.
  const ws = new WebSocket('wss://chatgpt.com/ws');
  ws.send('held');
  ws.send('');
  assert.deepEqual(ws.wire, []);
  gate.resolve(allow);
  await waitFor(() => ws.wire.length === 2);
  assert.deepEqual(ws.wire, ['held', '']);
});

// ── payload types ────────────────────────────────────────────────────────

test('ArrayBuffer: the bytes at send() time are screened and released, even if the page reuses the buffer', async () => {
  const { WebSocket, captures } = makeWorld(() => allow);
  const ws = new WebSocket(GROK_URL);
  const buf = new Uint8Array([104, 105]).buffer;
  ws.send(buf);
  new Uint8Array(buf)[0] = 0; // the page reuses its buffer
  await waitFor(() => ws.wire.length === 1);
  assert.deepEqual([...splitCapture(captures[0]).body], [104, 105]);
  assert.ok(ws.wire[0] instanceof ArrayBuffer || Object.prototype.toString.call(ws.wire[0]) === '[object ArrayBuffer]');
  assert.deepEqual([...bytesOf(ws.wire[0])], [104, 105]);
});

test('typed array and DataView: only the viewed bytes are screened and sent', async () => {
  const { WebSocket, captures } = makeWorld(() => allow);
  const ws = new WebSocket(GROK_URL);
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  ws.send(backing.subarray(2, 5));
  ws.send(new DataView(backing.buffer, 1, 2));
  await waitFor(() => ws.wire.length === 2);
  assert.deepEqual([...splitCapture(captures[0]).body], [1, 2, 3]);
  assert.deepEqual([...splitCapture(captures[1]).body], [9, 1]);
  assert.deepEqual([...bytesOf(ws.wire[0])], [1, 2, 3]);
  assert.deepEqual([...bytesOf(ws.wire[1])], [9, 1]);
});

test('Blob: its bytes are screened; an allow releases the page\'s own Blob', async () => {
  const { WebSocket, captures } = makeWorld(() => allow);
  const ws = new WebSocket(GROK_URL);
  const blob = new Blob(['blob body']);
  ws.send(blob);
  await waitFor(() => ws.wire.length === 1);
  assert.equal(splitCapture(captures[0]).body.toString(), 'blob body');
  assert.equal(ws.wire[0], blob);
});

test('a redacted binary frame goes out as the rebuilt bytes, still binary', async () => {
  const { WebSocket } = makeWorld(() => redactTo('WS-SEND /ws/mgw/ HTTP/1.1\r\nHost: grok.com', 'XX'));
  const ws = new WebSocket(GROK_URL);
  ws.send(new Blob(['secret']));
  await waitFor(() => ws.wire.length === 1);
  assert.notEqual(typeof ws.wire[0], 'string');
  assert.equal(bytesOf(ws.wire[0]).toString(), 'XX');
});

// ── close() and the platform's own answers ───────────────────────────────

test('close() while frames are held: CLOSING at once, real close after the held frames go, later sends discarded', async () => {
  const gate = deferred();
  const { WebSocket } = makeWorld(() => gate.promise);
  const ws = new WebSocket(GROK_URL);
  ws.send('last words');
  assert.equal(ws.close(1000, 'bye'), undefined);
  assert.equal(ws.readyState, 2, 'reports CLOSING immediately');
  assert.deepEqual(ws.closes, [], 'the real close waits for the held frame');
  assert.equal(ws.send('after close'), undefined, 'a send while closing does not throw');
  assert.ok(ws.bufferedAmount >= 'after close'.length, 'and is counted, like a native CLOSING socket');
  ws.close(); // a second close() is a no-op
  gate.resolve(allow);
  await waitFor(() => ws.closes.length === 1);
  assert.deepEqual(ws.wire, ['last words']);
  assert.deepEqual(ws.closes, [{ code: 1000, reason: 'bye' }]);
});

test('close() with held frames still validates its arguments synchronously', async () => {
  const gate = deferred();
  const { WebSocket } = makeWorld(() => gate.promise);
  const ws = new WebSocket(GROK_URL);
  ws.send('held');
  assert.throws(() => ws.close(1001), (e) => e.name === 'InvalidAccessError');
  assert.throws(() => ws.close(1000, 'x'.repeat(124)), (e) => e.name === 'SyntaxError');
  assert.equal(ws.readyState, 1, 'a rejected close changes nothing');
  gate.resolve(allow);
  await waitFor(() => ws.wire.length === 1);
});

test('close() with nothing held is the native close, untouched', () => {
  const { WebSocket } = makeWorld(() => allow);
  const ws = new WebSocket(GROK_URL);
  ws.close(4000, 'done');
  assert.deepEqual(ws.closes, [{ code: 4000, reason: 'done' }]);
});

test('a CONNECTING socket still throws InvalidStateError, and a CLOSED one still discards', () => {
  const { WebSocket, captures } = makeWorld(() => allow);
  const ws = new WebSocket(GROK_URL);
  ws._ready = 0;
  assert.throws(() => ws.send('early'), (e) => e.name === 'InvalidStateError');
  ws._ready = 3;
  assert.equal(ws.send('late'), undefined);
  assert.deepEqual(ws.wire, []);
  assert.equal(captures.length, 0);
});

// ── the guard unreachable: the fetch hook's own policy ───────────────────

test('guard unreachable (channel dead) and no fail-open window: the frame is refused, fail closed', async () => {
  const { WebSocket } = makeWorld(null, { postMessage: () => { throw new Error('channel gone'); } });
  const ws = new WebSocket(GROK_URL);
  ws.send('hello');
  await waitFor(() => ws.closes.length === 1);
  assert.deepEqual(ws.wire, []);
  assert.equal(ws.sonomosBlockReason, 'verdict-channel-failed');
});

test('guard unreachable (no-bridge relay code) and no fail-open window: refused with the same reason fetch gives', async () => {
  const { WebSocket } = makeWorld(() => ({ ok: false, code: 'no-bridge', message: 'host not found' }));
  const ws = new WebSocket(GROK_URL);
  ws.send('hello');
  await waitFor(() => ws.closes.length === 1);
  assert.deepEqual(ws.wire, []);
  assert.equal(ws.sonomosBlocked, true);
  assert.notEqual(ws.sonomosBlockReason, 'internal-error');
});

test('guard unreachable inside the user\'s fail-open window: the frame is sent and tallied unchecked', async () => {
  const { WebSocket, unchecked } = makeWorld(() => ({ ok: false, code: 'no-bridge' }), {
    config: { failOpenActive: true, failOpenUntilMs: Date.now() + 60_000 }
  });
  const ws = new WebSocket(GROK_URL);
  ws.send('hello');
  await waitFor(() => ws.wire.length === 1);
  assert.deepEqual(ws.wire, ['hello']);
  assert.equal(ws.closes.length, 0);
  assert.equal(unchecked.length, 1);
});

// ── consent ──────────────────────────────────────────────────────────────

test('without data-sharing consent: a catalog capture path is refused, the open web passes untouched', async () => {
  const { WebSocket, captures } = makeWorld(() => allow, { config: { dataSharingAllowed: false } });
  const open = new WebSocket('wss://gateway.discord.gg/?v=10');
  open.send('{"op":1,"d":null}');
  assert.deepEqual(open.wire, ['{"op":1,"d":null}'], 'synchronous pass-through');
  const ws = new WebSocket(GROK_URL);
  ws.send('hello');
  await waitFor(() => ws.closes.length === 1);
  assert.deepEqual(ws.wire, []);
  assert.equal(ws.sonomosBlockReason, 'data-consent-required');
  assert.equal(captures.length, 0, 'nothing sent to the desktop app without consent');
});

test('an ordinary site\'s socket keeps working: its frames are classified by the guard and released', async () => {
  const { WebSocket, captures } = makeWorld(() => allow, { page: 'https://app.slack.com/client' });
  const ws = new WebSocket('wss://wss-primary.slack.com/?token=abc');
  ws.send('{"type":"ping","id":1}');
  await waitFor(() => ws.wire.length === 1);
  assert.equal(captures[0].coverage, 'open_web');
  assert.match(splitCapture(captures[0]).head[0], /^WS-SEND \/\?token=abc HTTP\/1\.1$/);
  assert.equal(ws.closes.length, 0);
});
