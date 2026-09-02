// Copyright © 2026 Sonomos, Inc. All rights reserved.
//
// Decides whether a manually-dispatched run of `.github/workflows/release.yml`
// should publish to the stores.
//
// The rule: publish when, and only when, this repository has no release tag for
// the version in `manifest.json`. A dispatch on a version that has already been
// released ships nothing, so re-running the workflow — to check it, to look at
// the summary, to re-drive one job — cannot put a second submission in front of
// three review queues.
//
// WHY THIS IS NO LONGER A PARENT-COMMIT COMPARISON
//
// Until 2026-09-01 the workflow ran on every push to `main` and this script
// asked "did THIS COMMIT change the version?" — `manifest.json` at HEAD against
// `manifest.json` at HEAD^. That question is exactly right for a push trigger,
// where the run is pinned to the commit that arrived, and exactly wrong for a
// dispatch, where the run is pinned to whatever `main` happens to be when a
// human clicks the button. Under dispatch the version-bumping commit is
// routinely NOT the tip — a docs merge, a CI tweak or a dependency-free
// refactor lands after it — so HEAD^ carries the same version as HEAD, the gate
// answers "unchanged, nothing to publish", and the only way to release anything
// becomes `force: true`. An override that has to be used on every release is not
// an override; it is the normal path with a warning label on it, and it would
// have silently disabled the one check standing between a dispatch and three
// public stores.
//
// So the question changes with the trigger. "Did this commit bump the version?"
// is a fact about a push. "Has this version been released yet?" is a fact about
// the repository, true whenever it is asked, and it is the question a dispatch
// actually needs answered.
//
// WHY TAGS ARE THE EVIDENCE
//
// `release.yml` creates `v<version>` as part of publishing (its "Tag the release
// commit" step), and the local tag-push path in `scripts/hooks/pre-push`
// publishes from a `v<version>` tag too. Both routes to a store leave the same
// mark, so the tag set is the one record that covers every way a version can
// have shipped from here. It is also local, offline and deterministic — the
// decision cannot fail because a store API is down.
//
// Comparing against each store's live version remains the obvious design and
// still does not work uniformly: the Chrome Web Store exposes a published
// version (`scripts/publish/chrome.mjs::fetchStatus`), Edge's Partner Center API
// is submission-shaped and offers no "what is live right now" read, and AMO's
// answer lags its own review pipeline. A gate evaluable for one of three stores
// would be a gate in name only. Chrome's live check still earns its keep as a
// SAFETY NET below this one: `scripts/publish/chrome.mjs` refuses to re-upload a
// crxVersion that is already published. This script decides intent; the adapters
// refuse to do something incoherent.
//
// FAILURE POSTURE: fail-closed, in three directions.
//
//   1. A SHALLOW clone cannot be trusted to hold the whole tag set, so "no tag
//      for this version" there means "I could not look", not "not released".
//      That reads as a yes if you let it, which is the one mistake this file
//      exists to not make. Refuse. (`release.yml`'s gate job checks out with
//      `fetch-depth: 0` precisely so this branch is not taken.)
//   2. Git failing at all — not a repository, no git on PATH — is the same
//      unknown. Refuse.
//   3. A ref that is not the default branch. Dispatch, unlike a push trigger,
//      lets the operator choose the branch the run is built from, and nothing
//      downstream would notice: the artifacts would build, sign and publish
//      from unreviewed code, under a sigstore identity
//      (`release.yml@refs/heads/main`) that RELEASE-POLICY.md publishes as the
//      thing a verifier should check. Refuse anything but `main`, and refuse it
//      under `--force` too — force is an override for the VERSION question, and
//      was never a licence to ship a branch.
//
// `--force` covers the one legitimate case the version question gets wrong:
// re-driving a publish that failed after the tag was already created.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The branch a release may be built from. Not a preference: the published
// cosign verification recipe pins this ref
// (`docs/security/RELEASE-POLICY.md`, "Artifact integrity"), so a release built
// from anywhere else produces a signature nobody can verify with the documented
// command.
export const RELEASE_BRANCH = 'main';

export function versionFrom(manifestText) {
  const parsed = JSON.parse(manifestText);
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('manifest.json has no usable "version"');
  }
  return parsed.version;
}

