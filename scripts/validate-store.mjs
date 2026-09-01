#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Check the tree against the Chrome Web Store / Edge Add-ons / AMO rules
// without producing artifacts:  npm run validate
//
// Same staging and checks `npm run package` gates on (scripts/store-build.mjs)
// — this entry point exists so CI and pre-commit can fail on a store-rule
// regression without writing zips. Staged into dist/.validate so it never
// clobbers a real build.

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAll } from './store-build.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', '.validate');

try {
  const results = buildAll(dist);
  const errors = results.flatMap((r) => r.errors);
  for (const error of errors) console.error(error);
  if (errors.length > 0) {
    console.error(`\n${errors.length} store-rule violation(s)`);
    process.exit(1);
  }
  console.log(`store rules OK for: ${results.map((r) => r.target).join(', ')}`);
} finally {
  rmSync(dist, { recursive: true, force: true });
}
