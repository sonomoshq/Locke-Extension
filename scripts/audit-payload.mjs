// Copyright © 2026 Sonomos, Inc. All rights reserved.
//
// Asserts the privacy invariants of the code that actually ships.
//
// This extension's central claim is that it makes no outbound network request
// except to the Locke desktop app on loopback. SECURITY.md A1 states it,
// docs/legal/SUB-PROCESSORS.md rests on it, and the enterprise documentation
// tells administrators it is true. Nothing enforced it.
//
// The claim is unusually checkable: the payload has no dependencies and no
// build step, so every endpoint it can reach is a literal in a file we wrote.
// A grep is therefore not a heuristic here — it is close to a proof, and it is
// the difference between a claim and a control.
//
// This runs over the STAGED payload (what store-build.mjs puts in the zip),
// not the repository, so documentation and tests cannot launder a violation.
//
// Deliberately strict: an unrecognised absolute URL fails. Adding one should
// require someone to come here and say why.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, relative } from 'node:path';

// Loopback only. Not "an internal host", not "a host we trust" — the whole
// point is that nothing leaves the machine.
const ALLOWED_ORIGINS = ['http://127.0.0.1', 'http://localhost'];

// Absolute URLs allowed to appear as non-network references: user-facing links
// the popup opens in a tab. These are navigations a person chooses, not
// requests the extension makes.
const ALLOWED_LINKS = ['https://sonomos.ai/'];

// Dynamic code execution. MV3 forbids remote code outright; these are the
// shapes that smuggle it in.
const FORBIDDEN_PATTERNS = [
  { re: /\beval\s*\(/, what: 'eval()' },
  { re: /new\s+Function\s*\(/, what: 'new Function()' },
  { re: /\bimport\s*\(\s*[`'"]https?:/, what: 'dynamic import() of a remote URL' },
  { re: /document\.write\s*\(/, what: 'document.write()' },
  { re: /\.innerHTML\s*=\s*[^;]*\+/, what: 'innerHTML built by concatenation' }
];

const URL_RE = /https?:\/\/[a-zA-Z0-9._~:/?#@!$&'()*+,;=%-]+/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// A URL inside a line comment is documentation, not reach. Block comments and
// strings are deliberately NOT excused: a URL in a template literal is a URL.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i === -1) return line;
      // Don't treat the `//` of a scheme as a comment start.
      if (i > 0 && (line[i - 1] === ':' )) return line;
      return line.slice(0, i);
    })
    .join('\n');
}

export function auditSource(source) {
  const findings = [];
  const code = stripLineComments(source);

  for (const url of code.match(URL_RE) ?? []) {
    const clean = url.replace(/[",'`);]+$/, '');
    const okOrigin = ALLOWED_ORIGINS.some((o) => clean.startsWith(o));
    const okLink = ALLOWED_LINKS.some((l) => clean.startsWith(l));
    if (!okOrigin && !okLink) findings.push({ kind: 'endpoint', detail: clean });
  }

  for (const { re, what } of FORBIDDEN_PATTERNS) {
    if (re.test(code)) findings.push({ kind: 'dynamic-code', detail: what });
  }

  return findings;
}

function main(argv) {
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const root = dirArg ? dirArg.slice(6) : 'dist/chromium';

  let files;
  try {
    files = walk(root).filter((f) => ['.js', '.mjs', '.html'].includes(extname(f)));
  } catch {
    console.error(`audit-payload: cannot read ${root}. Run \`npm run package\` first.`);
    return 2;
  }

  if (files.length === 0) {
    // An empty scan passing is how this check would silently stop working.
    console.error(`audit-payload: no scannable files under ${root}. Refusing to pass on an empty set.`);
    return 2;
  }

  let failed = 0;
  for (const file of files) {
    for (const f of auditSource(readFileSync(file, 'utf8'))) {
      const where = relative(root, file);
      if (f.kind === 'endpoint') {
        console.error(`::error file=${where}::Unapproved absolute URL in shipped payload: ${f.detail}`);
      } else {
        console.error(`::error file=${where}::Dynamic code execution in shipped payload: ${f.detail}`);
      }
      failed++;
    }
  }

  if (failed > 0) {
    console.error('');
    console.error(`audit-payload: ${failed} finding(s).`);
    console.error('The extension claims it makes no outbound request except to the');
    console.error('desktop app on loopback (SECURITY.md A1). Either that is still true');
    console.error('and this list is wrong, or the claim needs changing. Do not silence');
    console.error('this by widening the allowlist without changing the documentation.');
    return 1;
  }

  console.log(`audit-payload: ${files.length} shipped file(s) scanned, no findings.`);
  console.log(`allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  return 0;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) process.exit(main(process.argv.slice(2)));
