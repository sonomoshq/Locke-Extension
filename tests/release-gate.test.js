// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide,
  isShallow,
  newestVersion,
  releasedVersions,
  versionFrom,
  RELEASE_BRANCH
} from '../scripts/release-gate.mjs';

// This module decides whether a dispatch reaches three public store review
// queues. The interesting cases are all the ones where the answer is "no" — a
// gate that only gets the happy path right is not a gate.

function repoWith(version) {
  const dir = mkdtempSync(join(tmpdir(), 'sonomos-gate-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version }, null, 2));
  return dir;
}

// A stand-in for the two git calls the gate makes. `shallow` is the string
// `git rev-parse --is-shallow-repository` prints; `tags` is what
// `git tag --list v*` prints. Either may be the sentinel THROWS, because
// throwing is how execFileSync reports a git that could not answer — and that
// is the case that matters most here.
const THROWS = Symbol('git failed');

function gitReturning({ shallow = 'false\n', tags = '' } = {}) {
  return (_cmd, args) => {
    const subcommand = args[0];
    if (subcommand === 'rev-parse') {
      if (shallow === THROWS) throw new Error('fatal: not a git repository');
      return shallow;
    }
    if (subcommand === 'tag') {
      if (tags === THROWS) throw new Error('fatal: not a git repository');
      return tags;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

// ── the version question ────────────────────────────────────────────

test('a version with no release tag publishes', () => {
  const result = decide({
    root: repoWith('2.1.0'),
    run: gitReturning({ tags: 'v1.9.0\nv2.0.0\n' })
  });
  assert.equal(result.publish, true);
  assert.equal(result.version, '2.1.0');
  assert.equal(result.lastReleased, '2.0.0');
});

test('a version that is already tagged publishes nothing', () => {
  // The case dispatch-only makes routine: somebody re-runs the workflow on a
  // `main` whose version already shipped — to read the summary, or because
  // they forgot they had. It must not submit that version twice.
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning({ tags: 'v2.0.0\n' })
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /already tagged/);
});

test('the first release from a repository with no tags at all publishes', () => {
  // An empty tag list is a real answer, not a missing one.
  const result = decide({ root: repoWith('2.0.0'), run: gitReturning({ tags: '' }) });
  assert.equal(result.publish, true);
  assert.equal(result.lastReleased, null);
  assert.match(result.reason, /first/);
});

test('a version bump made SEVERAL commits ago still publishes', () => {
  // The whole reason the parent-commit comparison was replaced. Under dispatch
  // the tip of `main` is routinely not the bump commit, and the old gate
  // answered "unchanged" there — which would have made `force: true` the normal
  // path and disabled the only check in front of three stores.
  const result = decide({
    root: repoWith('2.1.0'),
    run: gitReturning({ tags: 'v2.0.0\n' })
  });
  assert.equal(result.publish, true);
});

test('a version going BACKWARDS to an unreleased number still publishes', () => {
  // Deliberate: the gate answers "has this shipped", not "is it newer". Rolling
  // the manifest back to a number nothing was ever released under is a real
  // thing to want, and the stores enforce their own rules about ordering.
  const result = decide({
    root: repoWith('2.0.1'),
    run: gitReturning({ tags: 'v2.1.0\n' })
  });
  assert.equal(result.publish, true);
  assert.equal(result.lastReleased, '2.1.0');
});

// ── fail-closed: the three unknowns ─────────────────────────────────

test('a SHALLOW clone does NOT publish', () => {
  // A partial tag list makes "no tag for this version" mean "I could not look".
  // Reading that as a yes is the one mistake this file exists not to make.
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning({ shallow: 'true\n', tags: '' })
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /shallow/);
  assert.match(result.reason, /fetch-depth: 0/, 'the message must say how to fix it');
});

test('git failing outright does NOT publish', () => {
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning({ shallow: THROWS })
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /--force/, 'the message must say how to override it');
});

test('an unlistable tag set does NOT publish', () => {
  const result = decide({
    root: repoWith('2.0.0'),
    run: gitReturning({ tags: THROWS })
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /--force/);
});

// ── fail-closed: the branch ─────────────────────────────────────────

test('a dispatch on a branch other than main does NOT publish', () => {
  // New with dispatch: the operator picks the branch. Building a release from
  // an unreviewed one would sign it under an identity nobody can verify with
  // the recipe RELEASE-POLICY.md publishes.
  const result = decide({
    root: repoWith('2.1.0'),
    refName: 'feature/whatever',
    run: () => assert.fail('git must not be consulted for a non-release branch')
  });
  assert.equal(result.publish, false);
  assert.match(result.reason, /only be built from "main"/);
});

test('--force does NOT override the branch check', () => {
  const result = decide({
    root: repoWith('2.1.0'),
    refName: 'feature/whatever',
    force: true,
    run: () => assert.fail('git must not be consulted for a non-release branch')
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

// ── the pieces ──────────────────────────────────────────────────────

test('a manifest with no version is an error, not a silent skip', () => {
  assert.throws(() => versionFrom(JSON.stringify({ name: 'x' })), /no usable "version"/);
});

test('an empty version string is rejected', () => {
  assert.throws(() => versionFrom(JSON.stringify({ version: '' })), /no usable "version"/);
});

test('isShallow returns null rather than throwing when git fails', () => {
  assert.equal(isShallow({ run: gitReturning({ shallow: THROWS }) }), null);
});

test('releasedVersions returns null rather than throwing when git fails', () => {
  assert.equal(releasedVersions({ run: gitReturning({ tags: THROWS }) }), null);
});

test('releasedVersions ignores tags that are not release tags', () => {
  const versions = releasedVersions({
    run: gitReturning({ tags: 'v2.0.0\nvNext\nv2.0.1-rc.1\nvery-old\n\n' })
  });
  // `v2.0.1-rc.1` is kept: it starts with a full X.Y.Z, and a pre-release tag
  // for a version means that version has been out of the building.
  assert.deepEqual(versions, ['2.0.0', '2.0.1-rc.1']);
});

test('newestVersion sorts numerically, not lexically', () => {
  assert.equal(newestVersion(['2.9.0', '2.10.0', '2.1.0']), '2.10.0');
  assert.equal(newestVersion([]), null);
});

test('the real manifest in this repo has a readable version', () => {
  // Guards against the gate being wired to a manifest shape it cannot read.
  const version = versionFrom(
    readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
  );
  assert.match(version, /^\d+\.\d+\.\d+/);
});

// ── no workflow may publish on a push (Sonomos #190) ─────────────────
//
// The control this whole file backs. Until 2026-09-01 `release.yml` ran on
// every push to `main` and submitted to the Chrome Web Store, Edge Add-ons and
// AMO with no human step at all — merging was shipping. Reinstating a `push:`
// trigger on a workflow that publishes would undo that silently, in one line of
// YAML, in a file nobody diffs closely. So it is asserted here rather than
// remembered.
//
// Parsed with a purpose-built reader rather than a YAML library, because this
// repository ships zero dependencies (README "Why publish the source", and the
// `ci.yml::lint-js` tripwire that enforces it). The reader only has to
// understand the small, stable shape GitHub workflow triggers actually take.

const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

// The trigger names under the top-level `on:` key.
//
// Handles the three spellings a workflow can use: a block mapping (`on:` then
// indented keys), a flow sequence (`on: [push, pull_request]`) and a bare
// scalar (`on: push`). Comments and blank lines inside the block are skipped;
// the block ends at the next line that starts in column 0.
export function triggersOf(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const index = lines.findIndex((line) => /^on:/.test(line));
  if (index === -1) return [];

  const inline = lines[index].slice(3).trim();
  if (inline && !inline.startsWith('#')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  }

  const found = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break; // back to column 0: the `on:` block is over
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

// Whether a workflow submits to an extension store. Three independent
// signatures, because any one of them alone could be renamed: the publisher
// entrypoint, the npm script that wraps it, and the GitHub Environment the
// store credentials are scoped to.
export function publishesToStores(yamlText) {
  return (
    /scripts\/publish\.mjs/.test(yamlText) ||
    /npm run publish-stores/.test(yamlText) ||
    /environment:\s*store-publish/.test(yamlText)
  );
}

test('no workflow in this repository publishes on a push', () => {
  const offenders = [];
  for (const name of workflowFiles()) {
    const text = readFileSync(new URL(name, WORKFLOW_DIR), 'utf8');
    if (!publishesToStores(text)) continue;
    const triggers = triggersOf(text);
    for (const trigger of triggers) {
      if (trigger === 'push' || trigger === 'pull_request' || trigger === 'schedule') {
        offenders.push(`${name} publishes and triggers on ${trigger}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'publishing must be a deliberate act. Reaching a store from a push, a pull ' +
      'request or a cron makes merging (or waiting) the release: ' +
      offenders.join('; ')
  );
});

test('release.yml is dispatch-only and still has its inputs', () => {
  const text = readFileSync(new URL('release.yml', WORKFLOW_DIR), 'utf8');
  assert.deepEqual(triggersOf(text), ['workflow_dispatch']);
  assert.ok(publishesToStores(text), 'the publish detector must actually match release.yml');
  assert.match(text, /force:/, 'the re-drive override must survive');
  assert.match(text, /stores:/, 'the per-store input must survive');
});

test('release.yml tells a skipped store apart from a shipped one, and says when no notes went out', () => {
  const text = readFileSync(new URL('release.yml', WORKFLOW_DIR), 'utf8');
  // Every publisher returns ok:true, status:'skipped' for "already in review"
  // and "already at this version"; labelling that "shipped" is a lie in the
  // one place the operator reads.
  assert.match(text, /s\.status === "skipped" \? "skipped"/);
  // publish.mjs writes releaseNotes:false when the CHANGELOG section was
  // empty or placeholder-only; the summary is the only place it surfaces.
  assert.match(text, /r\.releaseNotes === false/);
});

test('release.yml pins SOURCE_DATE_EPOCH to the tagged commit on a re-drive, in both jobs', () => {
  const text = readFileSync(new URL('release.yml', WORKFLOW_DIR), 'utf8');
  // A --force re-drive rebuilds from a later HEAD. Pinning to the existing
  // tag's commit time is what makes the re-driven zip byte-identical to the
  // one the release attested (when the runtime payload is unchanged).
  const pins = text.match(/git rev-parse -q --verify "refs\/tags\/\$tag\^\{commit\}"/g) ?? [];
  assert.equal(pins.length, 2, 'both the release and store-publish jobs must pin the same way');
  assert.doesNotMatch(text, /git log -1 --pretty=%ct HEAD\)/, 'no job may still pin unconditionally to HEAD');
});

test('release.yml checks out deeply enough for the gate to read tags', () => {
  // fetch-depth: 2 was right for the parent-commit comparison and is wrong now:
  // the gate reads the tag set, and a shallow checkout makes it refuse.
  const text = readFileSync(new URL('release.yml', WORKFLOW_DIR), 'utf8');
  assert.doesNotMatch(text, /fetch-depth:\s*[12]\s*$/m);
});

test('the workflow trigger reader handles the spellings GitHub allows', () => {
  assert.deepEqual(triggersOf('on: push\njobs:\n'), ['push']);
  assert.deepEqual(triggersOf('on: [push, workflow_dispatch]\njobs:\n'), [
    'push',
    'workflow_dispatch'
  ]);
  assert.deepEqual(
    triggersOf('on:\n  # a comment\n  push:\n    branches: [main]\n\n  workflow_dispatch:\njobs:\n'),
    ['push', 'workflow_dispatch']
  );
  assert.deepEqual(triggersOf('name: x\njobs:\n'), []);
});

test('the store-publish detector is not fooled by prose alone', () => {
  assert.equal(publishesToStores('# we do not publish here\nrun: npm test\n'), false);
  assert.equal(publishesToStores('run: node scripts/publish.mjs --store=all\n'), true);
  assert.equal(publishesToStores('    environment: store-publish\n'), true);
});
