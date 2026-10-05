// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const CONSENT_KEY = 'dataSharingConsent';
const store = { local: {}, session: {} };
const events = new Map();
const event = name => ({ addListener(fn) {
  if (!events.has(name)) events.set(name, new Set());
  events.get(name).add(fn);
} });
const emit = async (name, ...args) => {
  for (const fn of events.get(name) || []) await fn(...args);
};
let storageError = false;
let permissionError = false;
let builtin = true;
let technical = false;
let hang = false;
let delayConnectedWrite = false;
let releaseConnectedWrite;
const broadcasts = [], badges = [];
const ports = [], sent = [], fetches = [], tabs = [];
const area = name => ({
  async get(key) {
    if (storageError && name === 'local') throw new Error('storage unavailable');
    return typeof key === 'string' ? { [key]: store[name][key] } : { ...store[name] };
  },
  async set(values) {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: store[name][key], newValue: value };
      store[name][key] = value;
    }
    if (name === 'session' && values.connectionState?.status === 'connected' && delayConnectedWrite) {
      delayConnectedWrite = false;
      await new Promise(resolve => { releaseConnectedWrite = resolve; });
    }
    await emit('storage', changes, name);
  },
  async remove(key) { delete store[name][key]; }
});
globalThis.browser = {
  runtime: {
    id: 'desktop-connector@sonomos.ai',
    getBrowserInfo: async () => ({ name: 'Firefox', version: '140.0' }),
    getManifest: () => ({ version: '2.0.2' }),
    getURL: path => `moz-extension://test-id/${path}`,
    onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
    sendMessage: async message => { broadcasts.push(message); },
    connectNative() {
      const messages = new Set(), disconnects = new Set();
      const port = {
        onMessage: { addListener: fn => messages.add(fn), removeListener: fn => messages.delete(fn) },
        onDisconnect: { addListener: fn => disconnects.add(fn), removeListener: fn => disconnects.delete(fn) },
        disconnect() { this.closed = true; },
        reply(value) { for (const fn of messages) fn(value); },
        postMessage(payload) {
          sent.push(payload);
          if (!hang) this.reply(payload.type === 'capture'
            ? { type: 'receipt', receipt: { decision: 'allow' } }
            : { type: 'status', connected: true });
        }
      };
      ports.push(port);
      return port;
    }
  },
  permissions: {
    async getAll() {
      if (permissionError) throw new Error('permission unavailable');
      return builtin ? { data_collection: technical ? ['technicalAndInteraction'] : [] } : {};
    },
    onAdded: event('permissions-added'), onRemoved: event('permissions-removed')
  },
  tabs: { async create(options) { tabs.push(options); } },
  storage: { local: area('local'), session: area('session'), managed: { get: async () => ({}) }, onChanged: event('storage') },
  alarms: { create: async () => {}, get: async () => ({}), onAlarm: event('alarm') },
  action: { setBadgeText: async value => { badges.push(value.text); }, setBadgeBackgroundColor: async () => {} }
};
globalThis.fetch = async (...args) => { fetches.push(args); return { json: async () => ({}) }; };
const { nativeRequest } = await import('../shared/native-client.js');
await import('../background/service-worker.js');
const trusted = { id: browser.runtime.id, tab: { id: 4 } };
const deliver = message => new Promise(resolve => {
  for (const fn of events.get('message')) fn(message, trusted, resolve);
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const grant = (allowTechnical = false) => browser.storage.local.set({ [CONSENT_KEY]: {
  version: 1, granted: true, technical: allowTechnical
} });
const deny = () => browser.storage.local.set({ [CONSENT_KEY]: {
  version: 1, granted: false, technical: false
} });

beforeEach(async () => {
  await flush();
  store.local = {}; store.session = {};
  ports.length = 0; sent.length = 0; fetches.length = 0; tabs.length = 0;
  storageError = false; permissionError = false; builtin = true; technical = false; hang = false;
  delayConnectedWrite = false; releaseConnectedWrite = null; broadcasts.length = 0; badges.length = 0;
});

test('Firefox native boundary refuses all transfers before explicit consent', async () => {
  await assert.rejects(nativeRequest({ type: 'capture', requestB64: 'sensitive' }, 100, 'timeout'), /data-consent-required/);
  assert.equal(ports.length, 0);
});

test('fresh install and upgrade show a focused single-page disclosure without egress', async () => {
  for (const reason of ['install', 'update']) {
    await emit('installed', { reason });
    await flush();
    assert.equal(tabs.at(-1)?.url, 'moz-extension://test-id/popup/consent.html');
    assert.equal(tabs.at(-1)?.active, true);
  }
  assert.equal(sent.length, 0);
  assert.equal(fetches.length, 0);
});

test('refusal, alarms and restarts stay blocked without reopening a declined disclosure', async () => {
  await deny();
  await emit('startup');
  await emit('alarm', { name: 'sonomos-presence' });
  await emit('alarm', { name: 'sonomos-desktop-heartbeat' });
  await emit('installed', { reason: 'update' });
  const result = await deliver({ type: 'capture', requestB64: 'sensitive' });
  const status = await deliver({ type: 'requestCheck' });
  await flush();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'data-consent-required');
  assert.equal(status.state.error, 'data-consent-required');
  assert.equal(status.state.screening, 'unavailable');
  assert.equal(sent.length, 0);
  assert.equal(fetches.length, 0);
  assert.equal(tabs.length, 0);
});

test('screening consent alone allows capture and a content-free health probe, not technical metadata', async () => {
  store.local.disabledWebHosts = { hosts: ['chatgpt.com'], ignoredCount: 0 };
  await grant();
  const result = await deliver({ type: 'capture', requestB64: 'sensitive', provider: 'openai' });
  assert.equal(result.receipt.decision, 'allow');
  await deliver({ type: 'requestCheck' });
  await flush();
  assert.deepEqual(sent.find(x => x.type === 'capture'), { type: 'capture', requestB64: 'sensitive', provider: 'openai' });
  assert.deepEqual(sent.find(x => x.type === 'status'), { type: 'status' });
  assert.equal(fetches.length, 0);
});

test('optional metadata requires both local choice and Firefox permission; browser revocation wins', async () => {
  await grant(true);
  await emit('alarm', { name: 'sonomos-presence' });
  await flush();
  assert.equal(fetches.length, 0);
  technical = true;
  await emit('permissions-added', { data_collection: ['technicalAndInteraction'] });
  await emit('alarm', { name: 'sonomos-presence' });
  await flush();
  assert.equal(fetches.length, 1);
  technical = false;
  await emit('permissions-removed', { data_collection: ['technicalAndInteraction'] });
  await emit('alarm', { name: 'sonomos-presence' });
  await flush();
  assert.equal(fetches.length, 1);
  assert.equal((await deliver({ type: 'capture', requestB64: 'sensitive' })).ok, true);
});

test('older Firefox uses explicit local choices; no browser permission API expansion needed', async () => {
  builtin = false;
  await grant(true);
  await emit('alarm', { name: 'sonomos-presence' });
  await flush();
  assert.equal(fetches.length, 1);
  await grant(false);
  await emit('alarm', { name: 'sonomos-presence' });
  await flush();
  assert.equal(fetches.length, 1);
  assert.equal((await deliver({ type: 'capture', requestB64: 'sensitive' })).ok, true);
});

test('revocation cancels an outstanding native request and blocks later requests', async () => {
  await grant();
  hang = true;
  const pending = deliver({ type: 'capture', requestB64: 'sensitive' });
  await flush();
  const port = ports.at(-1);
  assert.ok(port);
  await deny();
  assert.equal((await pending).code, 'data-consent-required');
  assert.equal(port.closed, true);
  port.reply({ type: 'receipt', receipt: { decision: 'allow' } });
  const count = sent.length;
  assert.equal((await deliver({ type: 'capture', requestB64: 'later' })).ok, false);
  assert.equal(sent.length, count);
});

test('consent persists across worker reload; an unknown consent version fails closed', async () => {
  await grant();
  const originalEvents = new Map([...events].map(([name, handlers]) => [name, new Set(handlers)]));
  events.set('message', new Set()); // an evicted worker's listener no longer exists
  await import('../background/service-worker.js?restart-consent');
  assert.equal((await deliver({ type: 'capture', requestB64: 'sensitive' })).ok, true);
  store.local[CONSENT_KEY].version = 0;
  assert.equal((await deliver({ type: 'capture', requestB64: 'later' })).code, 'data-consent-required');
  events.clear();
  for (const [name, handlers] of originalEvents) events.set(name, handlers);
});

test('unreadable consent or permissions never enables transmission', async () => {
  await grant(true);
  for (const source of ['storage', 'permissions']) {
    storageError = source === 'storage'; permissionError = source === 'permissions';
    assert.equal((await deliver({ type: 'capture', requestB64: 'sensitive' })).code, 'data-consent-required');
  }
  assert.equal(sent.length, 0);
  assert.equal(fetches.length, 0);
});

test('manifest declares native request data and optional technical information without more host/API access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const gecko = manifest.browser_specific_settings.gecko;
  assert.deepEqual(gecko.data_collection_permissions.required, [
    'personallyIdentifyingInfo', 'healthInfo', 'financialAndPaymentInfo', 'authenticationInfo',
    'personalCommunications', 'locationInfo', 'browsingActivity', 'websiteContent', 'searchTerms'
  ]);
  assert.deepEqual(gecko.data_collection_permissions.optional, ['technicalAndInteraction']);
  assert.equal(gecko.strict_min_version, '128.0');
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'nativeMessaging']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
});

