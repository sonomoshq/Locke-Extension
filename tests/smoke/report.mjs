// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Renders the smoke run as the markdown table docs/testing/BROWSER-SMOKE.md
// carries, and splices it into that document between two markers.
//
// Why splice rather than print and let a human transcribe: a results table
// that is typed up by hand is a table that can say something the run did not.
// The document's prose is written once and owned by a person; the table
// between the markers is only ever machine-written, so what it claims is
// exactly what a browser did on the day it says.
//
// The document is NOT regenerated wholesale — everything outside the markers
// survives untouched, and a run against a missing document writes only the
// table (the prose is a human's to add).

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, release, type } from 'node:os';
import { relative } from 'node:path';

export const BEGIN = '<!-- BEGIN SMOKE RESULTS — machine-written by tests/smoke/run.mjs; do not edit by hand -->';
export const END = '<!-- END SMOKE RESULTS -->';

// This document is committed to a PUBLIC repository, and the runner's notes
// naturally carry absolute paths to browser binaries under the developer's
// home directory. Nothing about a run depends on whose machine it was, so the
// home prefix is replaced with `~` and the machine's hostname is never
// recorded at all — the OS, architecture and Node version are the parts that
// actually qualify the result.
function redact(text) {
  const home = homedir();
  if (!home) return String(text ?? '');
  // Windows paths appear with both separators depending on who produced them.
  const variants = [home, home.split('\\').join('/')];
  let out = String(text ?? '');
  for (const v of variants) out = out.split(v).join('~');
  return out;
}

// A markdown table cell cannot contain a raw `|`, and a newline ends the row.
function cell(text) {
  return redact(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * @param {object} args
 * @param {object[]} args.rows        one entry per browser, from run.mjs
 * @param {string} args.catalogHost   the host that was visited
 * @param {string|null} args.out      document to splice into, or null to only render
 * @param {string} args.repoRoot
 * @returns {{ table: string, written: string|null }}
 */
export function writeReport({ rows, catalogHost, out, repoRoot }) {
  const recordedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const machine = `${type()} ${release()} (${process.arch}), Node ${process.version}`;

  const header = [
    '| Browser | Launched | Extension loaded from | Popup state observed | Fetch hook | NO_BRIDGE | Console errors | Result |',
    '|---|---|---|---|---|---|---|---|'
  ];

  const body = rows.map((r) =>
    '| ' +
    [
      // `Browser.version()` is already qualified ("Chrome/152.0…",
      // "firefox/154.0"); keep our own label for consistent capitalisation
      // and take only the number, so the cell does not read "Chrome Chrome/…".
      cell(r.version ? `${r.browser} ${String(r.version).split('/').pop()}` : `${r.browser} (not launched)`),
      cell(r.launched ?? '—'),
      cell(r.loadPath),
      cell(r.popup),
      cell(r.fetchHook),
      cell(r.noBridge),
      cell(r.consoleErrors),
      cell(r.result)
    ].join(' | ') +
    ' |'
  );

  const notes = rows.flatMap((r) =>
    r.notes.length ? [`**${r.browser}**`, ...r.notes.map((n) => `- ${redact(n)}`), ''] : []
  );

  const block = [
    BEGIN,
    '',
    `**Recorded:** ${recordedAt}  `,
    `**Machine:** ${machine}  `,
    `**Catalog host visited:** ${catalogHost}  `,
    '**Provenance:** developer-run (`npm run smoke`). **These are not CI results** — no',
    'workflow in `.github/workflows/` runs this harness and nothing gates on it.',
    '',
    ...header,
    ...body,
    '',
    '### Run notes',
    '',
    ...notes,
    END
  ].join('\n');

  if (!out) return { table: [...header, ...body].join('\n'), written: null };

  // Read-and-tolerate-ENOENT rather than exists-then-read: the check/use
  // pair is a TOCTOU window (CodeQL js/file-system-race).
  let document;
  try {
    document = readFileSync(out, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    document = '';
  }
  const start = document.indexOf(BEGIN);
  const finish = document.indexOf(END);
  if (start !== -1 && finish !== -1 && finish > start) {
    document = document.slice(0, start) + block + document.slice(finish + END.length);
  } else {
    // No markers (or a mangled pair): append rather than overwrite. Losing a
    // person's prose to a test runner would be a poor trade for tidiness.
    document = (document ? `${document.replace(/\s*$/, '')}\n\n` : '') + block + '\n';
  }
  writeFileSync(out, document);

  return { table: [...header, ...body].join('\n'), written: relative(repoRoot, out).split('\\').join('/') };
}
