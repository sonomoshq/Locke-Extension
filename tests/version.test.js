// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { root as ROOT } from '../scripts/store-build.mjs';
import {
  checkVersions,
  compareVersions,
  latestChangelogVersion,
  nextVersion,
  readVersions,
  writeVersion
} from '../scripts/lib/version.mjs';

// The release version lives in five files. Nothing but scripts/lib/version.mjs
// knows all five, and a half-applied bump is not cosmetic: every store keys
// its "this version already exists" rejection on it.


test('version: every site in the repo agrees', () => {
  // manifest.json, package.json, both package-lock.json sites, and a dated
  // CHANGELOG heading. A store rejects a re-upload of an existing version,
  // so a half-applied bump is a failed release, not a cosmetic slip.
  const { problems, version } = checkVersions();
  assert.deepEqual(problems, [], `version drift: ${problems.join('; ')}`);
  assert.match(version, /^\d+(\.\d+){0,3}$/);
});

test('version: readVersions covers every site present in the checkout', () => {
  const files = readVersions().map((s) => s.file);
  // package-lock.json is optional — a zero-dependency repo can legitimately
  // not have one, and asserting it unconditionally makes this suite pass only
  // on a machine that happens to have run `npm install`.
  const expected = existsSync(join(ROOT, 'package-lock.json'))
    ? ['manifest.json', 'package.json', 'package-lock.json (.version)', 'package-lock.json (.packages[""])', 'CHANGELOG.md (latest heading)']
    : ['manifest.json', 'package.json', 'CHANGELOG.md (latest heading)'];
  assert.deepEqual(files, expected);
});

test('version: writeVersion updates every site and opens a changelog section', () => {
  // Against a throwaway tree — this is the one function in the pipeline that
  // mutates four files, and a miss leaves a version the stores will reject.
  const root = mkdtempSync(join(tmpdir(), 'locke-bump-'));
  try {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: '2.0.0', browser_specific_settings: { gecko: { strict_min_version: '128.0' } } }, null, 2));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }, null, 2));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      name: 'x',
      version: '2.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '2.0.0' },
        // A dependency pinned at the same version as the extension. A blanket
        // string replace would bump this too, leaving `version` disagreeing
        // with `resolved` and `integrity` — a lockfile npm ci rejects.
        'node_modules/some-tool': { version: '2.0.0', resolved: 'https://r/some-tool-2.0.0.tgz', integrity: 'sha512-abc' }
      }
    }, null, 2));
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [2.0.0] — 2026-08-10\n');

    const result = writeVersion('2.0.1', { root, date: '2026-09-01' });
    assert.deepEqual(result.touched.sort(), ['CHANGELOG.md', 'manifest.json', 'package-lock.json', 'package.json']);

    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '2.0.1');
    assert.equal(lock.packages[''].version, '2.0.1');
    assert.equal(lock.packages['node_modules/some-tool'].version, '2.0.0', 'a dependency must not be bumped');

    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '2.0.1');
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0', 'strict_min_version is not a version field to bump');

    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /## \[Unreleased\]/);
    assert.match(changelog, /## \[2\.0\.1\] — 2026-09-01/);
    assert.deepEqual(checkVersions({ root }).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version: writeVersion keeps CRLF files CRLF', () => {
  const root = mkdtempSync(join(tmpdir(), 'locke-bump-'));
  try {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: '2.0.0' }, null, 2));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }, null, 2));
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [2.0.0] — 2026-08-10\r\n');
    writeVersion('2.0.1', { root, date: '2026-09-01' });
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(!/[^\r]\n/.test(changelog), 'the inserted section must not introduce bare LF into a CRLF file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version: a tag that disagrees with the manifest is a problem', () => {
  const { version, problems } = checkVersions({ tag: 'v99.0.0' });
  assert.deepEqual(problems, [`git tag v99.0.0 does not match manifest.json version ${version}`]);
  assert.deepEqual(checkVersions({ tag: `v${version}` }).problems, []);
});

test('version: the changelog heading parser ignores [Unreleased]', () => {
  const text = '## [Unreleased]\n\n## [2.1.0] — 2026-09-01\n\n## [2.0.0] — 2026-08-10\n';
  assert.equal(latestChangelogVersion(text), '2.1.0');
  assert.equal(latestChangelogVersion('## [Unreleased]\n'), undefined);
});

test('version: bump arithmetic', () => {
  assert.equal(nextVersion('2.0.0', 'patch'), '2.0.1');
  assert.equal(nextVersion('2.0.9', 'minor'), '2.1.0');
  assert.equal(nextVersion('2.4.1', 'major'), '3.0.0');
  assert.equal(nextVersion('2.0.0', '4.2.0'), '4.2.0');
  assert.throws(() => nextVersion('2.0.0', 'sideways'), /unknown bump kind/);
});

test('version: comparison orders numerically, not lexically', () => {
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
});
