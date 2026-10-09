// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PRESENCE_URL } from '../shared/constants.js';

// The manifest IS the capture boundary. Everything in content/shim.js only
// runs where `content_scripts` puts it, so a `matches` list or a frame-matching
// key that drifts from the catalog is a hole no amount of care inside the shim
// can close. These tests pin the injection surface itself.
//
// It is the EGRESS boundary too, and for the same reason: what the extension
// can reach is decided here, not in the code that reaches.

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);
const surfaces = JSON.parse(
  await readFile(new URL('../shared/ai-surfaces.json', import.meta.url), 'utf8')
);

// The content_scripts entries that carry the shim / its content-script half —
// i.e. the capture surface, as opposed to any future unrelated injection.
const captureEntries = manifest.content_scripts.filter((cs) => {
  const js = (cs.js || []).join(',');
  return js.includes('content/shim.js') || js.includes('content/content-script.js');
});

const catalogHosts = [...new Set(
  surfaces.providers.flatMap((p) => p.web_hosts || []).map((h) => h.toLowerCase())
)].sort();

test('manifest: both halves of the capture surface are declared', () => {
  assert.equal(captureEntries.length, 2, 'the MAIN-world shim and its isolated-world relay');
});

// ── opaque-scheme frames ───────────────────────────────────────────
//
// `all_frames` injects into frames whose OWN url matches — not into every
// frame of a matching tab. A frame with no matchable url of its own
// (`about:blank`, `about:srcdoc`, `blob:`, `data:`) therefore got no hooks at
// all, and a page could reach a pristine `fetch` through one. These two keys
// are what extends injection to frames an already-matching origin created.

test('manifest: frames created by a covered page are injected into', () => {
  for (const cs of captureEntries) {
    assert.equal(cs.all_frames, true, 'all_frames is the precondition for both keys');
    assert.equal(cs.match_origin_as_fallback, true,
      'about:/data:/blob:/filesystem: frames created by a matching origin (Chrome 99+, Firefox 128+)');
    assert.equal(cs.match_about_blank, true,
      'about:blank + about:srcdoc, for anything that does not honour the key above');
  }
});

test('manifest: every match pattern has the wildcard path match_origin_as_fallback requires', () => {
  // Documented precondition: "Match patterns in `matches` must specify a
  // wildcard path glob." A pattern with any other path silently disables the
  // fallback for that entry — which would reopen the hole while the key above
  // still claims it is shut.
  for (const cs of captureEntries) {
    for (const pattern of cs.matches) {
      assert.ok(pattern.endsWith('/*'), `${pattern} must end in /* `);
    }
  }
});

test('manifest: the browser minimums are at or above what these keys need', () => {
  // `match_origin_as_fallback` is Chrome 99+ / Firefox 128+. Declaring a key
  // the supported floor cannot honour would be a claim, not a fix.
  assert.ok(Number(manifest.minimum_chrome_version) >= 99,
    'minimum_chrome_version must be >= 99 for match_origin_as_fallback');
  assert.ok(parseFloat(manifest.browser_specific_settings.gecko.strict_min_version) >= 128,
    'gecko strict_min_version must be >= 128 for match_origin_as_fallback');
});

// ── where we inject: every http(s) page, and nothing past that ─────
//
// Super PR #15 (the discovery gate) moved the "is this AI traffic?" decision
// into the guard's classifier, so the shim runs on every page and the catalog
// only decides each capture's `coverage` hint. These pin the new ceiling from
// both sides: every web page is reached, and nothing that is not a web page
// (`<all_urls>` would add file:// and ftp://) or a new host permission rides
// along with it.

test('manifest: both capture entries inject on every http(s) page and nothing else', () => {
  for (const cs of captureEntries) {
    assert.deepEqual([...cs.matches].sort(), ['http://*/*', 'https://*/*'],
      'the generator emits exactly these — re-run `npm run generate`');
  }
});

test('manifest: no host permission was widened to do any of this', () => {
  // The capture path is native messaging; the only host permission is the
  // desktop app's loopback presence listener. Injecting everywhere is a
  // content-script grant, not a host permission, and must stay that way.
  //
  // Portless, and asserted as such in both directions. `http://127.0.0.1/*` is
  // wider than the one port we use, and narrowing it to
  // `http://127.0.0.1:18795/*` is a tempting one-line tightening that would be
  // a regression: Firefox treats a match pattern with an explicit port as
  // matching NOTHING (Bugzilla 1362809, 1468162), so on one of the three
  // targets the extension would silently lose the permission and the presence
  // beacon would start failing CORS. Chrome accepts the port; Firefox is the
  // constraint. `[reviewed again 2026-09-08 — see CHANGELOG 2.0.2]`
  //
  // What actually bounds the port is the extension-pages CSP, which pins
  // `connect-src` to the exact origin and is asserted by the next test.
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  for (const host of manifest.host_permissions) {
    assert.doesNotMatch(
      host, /:\d/,
      'a port here matches nothing in Firefox — narrow with the CSP, not this'
    );
  }
});

test('manifest: the extension-pages CSP pins connect-src to the loopback presence origin', () => {
  // `host_permissions` cannot carry the port — Firefox treats a match pattern
  // with an explicit port as matching nothing (Bugzilla 1362809) — so
  // `http://127.0.0.1/*` on its own leaves every loopback port reachable, and
  // in MV3 a host permission is not what decides whether a cross-origin
  // request may be *sent* at all. docs/security/PERMISSIONS.md answers that
  // with this line: "the extension-pages CSP still pins `connect-src` to
  // `http://127.0.0.1:18795`, so in practice only that port is reachable."
  // Nothing checked it. `store-build.mjs::validate` reads the CSP, but only
  // for `unsafe-eval` and a remote `script-src`, so a second connect-src
  // origin — the shape an exfiltration path takes — passed every gate.
  const csp = manifest.content_security_policy.extension_pages;
  const connectSrc = /connect-src([^;]*)/.exec(csp)?.[1]?.trim();
  assert.ok(connectSrc, 'default-src is none, so no connect-src would block even the beacon');
  assert.deepEqual(
    connectSrc.split(/\s+/), [new URL(PRESENCE_URL).origin],
    'exactly the origin shared/constants.js POSTs the presence beacon to, and nothing beside it'
  );
  assert.equal(new URL(PRESENCE_URL).hostname, '127.0.0.1', 'and that origin is loopback');
});

test('manifest: the generated host lists have not drifted from the catalog', async () => {
  // Both generated files are build inputs for the shim's own scope test
  // (`SONOMOS_WEB_HOSTS` → `AI_HOSTS`) and for the service worker's
  // override-ack membership check. If a sync updates the catalog and the
  // generator is never re-run, the manifest above and these two lists all keep
  // the old set — which is the same drift, one layer in.
  const { WEB_HOSTS } = await import('../shared/web-surfaces.generated.js');
  assert.deepEqual([...WEB_HOSTS].sort(), catalogHosts,
    'shared/web-surfaces.generated.js is stale — run `npm run generate`');

  const classic = await readFile(
    new URL('../content/web-surfaces.generated.js', import.meta.url), 'utf8'
  );
  const declared = /globalThis\.SONOMOS_WEB_HOSTS\s*=\s*(\[[^\]]*\])/.exec(classic)?.[1];
  assert.ok(declared, 'content/web-surfaces.generated.js no longer declares the global it is read for');
  assert.deepEqual(JSON.parse(declared).sort(), catalogHosts,
    'content/web-surfaces.generated.js is stale — run `npm run generate`');
});
