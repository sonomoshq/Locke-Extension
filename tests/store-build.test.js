// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { join, posix } from 'node:path';

import { LIMITS, PRIVACY_URL, TARGETS, buildAll, entries, root, stage, validate } from '../scripts/store-build.mjs';
import { writeZip } from '../scripts/zip.mjs';

// Every case stages into its own temp dir so a test run never touches dist/.
function withStage(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'locke-store-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Stage a target, mutate its manifest, and return validate()'s complaints.
function validateWith(target, mutate) {
  return withStage((dist) => {
    const staged = stage(target, dist);
    const path = join(staged, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    mutate(manifest);
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return validate(target, staged);
  });
}

// ── the shipped tree passes every store's rules ─────────────────────

test('store: the repo tree validates clean for both targets', () => {
  withStage((dist) => {
    for (const { target, errors } of buildAll(dist)) {
      assert.deepEqual(errors, [], `${target} should validate clean`);
    }
  });
});

// ── per-family manifest transforms ──────────────────────────────────

test('store: the chromium manifest carries no Gecko-only keys', () => {
  withStage((dist) => {
    const m = JSON.parse(readFileSync(join(stage('chromium', dist), 'manifest.json'), 'utf8'));
    assert.equal(m.browser_specific_settings, undefined);
    assert.equal(m.background.scripts, undefined);
    assert.equal(m.background.service_worker, 'background/service-worker.js');
    assert.equal(m.minimum_chrome_version, '120');
  });
});

test('store: the firefox manifest carries no Chromium-only keys', () => {
  withStage((dist) => {
    const m = JSON.parse(readFileSync(join(stage('firefox', dist), 'manifest.json'), 'utf8'));
    assert.equal(m.background.service_worker, undefined);
    assert.deepEqual(m.background.scripts, ['background/service-worker.js']);
    assert.equal(m.minimum_chrome_version, undefined);
    // Chrome-only managed_schema pointer — Firefox uses a native manifest.
    assert.equal(m.storage, undefined);
    assert.equal(m.browser_specific_settings.gecko.id, 'desktop-connector@sonomos.ai');
  });
});

test('store: AMO data-collection consent is declared as "none"', () => {
  // Mandatory for new AMO listings since 2025-11-03. The extension sends
  // nothing off-device, so the declaration is the explicit `none`.
  const gecko = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    .browser_specific_settings.gecko;
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
});

test('store: one target transform cannot leak into the other', () => {
  withStage((dist) => {
    stage('chromium', dist);
    const firefox = JSON.parse(readFileSync(join(stage('firefox', dist), 'manifest.json'), 'utf8'));
    // chromium's transform deletes browser_specific_settings; firefox must
    // still have it (i.e. each target re-reads and deep-copies the source).
    assert.ok(firefox.browser_specific_settings);
  });
});

// ── staged payload ──────────────────────────────────────────────────

test('store: staged payload is runtime-only, PNG icons, no build inputs', () => {
  withStage((dist) => {
    const names = entries(stage('chromium', dist)).map((e) => e.name);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('managed-schema.json'));
    assert.equal(names.filter((n) => n.endsWith('.svg')).length, 0, 'design-master SVGs must not ship');
    assert.ok(!names.includes('shared/ai-surfaces.json'), 'build-input catalog must not ship');
    for (const excluded of ['package.json', 'README.md']) {
      assert.ok(!names.includes(excluded), `${excluded} must not ship`);
    }
    for (const name of names) {
      assert.ok(!name.includes('\\'), `entry '${name}' must use forward slashes`);
      assert.ok(!name.startsWith('/'), `entry '${name}' must be relative`);
    }
  });
});

test('store: the firefox payload drops the Chrome-only managed schema', () => {
  withStage((dist) => {
    const names = entries(stage('firefox', dist)).map((e) => e.name);
    assert.ok(!names.includes('managed-schema.json'));
  });
});

test('store: both targets stage every file their manifest references', () => {
  withStage((dist) => {
    for (const target of Object.keys(TARGETS)) {
      const staged = stage(target, dist);
      const names = new Set(entries(staged).map((e) => e.name));
      const m = JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8'));
      const referenced = [
        ...(m.background.scripts ?? []),
        ...(m.background.service_worker ? [m.background.service_worker] : []),
        ...m.content_scripts.flatMap((cs) => cs.js),
        m.action.default_popup,
        ...Object.values(m.icons)
      ];
      for (const file of referenced) {
        assert.ok(names.has(file), `${target}: manifest references missing '${file}'`);
      }
    }
  });
});

// ── the module graph, not just the manifest's file list ─────────────

// The test above only sees files the manifest NAMES. `background/
// service-worker.js` is an ES module (`background.type: "module"`), so half
// its payload arrives through `import` — including `shared/
// web-surfaces.generated.js`, a build artifact that exists only after
// `npm run generate`. stage() copies whole directories, so an import that
// resolves outside DIRS (or a generated file nobody regenerated) leaves a zip
// that installs fine and then dies with "Failed to resolve module specifier"
// the first time the worker starts — a failure no manifest-level check sees.

// Static ESM edges as they can actually appear at the top level of a module:
//
//   import { a, b } from '../shared/x.js'   (the brace list may span lines)
//   export { a } from './y.js'
//   import './side-effect.js'
//   import('./lazy.js')
//
// Anchored to the start of a line because the word "import" is all over this
// codebase's prose — content/shim.js and shared/constants.js repeatedly
// explain that "a classic script cannot import an ES module" — and a comment
// must not be mistaken for a real edge.
const IMPORT_FROM = /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom[ \t\r\n]*['"]([^'"\n]+)['"]/gm;
const IMPORT_BARE = /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm;
const IMPORT_DYNAMIC = /\bimport[ \t]*\([ \t]*['"]([^'"\n]+)['"]/g;

function specifiersIn(text) {
  const out = [];
  for (const re of [IMPORT_FROM, IMPORT_BARE, IMPORT_DYNAMIC]) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

// Everything the manifest hands the browser as a script entry point. Read off
// the STAGED manifest so each target is checked against what it actually
// ships: chromium runs the service worker, firefox the event-page script.
function entryPointsOf(manifest) {
  return [...new Set([
    ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
    ...(manifest.background?.scripts ?? []),
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? [])
  ])];
}

// Follow `entry`'s relative imports through the staged tree, transitively.
// `shipped` is the entries() name set rather than the filesystem, so a module
// that exists on disk but never reaches the zip (a symlink, say) still counts
// as missing. Returns the unresolvable edges plus every specifier seen.
function walkImports(stagedDir, entry, shipped) {
  const missing = [];
  const bare = [];
  const declared = new Map();
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    // A ↔ B cycles are legal ESM and would otherwise spin here forever.
    if (seen.has(file)) continue;
    seen.add(file);
    if (!shipped.has(file)) continue;

    const specs = specifiersIn(readFileSync(join(stagedDir, ...file.split('/')), 'utf8'));
    declared.set(file, specs);
    for (const spec of specs) {
      // No package/bare specifiers exist in this tree, and none could work:
      // an extension has no resolver and no node_modules. Surfacing it beats
      // skipping it, because "we quietly ignored it" is how the first one ships.
      if (!spec.startsWith('./') && !spec.startsWith('../')) { bare.push({ file, spec }); continue; }
      const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
      if (shipped.has(resolved)) queue.push(resolved);
      else missing.push({ file, spec, resolved });
    }
  }
  return { missing, bare, declared };
}

test('store: both targets stage every module their entry points import', () => {
  withStage((dist) => {
    for (const target of Object.keys(TARGETS)) {
      const staged = stage(target, dist);
      const shipped = new Set(entries(staged).map((e) => e.name));
      const manifest = JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8'));
      const points = entryPointsOf(manifest);
      assert.ok(points.length > 0, `${target}: no script entry points found in the staged manifest`);

      for (const entry of points) {
        const { missing, bare } = walkImports(staged, entry, shipped);
        for (const { file, spec, resolved } of missing) {
          assert.fail(
            `${target}: entry point '${entry}' reaches '${file}', which imports '${spec}' ` +
            `→ '${resolved}' — that file is not in the staged tree, so the packaged ` +
            'extension fails to load. Add its directory to DIRS in scripts/store-build.mjs ' +
            '(or run `npm run generate` if it is a generated file).'
          );
        }
        for (const { file, spec } of bare) {
          assert.fail(
            `${target}: entry point '${entry}' reaches '${file}', which imports the bare ` +
            `specifier '${spec}'. Extensions have no module resolver — only './' and '../' ` +
            'paths load. Vendor the dependency into shared/ instead.'
          );
        }
      }
    }
  });
});

test('store: content scripts declare no imports — they are classic scripts', () => {
  // content_scripts entries are injected as classic scripts; there is no
  // `type: "module"` for them in MV3. An `import` here throws a SyntaxError at
  // injection time and the surface silently loses its guard, which is why
  // content/shim.js carries inline copies of shared constants instead.
  withStage((dist) => {
    const staged = stage('chromium', dist);
    const shipped = new Set(entries(staged).map((e) => e.name));
    const manifest = JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts.flatMap((cs) => cs.js);
    assert.ok(scripts.length > 0, 'expected content scripts to check');

    for (const file of scripts) {
      const { declared } = walkImports(staged, file, shipped);
      assert.deepEqual(
        declared.get(file), [],
        `${file} is a content script and must not import; inline what it needs instead`
      );
    }
  });
});

// ── validation actually rejects ─────────────────────────────────────

test('store: a description over the 132-char limit fails', () => {
  const errors = validateWith('chromium', (m) => { m.description = 'x'.repeat(LIMITS.description + 1); });
  assert.ok(errors.some((e) => e.includes('description is')), errors.join('\n'));
});

test('store: update_url / key in the package fail', () => {
  // Both get a Chrome Web Store upload auto-rejected.
  for (const key of ['update_url', 'key']) {
    const errors = validateWith('chromium', (m) => { m[key] = 'x'; });
    assert.ok(errors.some((e) => e.includes(key)), `${key}: ${errors.join('\n')}`);
  }
});

test('store: a manifest/package.json version mismatch fails', () => {
  const errors = validateWith('chromium', (m) => { m.version = '9.9.9'; });
  assert.ok(errors.some((e) => e.includes('package.json version')), errors.join('\n'));
});

test('store: a malformed version fails', () => {
  const errors = validateWith('chromium', (m) => { m.version = '2.0.0-beta'; });
  assert.ok(errors.some((e) => e.includes('integers')), errors.join('\n'));
});

test('store: a missing icon size fails', () => {
  const errors = validateWith('chromium', (m) => { delete m.icons['128']; });
  assert.ok(errors.some((e) => e.includes('icons.128')), errors.join('\n'));
});

test('store: an icon whose pixels do not match its declared size fails', () => {
  const errors = validateWith('chromium', (m) => { m.icons['128'] = 'icons/icon-48.png'; });
  assert.ok(errors.some((e) => e.includes('48x48')), errors.join('\n'));
});

test('store: a manifest reference to a file that is not packaged fails', () => {
  const errors = validateWith('chromium', (m) => { m.action.default_popup = 'popup/missing.html'; });
  assert.ok(errors.some((e) => e.includes('not in the package')), errors.join('\n'));
});

test('store: a CSP that permits unsafe-eval fails', () => {
  const errors = validateWith('chromium', (m) => {
    m.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'; object-src 'self'";
  });
  assert.ok(errors.some((e) => e.includes('unsafe-eval')), errors.join('\n'));
});

test('store: leftover cross-family keys fail their target', () => {
  const chromium = validateWith('chromium', (m) => { m.browser_specific_settings = { gecko: { id: 'a@b' } }; });
  assert.ok(chromium.some((e) => e.includes('Gecko-only')), chromium.join('\n'));

  const firefox = validateWith('firefox', (m) => { m.background.service_worker = 'background/service-worker.js'; });
  assert.ok(firefox.some((e) => e.includes('unsupported in Firefox')), firefox.join('\n'));
});

test('store: firefox without a data-collection declaration fails', () => {
  const errors = validateWith('firefox', (m) => {
    delete m.browser_specific_settings.gecko.data_collection_permissions;
  });
  assert.ok(errors.some((e) => e.includes('data_collection_permissions')), errors.join('\n'));
});

test('store: technicalAndInteraction may not be a required data permission', () => {
  const errors = validateWith('firefox', (m) => {
    m.browser_specific_settings.gecko.data_collection_permissions = { required: ['technicalAndInteraction'] };
  });
  assert.ok(errors.some((e) => e.includes('technicalAndInteraction')), errors.join('\n'));
});

test('store: a non-email, non-GUID gecko id fails', () => {
  const errors = validateWith('firefox', (m) => { m.browser_specific_settings.gecko.id = 'locke'; });
  assert.ok(errors.some((e) => e.includes('gecko.id')), errors.join('\n'));
});

test('store: the popup links the extension-specific privacy policy', () => {
  // The company-wide policy at sonomos.ai/privacy does not cover the
  // extension; every store checks that the listing's policy is the one the
  // extension actually points users at.
  assert.equal(PRIVACY_URL, 'https://sonomos.ai/locke/privacy');
  const popup = readFileSync(join(root, 'popup/popup.html'), 'utf8');
  assert.ok(popup.includes(PRIVACY_URL), 'popup must link the extension privacy policy');
});

test('store: linking the company-wide privacy policy instead fails', () => {
  withStage((dist) => {
    const staged = stage('chromium', dist);
    const popup = join(staged, 'popup/popup.html');
    writeFileSync(popup, readFileSync(popup, 'utf8').replace(PRIVACY_URL, 'https://sonomos.ai/privacy'));
    const errors = validate('chromium', staged);
    assert.ok(errors.some((e) => e.includes('company-wide privacy policy')), errors.join('\n'));
  });
});

test('store: shipping no privacy-policy link at all fails', () => {
  withStage((dist) => {
    const staged = stage('chromium', dist);
    const popup = join(staged, 'popup/popup.html');
    writeFileSync(popup, readFileSync(popup, 'utf8').replaceAll(PRIVACY_URL, 'https://example.invalid/'));
    const errors = validate('chromium', staged);
    assert.ok(errors.some((e) => e.includes('no shipped page links the privacy policy')), errors.join('\n'));
  });
});

// ── zip writer ──────────────────────────────────────────────────────

// Parse local file headers back out of an archive.
function readEntries(buf) {
  const out = [];
  let i = 0;
  while ((i = buf.indexOf('PK\x03\x04', i)) !== -1) {
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const usize = buf.readUInt32LE(i + 22);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nlen);
    const start = i + 30 + nlen + elen;
    const body = buf.subarray(start, start + csize);
    out.push({ name, data: method === 8 ? inflateRawSync(body) : body, usize });
    i = start + csize;
  }
  return out;
}

