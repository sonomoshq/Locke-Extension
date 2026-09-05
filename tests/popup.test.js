// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { dataset: {}, textContent: '', hidden: false });
    return elements.get(id);
  },
  addEventListener() {}
};
let answer;
let storageChanged;
globalThis.chrome = {
  runtime: { sendMessage: () => answer(), onMessage: { addListener() {} } },
  storage: {
    session: { get: async () => ({ connectionState: { status: 'connected', screening: 'available' } }) },
    onChanged: { addListener(fn) { storageChanged = fn; } }
  }
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('popup starts with a fresh check, never cached Active while worker is silent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  answer = () => new Promise(() => {});
  await import('../popup/popup.js?pending');
  await flush();
  assert.equal(elements.get('statusBadge').textContent, 'Checking…');
  assert.equal(elements.get('screeningValue').textContent, 'Not yet confirmed');
  t.mock.timers.tick(10_001);
  await flush();
  assert.equal(elements.get('statusBadge').textContent, 'Error');
});

test('popup makes an unavailable worker actionable instead of retaining Active', async () => {
  answer = () => Promise.reject(new Error('extension context invalidated'));
  await import('../popup/popup.js?restart');
  await flush();
  assert.equal(elements.get('statusBadge').textContent, 'Error');
  assert.match(elements.get('statusDetail').textContent, /reopen|reload/i);
  assert.equal(elements.get('screeningValue').textContent, 'Not yet confirmed');
});


test('screening changes during a pending check trigger a fresh follow-up, never stale Active', async () => {
  const responses = [];
  answer = () => new Promise(resolve => responses.push(resolve));
  await import('../popup/popup.js?evidence-race');
  await flush();
  assert.equal(responses.length, 1);
  storageChanged({ screeningState: { newValue: { state: 'unconfirmed', at: Date.now() } } }, 'session');
  responses[0]({ state: { status: 'connected', screening: 'available' } });
  await flush();
  assert.equal(responses.length, 2, 'failure evidence needs a probe after the older one settles');
  assert.notEqual(elements.get('screeningValue').textContent, 'Active');
  responses[1]({ state: { status: 'connected', screening: 'unconfirmed', lastCaptureFailure: { code: 'native-timeout', at: Date.now() } } });
  await flush();
  assert.equal(elements.get('screeningValue').textContent, 'Not yet confirmed');
});
