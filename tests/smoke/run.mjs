// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Developer-run, in-browser smoke check:  npm run smoke
//
// ═══════════════════════════════════════════════════════════════════════
//  THIS IS NOT CI. Nothing in .github/workflows runs this file, and it
//  gates nothing. It exists because every other test in this repository
//  runs the extension's modules OUTSIDE a browser — node:test plus a vm
//  sandbox for shim.js — so the one thing none of them can answer is
//  "does the extension still do anything at all when a real browser
//  loads it". That answer is worth having; pretending it is a gate would
//  not be. See docs/testing/BROWSER-SMOKE.md.
// ═══════════════════════════════════════════════════════════════════════
//
// What it checks, on each browser it can actually drive:
//
//   1. dist/<target>/ loads as an unpacked extension.
//   2. On ONE catalog host (shared/ai-surfaces.json → web_hosts), the
//      MAIN-world shim has replaced `window.fetch`. The check is
//      `Function.prototype.toString.call(window.fetch)` not containing
//      `[native code]`: content/shim.js assigns a plain `async function`
//      over `window.fetch` and does NOT spoof `toString` (grep it — there
//      is no `toString` anywhere in that file), so this is a true property
//      of the shipped shim rather than a convention we hope holds.
//   3. The extension reports NO_BRIDGE — cleanly, and as a PASS.
//      An unpacked Chromium load gets a fresh extension ID derived from its
//      path, and the desktop app's native-messaging manifest allows only the
//      published store IDs, so the browser refuses to start the host. That is
//      the EXPECTED state here, not a failure: this repository has no way to
//      authorise a development ID (that is a desktop-app-side step — see
//      README "Install", step 3). So the assertion is that the extension
//      says so accurately, not that it connects.
//   4. No console errors attributable to the extension. `console.warn` is
//      EXPECTED — the shim warns on every block, deliberately and loudly
//      (content/shim.js "SELF-DIAGNOSING") — so only level `error` counts,
//      and only when it can be attributed to us. See attribution() below for
//      what that means per browser and where it is weaker than we would like.
//
// SKIP, NEVER FAIL, on absence. A missing browser, a missing driver, no
// network: those say what is missing and how to install it, and exit 0. A
// harness that goes red because a developer does not have Firefox teaches
// people to ignore it.
//
// Driver: Puppeteer, one dependency for both browsers. Chrome over CDP with
// `Extensions.loadUnpacked` (puppeteer >= 24 exposes it as
// `browser.installExtension()`), Firefox over WebDriver BiDi with the same
// call installing a temporary add-on. Playwright would have needed a second
// tool (web-ext) for the Firefox half, and `page.on('console')` would then
// mean two different things on the two rows of one table.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyFor } from '../../popup/copy.js';
import { SCREENING, STATE_KEY, STATUS } from '../../shared/constants.js';
import { writeReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// The exact command a developer needs when something is missing. Printed
// verbatim in every skip message: a skip that does not say how to fix itself
// is a skip nobody ever converts into a run.
const INSTALL_DRIVER = 'cd tests/smoke && npm install';
const INSTALL_BROWSER = (browser) => `cd tests/smoke && npx puppeteer browsers install ${browser}`;

// ONE catalog host. Not a sample of them — this is a smoke check, and the
// scoping logic that decides WHICH hosts are in scope is already covered
// exhaustively by tests/shim.test.js against the real file. What a browser
// adds is only "did the injection happen at all", and one host answers that.
const CATALOG_HOST = 'https://chatgpt.com/';

// An allow-listed capture path for CATALOG_HOST, from
// content/web-surfaces.generated.js (SONOMOS_CAPTURE_PATHS). It has to be one
// of those: chatgpt.com is a NARROWED host, so a made-up path is deliberately
// out of scope and the shim would — correctly — ignore it, which would prove
// nothing. See the enforcement-probe comment in `runBrowser` for what this
// request does and does not send.
const CAPTURE_PATH = '/backend-api/conversation';

// The shim's console prefix (content/shim.js `LOG_PREFIX`). Used for
// attribution on Firefox, where a WebExtension's console frames arrive as
// `<anonymous code>` with no moz-extension:// URL to key on.
const LOG_PREFIX = '[sonomos]';

const BROWSERS = [
  {
    key: 'chromium',
    puppeteerBrowser: 'chrome',
    label: 'Chrome',
    dist: 'dist/chromium',
    // manifest.json `minimum_chrome_version`, read at runtime rather than
    // hardcoded, so the floor this harness enforces cannot drift from the
    // floor the extension declares.
    floor: (manifest) => Number(manifest.minimum_chrome_version) || 0,
    extensionScheme: 'chrome-extension://'
  },
  {
    key: 'firefox',
    puppeteerBrowser: 'firefox',
    label: 'Firefox',
    dist: 'dist/firefox',
    floor: (manifest) =>
      Number(String(manifest.browser_specific_settings?.gecko?.strict_min_version ?? '').split('.')[0]) || 0,
    extensionScheme: 'moz-extension://'
  }
];

// ── argument handling ────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const options = {
  build: !has('--no-build'),
  write: !has('--no-write'),
  out: value('out') ?? join(repoRoot, 'docs', 'testing', 'BROWSER-SMOKE.md'),
  only: value('only'),
  // Headful is occasionally the only way to see what a browser is doing.
  headless: !has('--headed'),
  // The one check that issues a real (held) request. On by default because
  // it is the ONLY way to observe NO_BRIDGE on Firefox — see runBrowser.
  enforcementProbe: !has('--no-enforcement-probe')
};