test('zip: entries round-trip with forward slashes and intact bytes', () => {
  // PowerShell 5.1's Compress-Archive writes backslash separators here, which
  // the stores reject ("manifest file not found") — this is the regression
  // guard for that.
  withStage((dist) => {
    const staged = stage('chromium', dist);
    const source = entries(staged);
    const zipPath = join(dist, 'test.zip');
    writeZip(zipPath, source);

    const got = readEntries(readFileSync(zipPath));
    assert.equal(got.length, source.length);
    assert.deepEqual(got.map((e) => e.name), source.map((e) => e.name));
    for (const entry of got) {
      assert.ok(!entry.name.includes('\\'), `'${entry.name}' must not use backslashes`);
      const expected = source.find((s) => s.name === entry.name).data;
      assert.equal(entry.usize, expected.length);
      assert.ok(entry.data.equals(expected), `${entry.name} bytes differ after round-trip`);
    }
    // manifest.json must be resolvable at the archive root.
    assert.ok(got.some((e) => e.name === 'manifest.json'));
  });
});

test('zip: the same input produces byte-identical archives', () => {
  withStage((dist) => {
    const source = entries(stage('chromium', dist));
    const a = join(dist, 'a.zip');
    const b = join(dist, 'b.zip');
    writeZip(a, source);
    writeZip(b, source);
    assert.ok(readFileSync(a).equals(readFileSync(b)), 'zip output must be deterministic');
  });
});

