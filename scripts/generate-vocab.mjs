#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Generate the extension's copy of the shared vocabulary from
// shared/vocab.json — the vendored copy of Service-Mesh/sonomos-vocab/vocab.json.
//
// Today that is one list: INFRASTRUCTURE_REASONS, the prose fragments that mean
// "an outage stopped this request" rather than "a policy refused it".
// Re-run after the vendored vocab.json changes:  npm run generate
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// shared/constants.js used to DECLARE those six strings. Rust declared them
// too, in sonomos_vocab::INFRASTRUCTURE_REASON_FRAGMENTS, and the two were held
// together by a test in a third repo — Extension-Bridge's
// `infrastructure_reasons_match_the_neighbours_own_source`, which opened a
// constants.js off the filesystem and diffed the literal out of it with a
// regex.
//
// That pin was wrong twice over, and the second way is the instructive one.
//
// It was the wrong MECHANISM: a repo cannot declare, version or fetch
// `../<Neighbour>`, so the test was green on a machine with the whole fleet
// checked out side by side, and an ENOENT in a fresh clone, in a container,
// and in anything that vendors one repo without the other. No cargo dependency
// could ever fix that either, because what it reached for was JavaScript.
//
// And it was aimed at the wrong REPO. The path it read was
// `../Depreciated-Desktop-Extension/shared/constants.js` — this extension's
// home before the 2026-08-31 rename, after which only the native-messaging
// host stayed behind there. So it had been pinning Rust against a copy in a
// repo that ships no browser extension: passing, and protecting nothing that
// runs. A stale pin does not announce that it is stale. It reports whatever
// its old target happens to say.
//
// So the list stopped being declared twice. It is canonical in
// sonomos-vocab/vocab.json (pinned entry-for-entry, in order, against the Rust
// by that crate's `vocab_json_matches_the_enums`), vendored here by Locke's
// scripts/sync-surfaces.sh, and compiled to JS by this script. This extension
// holds no literal of its own to drift, and Locke's `vendored-vocab` fleet pin
// fails a push if the vendored copy ever stops matching canonical.
//
// ── This is meant to be easy to DELETE ───────────────────────────────────────
//
// shared/constants.js is explicit that the whole string set is a transitional
// fallback for the mixed-version window where a sender predates `blockCause`,
// and that it goes away once every peer sends a real cause. Nothing here is
// load-bearing for that day: deleting the set is deleting this script, the
// generated file, its two tests and the sync target — no consumer has to be
// rewritten, because `isInfrastructureBlock` already reads the cause first and
// only falls through to these strings. Built to be removed, not to be lived
// with.
//
// ── Why a separate file from generate-surfaces.mjs ───────────────────────────
//
// Different input, different output, and one of them rewrites manifest.json.
// `npm run generate` runs both, so there is still one command to re-run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { writeIfChanged } from './lib/manifest-splice.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const vocab = JSON.parse(readFileSync(join(root, 'shared/vocab.json'), 'utf8'));

// An absent or empty list is a hard stop, never an empty emit.
//
// Everything downstream treats "no fragment matched" as "this was a policy
// refusal", which BLOCKS — safe — but reads to the user as "screening stopped
// this request" on a prompt with nothing sensitive in it. Emitting `[]` would
// therefore not fail loudly; it would silently reclassify every outage in the
// product as a refusal, and the popup would keep saying screening is Active
// while nothing was screening at all. Stopping the build is the only honest
// answer to a vendored file that does not carry the key we compile.
const fragments = vocab.infrastructure_reason_fragments;
if (!Array.isArray(fragments) || fragments.length === 0) {
  throw new Error(
    'shared/vocab.json has no non-empty `infrastructure_reason_fragments`. That is the ' +
      'vendored copy of Service-Mesh/sonomos-vocab/vocab.json — re-run Locke ' +
      'scripts/sync-surfaces.sh rather than hand-writing the key, and see that repo if ' +
      'canonical really has dropped it.'
  );
}
if (!fragments.every((f) => typeof f === 'string' && f.length > 0)) {
  throw new Error(
    'shared/vocab.json: every infrastructure_reason_fragment must be a non-empty string'
  );
}

// Order is preserved, not sorted. `infrastructureFragment` returns the FIRST
// fragment that matched as the thing we record or display, so a reordering
// silently changes how one reason is attributed. Canonical pins its order for
// the same reason; re-sorting here would quietly unpin it.
const banner =
  '// Copyright © 2026 Sonomos, Inc. All rights reserved.\n' +
  '// AUTO-GENERATED from shared/vocab.json by scripts/generate-vocab.mjs.\n' +
  '// Do not edit by hand — run `npm run generate` after the vendored file changes.\n';

const changed = writeIfChanged(
  join(root, 'shared/vocab.generated.js'),
  banner +
    '\n' +
    "// The stack's closed set of reason fragments meaning \"infrastructure\", from\n" +
    '// sonomos_vocab::INFRASTRUCTURE_REASON_FRAGMENTS. Matched with `includes()`\n' +
    '// where Rust matches with `contains()` — same semantics, same order.\n' +
    `export const INFRASTRUCTURE_REASONS = Object.freeze(${JSON.stringify(fragments)});\n`
);

console.log(
  `generated ${fragments.length} infrastructure reason fragments → shared/vocab.generated.js` +
    (changed ? '' : ' (already current — not rewritten)')
);
