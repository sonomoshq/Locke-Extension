// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, versionFrom, manifestAt } from '../scripts/release-gate.mjs';

// This module decides whether a merge reaches three public store review queues
// with no human in the loop. The interesting cases are all the ones where the
// answer is "no" — a gate that only gets the happy path right is not a gate.

function repoWith(version) {
  const dir = mkdtempSync(join(tmpdir(), 'sonomos-gate-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version }, null, 2));
  return dir;
}

// A stand-in for `git show <ref>:manifest.json`. Throwing is how git reports
// "no such ref", which is the case that matters most here.
function gitReturning(text) {
  return () => {
    if (text === null) throw new Error('fatal: invalid object name');
    return text;
  };
}

test('a changed version publishes', () => {
  const result = decide({
    root: repoWith('2.1.0'),
    run: gitReturning(JSON.stringify({ version: '2.0.0' }))
  });
  assert.equal(result.publish, true);
  assert.equal(result.version, '2.1.0');
  assert.equal(result.previous, '2.0.0');
  assert.match(result.reason, /2\.0\.0 -> 2\.1\.0/);
});

test('an unchanged version publishes nothing', () => {
  // The ordinary case: a docs fix, a CI tweak, a dependency bump. Merging it
  // must not put a build in front of a reviewer at three stores.
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning(JSON.stringify({ version: '2.0.0' }))
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /unchanged/);
});

test('an unreadable previous manifest does NOT publish', () => {
  // First commit, shallow clone, force-pushed history. "I could not tell" is
  // not "yes" — the failure posture is to ship nothing and say why.
  const result = decide({ root: repoWith('2.0.0'), run: gitReturning(null) });
  assert.equal(result.publish, false);
  assert.equal(result.previous, null);
  assert.match(result.reason, /--force/, 'the message must say how to override it');
});

test('an unparseable previous manifest does NOT publish', () => {
  const result = decide({ root: repoWith('2.0.0'), run: gitReturning('{ not json') });
  assert.equal(result.publish, false);
});

test('a previous manifest with no version does NOT publish', () => {
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning(JSON.stringify({ name: 'no version here' }))
  });
  assert.equal(result.publish, false);
});

test('--force publishes without consulting git at all', () => {
  const result = decide({
    root: repoWith('2.0.0'),
    force: true,
    run: () => assert.fail('git must not be consulted when forced')
  });
  assert.equal(result.publish, true);
  assert.match(result.reason, /forced/);
});

test('a version going BACKWARDS still counts as a change', () => {
  // Deliberate: this gate answers "did the version change", not "is it newer".
  // A rollback is a real thing to want, and the stores enforce their own rules
  // about re-using a version — that judgement belongs to them, not here.
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning(JSON.stringify({ version: '2.1.0' }))
  });
  assert.equal(result.publish, true);
});

test('a manifest with no version is an error, not a silent skip', () => {
  assert.throws(() => versionFrom(JSON.stringify({ name: 'x' })), /no usable "version"/);
});

test('an empty version string is rejected', () => {
  assert.throws(() => versionFrom(JSON.stringify({ version: '' })), /no usable "version"/);
});

test('manifestAt returns null rather than throwing when git fails', () => {
  assert.equal(manifestAt('nope', { run: gitReturning(null) }), null);
});

test('the real manifest in this repo has a readable version', () => {
  // Guards against the gate being wired to a manifest shape it cannot read.
  const version = versionFrom(
    readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
  );
  assert.match(version, /^\d+\.\d+\.\d+/);
});
