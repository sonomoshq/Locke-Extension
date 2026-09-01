#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Bump the release version everywhere at once:
//
//   npm run bump -- patch          2.0.0 → 2.0.1
//   npm run bump -- minor          2.0.0 → 2.1.0
//   npm run bump -- major          2.0.0 → 3.0.0
//   npm run bump -- 2.4.0          explicit
//   npm run bump -- patch --dry-run
//
// Touches manifest.json, package.json, both version sites in
// package-lock.json, and opens a dated CHANGELOG.md section. Every store
// rejects a re-upload of an existing version, so the bump IS the release
// trigger — see scripts/lib/version.mjs for why all five sites matter.
//
// It deliberately does NOT commit or tag. docs/security/RELEASE-POLICY.md
// requires the version bump to land through a reviewed PR and the tag to be
// pushed by someone other than the approver; a script that tagged for you
// would quietly defeat that.

import { authoritativeVersion, checkVersions, nextVersion, writeVersion } from './lib/version.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const kind = args.find((a) => !a.startsWith('--'));

if (!kind) {
  console.error('usage: npm run bump -- <major|minor|patch|X.Y.Z> [--dry-run]');
  process.exit(2);
}

// Bumping from an inconsistent state would spread the inconsistency: the
// rewrite only replaces version strings that currently equal manifest.json's.
const before = checkVersions();
if (before.problems.length) {
  console.error('version sites disagree — fix these first, otherwise the bump will miss a file:');
  for (const p of before.problems) console.error(`  - ${p}`);
  process.exit(1);
}

const current = authoritativeVersion();
let target;
try {
  target = nextVersion(current, kind);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

if (dryRun) {
  console.log(`${current} → ${target} (dry run; nothing written)`);
  process.exit(0);
}

const result = writeVersion(target);
console.log(`${result.from} → ${result.to}`);
for (const file of result.touched) console.log(`  updated ${file}`);
console.log('\nnext: write the CHANGELOG entry, open a PR, get a CODEOWNER review,');
console.log(`then (a different person) tag the merge commit:  git tag v${target} && git push origin v${target}`);
