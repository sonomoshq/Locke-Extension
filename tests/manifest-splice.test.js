// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deletePath, removeTopLevelKey, spliceValue, valueSpan, writeIfChanged } from '../scripts/lib/manifest-splice.mjs';

// The property that matters: `npm run generate` must not touch a byte it does
// not own. It used to reserialise the whole manifest, which reformatted
// hand-written inline arrays elsewhere in the file — diff noise a reviewer had
// to read past to find out whether anything real had changed.

const MANIFEST = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');

test('splicing an unchanged value back is byte-for-byte identical', () => {
  // Run against the REAL manifest, because the thing under test is agreement
  // with this file's actual formatting, not with a fixture's.
  const value = JSON.parse(MANIFEST).content_scripts;
  assert.equal(spliceValue(MANIFEST, 'content_scripts', value), MANIFEST);
});

// The test above is only as good as the bytes it reads, and those bytes depend
// on how git checked the file out. `spliceValue` re-serialises with LF, so it
// round-trips an LF manifest and NOT a uniformly-CRLF one — which is what a
// Windows clone produces under the default core.autocrlf=true.
//
// That went unnoticed because a Windows working tree tends to hold a MIXED
// manifest: CRLF for the hand-written body, LF for the content_scripts block
// `npm run generate` last wrote. spliceValue preserves whatever it finds, so
// the mixed case passes and hides the uniform-CRLF case that fails.
//
// `.gitattributes` pins this file to LF so every checkout is identical. This
// asserts that, because deleting .gitattributes would otherwise turn the test
// above green-on-this-machine and red for the next contributor to clone on
// Windows — the exact failure it was written to catch.
test('the manifest is checked out with LF endings on every platform', () => {
  assert.equal(
    MANIFEST.includes('\r\n'),
    false,
    'manifest.json contains CRLF. spliceValue emits LF, so the byte-for-byte ' +
      'test above cannot hold. Check that .gitattributes still pins *.json to eol=lf.'
  );
});

test('a changed value leaves every byte outside its span alone', () => {
  const value = JSON.parse(MANIFEST).content_scripts;
  value[0].matches = ['https://example.com/*'];
  const next = spliceValue(MANIFEST, 'content_scripts', value);

  const [start, end] = valueSpan(MANIFEST, 'content_scripts');
  const [nextStart, nextEnd] = valueSpan(next, 'content_scripts');
  assert.equal(next.slice(0, nextStart), MANIFEST.slice(0, start));
  assert.equal(next.slice(nextEnd), MANIFEST.slice(end));
});

test('the inline arrays the generator used to expand are preserved', () => {
  // The regression by name: `data_collection_permissions.required` is written
  // inline by hand and JSON.stringify expands it over three lines.
  assert.match(MANIFEST, /"required": \["none"\]/, 'the manifest still has an inline array to protect');
  const value = JSON.parse(MANIFEST).content_scripts;
  value[0].matches = ['https://example.com/*'];
  assert.match(spliceValue(MANIFEST, 'content_scripts', value), /"required": \["none"\]/);
});

test('valueSpan bracket-matches rather than scanning for the first close', () => {
  const text = '{\n  "a": [\n    { "b": [1, 2] },\n    { "c": {} }\n  ],\n  "d": 1\n}\n';
  const [start, end] = valueSpan(text, 'a');
  assert.equal(text.slice(start, end), '[\n    { "b": [1, 2] },\n    { "c": {} }\n  ]');
});

test('a bracket inside a string literal is not structure', () => {
  const text = '{\n  "a": [\n    "https://ex.com/]/*",\n    "x"\n  ],\n  "b": 1\n}\n';
  const [start, end] = valueSpan(text, 'a');
  assert.equal(JSON.parse(text.slice(start, end)).length, 2, 'the `]` in the pattern must not end the array');
});

test('an escaped quote does not end a string literal', () => {
  const text = '{\n  "a": [\n    "quote\\" and ] brace",\n    "x"\n  ],\n  "b": 1\n}\n';
  const [start, end] = valueSpan(text, 'a');
  assert.equal(JSON.parse(text.slice(start, end)).length, 2);
});

test('a missing key is an error, never a silent partial write', () => {
  assert.throws(() => valueSpan(MANIFEST, 'no_such_key'), /no top-level "no_such_key" key/);
});

test('scalar values are located too, not just containers', () => {
  const [start, end] = valueSpan(MANIFEST, 'manifest_version');
  assert.equal(MANIFEST.slice(start, end), '3');
  const [vs, ve] = valueSpan(MANIFEST, 'version');
  assert.equal(JSON.parse(MANIFEST.slice(vs, ve)), JSON.parse(MANIFEST).version);
});

// The bug this caught in review: "storage" is BOTH a top-level manifest key
// and a string inside the permissions array. An indexOf-based lookup finds the
// permission, and deleting from there cuts the wrong lines and corrupts the
// file — it produced an unparseable manifest before the lookup became
// depth-aware.
test('a key name that also appears as an array element resolves to the real key', () => {
  assert.match(MANIFEST, /"permissions": \[[^\]]*"storage"/s, 'the manifest still has the collision to guard');
  const [start, end] = valueSpan(MANIFEST, 'storage');
  assert.deepEqual(JSON.parse(MANIFEST.slice(start, end)), JSON.parse(MANIFEST).storage);
});

test('removing such a key leaves valid JSON with the array element intact', () => {
  const next = removeTopLevelKey(MANIFEST, 'storage');
  const parsed = JSON.parse(next);
  assert.equal(parsed.storage, undefined);
  assert.ok(parsed.permissions.includes('storage'), 'the permission is a different thing and must survive');
});

test('removing the LAST key takes the preceding comma with it', () => {
  // browser_specific_settings is last in the manifest, so nothing follows it
  // to carry a separator — the comma that must go belongs to the entry before.
  const keys = Object.keys(JSON.parse(MANIFEST));
  assert.equal(keys[keys.length - 1], 'browser_specific_settings', 'this test is about the last key');
  const parsed = JSON.parse(removeTopLevelKey(MANIFEST, 'browser_specific_settings'));
  assert.equal(parsed.browser_specific_settings, undefined);
  assert.equal(parsed.manifest_version, 3, 'everything else survives');
});

test('deleting a nested key rewrites only its container', () => {
  const next = deletePath(MANIFEST, ['background', 'scripts']);
  assert.equal(JSON.parse(next).background.scripts, undefined);
  assert.ok(JSON.parse(next).background.service_worker, 'its sibling stays');
  // Outside `background`, byte-identical.
  const [start] = valueSpan(MANIFEST, 'background');
  assert.equal(next.slice(0, start), MANIFEST.slice(0, start));
  const [, end] = valueSpan(MANIFEST, 'background');
  const [, nextEnd] = valueSpan(next, 'background');
  assert.equal(next.slice(nextEnd), MANIFEST.slice(end));
});

test('writeIfChanged leaves an already-current file untouched and reports it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonomos-splice-'));
  const path = join(dir, 'f.json');

  assert.equal(writeIfChanged(path, 'one'), true, 'a new file is a change');
  assert.equal(writeIfChanged(path, 'one'), false, 'identical content is not');
  assert.equal(writeIfChanged(path, 'two'), true);
  assert.equal(read(path, 'utf8'), 'two');
});

test('writeIfChanged does not rewrite a file whose content already matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonomos-splice-'));
  const path = join(dir, 'f.json');
  writeFileSync(path, 'same');
  const before = read(path, 'utf8');

  assert.equal(writeIfChanged(path, 'same'), false);
  assert.equal(read(path, 'utf8'), before);
});
