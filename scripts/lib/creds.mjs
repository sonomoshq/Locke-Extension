// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Store credentials — where they come from, what each store needs, and how
// to keep them out of logs.
//
// Resolution order (first hit wins per variable):
//   1. process.env                       — CI secrets, or an exported shell var
//   2. $LOCKE_RELEASE_ENV                — explicit override path
//   3. ~/.config/sonomos/release.env     — the local-publish default
//
// The file lives OUTSIDE the repo on purpose. .gitignore already covers .env,
// but "the secret was never in the working tree" is a stronger guarantee than
// "the secret was ignored" — a `git add -f`, a stray editor backup, or a
// tarball of the checkout can't leak what isn't there.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ENV_FILE = join(homedir(), '.config', 'sonomos', 'release.env');

/**
 * Per-store credential contracts. `secret: true` marks values that must be
 * redacted from any output; `note` is surfaced verbatim when a value is
 * missing, so the operator is told where to get it rather than just what it
 * is called.
 */
export const STORE_CREDENTIALS = Object.freeze({
  chrome: Object.freeze({
    label: 'Chrome Web Store (API v2)',
    vars: Object.freeze([
      { name: 'CWS_PUBLISHER_ID', note: 'Developer Dashboard → Publisher → Settings' },
      { name: 'CWS_EXTENSION_ID', note: 'the 32-char item ID from the dashboard URL' },
      { name: 'CWS_CLIENT_ID', note: 'Google Cloud OAuth client (Web application type)' },
      { name: 'CWS_CLIENT_SECRET', note: 'same OAuth client', secret: true },
      { name: 'CWS_REFRESH_TOKEN', note: 'minted via the OAuth playground; expires in 7 days while the consent screen is in Testing', secret: true }
    ])
  }),
  edge: Object.freeze({
    label: 'Edge Add-ons (API v1.1)',
    vars: Object.freeze([
      { name: 'EDGE_PRODUCT_ID', note: 'Partner Center → Extension overview → Product ID (GUID)' },
      { name: 'EDGE_CLIENT_ID', note: 'Partner Center → Publish API' },
      { name: 'EDGE_API_KEY', note: 'Partner Center → Publish API; EXPIRES EVERY 72 DAYS', secret: true }
    ])
  }),
  firefox: Object.freeze({
    label: 'Firefox AMO (API v5)',
    vars: Object.freeze([
      { name: 'AMO_JWT_ISSUER', note: 'AMO → Manage API Keys → JWT issuer, e.g. user:123456:78' },
      { name: 'AMO_JWT_SECRET', note: 'AMO → Manage API Keys → JWT secret', secret: true }
      // The add-on GUID is not a credential — it is read from the manifest
      // (browser_specific_settings.gecko.id), which is the only place it may
      // ever be defined.
    ])
  })
});

export const STORES = Object.freeze(Object.keys(STORE_CREDENTIALS));

/** Parse a KEY=VALUE file. Supports `export KEY=`, #comments, and quotes. */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** The merged environment: real env wins over the file, always. */
export function loadEnv({ env = process.env, file = env.LOCKE_RELEASE_ENV || DEFAULT_ENV_FILE } = {}) {
  const fromFile = file && existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...env };
}

/**
 * Resolve one store's credentials.
 * Returns { ok, values, missing[] } — never throws, so preflight can report
 * every store's gaps in a single pass instead of failing on the first.
 */
export function credentialsFor(store, options = {}) {
  const spec = STORE_CREDENTIALS[store];
  if (!spec) throw new Error(`unknown store: ${store}`);
  const env = options.env ? options.env : loadEnv(options);

  const values = {};
  const missing = [];
  for (const v of spec.vars) {
    const value = env[v.name];
    if (value === undefined || value === '') missing.push(v);
    else values[v.name] = value;
  }
  return { store, label: spec.label, ok: missing.length === 0, values, missing };
}

/** The secret values currently resolvable, for redaction. */
export function secretValues(options = {}) {
  const env = options.env ? options.env : loadEnv(options);
  const secrets = [];
  for (const spec of Object.values(STORE_CREDENTIALS)) {
    for (const v of spec.vars) {
      if (v.secret && env[v.name]) secrets.push(env[v.name]);
    }
  }
  return secrets;
}

/**
 * Replace every known secret with «redacted».
 *
 * Applied to everything a publisher prints. Store APIs echo request context
 * into error bodies, and an access token in a terminal scrollback (or a CI
 * log, once this repo is public) is a live credential.
 */
export function redact(text, secrets = secretValues()) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('«redacted»');
  }
  // Bearer/JWT/ApiKey values that never came from our env (e.g. a minted
  // access token) still must not survive into a log.
  out = out.replace(/(Bearer|JWT|ApiKey)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 «redacted»');
  return out;
}
