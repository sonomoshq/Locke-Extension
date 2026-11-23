// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { copyFor } from '../popup/copy.js';

// A fresh store install with no desktop app behind it. The popup must say the
// app is missing, offer the link, and not tell the person to open an app they
// do not have.
test('popup: a never-paired browser is "Not set up" with a link to the app', () => {
  const copy = copyFor({ status: 'no-bridge', notSetUp: true, screening: 'unavailable' });
  assert.equal(copy.view, 'setup');
  assert.equal(copy.badge, 'Not set up');
  assert.equal(copy.getApp, true);
  assert.match(copy.detail, /needs the free Locke desktop app/);
  assert.match(copy.detail, /other websites work normally/);
  assert.doesNotMatch(copy.detail, /click Allow/);
});

test('popup: a paired browser whose connector did not start keeps the repair advice and no link', () => {
  const copy = copyFor({ status: 'no-bridge', notSetUp: false, screening: 'unavailable' });
  assert.equal(copy.badge, 'Setup');
  assert.notEqual(copy.getApp, true);
  assert.match(copy.detail, /click Allow/);
});

test('popup and consent page link to the fixed downloads page', () => {
  const popup = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const consent = readFileSync(new URL('../popup/consent.html', import.meta.url), 'utf8');
  assert.match(popup, /id="getAppLink"[^>]*href="https:\/\/sonomos\.ai\/downloads\/"[^>]*hidden/);
  assert.match(consent, /href="https:\/\/sonomos\.ai\/downloads\/"/);
});
