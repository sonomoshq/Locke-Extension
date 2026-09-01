// Copyright © 2026 Sonomos, Inc. All rights reserved.
//
// Decides whether a push to `main` should publish to the stores.
//
// The rule: publish when, and only when, the version in `manifest.json` differs
// from the version at the previous commit. A merge that does not touch the
// version ships nothing, so an ordinary docs or CI change cannot put a new
// build in front of three review queues.
//
// WHY THE COMPARISON IS AGAINST GIT AND NOT AGAINST THE STORES
//
// Comparing against each store's live version is the obvious design and it does
// not work uniformly. The Chrome Web Store exposes a published version
// (`scripts/publish/chrome.mjs::fetchStatus` returns `publishedVersion`), but
// Edge's Partner Center API is submission-shaped and does not offer a "what is
// live right now" read, and AMO's answer lags its own review pipeline. A gate
// that could only be evaluated for one of three stores would be a gate in name
// only.
//
// Git is the one source all three agree on: the version this commit declares.
// It is also deterministic and offline, so the decision cannot fail because a
// store API is down.
//
// Chrome's live check still earns its keep, but as a SAFETY NET rather than the
// gate: `scripts/publish/chrome.mjs` refuses to re-upload a crxVersion that is
// already published. This script decides intent; the adapters refuse to do
// something incoherent.
//
// FAILURE POSTURE: when the previous version cannot be determined — the first
// commit, a shallow clone with no parent, a force-push that rewrote history —
// this does NOT publish. A missing answer is not a yes. Use `--force` when you
// genuinely mean to publish without a version change.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function versionFrom(manifestText) {
  const parsed = JSON.parse(manifestText);
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('manifest.json has no usable "version"');
  }
  return parsed.version;
}

// The manifest as of `ref`, or null when git cannot produce one. Null is a
// deliberate value here: "I could not tell" is different from "it was the same",
// and only the caller knows which way to fail.
export function manifestAt(ref, { root = ROOT, run = execFileSync } = {}) {
  try {
    return run('git', ['show', `${ref}:manifest.json`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

/**
 * @returns {{publish: boolean, version: string, previous: string|null, reason: string}}
 */
export function decide({ root = ROOT, ref = 'HEAD^', force = false, run = execFileSync } = {}) {
  const version = versionFrom(readFileSync(join(root, 'manifest.json'), 'utf8'));

  if (force) {
    return { publish: true, version, previous: null, reason: 'forced (--force)' };
  }

  const previousText = manifestAt(ref, { root, run });
  if (previousText === null) {
    return {
      publish: false,
      version,
      previous: null,
      reason:
        `could not read manifest.json at ${ref} — no parent commit, a shallow ` +
        'clone, or rewritten history. Not publishing on an unknown previous ' +
        'version; re-run with --force if this really should ship.'
    };
  }

  let previous;
  try {
    previous = versionFrom(previousText);
  } catch {
    return {
      publish: false,
      version,
      previous: null,
      reason: `manifest.json at ${ref} could not be parsed for a version`
    };
  }

  if (previous === version) {
    return {
      publish: false,
      version,
      previous,
      reason: `version unchanged at ${version} — nothing to publish`
    };
  }

  return {
    publish: true,
    version,
    previous,
    reason: `version changed ${previous} -> ${version}`
  };
}

function main(argv) {
  const force = argv.includes('--force');
  const ref = (argv.find((a) => a.startsWith('--ref=')) || '--ref=HEAD^').slice(6);
  const result = decide({ ref, force });

  console.log(`version:  ${result.version}`);
  console.log(`previous: ${result.previous ?? '(unknown)'}`);
  console.log(`publish:  ${result.publish}`);
  console.log(`reason:   ${result.reason}`);

  // Machine-readable for the workflow. GITHUB_OUTPUT is absent locally.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `publish=${result.publish}\nversion=${result.version}\nreason=${result.reason}\n`
    );
  }
  return 0;
}

const invoked =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) process.exit(main(process.argv.slice(2)));
