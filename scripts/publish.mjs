#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Publish the built artifacts to the extension stores:
//
//   node scripts/publish.mjs --store=all
//   node scripts/publish.mjs --store=chrome,edge --dry-run
//   node scripts/publish.mjs --store=firefox --tag=v2.0.1 --yes
//
// Runs preflight, builds dist/ (unless --no-build), then drives the three
// per-store publishers concurrently. One store failing never cancels the
// others: a Chrome outage should not stop a Firefox release that was
// otherwise ready. Every outcome lands in dist/publish-report.json.
//
// The same entry point is used by the local pre-push hook today and by
// .github/workflows/release.yml once the repo is public, so there is exactly
// one publishing code path to reason about.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifest, root as ROOT } from './store-build.mjs';
import { STORES, loadEnv, redact, secretValues } from './lib/creds.mjs';
import { escapeRegExp } from './lib/version.mjs';
import { runPreflight } from './preflight.mjs';

// Chrome and Edge consume the identical Chromium artifact — Microsoft's own
// porting guide says the MV3 package is code-compatible — so there are three
// stores but only two zips.
const ZIP_FOR_STORE = Object.freeze({ chrome: 'chromium', edge: 'chromium', firefox: 'firefox' });

// Seconds between "here is what I am about to submit" and the first upload.
// A tag push is the trigger, and a mistyped tag would otherwise burn a review
// cycle at all three stores (Edge restarts its 7-business-day certification
// clock on republish). Five seconds is enough to hit Ctrl-C and cheap enough
// not to be in the way.
const ABORT_WINDOW_MS = 5000;

function parseArgs(argv) {
  const args = { stores: STORES, dryRun: false, build: true, preflight: true, tag: null, yes: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-build') args.build = false;
    else if (arg === '--skip-preflight') args.preflight = false;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg.startsWith('--tag=')) args.tag = arg.slice(6);
    else if (arg.startsWith('--store=')) {
      const value = arg.slice(8);
      args.stores = value === 'all' ? STORES : value.split(',').map((s) => s.trim()).filter(Boolean);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const unknown = args.stores.filter((s) => !STORES.includes(s));
  if (unknown.length) throw new Error(`unknown store(s): ${unknown.join(', ')} — known: ${STORES.join(', ')}`);
  return args;
}

/**
 * Marks where the store-facing notes end inside a CHANGELOG version section.
 * Edge cuts certification notes at 5000 characters and AMO shows release
 * notes on the public listing, so a section that also carries the full
 * engineering log needs a line that says "reviewers stop here".
 */
export const NOTES_END = /^<!--\s*store-notes-end\s*-->[^\S\n]*$/m;

/**
 * The CHANGELOG section for this version, used as AMO release notes and Edge
 * certification notes. Store reviewers read these; "see git log" does not
 * survive a review.
 */
export function releaseNotesFor(version, changelog) {
  const escaped = escapeRegExp(version);
  const heading = new RegExp(`^##\\s*\\[${escaped}\\][^\\n]*$`, 'm').exec(changelog);
  if (!heading) return null;

  // Slice from the end of this heading to the next `## ` heading — or to the
  // end of the file for the newest entry. Done by index rather than a
  // lookahead because JS has no \Z, and an `$` in multiline mode would stop
  // at the first line break.
  const start = heading.index + heading[0].length;
  const next = /^##\s/m.exec(changelog.slice(start));
  let body = changelog.slice(start, next ? start + next.index : undefined);

  // Everything under a version heading is the changelog; only the part above
  // `<!-- store-notes-end -->` is what a store reviewer or an AMO listing
  // visitor should read. Without the marker the whole section goes, as it
  // always has. Cut here FIRST: the marker is itself an HTML comment, and the
  // comment-stripping below would otherwise eat it when nothing but the bump
  // placeholder sits above it.
  const cut = NOTES_END.exec(body);
  if (cut) body = body.slice(0, cut.index);

  // `npm run bump` opens the section with a TODO placeholder — and it lands
  // ON TOP of whatever was under [Unreleased], which becomes this version's
  // body. Shipping the placeholder to a store reviewer is worse than sending
  // none, but so is discarding a thousand lines of real notes because the
  // first four characters were `<!--`. Strip leading comments, then judge
  // what is left.
  body = body.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '');

  body = body.trim();
  return body || null;
}