const log = (...parts) => console.log(...parts);

// ── helpers ──────────────────────────────────────────────────────────

function readManifest() {
  return JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
}

/** Major version from a browser's `Browser.version()` string ("Chrome/152.0…"). */
function majorVersion(versionString) {
  const digits = /(\d+)/.exec(String(versionString).split('/').pop() ?? '');
  return digits ? Number(digits[1]) : 0;
}

/**
 * Build dist/chromium and dist/firefox by running the repo's own packager.
 *
 * Deliberately the same entry point a release uses (`npm run package` →
 * scripts/package.mjs), not a private copy of the staging logic: a smoke test
 * that builds its own tree is testing a tree nobody ships.
 */
function buildDist() {
  log('· building dist/ (node scripts/package.mjs)');
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'package.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    return false;
  }
  return true;
}

/**
 * Is this console message ours?
 *
 * Chromium: every frame of an extension's stack carries
 * `chrome-extension://<id>/…`, including for a MAIN-world content script, so
 * attribution is exact and a page's own errors are excluded with confidence.
 *
 * Firefox: it is NOT exact. A WebExtension's console frames arrive with the
 * URL `<anonymous code>` — indistinguishable from some page frames — so the
 * only honest key left is the shim's own `[sonomos]` prefix. That catches
 * everything the shim says on purpose and would MISS an uncaught internal
 * exception, which is exactly the thing an error-level assertion most wants
 * to catch. The report says so rather than implying parity.
 */
function attribution(browser, extensionId) {
  const prefix = extensionId ? `${browser.extensionScheme}${extensionId}/` : browser.extensionScheme;
  return (message) => {
    const urls = [message.url, ...(message.stack ?? [])].filter(Boolean);
    if (urls.some((u) => u.startsWith(prefix))) return true;
    return String(message.text).startsWith(LOG_PREFIX);
  };
}

/** Attach console/pageerror collection to a page, returning the live array. */
function collect(page) {
  const messages = [];
  page.on('console', (m) => {
    messages.push({
      type: m.type(),
      text: m.text(),
      url: m.location()?.url ?? null,
      stack: (m.stackTrace?.() ?? []).map((f) => f.url).filter(Boolean)
    });
  });
  // An uncaught exception never reaches `console`, so it has to be collected
  // separately or the loudest possible failure would be the one we miss.
  page.on('pageerror', (e) => {
    messages.push({ type: 'pageerror', text: String(e?.message ?? e), url: null, stack: [] });
  });
  return messages;
}

