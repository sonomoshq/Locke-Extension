// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
const ports = [];
globalThis.chrome = { runtime: {
  connectNative() {
    const messages = new Set(), disconnects = new Set();
    const port = {
      onMessage: { addListener: (fn) => messages.add(fn), removeListener: (fn) => messages.delete(fn) },
      onDisconnect: { addListener: (fn) => disconnects.add(fn), removeListener: (fn) => disconnects.delete(fn) },
      postMessage(payload) { this.payload = payload; },
      disconnect() { this.closed = true; },
      reply(value) { for (const fn of messages) fn(value); },
      crash() { for (const fn of disconnects) fn(port); },
      listeners: () => messages.size + disconnects.size
    };
    ports.push(port);
    return port;
  }
} };
const { nativeRequest } = await import('../shared/native-client.js');
const { checkHealth } = await import('../shared/health-client.js');

test('native port success closes both listeners and cannot settle another request', async () => {
  const first = nativeRequest({ type: 'capture' }, 100, 'timeout');
  const p1 = ports.at(-1);
  const second = nativeRequest({ type: 'capture' }, 100, 'timeout');
  const p2 = ports.at(-1);
  p1.reply({ type: 'receipt', receipt: { decision: 'block' } });
  assert.equal((await first).receipt.decision, 'block');
  assert.equal(p1.closed, true);
  assert.equal(p1.listeners(), 0);
  p1.reply({ type: 'receipt', receipt: { decision: 'allow' } });
  p2.reply({ type: 'receipt', receipt: { decision: 'redact' } });
  assert.equal((await second).receipt.decision, 'redact');
  assert.equal(p2.listeners(), 0);
});

test('Firefox port.error survives disconnect and cleanup', async () => {
  const pending = nativeRequest({ type: 'status' }, 100, 'timeout');
  const port = ports.at(-1);
  port.error = { message: 'No such native application' };
  port.crash();
  await assert.rejects(pending, /No such native application/);
  assert.equal(port.listeners(), 0);
  assert.equal(port.closed, true);
});

test('health timeout closes the host and a later check recovers without reloading', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = checkHealth({ settings: { bridgeTimeoutMs: 20 } });
  const port = ports.at(-1);
  t.mock.timers.tick(21);
  assert.equal((await pending).status, 'disconnected');
  assert.equal(port.closed, true);
  assert.equal(port.listeners(), 0);
  const recovered = checkHealth();
  ports.at(-1).reply({ type: 'status', connected: true });
  assert.equal((await recovered).status, 'connected');
});

test('Chrome missing or policy-disabled host remains fail closed with setup advice', async () => {
  for (const message of [
    'Specified native messaging host not found.',
    'Access to the specified native messaging host is forbidden because of the system policy.'
  ]) {
    const pending = checkHealth();
    const port = ports.at(-1);
    chrome.runtime.lastError = { message };
    port.crash();
    chrome.runtime.lastError = null;
    assert.equal((await pending).status, 'no-bridge');
    assert.equal(port.listeners(), 0);
  }
});


test('a protocol mismatch is actionable without claiming a connection or screening', async () => {
  const pending = checkHealth();
  ports.at(-1).reply({ type: 'status', connected: false, screening: 'unavailable', code: 'bridge-protocol-mismatch' });
  const state = await pending;
  assert.equal(state.status, 'disconnected');
  assert.equal(state.error, 'bridge-protocol-mismatch');
  const { copyFor } = await import('../popup/copy.js');
  const copy = copyFor(state);
  assert.equal(copy.view, 'error');
  assert.match(copy.detail, /incompatible versions/);
  assert.match(copy.detail, /Update or repair/);
});
