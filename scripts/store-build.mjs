// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Staging + store-rule validation for the browser-store artifacts.
//
// One tree, two targets. The repo manifest carries the union of both families'
// keys (Chromium's `background.service_worker` + `minimum_chrome_version`,
// Gecko's `browser_specific_settings` + `background.scripts`); each store
// rejects — or its linter flags — the other family's keys, so the per-target
// transform strips what doesn't belong before the manifest is written.
//
// `validate()` encodes the store rules that are cheap to check mechanically
// and expensive to discover from a rejection email days later: manifest field
// limits, every referenced file actually shipping, the keys that get a package
// auto-rejected (`update_url`, `key`), remote-code smells, and the per-family
// key hygiene above. It is a gate, not advice — `npm run package` refuses to
// emit a zip that fails it.
//
// Consumed by scripts/package.mjs (stage → validate → zip),
// scripts/validate-store.mjs (stage → validate), and tests/store-build.test.js.

import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
// The per-target manifest edits are textual, not a reserialisation — see
// lib/manifest-splice.mjs, and scripts/lib/version.mjs for the convention.
import { deletePath } from './lib/manifest-splice.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repo's superset manifest — the one source of truth for the version and
 * the add-on's identity. Exported here so the release tooling
 * (scripts/preflight.mjs, publish.mjs, publish/firefox.mjs) reads it through
 * the same module that owns the per-store transforms, instead of each
 * re-implementing "where does the manifest live".
 */
export function readManifest() {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
}

// Runtime payload only — docs/, tests/, scripts/, *.md and package.json
// never enter a store zip.
const DIRS = ['background', 'content', 'popup', 'shared'];

// Build inputs that live inside a staged directory but have no runtime
// consumer. `shared/ai-surfaces.json` is the vendored catalog that
// `npm run generate` compiles into content/web-surfaces.generated.js; nothing
// loads it at runtime, so it is a build input, not payload.
const EXCLUDE = new Set(['shared/ai-surfaces.json']);

// Strictest limit across the three stores wins, so one tree passes all of
// them: name 45 (Edge), short_name 12 (Chrome), description 132 (Chrome).
export const LIMITS = Object.freeze({ name: 45, shortName: 12, description: 132 });

// Manifest keys that get an upload auto-rejected by the Chrome Web Store /
// Edge Add-ons: `update_url` is for self-hosted CRXs, `key` is a local
// development artifact that pins an extension ID.
const FORBIDDEN_KEYS = ['update_url', 'key'];

// Icon sizes every store's listing + toolbar rendering expects.
const REQUIRED_ICON_SIZES = [16, 32, 48, 128];

// The extension-specific privacy policy. Every store requires that the policy
// disclosed in the listing is the one the extension actually points users at,
// and the company-wide policy at sonomos.ai/privacy does NOT cover this
// extension — linking it from the popup would misstate what users consented
// to. Pinned here so the popup and docs/store/LISTING.md can't drift apart.
export const PRIVACY_URL = 'https://sonomos.ai/locke/privacy';
const WRONG_PRIVACY_URL = /https:\/\/sonomos\.ai\/privacy\b/;

export const TARGETS = Object.freeze({
  chromium: Object.freeze({
    // Chrome Web Store AND Edge Add-ons take this artifact unchanged.
    files: ['managed-schema.json'],
    // Key paths to delete from the manifest, applied as text edits so the
    // shipped file differs from the reviewed one only where we mean it to.
    remove: [
      ['background', 'scripts'],          // MV2/Gecko form; Chrome ignores it, reviewers ask why
      ['browser_specific_settings']       // Gecko-only
    ]
  }),
  firefox: Object.freeze({
    // `storage.managed_schema` is Chrome-only — Firefox delivers managed
    // storage through a native manifest (docs/enterprise/templates/
    // firefox-managed-storage.json), so the schema file has no consumer in
    // this zip and only earns an addons-linter warning.
    files: [],
    remove: [
      ['background', 'service_worker'],   // Firefox has no MV3 SW; it runs an event page
      ['minimum_chrome_version'],         // Chromium-only
      ['storage']                         // Chrome-only managed_schema pointer
    ]
  })
});

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // lstat, not stat: stat follows the link, so a symlink that reached the
    // staged tree would have its TARGET's bytes read and shipped under the
    // link's name. cpSync does not dereference by default, so a link in
    // background/, content/, popup/ or shared/ really can get this far — and
    // one pointing at, say, a credentials file outside the repo would end up
    // inside a store zip.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** Stage one target into `<dist>/<target>` and return its directory. */