function git(args, { root = ROOT, run = execFileSync } = {}) {
  return run('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

// true, false, or null when git could not answer. Null is a deliberate third
// value here: "I could not tell" is different from "it is complete", and only
// the caller knows which way to fail.
export function isShallow({ root = ROOT, run = execFileSync } = {}) {
  try {
    return git(['rev-parse', '--is-shallow-repository'], { root, run }).trim() === 'true';
  } catch {
    return null;
  }
}

// Every version this repository has a release tag for, or null when git could
// not be asked. An empty ARRAY is a real answer — a repository that has never
// released anything — and is not the same as null.
export function releasedVersions({ root = ROOT, run = execFileSync } = {}) {
  let out;
  try {
    out = git(['tag', '--list', 'v*'], { root, run });
  } catch {
    return null;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^v\d+\.\d+\.\d+/.test(line))
    .map((tag) => tag.slice(1));
}

// The newest of them, by numeric version order rather than string order, so
// `2.10.0` sorts above `2.9.0`. Reported for the run summary only — nothing
// decides on it, because "newest released" is not the question this gate asks.
export function newestVersion(versions) {
  let newest = null;
  let newestParts = null;
  for (const version of versions) {
    const parts = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
    if (
      newestParts === null ||
      parts[0] > newestParts[0] ||
      (parts[0] === newestParts[0] && parts[1] > newestParts[1]) ||
      (parts[0] === newestParts[0] && parts[1] === newestParts[1] && parts[2] > newestParts[2])
    ) {
      newest = version;
      newestParts = parts;
    }
  }
  return newest;
}

/**
 * @returns {{publish: boolean, version: string, lastReleased: string|null, reason: string}}
 */
export function decide({
  root = ROOT,
  force = false,
  refName = RELEASE_BRANCH,
  run = execFileSync
} = {}) {
  const version = versionFrom(readFileSync(join(root, 'manifest.json'), 'utf8'));

  // Checked before `force`, on purpose. See failure posture (3) above.
  if (refName !== RELEASE_BRANCH) {
    return {
      publish: false,
      version,
      lastReleased: null,
      reason:
        `dispatched on "${refName}", and a release may only be built from ` +
        `"${RELEASE_BRANCH}" — the published signature-verification recipe pins ` +
        'that ref. Merge to main and dispatch again. --force does not override this.'
    };
  }

  if (force) {
    return { publish: true, version, lastReleased: null, reason: 'forced (--force)' };
  }

  const shallow = isShallow({ root, run });
  if (shallow === null) {
    return {
      publish: false,
      version,
      lastReleased: null,
      reason:
        'git could not be consulted, so whether this version has already been ' +
        'released is unknown. Not publishing on an unknown answer; re-run with ' +
        '--force if this really should ship.'
    };
  }
  if (shallow) {
    return {
      publish: false,
      version,
      lastReleased: null,
      reason:
        'shallow clone — the tag list here is not the whole tag list, so a ' +
        'missing release tag proves nothing. Check out with fetch-depth: 0; ' +
        're-run with --force if this really should ship.'
    };
  }

  const released = releasedVersions({ root, run });
  if (released === null) {
    return {
      publish: false,
      version,
      lastReleased: null,
      reason:
        'the release tags could not be listed, so whether this version has ' +
        'already been released is unknown. Not publishing on an unknown answer; ' +
        're-run with --force if this really should ship.'
    };
  }

  const lastReleased = newestVersion(released);

  if (released.includes(version)) {
    return {
      publish: false,
      version,
      lastReleased,
      reason:
        `v${version} is already tagged — that version has been released from ` +
        'this repository, and every store rejects a re-upload of a version it ' +
        'already has. Bump the version to release again, or re-run with --force ' +
        'to re-drive a publish that failed after the tag was created.'
    };
  }

  return {
    publish: true,
    version,
    lastReleased,
    reason: `no release tag v${version} yet — this dispatch is a release${
      lastReleased ? ` (last released ${lastReleased})` : ' (the first from this repository)'
    }`
  };
}

function main(argv) {
  const force = argv.includes('--force');
  const refName = (argv.find((a) => a.startsWith('--ref-name=')) ?? `--ref-name=${RELEASE_BRANCH}`)
    .slice('--ref-name='.length);
  const result = decide({ force, refName });

  console.log(`version:       ${result.version}`);
  console.log(`last released: ${result.lastReleased ?? '(none)'}`);
  console.log(`ref:           ${refName}`);
  console.log(`publish:       ${result.publish}`);
  console.log(`reason:        ${result.reason}`);

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
