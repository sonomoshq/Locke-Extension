#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Install the repo's git hooks:  npm run install-hooks  [-- --quiet] [--force]
//
// Git hooks are not versioned by git, so every clone starts with none. This
// copies scripts/hooks/* into the repository's real hooks directory and marks
// them executable.
//
// The destination is `git rev-parse --git-common-dir`/hooks, NOT .git/hooks:
// in a worktree, .git is a file and the per-worktree gitdir has no hooks
// directory of its own — git looks in the common dir. Getting this wrong
// installs a hook that never runs.
//
// Deliberately NOT done by setting core.hooksPath: some developers already
// have a global core.hooksPath pointing at a third-party hook manager, that
// setting holds a single path rather than a search list, and a repo-local
// value would silently disable that manager here. Such shims typically
// delegate to the repo-local hook of the same name and propagate its exit
// status, so copying into the common dir chains both.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { root as ROOT } from './store-build.mjs';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const force = args.includes('--force');
const say = (message) => { if (!quiet) console.log(message); };

const source = join(ROOT, 'scripts', 'hooks');
// Every hook this repo installs carries this line, which is how we tell our
// own file from one a developer wrote by hand.
const MARKER = 'Locke Extension pre-push gate';

let hooksDir;
try {
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  hooksDir = join(resolve(ROOT, commonDir), 'hooks');
} catch (err) {
  // `npm install` in a tarball or a non-git checkout is not a failure worth
  // breaking the install over.
  say(`install-hooks: not a git repository (${err.message.trim()}) — nothing to do`);
  process.exit(0);
}

mkdirSync(hooksDir, { recursive: true });

let installed = 0;
let skipped = 0;

for (const name of readdirSync(source)) {
  const from = join(source, name);
  const to = join(hooksDir, name);

  if (existsSync(to) && !force) {
    const existing = readFileSync(to, 'utf8');
    if (!existing.includes(MARKER)) {
      // Someone's own hook is there. Overwriting it silently would be a
      // hostile thing for a postinstall step to do.
      console.warn(`install-hooks: ${to} exists and is not ours — left alone (re-run with --force to replace)`);
      skipped++;
      continue;
    }
  }

  copyFileSync(from, to);
  // 0o755: git runs the hook as a program. On Windows the mode is cosmetic,
  // but Git Bash still honours the shebang, and a repo cloned to WSL/macOS
  // gets a correctly executable file.
  chmodSync(to, 0o755);
  installed++;
  say(`install-hooks: installed ${name} → ${to}`);
}

// A stale copy of a hook we no longer ship would keep running forever.
// Record what we actually installed so a future version can clean up after
// itself — writing the full list even when everything was skipped would
// record work that did not happen.
if (installed > 0) {
  writeFileSync(join(hooksDir, '.locke-hooks'), readdirSync(source).join('\n') + '\n');
}

// ── Will the hook actually run? ───────────────────────────────────────
//
// A global core.hooksPath overrides this directory entirely. Well-behaved
// tools install a shim there that delegates back to the repo-local hook, but
// those shims guard against infinite recursion by grepping the local hook for
// their own name — and a hook that merely MENTIONS the tool in a comment
// matches that grep and is silently skipped. That failure is invisible: the
// push succeeds, nothing is validated, nothing warns. So verify rather than
// assume, and treat a hook that cannot run as an install failure.
let hooksPath = '';
try {
  hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  // Unset: git reads hooksDir directly and there is nothing to check.
}

let blocked = 0;
if (hooksPath && resolve(hooksPath) !== resolve(hooksDir)) {
  for (const name of readdirSync(source)) {
    const shimPath = join(resolve(ROOT, hooksPath), name);
    const ours = readFileSync(join(source, name), 'utf8');

    if (!existsSync(shimPath)) {
      console.warn(`install-hooks: core.hooksPath is ${hooksPath} and has no ${name}, so ${name} will NEVER run`);
      blocked++;
      continue;
    }

    const shim = readFileSync(shimPath, 'utf8');
    if (!shim.includes('hooks/')) {
      console.warn(`install-hooks: ${shimPath} does not appear to delegate to the repo hook, so ${name} will NEVER run`);
      blocked++;
      continue;
    }

    // Replay whatever `grep -q <token>` recursion guards the shim uses
    // against our own text.
    for (const [, token] of shim.matchAll(/grep\s+-q\s+([A-Za-z0-9_-]+)/g)) {
      if (ours.includes(token)) {
        console.error(`install-hooks: ${shimPath} skips any repo hook containing "${token}", and ${name} contains it — the hook would be silently disabled`);
        console.error(`install-hooks: remove every occurrence of "${token}" from scripts/hooks/${name} (a comment counts)`);
        blocked++;
      }
    }
  }
}

say(`install-hooks: ${installed} installed, ${skipped} skipped`);

if (blocked > 0) {
  console.error(`install-hooks: ${blocked} hook(s) are installed but cannot run — fix the above before relying on the gate`);
  process.exit(1);
}
