// Copyright © 2026 Sonomos, Inc. All rights reserved.
//
// Reports how a change alters what the extension is allowed to see.
//
// The three fields below are the extension's entire declared reach. A change
// to any of them widens or narrows what it can read, and in a diff they look
// like ordinary one-line edits — a new host in an array reads the same as a
// typo fix. With publishing automated from `main`, the pull request is the
// last point a person looks before a widened permission set reaches users.
//
// This never fails a build. A permission change is often exactly right; the
// problem is only that it can pass unnoticed. So it renders a summary that is
// hard to skim past, and leaves the judgement to the reviewer.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// content_scripts matches are listed per entry; flatten to one set, because
// which entry a host sits in does not change what the extension can read.
export function surfaceOf(manifest) {
  const m = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
  const matches = (m.content_scripts ?? []).flatMap((c) => c.matches ?? []);
  return {
    permissions: [...(m.permissions ?? [])].sort(),
    host_permissions: [...(m.host_permissions ?? [])].sort(),
    content_script_matches: [...new Set(matches)].sort()
  };
}

export function diffSets(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x))
  };
}

export function report(beforeManifest, afterManifest) {
  const before = surfaceOf(beforeManifest);
  const after = surfaceOf(afterManifest);
  const fields = ['permissions', 'host_permissions', 'content_script_matches'];

  const lines = ['### Declared surface', ''];
  let changed = false;
  let widened = false;

  for (const field of fields) {
    const { added, removed } = diffSets(before[field], after[field]);
    if (added.length === 0 && removed.length === 0) continue;
    changed = true;
    if (added.length > 0) widened = true;

    lines.push(`**\`${field}\`**`, '');
    for (const x of added) lines.push(`- \`+\` **${x}**`);
    for (const x of removed) lines.push(`- \`-\` ~~${x}~~`);
    lines.push('');
  }

  if (!changed) {
    lines.push('No change to `permissions`, `host_permissions` or the content-script match list.');
    return { changed, widened, text: lines.join('\n') };
  }

  if (widened) {
    lines.push(
      '> This change **widens** what the extension can read. That may be exactly',
      '> right — a new AI surface has to be added somewhere. Confirm the added',
      '> entries are surfaces the extension is meant to screen, and that',
      '> `shared/ai-surfaces.json` was the source of the change rather than the',
      '> manifest being edited directly.',
      ''
    );
  } else {
    lines.push('> This change only narrows the declared surface.', '');
  }

  return { changed, widened, text: lines.join('\n') };
}

function main(argv) {
  const baseArg = argv.find((a) => a.startsWith('--base='));
  if (!baseArg) {
    console.error('usage: node scripts/permission-diff.mjs --base=<git-ref>');
    return 2;
  }
  const base = baseArg.slice(7);

  let beforeText;
  try {
    beforeText = execFileSync('git', ['show', `${base}:manifest.json`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    // Not a failure: a base without a manifest is a legitimate state (a new
    // repository, an unrelated history). Say so and move on.
    console.log('### Declared surface\n');
    console.log(`Could not read \`manifest.json\` at \`${base}\`, so there is nothing to compare against.`);
    return 0;
  }

  const afterText = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
  console.log(report(beforeText, afterText).text);
  return 0;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) process.exit(main(process.argv.slice(2)));
