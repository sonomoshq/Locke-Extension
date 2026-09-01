#!/usr/bin/env node
// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Build per-browser store artifacts:  npm run package
//
//   dist/locke-extension-<version>-chromium.zip  — Chrome Web Store AND Edge
//     Add-ons (Edge accepts the same MV3 zip; no separate build needed).
//   dist/locke-extension-<version>-firefox.zip   — Firefox AMO.
//
// Staging and the per-target manifest transforms live in store-build.mjs;
// zipping lives in zip.mjs (a dependency-free writer — see its header for why
// shelling out to Compress-Archive produced store-rejected archives). This
// file is the sequence: stage → validate → zip, and it refuses to emit a zip
// for a target that fails validation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAll, entries, root } from './store-build.mjs';
import { writeZip } from './zip.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;

const results = buildAll(dist);
const failed = results.filter((r) => r.errors.length > 0);

if (failed.length > 0) {
  for (const { errors } of failed) {
    for (const error of errors) console.error(error);
  }
  console.error('\nstore validation failed — no artifacts written');
  process.exit(1);
}

for (const { target, dir } of results) {
  const zipPath = join(dist, `locke-extension-${version}-${target}.zip`);
  writeZip(zipPath, entries(dir));
  console.log(`${target.padEnd(8)} ${zipPath}`);
}

console.log('The chromium zip serves both the Chrome Web Store and Edge Add-ons.');