async function loadPublisher(store) {
  try {
    return await import(`./publish/${store}.mjs`);
  } catch (err) {
    throw new Error(`store publisher scripts/publish/${store}.mjs could not be loaded: ${err.message}`);
  }
}

export async function publishAll({ stores = STORES, dryRun = false, env = loadEnv(), log = console.log } = {}) {
  const manifest = readManifest();
  const version = manifest.version;
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const releaseNotes = releaseNotesFor(version, changelog);
  const secrets = secretValues({ env });
  const say = (message) => log(redact(message, secrets));

  const results = await Promise.all(stores.map(async (store) => {
    const zipPath = join(ROOT, 'dist', `locke-extension-${version}-${ZIP_FOR_STORE[store]}.zip`);
    try {
      if (!existsSync(zipPath)) {
        return { store, ok: false, status: 'failed', message: `artifact missing: ${zipPath} (run npm run package)` };
      }
      const publisher = await loadPublisher(store);
      return await publisher.publish({
        zipPath,
        version,
        releaseNotes,
        dryRun,
        env,
        // Publishers self-prefix with their store key; prefixing again here
        // would print `[edge] [edge] …`.
        log: say
      });
    } catch (err) {
      // A publisher is contractually not supposed to throw for API failures,
      // but an unexpected throw must still not take the other stores down.
      return { store, ok: false, status: 'failed', message: redact(err.stack ?? err.message, secrets) };
    }
  }));

  return { version, dryRun, releaseNotes: Boolean(releaseNotes), results };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const env = loadEnv();

  if (args.preflight) {
    const pre = runPreflight({ stores: args.stores, tag: args.tag, env });
    for (const w of pre.warnings) console.log(`  warn  [${w.check}] ${w.message}`);
    if (!pre.ok) {
      console.error('preflight failed — nothing was uploaded:');
      for (const p of pre.problems) console.error(`  FAIL  [${p.check}] ${p.message}`);
      process.exit(1);
    }
  }

  if (args.build) {
    console.log('building dist/ …');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs')], { cwd: ROOT, stdio: 'inherit' });
  }

  const version = readManifest().version;
  console.log(`\npublishing ${version} to: ${args.stores.join(', ')}${args.dryRun ? '  (dry run)' : ''}`);

  if (!args.dryRun && !args.yes && process.stdin.isTTY) {
    console.log(`this submits to live stores and cannot be undone — Ctrl-C within ${ABORT_WINDOW_MS / 1000}s to abort`);
    await new Promise((resolve) => setTimeout(resolve, ABORT_WINDOW_MS));
  }

  const report = await publishAll({ stores: args.stores, dryRun: args.dryRun, env });

  // A publisher's returned `message` and `data` can quote an API error body,
  // and those bodies sometimes echo the request headers back — an Edge 401
  // will happily hand you `Authorization: ApiKey <your key>`. The log channel
  // is redacted inside each publisher; this is the other channel, and it ends
  // up both on disk and in a CI build artifact.
  const secrets = secretValues({ env });
  const reportPath = join(ROOT, 'dist', 'publish-report.json');
  writeFileSync(reportPath, redact(JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2), secrets) + '\n');

  console.log('');
  for (const r of report.results) {
    const mark = r.ok ? (r.status === 'skipped' ? 'skip' : 'ok  ') : 'FAIL';
    console.log(redact(`  ${mark}  ${r.store.padEnd(8)} ${r.status.padEnd(9)} ${r.message}`, secrets));
  }
  console.log(`\nreport: ${reportPath}`);

  const failed = report.results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(redact(`${failed.length} store(s) failed: ${failed.map((r) => r.store).join(', ')}`, secrets));
    process.exit(1);
  }
}