test('zip: a traversal entry name is refused', () => {
  withStage((dist) => {
    assert.throws(
      () => writeZip(join(dist, 'bad.zip'), [{ name: '../escape.js', data: Buffer.from('x') }]),
      /traversal/
    );
  });
});

test('zip: SOURCE_DATE_EPOCH pins the entry timestamps', () => {
  // The fixed 2020 stamp already makes two builds of one tree identical. This
  // is the other half of the reproducibility promise in RELEASE-POLICY.md: an
  // auditor checks out a tag, exports the tag commit's time, rebuilds, and
  // must get the published bytes back.
  withStage((dist) => {
    const source = entries(stage('chromium', dist));
    const before = process.env.SOURCE_DATE_EPOCH;
    try {
      const fixed = join(dist, 'fixed.zip');
      delete process.env.SOURCE_DATE_EPOCH;
      writeZip(fixed, source);

      process.env.SOURCE_DATE_EPOCH = '1700000000';
      const pinned = join(dist, 'pinned.zip');
      const pinnedAgain = join(dist, 'pinned-again.zip');
      writeZip(pinned, source);
      writeZip(pinnedAgain, source);

      assert.ok(!readFileSync(fixed).equals(readFileSync(pinned)), 'the pinned epoch must actually reach the headers');
      assert.ok(readFileSync(pinned).equals(readFileSync(pinnedAgain)), 'a pinned epoch must still be deterministic');

      // An unparseable value falls back rather than writing a garbage stamp.
      process.env.SOURCE_DATE_EPOCH = 'not-a-number';
      const junk = join(dist, 'junk.zip');
      writeZip(junk, source);
      assert.ok(readFileSync(junk).equals(readFileSync(fixed)));
    } finally {
      if (before === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = before;
    }
  });
});

test('store: a symlink in a staged tree is skipped, not followed', async (t) => {
  // cpSync does not dereference by default, so a symlink under background/,
  // content/, popup/ or shared/ really can reach the staged tree — and one
  // pointing outside the repo would otherwise have its target's bytes shipped
  // inside a store zip under an innocuous name.
  const { symlinkSync } = await import('node:fs');
  const outside = mkdtempSync(join(tmpdir(), 'locke-outside-'));
  try {
    const secret = join(outside, 'release.env');
    writeFileSync(secret, 'AMO_JWT_SECRET=real');
    withStage((dist) => {
      const staged = stage('chromium', dist);
      try {
        symlinkSync(secret, join(staged, 'shared', 'leaked.js'));
      } catch (err) {
        // Windows needs Developer Mode or elevation. Skip only when the OS
        // actually refuses — a blanket platform skip would hide this on every
        // Windows machine, including the ones that can run it.
        if (err.code === 'EPERM' || err.code === 'UNKNOWN') return t.skip(`cannot create symlinks here (${err.code})`);
        throw err;
      }
      assert.ok(!entries(staged).some((e) => e.name === 'shared/leaked.js'));
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('store: a non-loopback host permission fails', () => {
  // docs/security/CONTROL-CATALOG.md, ASVS-MAPPING.md 11.1.1 and
  // RISK-REGISTER.md R-01 all cite a build-time tripwire for this. An
  // enterprise customer following those citations has to find a real check.
  const errors = validateWith('chromium', (m) => { m.host_permissions = ['https://example.com/*']; });
  assert.match(errors.join('\n'), /is not loopback-only/);
  assert.deepEqual(validateWith('chromium', (m) => { m.host_permissions = ['http://127.0.0.1/*']; }), []);
});

test('store: a wildcard content-script host fails in every spelling', () => {
  for (const match of ['<all_urls>', '*://*/*', 'https://*/*', 'http://*/*', '*://*.com/*']) {
    const errors = validateWith('chromium', (m) => { m.content_scripts[0].matches = [match]; });
    assert.match(errors.join('\n'), /is a wildcard host/, match);
  }
  // A narrow subdomain pattern is normal and must not trip the check.
  assert.deepEqual(validateWith('chromium', (m) => { m.content_scripts[0].matches = ['https://*.google.com/*']; }), []);
});
