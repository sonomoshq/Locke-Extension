// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ── the doc-drift tripwire for the capture-path allow-list ──────────
//
// `SONOMOS_CAPTURE_PATHS` is the one piece of catalog data that decides
// whether a bodied request on a covered host is HELD at all. A host with an
// entry is narrowed to exactly the paths listed; everything else on that host
// goes out as the page issued it. That is a coverage gap the user cannot see
// from the browser — a declined path never reaches a log anywhere — so the
// only place it can be discovered is a document, and HONEST.md is that
// document.
//
// It was undocumented from the day the mechanism landed. Worse, HONEST.md and
// README.md carried the OPPOSITE claim (that a same-origin multipart upload
// back to the AI host is captured) for the whole time the allow-list was
// silently declining `claude.ai`'s upload path. Nothing could have caught
// that: the code was right, the tests were right, and the prose was wrong.
//
// So this test reads both sides at run time and fails if they disagree. It is
// deliberately not a snapshot of today's paths — a snapshot would have to be
// edited by whoever changes the catalog, which is exactly the step that gets
// skipped. It compares the generated file to the table in the document, so
// re-syncing the document is the only way to make it pass.

const url = (p) => new URL(p, import.meta.url);

// The generated file is a MAIN-world classic script: it assigns to globalThis
// rather than exporting. Read it the way the shim gets it — evaluated — not by
// regexing the literal out, so a change to how the generator spells the
// assignment cannot silently defeat this test.
async function loadGeneratedGlobals() {
  const src = await readFile(url('../content/web-surfaces.generated.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(src, context);
  return vm.runInContext('({ paths: SONOMOS_CAPTURE_PATHS, hosts: SONOMOS_WEB_HOSTS })', context);
}

// Parse the `| Host | Paths screened … |` table out of HONEST.md. Backticked
// cells only: a host or path written as plain prose is not a claim this test
// can check, and quietly accepting one would let the table rot.
function parseHonestTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\|\s*Host\s*\|\s*Paths screened/.test(l));
  assert.notEqual(
    start, -1,
    'HONEST.md no longer has the capture-path allow-list table. The mechanism still ' +
    'narrows three hosts, so removing the table removes the only public statement of ' +
    'what is NOT screened — restore it rather than deleting this test.'
  );
  const out = {};
  // start + 1 is the `| --- | --- |` separator.
  for (const line of lines.slice(start + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) break;
    const host = /^`([^`]+)`$/.exec(cells[0])?.[1];
    assert.ok(host, `HONEST.md allow-list table: host cell ${JSON.stringify(cells[0])} is not a single backticked host`);
    const paths = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(paths.length, `HONEST.md allow-list table: no backticked paths listed for ${host}`);
    out[host] = paths;
  }
  return out;
}

// The reduction scripts/generate-surfaces.mjs performs, repeated here so a
// hand-edit of the generated file (which the banner forbids and nothing else
// checks) is caught rather than trusted.
function capturePathsFromCatalog(surfaces) {
  const out = {};
  for (const p of surfaces.providers) {
    const hosts = (p.capture_path_allowlist || {}).hosts || {};
    for (const [entry, paths] of Object.entries(hosts)) {
      if (Array.isArray(paths) && paths.length) out[entry.toLowerCase()] = paths;
    }
  }
  return out;
}

const sortedEntries = (table) => Object.keys(table).sort()
  .map((host) => [host, [...table[host]].sort()]);

test('HONEST.md lists exactly the hosts SONOMOS_CAPTURE_PATHS narrows', async () => {
  const { paths } = await loadGeneratedGlobals();
  const documented = parseHonestTable(await readFile(url('../HONEST.md'), 'utf8'));

  assert.deepEqual(
    Object.keys(documented).sort(), Object.keys(paths).sort(),
    'HONEST.md\'s narrowed-host list has drifted from SONOMOS_CAPTURE_PATHS in ' +
    'content/web-surfaces.generated.js. A host that gained an allow-list is a host ' +
    'whose other bodied requests stopped being screened; a host that lost one is a ' +
    'host we now hold everything on. Both are coverage changes users are entitled to ' +
    'read about. Re-sync the table in HONEST.md.'
  );

  assert.deepEqual(
    sortedEntries(documented), sortedEntries(paths),
    'HONEST.md\'s per-host path lists have drifted from SONOMOS_CAPTURE_PATHS. Every ' +
    'path missing from the document is a path users are told is screened when it is, ' +
    'and every extra one is a path they are told is screened when it is not.'
  );
});

test('the generated capture paths are the vendored catalog\'s, not a hand edit', async () => {
  const { paths } = await loadGeneratedGlobals();
  const surfaces = JSON.parse(await readFile(url('../shared/ai-surfaces.json'), 'utf8'));
  assert.deepEqual(
    sortedEntries(paths), sortedEntries(capturePathsFromCatalog(surfaces)),
    'content/web-surfaces.generated.js disagrees with shared/ai-surfaces.json. The ' +
    'generated file is not editable by hand — change the catalog in Service-Mesh\'s ' +
    'sonomos-vocab, re-vendor shared/ai-surfaces.json, and run `npm run generate`.'
  );
});

test('both generated copies of the capture paths agree', async () => {
  // The shim reads the classic-script copy; the service worker imports the
  // module copy. Two consumers of one catalog disagreeing about which paths
  // carry a prompt is the failure the generator exists to prevent.
  const { paths } = await loadGeneratedGlobals();
  const { CAPTURE_PATHS } = await import('../shared/web-surfaces.generated.js');
  assert.deepEqual(sortedEntries(paths), sortedEntries(CAPTURE_PATHS));
});

test('HONEST.md and README.md both name the mechanism by its catalog key', async () => {
  // Not decoration: `capture_path_allowlist` is the string a reader greps for
  // in the catalog after reading either document, and `SONOMOS_CAPTURE_PATHS`
  // is the one they grep for in the extension. A rewrite that drops both
  // leaves the table sitting there with no way to verify it.
  const honest = await readFile(url('../HONEST.md'), 'utf8');
  const readme = await readFile(url('../README.md'), 'utf8');
  assert.match(honest, /capture_path_allowlist/);
  assert.match(honest, /SONOMOS_CAPTURE_PATHS/);
  assert.match(readme, /capture_path_allowlist/);

  // The specific over-claim this release corrected. HONEST.md used to say a
  // same-origin multipart upload back to the AI host "are captured as they
  // always were" with no qualification at all.
  assert.doesNotMatch(
    honest, /Claude's web app does\) are captured as they always were\./,
    'the unqualified same-origin-upload claim is back in HONEST.md'
  );
});