test('Edge also requires explicit consent while Chrome retains its existing behavior', async () => {
  const getBrowserInfo = browser.runtime.getBrowserInfo;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  delete browser.runtime.getBrowserInfo;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0' } });
  try {
    await assert.rejects(nativeRequest({ type: 'capture', requestB64: 'sensitive' }, 100, 'timeout'), /data-consent-required/);
    assert.equal(sent.length, 0);
    await grant();
    assert.equal((await nativeRequest({ type: 'capture', requestB64: 'sensitive' }, 100, 'timeout')).type, 'receipt');
    await emit('alarm', { name: 'sonomos-presence' });
    await flush();
    assert.equal(fetches.length, 0);
    await deny();
    assert.equal((await deliver({ type: 'capture', requestB64: 'sensitive' })).code, 'data-consent-required');
    navigator.userAgent = 'Mozilla/5.0 Chrome/130.0 Safari/537.36';
    assert.equal((await nativeRequest({ type: 'capture', requestB64: 'sensitive' }, 100, 'timeout')).type, 'receipt');
  } finally {
    browser.runtime.getBrowserInfo = getBrowserInfo;
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }
});


test('revocation during an awaited state write cannot return or broadcast stale Active', async () => {
  await grant();
  store.session.screeningState = { state: 'available', at: Date.now() };
  delayConnectedWrite = true;
  const pending = deliver({ type: 'requestCheck' });
  await flush();
  assert.ok(releaseConnectedWrite);
  await deny();
  await flush();
  releaseConnectedWrite();
  const result = await pending;
  await flush();
  assert.equal(result.state.error, 'data-consent-required');
  assert.equal(result.state.screening, 'unavailable');
  assert.equal(broadcasts.at(-1).state.error, 'data-consent-required');
  assert.equal(badges.at(-1), '!');
});
