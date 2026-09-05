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

// ── match patterns are the injection surface, so they follow the catalog's
//    own host rule, not a narrower one ────────────────────────────────────
//
// The catalog's host-matching rule is: an entry means itself AND every
// subdomain of itself (see shared/constants.js `hostMatches`, the JS mirror,
// and content/shim.js `isAiHost`, the shim's inline copy). The
// shim has always enforced that rule — a request to `www.perplexity.ai` is in
// scope — but `matches` used to list the catalog's exact spellings only, so
// the shim was never INJECTED on `www.perplexity.ai` and enforced nothing
// there. The catalog and the extension disagreed about what counts as a
// protected surface, and the extension lost: not partial coverage, none.
//
// Two patterns per entry is what `hostMatches` spells in match-pattern syntax.
// `https://*.<h>/*` covers the entry itself in both Chrome and Firefox, but
// the bare form is emitted alongside it anyway: it costs one line, it is what
// a reader checks the catalog against by eye, and it does not depend on that
// wildcard's apex behaviour staying true in every engine.
//
// This widens where we inject and nowhere else. It cannot widen what we HOLD:
// the shim's scope test was already `hostMatches`, so every request this now
// screens is one it would already have screened had it been running. The
// catalog's own care is what bounds the blast radius — it lists
// `www.google.com`, not `google.com`, precisely so that `*.` cannot swallow
// all of Google.
const matches = hosts.flatMap((h) => [`https://${h}/*`, `https://*.${h}/*`]);

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
const capturePaths = {};
for (const p of surfaces.providers) {
  const hostsForProvider = (p.capture_path_allowlist || {}).hosts || {};
  for (const [entry, paths] of Object.entries(hostsForProvider)) {
    // Empty lists are dropped BEFORE specificity is considered: a half-written
    // entry must behave as if never typed, not as a more-specific "declares
    // nothing" shadowing a real list on a broader key.
    if (Array.isArray(paths) && paths.length) capturePaths[entry.toLowerCase()] = paths;
  }
}
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

// Rewrite the manifest's content_scripts matches for the AI page entries (those
// that inject shim.js / content-script.js). Also ensure the generated globals
// load before each consumer, independently in MAIN and ISOLATED worlds.
//
// This used to claim it left "<all_urls> entries (the keystroke guard)"
// untouched. There is no keystroke guard and there is no <all_urls> entry: the
// manifest declares exactly two content scripts, both scoped to the patterns
// built above, and `scripts/store-build.mjs::validate` rejects a wildcard
// content-script host in every spelling. A comment describing a capability we
// do not have, sitting next to the code that decides where we inject, is the
// last place to leave that lying around — it is the kind of thing a reader
// takes for a coverage claim. What the extension actually screens, and the
// navigation-borne prompts it does not, is stated in HONEST.md.
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
  `generated ${hosts.length} web surfaces → shim globals; ${matches.length} manifest matches` +
    (manifestChanged ? '' : ' (manifest already current — not rewritten)')
);
