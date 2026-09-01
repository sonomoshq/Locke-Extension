// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Adds (or normalizes) the standard Sonomos copyright header on every
// tracked source file.
//
// The standard is HEADER below, rendered in each language's comment
// syntax. Idempotent: a file already carrying the exact current header is
// untouched, and a file carrying an OLD variant (see LEGACY) gets it
// replaced — so changing the wording later is: edit HEADER, re-run,
// commit. Shebangs and "use strict" stay where they belong (header goes
// after a shebang, before everything else).
//
// Usage: node scripts/add-copyright-headers.mjs [--check]
//   --check  exit 1 listing files missing the header, changing nothing
//            (suitable for a pre-commit hook later).

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const HEADER = "Copyright © 2026 Sonomos, Inc. All rights reserved.";
// PowerShell must stay pure ASCII unless a UTF-8 BOM is present — same
// header, ASCII spelling.
const ASCII_HEADER = "Copyright (c) 2026 Sonomos, Inc. All rights reserved.";
// Recognized older spellings, replaced on sight (first 5 lines only).
const LEGACY = /Copyright (\(c\)|©) 20\d\d Sonomos(, Inc\.?)?( All rights reserved\.?)?/;

const COMMENT = new Map(Object.entries({
  ts: "//", tsx: "//", js: "//", cjs: "//", mjs: "//", rs: "//",
  css: "/*", sh: "#", ps1: "#", bash: "#",
}));

const SKIP_DIRS = /^(dist|dist-electron-packages|node_modules|target|fleet-bundle|native-host-bundle|coverage)\//;
// Generated or foreign files a header would corrupt or misclaim.
const SKIP_FILES = /(package-lock\.json|\.min\.|\.d\.ts$|\.json$|\.md$|\.toml$|\.ya?ml$|\.html$|\.svg$|\.png$|\.ico$|\.icns$)/;

const check = process.argv.includes("--check");
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !SKIP_DIRS.test(f) && !SKIP_FILES.test(f))
  .filter((f) => COMMENT.has(f.split(".").pop()));

let changed = 0;
const missing = [];
for (const file of files) {
  const extension = file.split(".").pop();
  const marker = COMMENT.get(extension);
  const wanted = extension === "ps1" ? ASCII_HEADER : HEADER;
  const line = marker === "/*" ? `/* ${wanted} */` : `${marker} ${wanted}`;
  let text = fs.readFileSync(file, "utf8");
  // A UTF-8 BOM must stay the FIRST bytes of the file (PowerShell 5.1
  // reads BOM-less files as CP1252 — see tests/ps1-encoding.test.js).
  // Strip it for processing, restore it on write.
  const bom = text.startsWith("﻿") ? "﻿" : "";
  if (bom) text = text.slice(1);
  const lines = text.split("\n");
  const head = lines.slice(0, 5);

  if (head.some((l) => l.includes(wanted))) continue; // current standard present

  const legacyAt = head.findIndex((l) => LEGACY.test(l));
  if (legacyAt >= 0) {
    // Replace the old variant in place; drop a trailing bare
    // "All rights reserved." continuation line from the two-line form.
    lines[legacyAt] = line;
    if (/^\s*(\/\/|#)\s*All rights reserved\.?\s*$/.test(lines[legacyAt + 1] ?? "")) {
      lines.splice(legacyAt + 1, 1);
    }
  } else {
    const insertAt = lines[0]?.startsWith("#!") ? 1 : 0;
    lines.splice(insertAt, 0, line);
  }

  if (check) {
    missing.push(file);
    continue;
  }
  fs.writeFileSync(file, bom + lines.join("\n"));
  changed += 1;
}

if (check) {
  if (missing.length) {
    console.error(`missing/outdated header on ${missing.length} file(s):`);
    for (const f of missing) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`all ${files.length} source files carry the standard header`);
} else {
  console.log(`header ensured on ${files.length} files (${changed} updated)`);
}
