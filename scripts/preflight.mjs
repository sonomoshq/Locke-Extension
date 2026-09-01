#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Release gate:  node scripts/preflight.mjs [--tag=v2.0.1] [--stores=all]
//                                           [--checks=version,manifest,...]
//                                           [--skip-tests] [--json]
//
// Everything that must be true BEFORE a byte is uploaded to a store. Run by
// the pre-push hook on every push, by `npm run publish`, and by
// .github/workflows/{ci,release}.yml — the same code path in all three, so a
// check can't pass locally and be absent in CI.
//
// Exit 0 = clear to publish. Exit 1 = at least one hard problem. Warnings
// never fail the run; they are the things a human should look at but that
// shouldn't block a release at 2am.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAll, readManifest, root as ROOT } from './store-build.mjs';
import { checkVersions } from './lib/version.mjs';
import { STORES, credentialsFor, loadEnv } from './lib/creds.mjs';

const ALL_CHECKS = ['version', 'manifest', 'assets', 'credentials', 'headers', 'tests'];

function parseArgs(argv) {
  const args = { checks: ALL_CHECKS, stores: STORES, tag: null, skipTests: false, json: false };
  for (const arg of argv) {
    if (arg === '--skip-tests') args.skipTests = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--tag=')) args.tag = arg.slice(6);
    else if (arg.startsWith('--checks=')) args.checks = arg.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--stores=')) {
      const value = arg.slice(9);
      args.stores = value === 'all' ? STORES : value.split(',').map((s) => s.trim()).filter(Boolean);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const unknown = args.checks.filter((c) => !ALL_CHECKS.includes(c));
  if (unknown.length) throw new Error(`unknown check(s): ${unknown.join(', ')} — known: ${ALL_CHECKS.join(', ')}`);
  const badStores = args.stores.filter((s) => !STORES.includes(s));
  if (badStores.length) throw new Error(`unknown store(s): ${badStores.join(', ')}`);
  return args;
}

// ── Individual checks ─────────────────────────────────────────────────

// The store rules themselves live in scripts/store-build.mjs — field limits,
// icon dimensions, forbidden keys, per-family key hygiene, every manifest
// reference actually shipping. Preflight does not re-implement any of that; it
// stages both targets somewhere disposable and reports what that validator
// says, so `npm run validate`, `npm run package` and this gate can never
// disagree about what a store accepts.
function checkManifest(report) {
  const dist = mkdtempSync(join(tmpdir(), 'locke-preflight-'));
  try {
    for (const { errors } of buildAll(dist)) {
      for (const error of errors) report.problem('manifest', error);
    }
  } catch (err) {
    report.problem('manifest', `store validation could not run: ${err.message}`);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

// There used to be a `native-host` check here. It cross-checked the pinned
// NATIVE_HOST name, and the published CWS_EXTENSION_ID / EDGE_EXTENSION_ID
// against the native messaging host's allowed_origins. Both halves of that
// contract have to be readable for the check to mean anything, and the host's
// manifest templates are not part of this repository — they are installed by
// the Locke desktop app. The check now lives with the native messaging host;
// it is not verifiable from here, so it is not claimed here either.

// Store listing assets are human-produced (screenshots of a real running
// browser). Nothing here can generate them; the check exists so their absence
// is stated at release time rather than discovered in a submission form.
const REQUIRED_ASSETS = [
  { path: 'docs/store/assets/screenshot-1280x800-1.png', why: 'all three stores require at least one 1280x800 screenshot' },
  { path: 'docs/store/assets/promo-tile-440x280.png', why: 'Chrome Web Store small promo tile' },
  { path: 'docs/store/assets/edge-logo-300x300.png', why: 'Edge Add-ons requires a 300x300 store logo per language' }
];

function checkAssets(report) {
  for (const asset of REQUIRED_ASSETS) {
    if (!existsSync(join(ROOT, asset.path))) report.warn('assets', `${asset.path} is missing — ${asset.why}`);
  }
}

function checkCredentials(report, env, stores) {
  for (const store of stores) {
    const result = credentialsFor(store, { env });
    for (const v of result.missing) {
      report.problem('credentials', `${result.label}: ${v.name} is unset (${v.note})`);
    }
  }

  // The Edge API key expires 72 days after issue and the key itself carries
  // no readable expiry, so the only way to see the cliff coming is to record
  // the issue date.
  if (stores.includes('edge')) {
    const issued = env.EDGE_API_KEY_ISSUED;
    if (!issued) {
      report.warn('credentials', 'EDGE_API_KEY_ISSUED is unset — the Edge API key expires 72 days after issue and there is no way to warn before it does');
    } else {
      const days = Math.floor((Date.now() - Date.parse(issued)) / 86400000);
      if (!Number.isFinite(days)) report.warn('credentials', `EDGE_API_KEY_ISSUED="${issued}" is not a parseable date`);
      else if (days >= 72) report.problem('credentials', `the Edge API key was issued ${days} days ago and expired at 72 — rotate it in Partner Center → Publish API`);
      else if (days >= 58) report.warn('credentials', `the Edge API key expires in ${72 - days} day(s) — rotate it in Partner Center → Publish API`);
    }
  }
}

// The copyright header, on every source file the header script covers.
//
// `add-copyright-headers.mjs --check` has existed since the headers landed
// and was wired to nothing — no npm script, no hook, no gate. A one-time
// sweep with no gate behind it decays from the first file added afterwards,
// silently, and the next person to notice has to redo the sweep.
//
// This is the narrow, honest version of that gate: it asserts only what the
// script itself covers (its own extension map, minus its skip list), so it
// locks in the state the sweep reached rather than claiming more.
function checkHeaders(report) {
  try {
    execFileSync(process.execPath, [join('scripts', 'add-copyright-headers.mjs'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe'
    });
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    report.problem(
      'headers',
      `source files are missing the standard copyright header${output ? `:\n      ${output.split(/\r?\n/).slice(0, 10).join('\n      ')}` : ''}\n      fix: node scripts/add-copyright-headers.mjs`
    );
  }
}

function checkTests(report) {
  // Enumerate the files rather than passing `tests/`: on Node 24 the
  // directory form fails with "Cannot find module ...\tests" on Windows, and
  // execFileSync does not expand the `tests/*.test.js` glob that npm's shell
  // does for `npm test`.
  const files = readdirSync(join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join('tests', f));
  if (files.length === 0) {
    report.problem('tests', 'no tests/*.test.js files found');
    return;
  }
  try {
    execFileSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const failing = output.split(/\r?\n/).filter((l) => /^not ok /.test(l.trim())).slice(0, 10);
    report.problem('tests', `npm test failed${failing.length ? `:\n      ${failing.join('\n      ')}` : ''}`);
  }
}

// ── Runner ────────────────────────────────────────────────────────────

export function runPreflight({ checks = ALL_CHECKS, stores = STORES, tag = null, skipTests = false, env = loadEnv() } = {}) {
  const problems = [];
  const warnings = [];
  const report = {
    problem: (check, message) => problems.push({ check, message }),
    warn: (check, message) => warnings.push({ check, message })
  };

  if (checks.includes('version')) {
    const result = checkVersions({ tag });
    for (const p of result.problems) report.problem('version', p);
  }
  if (checks.includes('manifest')) checkManifest(report);
  if (checks.includes('assets')) checkAssets(report);
  if (checks.includes('credentials')) checkCredentials(report, env, stores);
  if (checks.includes('headers')) checkHeaders(report);
  if (checks.includes('tests') && !skipTests) checkTests(report);

  return { ok: problems.length === 0, problems, warnings, version: readManifest().version };
}

// Importable as a module (tests, publish.mjs) and runnable as a CLI. Compare
// real paths, not URL strings — on Windows the argv path is a drive-letter
// path and import.meta.url is a file:// URL with different escaping.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const result = runPreflight(args);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`preflight — version ${result.version}${args.tag ? ` (tag ${args.tag})` : ''}`);
    for (const w of result.warnings) console.log(`  warn  [${w.check}] ${w.message}`);
    for (const p of result.problems) console.error(`  FAIL  [${p.check}] ${p.message}`);
    console.log(result.ok
      ? `  ok    ${args.checks.join(', ')}${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}`
      : `  ${result.problems.length} problem(s) — not clear to publish`);
  }

  process.exit(result.ok ? 0 : 1);
}
