// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { copyFor } from '../popup/copy.js';

// A fresh store install with no desktop app behind it. The popup must say the
// app is missing, offer the link, and not tell the person to open an app they
// do not have.
test('popup: a never-paired browser is "Not connected", says nothing is screened, and links to the app', () => {
  const copy = copyFor({ status: 'no-bridge', notSetUp: true, screening: 'unavailable' });
  assert.equal(copy.view, 'setup');
  assert.equal(copy.badge, 'Not connected');
  assert.equal(copy.screeningLabel, 'Off');
  assert.equal(copy.getApp, true);
  assert.match(copy.detail, /needs the free Locke desktop app/);
  assert.match(copy.detail, /nothing in this browser is being screened/);
  assert.match(copy.detail, /AI sites included/);
  // Nothing is held in this state, so the copy must not claim anything is.
  assert.doesNotMatch(copy.detail, /held back/);
  assert.doesNotMatch(copy.detail, /click Allow/);
});

test('popup: Firefox/Edge before consent, never paired, leads with the missing app — not "held back"', () => {
  const copy = copyFor({ error: 'data-consent-required', notSetUp: true, screening: 'unavailable' });
  assert.equal(copy.badge, 'Not connected');
  assert.equal(copy.getApp, true);
  assert.match(copy.detail, /install the free Locke desktop app/);
  assert.match(copy.detail, /Data sharing/);
  assert.doesNotMatch(copy.detail, /held back/);
});

test('popup: consent needed on a browser that HAS reached Locke keeps the held-back warning', () => {
  const copy = copyFor({ error: 'data-consent-required', notSetUp: false, screening: 'unavailable' });
  assert.equal(copy.badge, 'Consent needed');
  assert.notEqual(copy.getApp, true);
  assert.match(copy.detail, /held back/);
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
