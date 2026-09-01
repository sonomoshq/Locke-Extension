// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { surfaceOf, diffSets, report } from '../scripts/permission-diff.mjs';

const base = {
  permissions: ['storage', 'nativeMessaging'],
  host_permissions: ['http://127.0.0.1/*'],
  content_scripts: [{ matches: ['https://chatgpt.com/*'] }]
};

const clone = (o) => JSON.parse(JSON.stringify(o));

test('the declared surface is the three fields that govern reach', () => {
  const s = surfaceOf(base);
  assert.deepEqual(s.permissions, ['nativeMessaging', 'storage'], 'sorted, so order churn is not a diff');
  assert.deepEqual(s.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(s.content_script_matches, ['https://chatgpt.com/*']);
});

test('matches are flattened across content_scripts entries and de-duplicated', () => {
  // Which entry a host sits in does not change what can be read.
  const m = {
    content_scripts: [
      { matches: ['https://a.com/*', 'https://b.com/*'] },
      { matches: ['https://b.com/*', 'https://c.com/*'] }
    ]
  };
  assert.deepEqual(surfaceOf(m).content_script_matches, [
    'https://a.com/*',
    'https://b.com/*',
    'https://c.com/*'
  ]);
});

test('a manifest missing a field is empty, not a crash', () => {
  const s = surfaceOf({});
  assert.deepEqual(s.permissions, []);
  assert.deepEqual(s.host_permissions, []);
  assert.deepEqual(s.content_script_matches, []);
});

test('no change reports no change', () => {
  const r = report(JSON.stringify(base), JSON.stringify(clone(base)));
  assert.equal(r.changed, false);
  assert.equal(r.widened, false);
  assert.match(r.text, /No change/);
});

test('an added host is reported as a widening', () => {
  const after = clone(base);
  after.content_scripts[0].matches.push('https://evil.example/*');
  const r = report(JSON.stringify(base), JSON.stringify(after));
  assert.equal(r.changed, true);
  assert.equal(r.widened, true, 'adding a match widens reach');
  assert.match(r.text, /evil\.example/);
  assert.match(r.text, /widens/);
});

test('an added permission is reported as a widening', () => {
  const after = clone(base);
  after.permissions.push('tabs');
  const r = report(JSON.stringify(base), JSON.stringify(after));
  assert.equal(r.widened, true);
  assert.match(r.text, /tabs/);
});

test('a removal alone is not a widening', () => {
  const after = clone(base);
  after.permissions = ['storage'];
  const r = report(JSON.stringify(base), JSON.stringify(after));
  assert.equal(r.changed, true);
  assert.equal(r.widened, false);
  assert.match(r.text, /only narrows/);
});

test('reordering a list is not a change', () => {
  // Without sorting, a reordered array would raise a false alarm every time
  // the generator reshuffled its output, and reviewers would learn to ignore
  // this check — which is the failure mode that matters.
  const after = clone(base);
  after.permissions = ['storage', 'nativeMessaging'].reverse();
  assert.equal(report(JSON.stringify(base), JSON.stringify(after)).changed, false);
});

test('diffSets reports both directions', () => {
  const d = diffSets(['a', 'b'], ['b', 'c']);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.removed, ['a']);
});

test('the real manifest has a readable declared surface', () => {
  const s = surfaceOf(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(s.content_script_matches.length > 0, 'the shipped manifest declares matches');
  assert.ok(s.permissions.includes('nativeMessaging'), 'and still asks for native messaging');
});
