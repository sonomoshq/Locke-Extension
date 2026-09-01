// Copyright © 2026 Sonomos, Inc. All rights reserved.
// The release version lives in five places. This module is the only thing
// that knows all five, so a bump is one command and drift is one check.
//
//   manifest.json        .version              ← the source of truth; the git
//                                                tag must equal it exactly
//                                                (docs/security/RELEASE-POLICY.md)
//   package.json         .version
//   package-lock.json    .version and .packages[""].version   (two sites)
//   CHANGELOG.md         a dated "## [x.y.z] — YYYY-MM-DD" heading
//
// Before this existed, a bump was four hand edits and nothing caught a miss —
// and a mismatched version is not a cosmetic problem: it is what the store
// APIs key their "is this actually a new version" rejection on.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { root as ROOT } from '../store-build.mjs';

const STORE_VERSION = /^\d+(\.\d+){0,3}$/;

/** Read every version site. Missing files are reported, not thrown on. */
export function readVersions(root = ROOT) {
  const sites = [];

  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  sites.push({ file: 'manifest.json', path: manifestPath, version: manifest.version, authoritative: true });

  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  sites.push({ file: 'package.json', path: pkgPath, version: pkg.version });

  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    sites.push({ file: 'package-lock.json (.version)', path: lockPath, version: lock.version });
    sites.push({ file: 'package-lock.json (.packages[""])', path: lockPath, version: lock.packages?.['']?.version });
  }

  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  sites.push({
    file: 'CHANGELOG.md (latest heading)',
    path: changelogPath,
    version: latestChangelogVersion(changelog),
    // The changelog heading is informational for the bump but MUST exist for
    // a release — a store submission with no release note is a reviewer
    // question waiting to happen.
    changelog: true
  });

  return sites;
}

/** The version in the newest dated heading, ignoring [Unreleased]. */
export function latestChangelogVersion(text) {
  // Em dash is what this changelog uses; accept the ASCII forms too so a
  // hand-typed heading is not silently invisible to the check.
  const match = /^##\s*\[(\d+(?:\.\d+){0,3})\]\s*[—–-]/m.exec(text);
  return match?.[1];
}

export function authoritativeVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
}

/**
 * Check that every site agrees, and (when given) that a git tag matches.
 * Returns problems as strings so the caller can print them all at once.
 */
export function checkVersions({ root = ROOT, tag } = {}) {
  const sites = readVersions(root);
  const problems = [];
  const expected = sites.find((s) => s.authoritative).version;

  if (!STORE_VERSION.test(expected || '')) {
    problems.push(`manifest.json version "${expected}" is not a store-legal dotted-integer version`);
  }

  for (const site of sites) {
    if (site.version === expected) continue;
    if (site.changelog) {
      problems.push(`CHANGELOG.md has no "## [${expected}] — <date>" heading (newest dated heading is ${site.version ?? 'none'})`);
    } else {
      problems.push(`${site.file} is ${site.version ?? 'missing'}, expected ${expected}`);
    }
  }

  if (tag !== undefined && tag !== null && tag !== '') {
    const normalized = String(tag).replace(/^v/, '');
    if (normalized !== expected) {
      problems.push(`git tag ${tag} does not match manifest.json version ${expected}`);
    }
  }

  return { version: expected, sites, problems };
}

/**
 * Compare dotted-integer versions. -1 | 0 | 1
 *
 * Store versions are dotted integers — no prereleases, no build metadata —
 * so a non-numeric part means the caller has something that is not a store
 * version. Throwing beats the silent `NaN !== 0` path, where `2.0.0-beta`
 * would compare as less than everything including itself.
 */
export function compareVersions(a, b) {
  const parts = (value) => String(value).split('.').map((piece) => {
    const n = Number(piece);
    if (!Number.isInteger(n) || n < 0) throw new Error(`"${value}" is not a dotted-integer version`);
    return n;
  });
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Next version for a bump kind, or the literal version if one was given. */
export function nextVersion(current, kind) {
  if (STORE_VERSION.test(kind)) return kind;
  const [major = 0, minor = 0, patch = 0] = String(current).split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump kind "${kind}" — use major, minor, patch, or an explicit version`);
}

/**
 * Write `version` to every site.
 *
 * JSON files are rewritten with a targeted string replacement rather than
 * JSON.stringify: reserialising package-lock.json would reformat a file npm
 * owns, and reserialising manifest.json would drop the key order a reviewer
 * diffs against.
 */
export function writeVersion(version, { root = ROOT, date } = {}) {
  const current = authoritativeVersion(root);
  const touched = [];

  // manifest.json and package.json each carry exactly one top-level version
  // field, so a targeted string replacement preserves the key order and
  // formatting a reviewer diffs against. The `"` before `version` is what
  // keeps this off `strict_min_version` and `lockfileVersion`.
  for (const file of ['manifest.json', 'package.json']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const after = before.replace(
      /("version"\s*:\s*")([^"]+)(")/,
      (whole, open, value, close) => (value === current ? `${open}${version}${close}` : whole)
    );
    if (after !== before) {
      writeFileSync(path, after);
      touched.push(file);
    }
  }

  // package-lock.json gets structural treatment, not a global replace: a
  // dependency that happens to sit at the same version as the extension would
  // otherwise be rewritten too, leaving `version` disagreeing with the
  // `resolved` URL and `integrity` hash beside it — a lockfile npm ci either
  // mis-installs from or rejects. Reserialising is safe here because npm
  // regenerates this file wholesale anyway.
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    let changed = false;
    if (lock.version === current) { lock.version = version; changed = true; }
    if (lock.packages?.['']?.version === current) { lock.packages[''].version = version; changed = true; }
    if (changed) {
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
      touched.push('package-lock.json');
    }
  }

  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  if (!new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
    const stamp = date ?? new Date().toISOString().slice(0, 10);
    // Match the file's existing line endings. Writing bare \n into a CRLF
    // file leaves mixed endings in the one document store reviewers read
    // (publish.mjs lifts release notes straight out of it).
    const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
    const section = [
      '## [Unreleased]',
      '',
      `## [${version}] — ${stamp}`,
      '',
      '<!-- TODO: describe this release before tagging. -->'
    ].join(eol);
    // Insert directly under [Unreleased] so the new section is where a
    // human is already typing, and [Unreleased] survives for the next cycle.
    const updated = changelog.replace(/^##\s*\[Unreleased\][^\S\r\n]*$/m, section);
    if (updated === changelog) {
      throw new Error('CHANGELOG.md has no "## [Unreleased]" heading to insert under');
    }
    writeFileSync(changelogPath, updated);
    touched.push('CHANGELOG.md');
  }

  return { from: current, to: version, touched };
}
