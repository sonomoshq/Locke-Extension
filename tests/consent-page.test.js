// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';

test('consent UI is a shipped, single-page disclosure with a separate optional choice and uninstall path', () => {
  const path = new URL('../popup/consent.html', import.meta.url);
  assert.ok(existsSync(path), 'the consent page must exist');
  const html = readFileSync(path, 'utf8');
  for (const word of ['prompt', 'upload', 'header', 'authentication', 'health', 'financial', 'location', 'search', 'native messaging']) {
    assert.ok(html.toLowerCase().includes(word), word);
  }
  for (const id of ['allowConsent', 'pauseConsent', 'declineConsent', 'technicalConsent', 'consentStatus']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /Decline and uninstall/);
  assert.match(html, /type="checkbox"(?![^>]*checked)/);
  assert.match(html, /https:\/\/sonomos.ai\/locke\/privacy/);
});

const elements = new Map();
const handlers = new Map();
const listeners = [];
let stored = {}, builtin = true, technicalGranted = false, requestAllowed = false;
let getFails = false, setFails = false, uninstallFails = false;
const requests = [], removals = [], uninstalls = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, { disabled: true, checked: false, hidden: false, textContent: '',
    addEventListener(kind, fn) { handlers.set(`${id}:${kind}`, fn); }
  });
  return elements.get(id);
}
globalThis.document = { getElementById: element };
globalThis.browser = {
  runtime: { getBrowserInfo: async () => ({}), sendMessage: async () => {} },
  storage: {
    local: {
      async get() { if (getFails) throw new Error('failed read'); return stored; },
      async set(value) {
        if (setFails) throw new Error('failed write');
        stored = { ...stored, ...value };
        for (const fn of listeners) fn({ dataSharingConsent: { newValue: value.dataSharingConsent } }, 'local');
      }
    },
    onChanged: { addListener: fn => listeners.push(fn) }
  },
  permissions: {
    async getAll() { return builtin ? { data_collection: technicalGranted ? ['technicalAndInteraction'] : [] } : {}; },
    request(value) { requests.push(value); technicalGranted = requestAllowed; return Promise.resolve(requestAllowed); },
    async remove(value) { removals.push(value); technicalGranted = false; return true; }
  },
  management: { async uninstallSelf(value) { uninstalls.push(value); if (uninstallFails) throw new Error('cancelled'); } }
};
const flush = () => new Promise(resolve => setImmediate(resolve));
let instance = 0;
async function load() {
  elements.clear(); handlers.clear();
  await import(`../popup/consent.js?case=${++instance}`);
  await flush();
}

test('consent controls stay off by default; a click enables only the chosen transmission', async () => {
  await load();
  assert.equal(element('technicalConsent').checked, false);
  assert.equal(stored.dataSharingConsent, undefined);
  await handlers.get('allowConsent:click')();
  assert.deepEqual(stored.dataSharingConsent, { version: 1, granted: true, technical: false });
  assert.equal(requests.length, 0);
  assert.match(element('consentStatus').textContent, /enabled/);
});

test('Firefox optional prompt is invoked synchronously in the user gesture; denial preserves screening only', async () => {
  await load();
  element('technicalConsent').checked = true;
  const pending = handlers.get('allowConsent:click')();
  assert.equal(requests.length, 1, 'request permission before awaiting any other API');
  assert.deepEqual(requests.at(-1), { data_collection: ['technicalAndInteraction'] });
  await pending;
  assert.equal(stored.dataSharingConsent.granted, true);
  assert.equal(stored.dataSharingConsent.technical, false);
  assert.equal(element('technicalConsent').checked, false);
});

test('old Firefox saves optional choice without requesting unsupported data permissions', async () => {
  builtin = false;
  await load();
  element('technicalConsent').checked = true;
  const count = requests.length;
  await handlers.get('allowConsent:click')();
  assert.equal(requests.length, count);
  assert.equal(stored.dataSharingConsent.technical, true);
  builtin = true;
});

test('pause revokes persisted consent and optional permission, then reports held requests and exit', async () => {
  await load();
  await handlers.get('pauseConsent:click')();
  assert.deepEqual(stored.dataSharingConsent, { version: 1, granted: false, technical: false });
  assert.ok(removals.length);
  assert.match(element('consentStatus').textContent, /paused/i);
  assert.match(element('consentStatus').textContent, /held back/);
});

test('decline revokes before uninstall; cancellation leaves sharing off and an actionable message', async () => {
  uninstallFails = true;
  await load();
  await handlers.get('declineConsent:click')();
  assert.equal(stored.dataSharingConsent.granted, false);
  assert.deepEqual(uninstalls.at(-1), { showConfirmDialog: true });
  assert.match(element('consentStatus').textContent, /uninstall.*cancelled|could not.*uninstall/i);
  assert.match(element('consentStatus').textContent, /extension settings/);
});

test('failed storage write cannot report a successful grant', async () => {
  await load();
  setFails = true;
  await handlers.get('allowConsent:click')();
  assert.match(element('consentStatus').textContent, /could not save/i);
  assert.equal(stored.dataSharingConsent.granted, false);
  setFails = false;
});