export function stage(target, dist) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unknown target '${target}'`);

  const manifestText = readFileSync(join(root, 'manifest.json'), 'utf8');
  const out = join(dist, target);
  mkdirSync(join(out, 'icons'), { recursive: true });

  for (const dir of DIRS) {
    cpSync(join(root, dir), join(out, dir), {
      recursive: true,
      filter: (src) => !EXCLUDE.has(relative(root, src).split(sep).join('/'))
    });
  }
  for (const file of spec.files) cpSync(join(root, file), join(out, file));
  // PNGs only: the source SVGs (icons/action.svg, icons/brand.svg) are design
  // masters, referenced by no manifest key, and just add unexplained files to
  // a reviewer's tree.
  for (const icon of readdirSync(join(root, 'icons'))) {
    if (icon.endsWith('.png')) cpSync(join(root, 'icons', icon), join(out, 'icons', icon));
  }

  // Text edits from the source bytes, per target. Nothing is shared between
  // targets to leak — each starts from the same string — and the staged
  // manifest stays diffable against the repo's, so a reviewer comparing the
  // published artifact to the source sees the removals and nothing else.
  let staged = manifestText;
  for (const path of spec.remove) staged = deletePath(staged, path);
  writeFileSync(join(out, 'manifest.json'), staged);
  return out;
}

/** Every file in a staged directory, as `{ name, data }` with `/` separators. */
export function entries(stagedDir) {
  return walk(stagedDir)
    .sort()
    .map((name) => ({ name, data: readFileSync(join(stagedDir, name)) }));
}

// ── validation ──────────────────────────────────────────────────────

function pngSize(buf) {
  // PNG signature + IHDR: width/height are big-endian u32 at bytes 16 and 20.
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function collectScripts(manifest) {
  const files = [];
  if (manifest.background?.service_worker) files.push(manifest.background.service_worker);
  for (const s of manifest.background?.scripts ?? []) files.push(s);
  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) files.push(js);
    for (const css of cs.css ?? []) files.push(css);
  }
  if (manifest.action?.default_popup) files.push(manifest.action.default_popup);
  if (manifest.storage?.managed_schema) files.push(manifest.storage.managed_schema);
  return files;
}

// Reviewer-facing remote-code smells. Every store treats "the extension can
// run code it did not ship" as a policy violation, so these must stay at zero
// rather than be argued about in a review thread.
const REMOTE_CODE_PATTERNS = [
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function('],
  [/\bimportScripts\s*\(\s*['"`]https?:/, 'importScripts() from a remote URL'],
  [/<script[^>]+src\s*=\s*['"]https?:/i, '<script src="http…">'],
  [/\bdocument\.write\s*\(/, 'document.write(']
];

/**
 * Check a staged target against the store rules.
 *
 * @param {string} target - 'chromium' | 'firefox'
 * @param {string} stagedDir - directory produced by stage()
 * @returns {string[]} human-readable failures; empty means it passes.
 */
export function validate(target, stagedDir) {
  const errors = [];
  const fail = (msg) => errors.push(`[${target}] ${msg}`);
  const manifest = JSON.parse(readFileSync(join(stagedDir, 'manifest.json'), 'utf8'));
  const shipped = new Set(walk(stagedDir));

  // ── universal store rules ──
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (manifest.version !== pkgVersion) {
    fail(`manifest version ${manifest.version} != package.json version ${pkgVersion}`);
  }
  // Chrome's rule (1–4 dot-separated integers, each 0–65535) is the strictest
  // of the three, so satisfying it satisfies Edge and AMO too.
  const parts = String(manifest.version ?? '').split('.');
  const versionOk = parts.length >= 1 && parts.length <= 4 &&
    parts.every((p) => /^\d+$/.test(p) && Number(p) <= 65535 && (p === '0' || !p.startsWith('0')));
  if (!versionOk) fail(`version '${manifest.version}' is not 1–4 integers of 0–65535`);

  if (!manifest.name?.trim()) fail('name is required');
  else if (manifest.name.length > LIMITS.name) fail(`name is ${manifest.name.length} chars (max ${LIMITS.name})`);

  if (manifest.short_name && manifest.short_name.length > LIMITS.shortName) {
    fail(`short_name is ${manifest.short_name.length} chars (max ${LIMITS.shortName})`);
  }

  if (!manifest.description?.trim()) fail('description is required');
  else if (manifest.description.length > LIMITS.description) {
    fail(`description is ${manifest.description.length} chars (max ${LIMITS.description})`);
  } else if (/[\r\n]/.test(manifest.description)) fail('description must be a single line');

  for (const key of FORBIDDEN_KEYS) {
    if (key in manifest) fail(`'${key}' must not ship in a store package`);
  }

  for (const size of REQUIRED_ICON_SIZES) {
    const path = manifest.icons?.[String(size)];
    if (!path) { fail(`icons.${size} is missing`); continue; }
    if (!shipped.has(path)) { fail(`icons.${size} points at '${path}', which is not in the package`); continue; }
    const dims = pngSize(readFileSync(join(stagedDir, path)));
    if (!dims) fail(`${path} is not a PNG`);
    else if (dims.width !== size || dims.height !== size) {
      fail(`${path} is ${dims.width}x${dims.height}, expected ${size}x${size}`);
    }
  }

  for (const file of collectScripts(manifest)) {
    if (!shipped.has(file)) fail(`manifest references '${file}', which is not in the package`);
  }

  // ── the two security invariants the compliance docs cite by name ──
  //
  // These are not store rules — no reviewer enforces them — but
  // docs/security/CONTROL-CATALOG.md, ASVS-MAPPING.md 11.1.1,
  // RISK-REGISTER.md R-01 and docs/legal/SUB-PROCESSORS.md all state that a
  // build-time tripwire enforces them, and an enterprise customer following
  // those citations must find something real. Checking here means the claim
  // holds for the artifact that actually ships, not merely for the tree.
  //
  // A1: the extension makes no outbound request except to the Locke desktop
  // app on loopback.
  // Anything other than loopback in host_permissions breaks that promise —
  // and would be invisible in a diff that only added one line.
  for (const host of manifest.host_permissions ?? []) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(host)) {
      fail(`host_permissions entry '${host}' is not loopback-only — see SECURITY.md A1 and RISK-REGISTER.md R-01`);
    }
  }

  // The store listing promises a fixed list of AI surfaces. A wildcard host
  // — in any of its spellings — contradicts that, and in the MAIN world it
  // is an unreviewable capability grab. `*.google.com` is a normal narrow
  // subdomain pattern; `*.com` is a whole TLD, so a wildcard followed by a
  // single label is the tell.
  for (const cs of manifest.content_scripts ?? []) {
    for (const match of cs.matches ?? []) {
      const host = /^(?:\*|https?|file|ftp):\/\/([^/]*)/.exec(match)?.[1];
      if (match === '<all_urls>' || host === '*' || /^\*\.[^.]+$/.test(host ?? '')) {
        const where = cs.world === 'MAIN' ? ' in the MAIN world' : '';
        fail(`content_scripts match '${match}'${where} is a wildcard host; the store listing claims a fixed AI-surface list`);
      }
    }
  }

  const csp = manifest.content_security_policy?.extension_pages;
  if (!csp) fail('content_security_policy.extension_pages is required');
  else {
    if (/unsafe-eval|unsafe-inline/.test(csp)) fail('extension_pages CSP allows unsafe-eval/unsafe-inline');
    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
    if (/https?:/.test(scriptSrc)) fail('extension_pages CSP script-src allows a remote origin');
  }

  let privacyLinks = 0;
  for (const file of shipped) {
    if (!/\.(js|mjs|html)$/.test(file)) continue;
    const text = readFileSync(join(stagedDir, file), 'utf8');
    for (const [pattern, label] of REMOTE_CODE_PATTERNS) {
      if (pattern.test(text)) fail(`${file} contains ${label} — stores treat this as remote/dynamic code`);
    }
    if (text.includes(PRIVACY_URL)) privacyLinks++;
    else if (WRONG_PRIVACY_URL.test(text)) {
      fail(`${file} links the company-wide privacy policy, which does not cover the extension — use ${PRIVACY_URL}`);
    }
  }
  if (privacyLinks === 0) fail(`no shipped page links the privacy policy (${PRIVACY_URL})`);

  // ── per-family key hygiene ──
  if (target === 'chromium') {
    if (manifest.browser_specific_settings) fail('browser_specific_settings is Gecko-only and must be stripped');
    if (manifest.background?.scripts) fail('background.scripts is Gecko-only and must be stripped');
    if (!manifest.background?.service_worker) fail('background.service_worker is required for MV3 Chromium');
    if (!/^\d+$/.test(String(manifest.minimum_chrome_version ?? ''))) {
      fail('minimum_chrome_version must be a numeric string');
    }
  }

  if (target === 'firefox') {
    if (manifest.background?.service_worker) fail('background.service_worker is unsupported in Firefox and must be stripped');
    if (!manifest.background?.scripts?.length) fail('background.scripts is required for the Firefox event page');
    if ('minimum_chrome_version' in manifest) fail('minimum_chrome_version is Chromium-only and must be stripped');
    if ('storage' in manifest) fail('storage.managed_schema is Chrome-only and must be stripped');

    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko) fail('browser_specific_settings.gecko is required for AMO');
    else {
      if (!/^(\{[0-9a-fA-F-]{36}\}|[^@\s]+@[^@\s]+)$/.test(gecko.id ?? '')) {
        fail(`gecko.id '${gecko.id}' must be an email-style id or a {GUID}`);
      }
      if (!/^\d+(\.\d+)*$/.test(String(gecko.strict_min_version ?? ''))) {
        fail('gecko.strict_min_version is required');
      }
      // Mandatory for new AMO listings since 2025-11-03: an add-on must
      // declare what personal data it collects, or declare `none`.
      const dcp = gecko.data_collection_permissions;
      if (!dcp?.required?.length) {
        fail('gecko.data_collection_permissions.required is required by AMO (use ["none"] when nothing is collected)');
      } else {
        if (dcp.required.includes('none') && dcp.required.length > 1) {
          fail("data_collection_permissions.required cannot combine 'none' with other values");
        }
        if (dcp.required.includes('technicalAndInteraction')) {
          fail("'technicalAndInteraction' may only appear in data_collection_permissions.optional");
        }
      }
    }
  }

  return errors;
}

/** Stage + validate every target into `dist`. Returns [{ target, dir, errors }]. */
export function buildAll(dist, { clean = true } = {}) {
  if (clean) rmSync(dist, { recursive: true, force: true });
  return Object.keys(TARGETS).map((target) => {
    const dir = stage(target, dist);
    return { target, dir, errors: validate(target, dir) };
  });
}
