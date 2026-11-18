// Copyright © 2026 Sonomos, Inc.
// All rights reserved.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// background/navigation-screen.js resolves `ext` from globalThis.chrome at
// import time, so the stub must exist first.
const sessionRules = new Map();
const dynamicRules = new Map();
globalThis.chrome = {
  runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}` },
  declarativeNetRequest: {
    getDynamicRules: async () => [...dynamicRules.values()],
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
      for (const id of removeRuleIds) dynamicRules.delete(id);
      for (const r of addRules) dynamicRules.set(r.id, r);
    },
    getSessionRules: async () => [...sessionRules.values()],
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      for (const id of removeRuleIds) sessionRules.delete(id);
      for (const r of addRules) sessionRules.set(r.id, r);
    }
  }
};

const nav = await import('../background/navigation-screen.js');
const { NAVIGATION_SCREEN_HOSTS } = await import('../scripts/store-build.mjs');
const { readFileSync } = await import('node:fs');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));

const AI = 'https://www.google.com/search?q=my+name+is+Jack&sca_esv=1&udm=50&source=hp';
const SEARCH = 'https://www.google.com/search?q=my+name+is+Jack&sca_esv=1';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const receipt = (r) => async () => ({ ok: true, receipt: r });

test('the catalog yields exactly the Google AI Mode navigation', () => {
  assert.deepEqual(nav.navigationPrompts(), [{ host: 'www.google.com', path: '/search', pairs: ['udm=50'] }]);
});

test('udm=50 is AI Mode; plain search, images and lookalikes are not', () => {
  assert.equal(nav.matchesNavigationPrompt(AI), true);
  assert.equal(nav.matchesNavigationPrompt('https://www.google.com/search?udm=50&q=x'), true);
  for (const url of [
    SEARCH,
    'https://www.google.com/search?q=x&udm=2',
    'https://www.google.com/search?q=x&udm=500',
    'https://www.google.com/search?q=udm%3D50',
    'https://www.google.com/searchx?q=x&udm=50',
    'https://www.google.co.uk/search?q=x&udm=50',
    'http://www.google.com/search?q=x&udm=50',
    'not a url'
  ]) {
    assert.equal(nav.matchesNavigationPrompt(url), false, url);
  }
});

test('the redirect rule regex matches AI Mode and not plain search', () => {
  const [rule] = nav.redirectRules('chrome-extension://test/screen/navigation.html');
  assert.equal(rule.action.type, 'redirect');
  assert.equal(rule.action.redirect.regexSubstitution, 'chrome-extension://test/screen/navigation.html#\\0');
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
  const re = new RegExp(rule.condition.regexFilter, 'i');
  assert.match(AI, re);
  assert.match('https://www.google.com/search?udm=50', re);
  assert.doesNotMatch(SEARCH, re);
  assert.doesNotMatch('https://www.google.com/search?q=x&udm=500', re);
  assert.doesNotMatch('https://www.google.com/search?q=x&xudm=50', re);
});

test('install replaces its redirect rules and clears stale one-shot allows', async () => {
  sessionRules.set(9205, { id: 9205 });
  sessionRules.set(1, { id: 1 });
  assert.equal(await nav.installNavigationRules(), true);
  assert.equal(await nav.installNavigationRules(), true);
  assert.deepEqual([...dynamicRules.keys()], [9100]);
  assert.deepEqual([...sessionRules.keys()], [1], 'only our stale allow is removed');
  sessionRules.clear();
});

test('a clean allow continues to the original URL through a one-shot allow', async () => {
  let sent = null;
  const r = await nav.screenNavigation(AI, 7, async (req, provider, coverage) => {
    sent = { req: Buffer.from(req, 'base64').toString('utf8'), coverage };
    return { ok: true, receipt: { decision: 'allow' } };
  });
  assert.equal(r.go, AI);
  assert.equal(sent.coverage, 'capture_path');
  assert.match(sent.req, /^GET \/search\?q=my\+name\+is\+Jack&sca_esv=1&udm=50&source=hp HTTP\/1\.1\r\nHost: www\.google\.com\r\n/);
  const [allow] = [...sessionRules.values()];
  assert.equal(allow.action.type, 'allow');
  assert.equal(allow.priority, 2);
  assert.deepEqual(allow.condition.tabIds, [7]);
  assert.match(AI, new RegExp(allow.condition.regexFilter));
  sessionRules.clear();
});

test('a redaction continues to the rebuilt URL', async () => {
  const rebuilt = 'GET /search?q=my+name+is+PER_abcd&sca_esv=1&udm=50&source=hp HTTP/1.1\r\nHost: www.google.com\r\n\r\n';
  const r = await nav.screenNavigation(AI, 3, receipt({ decision: 'redact', requestB64: b64(rebuilt), redactedCount: 1 }));
  assert.equal(r.go, 'https://www.google.com/search?q=my+name+is+PER_abcd&sca_esv=1&udm=50&source=hp');
  assert.equal(r.decision, 'redact');
  sessionRules.clear();
});

test('a redaction that moves the endpoint, or is missing, blocks', async () => {
  const elsewhere = 'GET /other?q=x HTTP/1.1\r\nHost: www.google.com\r\n\r\n';
  assert.deepEqual(await nav.screenNavigation(AI, 3, receipt({ decision: 'redact', requestB64: b64(elsewhere) })), { block: 'redact-malformed' });
  assert.deepEqual(await nav.screenNavigation(AI, 3, receipt({ decision: 'redact' })), { block: 'redact-malformed' });
});

test('a policy block blocks; an outage block and our own failures continue', async () => {
  assert.deepEqual(await nav.screenNavigation(AI, 3, receipt({ decision: 'block', blockCause: 'policy' })), { block: 'decision-block' });
  for (const capture of [
    receipt({ decision: 'block', blockCause: 'infrastructure' }),
    receipt({ decision: 'block', reason: 'guard unreachable' }),
    async () => ({ ok: false, code: 'no-bridge' }),
    async () => { throw new Error('boom'); }
  ]) {
    const r = await nav.screenNavigation(AI, 3, capture);
    assert.equal(r.go, AI);
  }
  sessionRules.clear();
});

test('a URL that is not a catalog navigation is let through untouched', async () => {
  let called = false;
  const r = await nav.screenNavigation(SEARCH, 3, async () => { called = true; });
  assert.equal(r.go, SEARCH);
  assert.equal(called, false);
  sessionRules.clear();
});

test('the manifest grants exactly the hosts the catalog navigations need', () => {
  const needed = [...new Set(nav.navigationPrompts().map((p) => `https://${p.host}/*`))].sort();
  assert.deepEqual([...NAVIGATION_SCREEN_HOSTS].sort(), needed);
  const nonLoopback = manifest.host_permissions.filter((h) => !h.startsWith('http://127.0.0.1/'));
  assert.deepEqual(nonLoopback.sort(), needed);
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  const war = manifest.web_accessible_resources.find((w) => w.resources.includes('screen/navigation.html'));
  assert.deepEqual(war.matches.sort(), needed);
});
