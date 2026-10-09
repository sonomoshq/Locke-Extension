#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Generate the extension's web-surface lists from shared/ai-surfaces.json —
// the vendored copy of the shared surface catalog.
//
// The extension reads the WEB surfaces (web_hosts): consumer sites it captures
// page-side.
//
// This writes the host lists the content scripts read AND rewrites the manifest's
// content_scripts `matches`, so there's no hand-maintained copy to drift. Re-run
// after the vendored ai-surfaces.json changes:  npm run generate

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// manifest.json is edited in place, never reserialised — see the module doc
// for why, and scripts/lib/version.mjs for the convention it follows.
import { spliceValue, writeIfChanged } from './lib/manifest-splice.mjs';
import { capturePathsFor, unscreenedWebHosts } from './lib/capture-paths.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const surfaces = JSON.parse(readFileSync(join(root, 'shared/ai-surfaces.json'), 'utf8'));

// All consumer web surfaces, deduped + sorted, AND the host -> catalog id map
// the shim attributes a capture with.
//
// The extension is the one component holding both the URL and this catalog, so
// attribution belongs here — and `id` is what the catalog documents as the
// identity every capture surface emits.
const hostSet = new Set();
const providerByHost = {};
for (const p of surfaces.providers) {
  for (const h of p.web_hosts || []) {
    const host = h.toLowerCase();
    // The catalog's host rule allows ONE `*` per label since 2026-10-01
    // (shared/constants.js `hostMatches`), and today every wildcard entry is
    // an `api_hosts` one — the proxy's side. A wildcard `web_hosts` entry
    // cannot be honoured HERE: a manifest match pattern can say `*.host` but
    // not a partial label, so the shim would be injected nowhere for it while
    // the catalog claimed the surface screened. Stop the build rather than
    // ship that claim; the fix belongs in the catalog or in this generator,
    // never in a silently narrower manifest.
    if (host.includes('*')) {
      throw new Error(
        `ai-surfaces.json: web_host ${host} ("${p.id}") carries a wildcard, which a manifest match pattern cannot express`
      );
    }
    hostSet.add(host);
    // Two providers claiming one host is a catalog bug. Resolving it silently
    // by last-write-wins would let a catalog edit quietly regroup a user's own
    // evidence, so it stops the build instead.
    if (providerByHost[host] && providerByHost[host] !== p.id) {
      throw new Error(
        `ai-surfaces.json: ${host} is claimed by both "${providerByHost[host]}" and "${p.id}"`
      );
    }
    providerByHost[host] = p.id;
  }
}
const hosts = [...hostSet].sort();
// Key order follows `hosts` so the generated file is stable across runs.
const providers = Object.fromEntries(hosts.map((h) => [h, providerByHost[h]]));

// ── match patterns: every http(s) page ────────────────────────────────────
//
// Super PR #15 (the discovery gate) moved the "is this AI traffic?" decision
// out of every capture surface and into the guard's classifier. The extension
// follows: it injects on every page, holds every bodied request, and lets the
// guard classify it. The catalog no longer decides WHERE we inject — it
// decides only the `coverage` hint each capture carries (content/shim.js
// coverageFor), which is why the host and path lists below are still
// generated.
//
// http and https only, never `<all_urls>`: that also grants file:// and ftp://,
// neither of which a web prompt travels over, and scripts/store-build.mjs
// rejects it.
const matches = ['http://*/*', 'https://*/*'];

// ── path scoping: the half of a capture decision the extension used to lack ──
//
// A host in `web_hosts` is INJECTED wholesale, and until now the shim held
// every request on it. That is survivable only where the whole hostname
// carries prompts. `chatgpt.com` and `claude.ai` do not: each serves sign-in,
// billing, telemetry and — the one that actually broke — sentinel
// proof-of-work on the same name as chat. Holding those hands a
// field-agnostic redactor traffic it must not touch, and an item that cannot
// be screened becomes a BLOCK, which reads to the user as "ChatGPT is down".
//
// The catalog has said which paths carry a prompt since the per-host
// allow-list landed. These two exports are that data, so the shim can compose
// the decision the catalog describes:
//
//     screen = allowlistAdmits(host, path) && !skipPathSegments(path)
//
// Both halves, or consumers of the catalog come to disagree about which paths
// carry a prompt.
//
// ── and the hosts the catalog says screen NOTHING ──
//
// A provider declared `web_screening: "none"` (the `search` entry: Google,
// Bing, Brave Search, DuckDuckGo, Kagi, You.com) has no screened submission
// path — what a user types there leaves as a top-level navigation the shim
// never sees. Until this generator read that field, every one of those hosts
// was injected AND held wholesale: every Maps / Flights / account XHR and every
// telemetry beacon on www.google.com was relayed through a fresh native-host
// process, and BLOCKED whenever the desktop app was not running. Those hosts
// now get an EMPTY allow-list — narrowed to nothing — so the shim's
// `isScreenedPath` falls through to the same passthrough a declined path takes.
//
// They stay in `web_hosts`, in SONOMOS_WEB_HOSTS and in the manifest, and that
// is not an oversight: `web_hosts` is also the shim's request-TARGET scope set
// (duck.ai's chat XHRs target duckduckgo.com), and the shim honours an empty
// list only on the unscreened surface's OWN pages. The rules, and the one
// subdomain case the reduction must handle itself, are in
// scripts/lib/capture-paths.mjs.
const capturePaths = capturePathsFor(surfaces);
const unscreened = unscreenedWebHosts(surfaces);
const skipSegments = (surfaces.skip_path_segments || {}).segments || [];

