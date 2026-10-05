// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const elements = new Map(), handlers = new Map();
const storageListeners = [], permissionListeners = [], pendingReads = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    disabled: true, checked: false, textContent: '',
    addEventListener(kind, fn) { handlers.set(`${id}:${kind}`, fn); }
  });
  return elements.get(id);
}
globalThis.document = { getElementById: element };
let record = { version: 1, granted: true, technical: false };
let permissionGranted = false, holdReads = false, failRead = false, failAfterSet = false;
function emitChange() {
  for (const listener of storageListeners) listener({ dataSharingConsent: { newValue: record } }, 'local');
}
globalThis.browser = {
  runtime: { getBrowserInfo: async () => ({}) },
  storage: {
    local: {
      async get() {
        if (failRead) throw new Error('storage unavailable');
        return { dataSharingConsent: { ...record } };
      },
      async set(value) {
        record = { ...value.dataSharingConsent };
        emitChange();
        if (failAfterSet) failRead = true;
      }
    },
    onChanged: { addListener: fn => storageListeners.push(fn) }
  },
  permissions: {
    getAll() {
      const result = { data_collection: permissionGranted ? ['technicalAndInteraction'] : [] };
      return holdReads ? new Promise(resolve => pendingReads.push(() => resolve(result))) : Promise.resolve(result);
    },
    request() { permissionGranted = true; return Promise.resolve(true); },
    async remove() {
      permissionGranted = false;
      for (const listener of permissionListeners) listener({ data_collection: ['technicalAndInteraction'] });
      return true;
    },
    onRemoved: { addListener: fn => permissionListeners.push(fn) }
  }
};
const flush = () => new Promise(resolve => setImmediate(resolve));
await import('../popup/consent.js');
await flush();

test('a pre-action refresh cannot repaint or restart over an in-progress Allow choice', async () => {
  holdReads = true;
  emitChange();
  await flush();
  assert.equal(pendingReads.length, 1);
  element('technicalConsent').checked = true;
  const save = handlers.get('allowConsent:click')();
  await flush();
  assert.equal(pendingReads.length, 2);
  pendingReads.shift()(); // obsolete pre-action read
  await flush();
  assert.equal(element('technicalConsent').checked, true);
  assert.equal(pendingReads.length, 1, 'discard the obsolete read rather than competing with save verification');
  pendingReads.shift()();
  await save;
  assert.equal(element('technicalConsent').checked, true);
  assert.match(element('consentStatus').textContent, /^Local screening is enabled/);
});

test('an older refusal refresh cannot overwrite a newer granted choice', async () => {
  record = { version: 1, granted: false, technical: false };
  emitChange();
  await flush();
  record = { version: 1, granted: true, technical: true };
  emitChange();
  await flush();
  assert.equal(pendingReads.length, 2);
  const older = pendingReads.shift(), newer = pendingReads.shift();
  newer();
  await flush();
  assert.equal(element('technicalConsent').checked, true);
  assert.match(element('consentStatus').textContent, /^Local screening is enabled/);
  older();
  await flush();
  assert.equal(pendingReads.length, 0, 'superseded refresh must not initiate another read');
  assert.equal(element('technicalConsent').checked, true);
  assert.match(element('consentStatus').textContent, /^Local screening is enabled/);
  holdReads = false;
});

test('a genuine post-save read failure shows a warning and disables Allow', async () => {
  failAfterSet = true;
  await handlers.get('allowConsent:click')();
  assert.equal(record.granted, true, 'the write did commit, but the UI cannot verify its effective state');
  assert.match(element('consentStatus').textContent, /could not save/);
  assert.equal(element('allowConsent').disabled, true);
  assert.equal(pendingReads.length, 0);
});