const isError = (m) => m.type === 'error' || m.type === 'pageerror';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the per-browser run ──────────────────────────────────────────────

/**
 * Drive one browser. Never throws for an environmental reason: an absent
 * browser, an absent driver or a dead network all come back as
 * `{ result: 'skip', … }` and the process still exits 0.
 *
 * @returns {Promise<object>} one row for the results table.
 */
async function runBrowser(puppeteer, browser, manifest) {
  const row = {
    browser: browser.label,
    version: null,
    launched: null,
    loadPath: browser.dist,
    extensionId: null,
    popup: 'not observed',
    fetchHook: 'not observed',
    noBridge: 'not observed',
    consoleErrors: 'not observed',
    result: 'skip',
    notes: []
  };

  const extensionDir = join(repoRoot, browser.dist);
  if (!existsSync(extensionDir)) {
    row.notes.push(`${browser.dist} does not exist — run \`npm run package\` (or drop --no-build).`);
    return row;
  }

  // Ask Puppeteer where the binary is, but do NOT trust the answer as a
  // gate. `puppeteer.executablePath({ browser: 'firefox' })` resolves the
  // path using the CHROME build id (verified on puppeteer 25.9.0: it names a
  // firefox/win64-<chrome-build-id> directory that does not exist), while
  // `launch()` resolves the installed Firefox correctly. So a path that
  // exists is used and reported; a path that does not is discarded and
  // launch() is left to do its own resolution. The skip then comes from a
  // real launch failure, which is the only trustworthy evidence of absence.
  let executablePath;
  try {
    const guess = await puppeteer.executablePath({ browser: browser.puppeteerBrowser });
    if (guess && existsSync(guess)) executablePath = guess;
  } catch { /* no cached download; launch() may still find a system install */ }

  let instance = null;
  try {
    instance = await puppeteer.launch({
      browser: browser.puppeteerBrowser,
      ...(executablePath ? { executablePath } : {}),
      headless: options.headless,
      // Chrome: `enableExtensions: true` only stops Puppeteer adding
      // `--disable-extensions`. The extension itself is installed below, by
      // hand, because that call is what returns the ID — and without the ID
      // there is no popup URL to open.
      ...(browser.key === 'chromium' ? { enableExtensions: true, args: ['--no-first-run'] } : {})
    });
  } catch (e) {
    row.notes.push(
      `SKIP — no ${browser.label} for Puppeteer to drive: ` +
        `${String(e?.message ?? e).split('\n')[0].slice(0, 220)}. ` +
        `Install one with: ${INSTALL_BROWSER(browser.puppeteerBrowser)}`
    );
    return row;
  }

  try {
    const versionString = await instance.version();
    row.version = versionString;
    row.launched = `puppeteer.launch({ browser: '${browser.puppeteerBrowser}', headless: ${options.headless} })`;
    row.notes.push(`binary: ${instance.process()?.spawnfile ?? executablePath ?? 'unknown'}`);

    const floor = browser.floor(manifest);
    if (majorVersion(versionString) < floor) {
      row.notes.push(
        `SKIP — ${versionString} is below the manifest's declared floor of ${floor}. ` +
          `Install a newer one with: ${INSTALL_BROWSER(browser.puppeteerBrowser)}`
      );
      return row;
    }

    row.extensionId = await instance.installExtension(extensionDir);
    row.loadPath = `${browser.dist} (unpacked, id ${row.extensionId})`;

    const mine = attribution(browser, browser.key === 'chromium' ? row.extensionId : null);

    // ── the catalog page ──
    const page = await instance.newPage();
    const pageMessages = collect(page);
    try {
      await page.goto(CATALOG_HOST, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (e) {
      row.notes.push(
        `SKIP — could not reach ${CATALOG_HOST}: ${String(e?.message ?? e).slice(0, 200)}. ` +
          'This check needs network access to one real catalog host; the shim only ' +
          'runs on hosts the manifest names, so there is no offline stand-in.'
      );
      return row;
    }
    // document_start means the hook is already installed by the time the
    // navigation resolves; the wait is for the isolated-world relay and the
    // SONOMOS_CONFIG post, which the enforcement probe below needs.
    await sleep(1500);

    const fetchSource = await page.evaluate(() =>
      Function.prototype.toString.call(window.fetch)
    );
    const hooked = !fetchSource.includes('[native code]');
    row.fetchHook = hooked ? 'PASS — window.fetch is wrapped (no [native code])' : 'FAIL — window.fetch is native';

    // ── NO_BRIDGE, observed two different ways ──
    //
    // Chromium: read it straight out of the service worker's own session
    // state. That is the fact itself, not a rendering of it.
    let backgroundStatus = null;
    if (browser.key === 'chromium') {
      try {
        const target = await instance.waitForTarget(
          (t) => t.type() === 'service_worker' && t.url().includes(row.extensionId),
          { timeout: 20_000 }
        );
        const worker = await target.worker();
        const state = await worker.evaluate(async (key) => {
          const got = await chrome.storage.session.get(key);
          return got?.[key] ?? null;
        }, STATE_KEY);
        backgroundStatus = state?.status ?? null;
        row.notes.push(`background state: status=${backgroundStatus}, screening=${state?.screening ?? 'n/a'}`);
      } catch (e) {
        row.notes.push(`background state not readable: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    } else {
      row.notes.push(
        'background state: not observable — Firefox does not expose the ' +
          'extension event page as a WebDriver BiDi target, so there is no ' +
          'context to evaluate chrome.storage.session in.'
      );
    }

    // Both browsers: make the extension SAY it, through the enforcement path.
    //
    // This issues one real in-scope request. It is the only way to observe
    // NO_BRIDGE on Firefox, and it is worth saying plainly what it does: on
    // the state this harness asserts, the shim HOLDS the request, gets
    // `no-bridge` back from the relay, blocks, and the bytes never leave the
    // machine — the block is the observation. On a machine where the desktop
    // app IS reachable and this load IS authorised, the premise does not hold
    // and the request would go out (unauthenticated, body `{"smoke":true}`),
    // so that outcome is reported as a SKIP rather than quietly passed.
    // `--no-enforcement-probe` turns it off.
    let probe = null;
    const probeWorthRunning =
      options.enforcementProbe && (browser.key !== 'chromium' || backgroundStatus === STATUS.NO_BRIDGE);
    if (options.enforcementProbe && !probeWorthRunning) {
      row.notes.push(
        `enforcement probe skipped: background status is '${backgroundStatus}', not '${STATUS.NO_BRIDGE}' — ` +
          'this machine has a working bridge, so there is nothing to assert.'
      );
    }
    if (probeWorthRunning) {
      probe = await page.evaluate(async (path) => {
        try {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"smoke":true}'
          });
          return { blocked: false, status: response.status };
        } catch (e) {
          return { blocked: true, message: String(e?.message ?? e) };
        }
      }, CAPTURE_PATH);
      await sleep(1200);
    }

    // The shim names every block on the console with a stable `reason=`
    // (content/shim.js RELAY_BLOCK_REASON maps the worker's `no-bridge` to
    // `connector-not-started`). Finding that string is a direct observation
    // that the background reported NO_BRIDGE.
    const sawConnectorNotStarted = pageMessages.some(
      (m) => m.text.includes('reason=connector-not-started') && m.text.startsWith(LOG_PREFIX)
    );

    if (probe?.blocked && sawConnectorNotStarted) {
      row.noBridge = 'PASS — in-scope request held and blocked, reason=connector-not-started';
    } else if (backgroundStatus === STATUS.NO_BRIDGE) {
      row.noBridge = `PASS — background reports status='${STATUS.NO_BRIDGE}'`;
    } else if (probe && !probe.blocked) {
      row.noBridge = `SKIP — in-scope request was NOT blocked (HTTP ${probe.status}); this machine has a working bridge`;
    } else if (backgroundStatus && backgroundStatus !== STATUS.NO_BRIDGE) {
      // A developer running this on their own machine, with Locke installed
      // and this load already authorised, is not looking at a defect: the
      // state this harness asserts simply is not the state they are in.
      // Calling that a failure would train them to ignore a red run.
      row.noBridge = `SKIP — background reports status='${backgroundStatus}'; this machine has a working bridge`;
    } else if (!options.enforcementProbe && browser.key === 'firefox') {
      row.noBridge = 'not observable — --no-enforcement-probe, and Firefox exposes no other view of it';
    } else {
      row.noBridge = 'FAIL — could not observe NO_BRIDGE';
    }
    if (probe?.blocked) {
      row.notes.push(`enforcement probe: POST ${CAPTURE_PATH} was blocked by the shim — nothing left the machine.`);
    }

    // ── the popup ──
    if (browser.key === 'chromium') {
      const popup = await instance.newPage();
      const popupMessages = collect(popup);
      await popup.goto(`chrome-extension://${row.extensionId}/popup/popup.html`, {
        waitUntil: 'domcontentloaded'
      });
      // popup.js renders "Checking…" from the static HTML, then re-renders
      // from the background state. Poll for the second render rather than
      // sleeping a guessed interval.
      try {
        await popup.waitForFunction(
          () => document.getElementById('statusBadge')?.textContent !== 'Checking…',
          { timeout: 15_000 }
        );
      } catch {
        row.notes.push('popup never left its "Checking…" placeholder within 15 s');
      }
      const rendered = await popup.evaluate(() => ({
        badge: document.getElementById('statusBadge')?.textContent ?? null,
        view: document.getElementById('statusBadge')?.dataset.status ?? null,
        screeningLabel: document.getElementById('screeningValue')?.textContent ?? null,
        screening: document.getElementById('screeningValue')?.dataset.screening ?? null,
        detail: document.getElementById('statusDetail')?.textContent ?? null
      }));

      // Two questions, deliberately kept apart.
      //
      // (a) Does the popup render what popup/copy.js says for the state the
      //     background is actually in? That is the DOM assertion, and the
      //     expected strings are COMPUTED from copy.js — imported live, pure,
      //     the same module popup.js itself calls — rather than transcribed
      //     into this file, where they would drift the first time the copy is
      //     reworded and this harness would go on asserting the old sentence.
      //
      // (b) Is that state NO_BRIDGE / the `setup` view? On a developer's own
      //     machine with Locke installed and this load authorised it may not
      //     be, and that is not a defect — so it downgrades the row to a skip
      //     instead of failing it.
      const observedStatus = backgroundStatus ?? STATUS.NO_BRIDGE;
      const expected = copyFor({
        status: observedStatus,
        screening: rendered.screening ?? SCREENING.UNCONFIRMED
      });
      const rendersCopy =
        rendered.badge === expected.badge &&
        rendered.screeningLabel === expected.screeningLabel &&
        rendered.detail === expected.detail;
      if (!rendersCopy) {
        row.popup = `FAIL — rendered ${JSON.stringify(rendered)}; copy.js expected ${JSON.stringify({
          badge: expected.badge,
          screeningLabel: expected.screeningLabel
        })}`;
      } else if (rendered.view === 'setup') {
        row.popup = `PASS — view='setup', badge='${rendered.badge}', screening='${rendered.screeningLabel}' (matches popup/copy.js)`;
      } else {
        row.popup =
          `SKIP — the popup renders popup/copy.js correctly, but the state is ` +
          `'${observedStatus}' (view='${rendered.view}'), not the NO_BRIDGE/setup this harness asserts`;
      }

      const popupErrors = popupMessages.filter(isError);
      row.notes.push(
        `popup console: ${popupMessages.length} message(s), ${popupErrors.length} at level error` +
          (popupErrors.length ? `: ${popupErrors.map((m) => m.text.slice(0, 120)).join(' | ')}` : '')
      );
      await popup.close();
    } else {
      row.popup =
        'not observable — Firefox/BiDi refuses to navigate a content browsing ' +
        'context to a moz-extension:// URL ("unsupported operation … is not allowed in this context")';
    }

    // ── console errors ──
    const errors = pageMessages.filter(isError);
    const ours = errors.filter(mine);
    const theirs = errors.length - ours.length;
    row.consoleErrors =
      ours.length === 0
        ? `PASS — 0 attributable (${theirs} from the page itself, not counted)`
        : `FAIL — ${ours.length} attributable: ${ours.map((m) => m.text.slice(0, 120)).join(' | ')}`;
    const warns = pageMessages.filter((m) => m.type === 'warning' || m.type === 'warn').filter(mine);
    row.notes.push(`${warns.length} attributable console.warn (expected — the shim warns on every block)`);
    if (theirs > 0) {
      // Named, not merely counted: "we filtered some errors out" is only a
      // defensible claim if a reader can see which ones and judge for
      // themselves that none of them are ours.
      const excluded = errors.filter((m) => !mine(m)).map((m) => m.text.slice(0, 90));
      const shown = excluded.slice(0, 6);
      row.notes.push(
        `page-origin errors excluded (${excluded.length}): ${shown.join(' | ')}` +
          (excluded.length > shown.length ? ` | …and ${excluded.length - shown.length} more` : '')
      );
    }

    // ── verdict ──
    const cells = [row.popup, row.fetchHook, row.noBridge, row.consoleErrors];
    if (cells.some((c) => c.startsWith('FAIL'))) row.result = 'fail';
    else if (cells.some((c) => c.startsWith('SKIP'))) row.result = 'skip';
    else if (cells.some((c) => c.startsWith('not observable'))) row.result = 'pass (partial)';
    else row.result = 'pass';
    return row;
  } catch (e) {
    row.result = 'fail';
    row.notes.push(`unexpected harness error: ${String(e?.stack ?? e).slice(0, 400)}`);
    return row;
  } finally {
    try { await instance.close(); } catch { /* already gone */ }
  }
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  log('Locke extension — in-browser smoke (developer-run; NOT CI, NOT a gate)\n');

  // The driver is checked BEFORE the build: on a checkout where the harness
  // was never installed — the common case, since it is opt-in — there is no
  // reason to spend a package build on a run that is about to skip.
  //
  // The driver is the one thing this repository deliberately does not have
  // installed by default. Its absence is a skip, with the command.
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch (e) {
    log('SKIP — the smoke harness is not installed.');
    log(`  ${String(e?.message ?? e).split('\n')[0]}`);
    log('');
    log('  Install it (opt-in, gitignored, nothing is added to the root package.json):');
    log(`    ${INSTALL_DRIVER}`);
    log('');
    log('  Note: use `cd tests/smoke && npm install`, NOT `npm --prefix tests/smoke install`.');
    log('  npm 11 rewrites the nested manifest when installed through --prefix from the');
    log('  repo root, adding a `file:../..` dependency on the extension itself.');
    return 0;
  }

  if (options.build && !buildDist()) {
    console.error('\nnpm run package failed — cannot smoke-test a tree that will not build.');
    return 1;
  }

  const manifest = readManifest();
  const targets = BROWSERS.filter((b) => !options.only || b.key === options.only);
  const rows = [];
  for (const browser of targets) {
    log(`· ${browser.label}`);
    const row = await runBrowser(puppeteer, browser, manifest);
    rows.push(row);
    log(`  → ${row.result}`);
    for (const note of row.notes) log(`    ${note}`);
  }

  const report = writeReport({
    rows,
    catalogHost: CATALOG_HOST,
    out: options.write ? options.out : null,
    repoRoot
  });
  log('');
  log(report.table);
  if (report.written) log(`\nwritten to ${report.written}`);

  const failed = rows.filter((r) => r.result === 'fail');
  if (failed.length > 0) {
    console.error(`\n${failed.length} browser row(s) FAILED.`);
    return 1;
  }
  log('\nno failures. Rows marked skip / not observable are recorded as such, not as passes.');
  return 0;
}

process.exit(await main());