// The copyright header leads, in the same one-line form
// scripts/add-copyright-headers.mjs writes everywhere else. It belongs in the
// banner rather than in the header script's sights: these two files are
// regenerated, so a header added to the file on disk is deleted by the next
// `npm run generate` — as it was, silently, until the generator was repaired.
const banner =
  '// Copyright © 2026 Sonomos, Inc. All rights reserved.\n' +
  '// AUTO-GENERATED from shared/ai-surfaces.json by scripts/generate-surfaces.mjs.\n' +
  '// Do not edit by hand — run `npm run generate` after the vendored file changes.\n';

// Classic-script form: both content-script worlds load their own copy. The
// shim uses it for capture; the isolated relay uses its trusted copy to
// validate provider metadata received from the page.
writeIfChanged(
  join(root, 'content/web-surfaces.generated.js'),
  banner +
    `globalThis.SONOMOS_WEB_HOSTS = ${JSON.stringify(hosts)};\n` +
    `globalThis.SONOMOS_WEB_PROVIDERS = ${JSON.stringify(providers)};\n` +
    `globalThis.SONOMOS_CAPTURE_PATHS = ${JSON.stringify(capturePaths)};\n` +
    `globalThis.SONOMOS_SKIP_PATH_SEGMENTS = ${JSON.stringify(skipSegments)};\n`
);

// Module form, for the service worker. It needs the same list to answer one
// question the content scripts never ask: of the surfaces the Locke desktop
// app says to leave alone, which are ones we actually screen? Answering that
// from a second, hand-kept copy of the catalog is precisely how the extension
// and the catalog came to disagree once already.
writeIfChanged(
  join(root, 'shared/web-surfaces.generated.js'),
  banner +
    `export const WEB_HOSTS = ${JSON.stringify(hosts)};\n` +
    `export const CAPTURE_PATHS = ${JSON.stringify(capturePaths)};\n` +
    `export const SKIP_PATH_SEGMENTS = ${JSON.stringify(skipSegments)};\n`
);

// Rewrite the manifest's content_scripts matches for the page entries (those
// that inject shim.js / content-script.js). Also ensure the generated globals
// load before each consumer, independently in MAIN and ISOLATED worlds. What
// the extension actually screens, and the navigation-borne prompts it does
// not, is stated in HONEST.md.
const manifestPath = join(root, 'manifest.json');
const manifestText = readFileSync(manifestPath, 'utf8');
const contentScripts = JSON.parse(manifestText).content_scripts || [];
for (const cs of contentScripts) {
  const js = (cs.js || []).join(',');
  if (js.includes('content/shim.js') || js.includes('content/content-script.js')) {
    cs.matches = matches;
  }
  if ((js.includes('content/shim.js') || js.includes('content/content-script.js')) &&
      !cs.js.includes('content/web-surfaces.generated.js')) {
    cs.js = ['content/web-surfaces.generated.js', ...cs.js];
  }
}
const manifestChanged = writeIfChanged(
  manifestPath,
  spliceValue(manifestText, 'content_scripts', contentScripts)
);

console.log(
  `generated ${hosts.length} web surfaces → shim globals; manifest matches: ${matches.join(' ')}` +
    (manifestChanged ? '' : ' (manifest already current — not rewritten)')
);
console.log(
  `unscreened (web_screening: "none") hosts narrowed to nothing: ` +
    (unscreened.narrowed.length ? unscreened.narrowed.join(', ') : '(none)')
);
// Say which unscreened hosts are still held wholesale and why, so the next
// reader does not conclude the generator missed them.
for (const k of unscreened.kept) {
  const why = k.reason === 'explicit'
    ? 'has an explicit capture_path_allowlist, which wins'
    : `still capture-everything: ${k.screened} is a screened surface under it with no allow-list of its own`;
  console.log(`  kept ${k.host} ("${k.provider}") — ${why}`);
}
