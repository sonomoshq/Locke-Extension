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

// ── the catalog is the authority on which hosts are a surface ──────
//
// The stack's ONE definition of "the same host" is true for an entry, for any
// subdomain of it, case-insensitively,
// with trailing dots stripped. content/shim.js implements exactly that in
// `isAiHost`, so a request to `www.perplexity.ai` is in enforcement scope. But
// `matches` listed the catalog's exact spellings only, so the shim was never
// INJECTED on `www.perplexity.ai` and enforced nothing there. The catalogue
// and the extension disagreed about what counts as a protected surface, and
// the extension lost.
//
// The check is mechanical: take every spelling the catalog calls the same
// host, and confirm the injection surface still reaches it.

// Chrome/Firefox match-pattern host matching, for the `https://<host>/*` and
// `https://*.<host>/*` shapes this manifest uses and nothing else. Kept
// deliberately small — an over-clever matcher here would pass tests the
// browser fails.
function patternMatchesHost(pattern, host) {
  const m = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
  if (!m) return false;
  const hostPattern = m[1].toLowerCase();
  const h = host.toLowerCase();
  if (hostPattern.startsWith('*.')) {
    const base = hostPattern.slice(2);
    // `*.example.com` covers example.com itself as well as its subdomains.
    return h === base || h.endsWith(`.${base}`);
  }
  return h === hostPattern;
}

test('manifest: the pattern matcher used by these tests behaves like the browser', () => {
  // A test whose helper can never say no proves nothing, so pin the helper.
  assert.equal(patternMatchesHost('https://claude.ai/*', 'claude.ai'), true);
  assert.equal(patternMatchesHost('https://claude.ai/*', 'www.claude.ai'), false);
  assert.equal(patternMatchesHost('https://*.claude.ai/*', 'claude.ai'), true);
  assert.equal(patternMatchesHost('https://*.claude.ai/*', 'www.claude.ai'), true);
  assert.equal(patternMatchesHost('https://*.claude.ai/*', 'notclaude.ai'), false);
  assert.equal(patternMatchesHost('https://*.claude.ai/*', 'evil.com'), false);
  assert.equal(patternMatchesHost('https://claude.ai/', 'claude.ai'), false, 'non-wildcard path');
});

test('manifest: every catalog spelling of a web surface is injected on', () => {
  assert.ok(catalogHosts.length >= 20, 'the catalog must actually have been read');
  for (const cs of captureEntries) {
    for (const host of catalogHosts) {
      // The spellings the shared host rule calls the same host.
      for (const spelling of [host, `www.${host}`, `chat.${host}`]) {
        assert.ok(
          cs.matches.some((pattern) => patternMatchesHost(pattern, spelling)),
          `no content_scripts.matches pattern injects on ${spelling} ` +
          `(catalog entry ${host}) — the shim enforces there but never runs there`
        );
      }
    }
  }
});

test('manifest: injection does not reach a host the catalog does not name', () => {
  // The other direction, which is the one that fails toward "we intercepted
  // something we should not have". `*.<entry>` must not become `*`.
  const strangers = [
    'example.com', 'notclaude.ai', 'claude.ai.evil.com', 'perplexity.ai.attacker.net',
    'google.com', 'bing.com', 'mail.google.com', 'accounts.google.com'
  ];
  for (const cs of captureEntries) {
    for (const stranger of strangers) {
      assert.ok(
        !cs.matches.some((pattern) => patternMatchesHost(pattern, stranger)),
        `${stranger} must not be injected on`
      );
    }
  }
});

test('manifest: only https, and no host permission was widened to do any of this', () => {
  for (const cs of captureEntries) {
    for (const pattern of cs.matches) {
      assert.ok(pattern.startsWith('https://'), `${pattern} must be https`);
    }
  }
  // The capture path is native messaging; the only host permission is the
  // desktop app's loopback presence listener. Nothing above may add to it.
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
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

// ── the removal direction ──────────────────────────────────────────
//
// `manifest: every catalog spelling of a web surface is injected on` pins the
// ADDITION direction: the catalog gains a host and `npm run generate` was run
// to match. The removal direction had no pin at all. A host deleted from the
// catalog but left behind in the manifest keeps being injected on, and the
// `strangers` list above is hand-written, so nothing would notice.
//
// That is not hypothetical. The sync this test arrived with removed six hosts,
// two of which (`phind.com`, `www.phind.com`) belonged to a service that had
// shut down seven months earlier, and one of which (`chat.lechat.fr`) has no
// DNS record at all. A dead hostname in a shipped MAIN-world injection list is
// worse than dead weight: whoever registers that name next inherits a
// MAIN-world content script on their pages, from us, for free.

test('manifest: no match pattern names a host the catalog no longer lists', () => {
  const catalog = new Set(catalogHosts);
  for (const cs of captureEntries) {
    for (const pattern of cs.matches) {
      const host = /^https:\/\/(?:\*\.)?([^/]+)\/\*$/.exec(pattern)?.[1];
      assert.ok(host, `match pattern ${pattern} is not a shape this generator emits`);
      assert.ok(
        catalog.has(host),
        `${pattern} injects on "${host}", which shared/ai-surfaces.json does not list — ` +
          're-run `npm run generate` after syncing the vendored catalog'
      );
    }
  }
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
