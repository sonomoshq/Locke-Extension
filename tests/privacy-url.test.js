// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { PRIVACY_URL } from '../scripts/store-build.mjs';
import { escapeRegExp } from '../scripts/lib/version.mjs';

// Two small things that were only correct by accident, now pinned.
//
// The privacy-link check used `text.includes(PRIVACY_URL)`, which is satisfied
// by any string merely CONTAINING the URL. It is a presence check rather than
// an authorisation boundary, so it was never a hole — but "this page links our
// privacy policy" should mean that, and CodeQL flagged it as incomplete URL
// substring sanitisation.
//
// The regex is rebuilt here from the same parts store-build.mjs uses, so this
// tests the property rather than re-importing a private constant.
const PRIVACY_URL_RE = new RegExp(
  escapeRegExp(PRIVACY_URL) + `(?=["'\\s<>#?]|/(?![\\w-])|$)`
);

test('a real privacy link is recognised', () => {
  assert.ok(PRIVACY_URL_RE.test(`<a href="${PRIVACY_URL}">Privacy</a>`));
  assert.ok(PRIVACY_URL_RE.test(PRIVACY_URL), 'bare URL at end of input');
  assert.ok(PRIVACY_URL_RE.test(`${PRIVACY_URL}/`), 'a trailing slash is the same page');
  assert.ok(PRIVACY_URL_RE.test(`${PRIVACY_URL}?utm=x`), 'a query string is the same page');
  assert.ok(PRIVACY_URL_RE.test(`${PRIVACY_URL}#section`), 'a fragment is the same page');
});

test('a lookalike host does NOT satisfy the check', () => {
  // The failure the old `includes()` allowed: a shipped page could link
  // somewhere else entirely and still count as linking the privacy policy.
  assert.equal(PRIVACY_URL_RE.test(`${PRIVACY_URL}.evil.example/steal`), false);
  assert.equal(PRIVACY_URL_RE.test(`${PRIVACY_URL}-not-really`), false);
  assert.equal(PRIVACY_URL_RE.test(`${PRIVACY_URL}extra`), false);
});

test('escapeRegExp covers every metacharacter, not just the dot', () => {
  assert.equal(escapeRegExp('2.0.0'), '2\\.0\\.0');
  for (const ch of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
    assert.equal(escapeRegExp(ch), '\\' + ch, `${ch} must be escaped`);
  }
});

test('an escaped version is inert when interpolated into a RegExp', () => {
  // The shape of the original bug: only `.` was escaped, so any other
  // metacharacter reaching a `new RegExp(...)` would have been live.
  const hostile = '1.0.0|.*';
  const re = new RegExp(`^${escapeRegExp(hostile)}$`);
  assert.ok(re.test(hostile), 'matches itself literally');
  assert.equal(re.test('1x0x0anything'), false, 'and nothing else');
});

test('the shipped popup really does link the privacy policy', () => {
  // Guards the guard: if this stops being true, the check above is testing
  // a condition that no longer occurs in the product.
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  assert.ok(PRIVACY_URL_RE.test(html), 'popup.html must link the extension privacy policy');
});
