// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Firefox AMO publisher — addons.mozilla.org submission API v5.
//
// The flow AMO actually implements is three calls, not one:
//
//   1. POST  addons/upload/            multipart zip → { uuid, processed:false }
//   2. GET   addons/upload/{uuid}/     poll until processed:true, then read `valid`
//   3. POST  addons/addon/{guid}/versions/   { upload: uuid, ... } → the version
//
// Step 1 hands back a *validation job*, not a version. Nothing is published
// until step 3 attaches that uuid to the add-on, and a uuid may be attached
// exactly once (the record carries a `submitted` flag for precisely this).
//
// AMO is post-review: once a package validates, it is signed and published
// automatically, and a human reviewer looks at it later. There is no
// "pending approval" state to wait on via the API — `nativeMessaging` raises
// our review weight (a human will definitely look), but it does not gate
// signing. Anyone extending this must not add a poll for an approval that the
// API will never report.
//
// Like the other publishers here: zero npm deps, `fetchImpl` injectable on
// every network-touching function, and `publish()` never throws for an API or
// credential failure — a release runner needs a result object per store, not
// an exception that kills the remaining two.

import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { request, poll, multipart } from '../lib/http.mjs';
import { credentialsFor, redact, secretValues } from '../lib/creds.mjs';
import { readManifest } from '../store-build.mjs';

export const store = 'firefox';
export const label = 'Firefox AMO';

export const API_BASE = 'https://addons.mozilla.org/api/v5/';

// AMO rejects any JWT whose `exp` is more than 300 seconds past `iat`. 240
// leaves an explicit minute of headroom for clock skew between this machine
// and Mozilla's — a token that is "valid" locally and expired server-side is
// an opaque 401 with no useful body.
export const JWT_LIFETIME_SECONDS = 240;

// AMO's `listed` channel = distributed on addons.mozilla.org. The alternative,
// `unlisted`, means self-distribution (signed but not listed), which is a
// different product decision, not a knob a release script should flip.
const CHANNEL = 'listed';

// Mirrors the repo's LICENSE. AMO requires a license slug on every listed
// version; sending it every time is cheaper than reading back which one the
// add-on already has.
const LICENSE = 'MPL-2.0';

// ── JWT ───────────────────────────────────────────────────────────────

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Build one AMO API token (HS256, symmetric — the "secret" from Manage API
 * Keys *is* the HMAC key; there is no keypair anywhere in this flow).
 *
 * Pure by construction: `now` and `jti` are parameters so a test can assert
 * the exact claim set. AMO validates the claims strictly — it wants exactly
 * iss/jti/iat/exp, and it rejects a replayed `jti`, so the nonce must be
 * fresh per token, not per release.
 */
export function signJwt({ issuer, secret, now = Math.floor(Date.now() / 1000), jti = randomUUID() } = {}) {
  if (!issuer) throw new Error('signJwt: issuer is required');
  if (!secret) throw new Error('signJwt: secret is required');

  const iat = Math.floor(now);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: issuer, jti: String(jti), iat, exp: iat + JWT_LIFETIME_SECONDS };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = b64url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

/**
 * A token *factory*, not a token.
 *
 * Re-signing per request is mandatory, not tidiness: validation polling
 * routinely runs longer than a token's 240s life (a first upload of a new
 * add-on can sit in the linter queue for minutes), so a token captured once
 * at the top of publish() would expire mid-poll and turn a healthy release
 * into a 401 storm. Every request below calls `token()` fresh, and each call
 * also mints a new `jti` — AMO treats a reused nonce as a replay.
 */
export function tokenFactory({ issuer, secret }) {
  return () => signJwt({ issuer, secret });
}

const authHeader = (token) => ({ Authorization: `JWT ${token}` });

// ── Preflight ─────────────────────────────────────────────────────────

/**
 * Everything checkable without touching the network: credentials present, and
 * the two manifest keys AMO refuses an upload without.
 *
 * Returns { ok, problems, warnings } and never throws — the release runner
 * prints every store's gaps in one pass.
 */
export function preflight({ env } = {}) {
  const problems = [];
  const warnings = [];

  const creds = credentialsFor(store, { env });
  for (const missing of creds.missing) {
    // Name AND note: "AMO_JWT_SECRET is missing" is useless at 2am; "AMO →
    // Manage API Keys → JWT secret" is actionable.
    problems.push(`${missing.name} is not set — ${missing.note}`);
  }

  let manifest;
  try {
    manifest = readManifest();
  } catch (err) {
    problems.push(`manifest.json could not be read: ${err.message}`);
    return { ok: false, problems, warnings };
  }

  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko?.id) {
    // The GUID is the add-on's identity on AMO and is deliberately NOT an env
    // var: an env-supplied GUID can point a release at the wrong add-on, and
    // changing it orphans every existing install.
    problems.push('browser_specific_settings.gecko.id is missing — AMO addresses the add-on by GUID and there is no env-var fallback by design');
  }

  const required = gecko?.data_collection_permissions?.required;
  if (!Array.isArray(required) || required.length === 0) {
    // Mandatory for new add-ons since 2025-11-03 and extended to all add-ons
    // during H1 2026. AMO blocks the submission outright — this is a hard
    // problem, not a warning, because the upload cannot succeed without it.
    problems.push('browser_specific_settings.gecko.data_collection_permissions.required is missing or empty — AMO blocks submission without it (use ["none"] when the add-on collects nothing)');
  }

  if (!gecko?.strict_min_version) {
    // Not fatal: we fall back to a floor below, but an unset value means the
    // compatibility range we declare stops matching the manifest.
    warnings.push(`gecko.strict_min_version is unset; version compatibility will be declared as ${FALLBACK_MIN_VERSION}`);
  }

  if ((manifest.permissions || []).includes('nativeMessaging')) {
    // Worth saying out loud once per release so nobody reads the eventual
    // reviewer email as a failure: it raises review weight, not a signing gate.
    warnings.push('manifest requests nativeMessaging — this raises AMO review weight (a human WILL review) but does not block signing or publication');
  }

  return { ok: problems.length === 0, problems, warnings };
}

// Firefox 128 is where `world: "MAIN"` content scripts landed, which the shim
// depends on; it is the same floor scripts/store-build.mjs enforces.
const FALLBACK_MIN_VERSION = '128.0';

// ── Step 1: upload ────────────────────────────────────────────────────

/**
 * POST the zip to addons/upload/. Returns the parsed upload record
 * { uuid, channel, processed, submitted, url, valid, validation, version }.
 *
 * `data` is injectable so a test can exercise request shaping without a real
 * artifact; in production it is the bytes at `zipPath`.
 */
export async function uploadPackage({
  zipPath,
  data = readFileSync(zipPath),
  channel = CHANNEL,
  token,
  fetchImpl,
  timeoutMs = 300000
}) {
  const form = multipart({
    upload: { data, filename: basename(zipPath), type: 'application/zip' },
    channel
  });

  const res = await request(`${API_BASE}addons/upload/`, {
    method: 'POST',
    // Only the Authorization header: multipart() deliberately leaves
    // Content-Type unset so fetch generates the boundary itself.
    headers: authHeader(token()),
    body: form,
    // No retries. An upload is not idempotent — every accepted POST creates
    // another server-side validation job with its own uuid, so a retry after
    // an ambiguous failure silently litters the account with orphan uploads.
    retries: 0,
    timeoutMs,
    fetchImpl
  });

  if (!res.ok || !res.json?.uuid) {
    throw new Error(`upload failed: HTTP ${res.status} ${truncate(res.text)}`);
  }
  return res.json;
}

// ── Step 2: poll validation ───────────────────────────────────────────

/**
 * GET addons/upload/{uuid}/ until `processed` flips true.
 *
 * Deliberately does NOT judge `valid` — the caller does, so that the
 * "processed but invalid" case gets a proper validation dump instead of a
 * generic poll timeout.
 */
export async function pollUpload({
  uuid,
  token,
  fetchImpl,
  intervalMs = 5000,
  timeoutMs = 600000,
  onTick
}) {
  return poll(
    async () => {
      const res = await request(`${API_BASE}addons/upload/${encodeURIComponent(uuid)}/`, {
        // Fresh token every tick — see tokenFactory(): the poll outlives the
        // 240s token life on any non-trivial package.
        headers: authHeader(token()),
        // A GET is safe to retry, unlike the upload above.
        retries: 3,
        timeoutMs: 60000,
        fetchImpl
      });
      if (!res.ok) throw new Error(`upload status check failed: HTTP ${res.status} ${truncate(res.text)}`);
      return res.json ?? {};
    },
    { done: (v) => v.processed === true, intervalMs, timeoutMs, label: 'AMO validation', onTick }
  );
}

/**
 * Condense the addons-linter output into something a release log can carry.
 *
 * The raw `validation` blob is the linter's full JSON — every notice on every
 * line of every file. Dumping it buries the two lines that matter, so this
 * keeps the counts and the actual error text.
 */
export function summarizeValidation(validation) {
  if (!validation) return 'no validation payload returned';

  const messages = Array.isArray(validation.messages) ? validation.messages : [];
  const errors = messages.filter((m) => m.type === 'error');
  const counts = `errors=${validation.errors ?? errors.length} warnings=${validation.warnings ?? '?'} notices=${validation.notices ?? '?'}`;

  const lines = errors.slice(0, 10).map((m) => {
    const where = [m.file, m.line].filter(Boolean).join(':');
    return `  • ${m.message}${m.description ? ` — ${[].concat(m.description).join(' ')}` : ''}${where ? ` (${where})` : ''}`;
  });
  if (errors.length > lines.length) lines.push(`  • …and ${errors.length - lines.length} more error(s)`);

  return [counts, ...lines].join('\n');
}

// ── Step 3: create the version ────────────────────────────────────────

/**
 * Attach a validated upload uuid to the existing add-on as a new version.
 *
 * Returns the raw response object rather than throwing on 4xx, because the
 * caller has to distinguish "this version already exists" (benign, re-run of a
 * finished release) from a genuine rejection.
 */
export async function createVersion({
  guid,
  uuid,
  releaseNotes,
  approvalNotes = DEFAULT_APPROVAL_NOTES,
  license = LICENSE,
  minVersion = FALLBACK_MIN_VERSION,
  token,
  fetchImpl,
  timeoutMs = 120000
}) {
  const body = {
    upload: uuid,
    license,
    // AMO stores release notes per locale; en-US is the listing's default.
    release_notes: releaseNotes ? { 'en-US': releaseNotes } : undefined,
    approval_notes: approvalNotes,
    // Declared, not inferred: AMO would otherwise guess a compatibility range
    // from the manifest and can pick a floor below the one the shim needs.
    compatibility: { firefox: { min: minVersion, max: '*' } }
  };

  return request(`${API_BASE}addons/addon/${encodeURIComponent(guid)}/versions/`, {
    method: 'POST',
    headers: { ...authHeader(token()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Not idempotent either: a retried POST that actually succeeded the first
    // time comes back as a duplicate-version error, which is noise at best.
    retries: 0,
    timeoutMs,
    fetchImpl
  });
}

// Reviewers get told what they cannot see from the package alone: why there is
// no build step, and what the native host on the other end of the port is.
const DEFAULT_APPROVAL_NOTES = [
  'This add-on ships exactly the source in the repository: no bundler, no minifier, no transpiler, no third-party runtime dependencies.',
  'Every file in the package is human-readable as authored.',
  'nativeMessaging is used to talk to a locally installed companion host over a native messaging port; all network egress is loopback-only (see host_permissions).'
].join(' ');

// ── Duplicate detection ───────────────────────────────────────────────

// The "this version is already published" family of responses. These are DRF
// field-validation errors: near-certainly HTTP 400, with the message inside a
// per-field array, e.g. {"version":["Version 2.0.0 already exists."]}.
//
// The exact status code is UNVERIFIED against a live account, so detection is
// message-based and treats the status only as a hint — matching on 400 alone
// would swallow real rejections, and requiring 400 would miss the case where
// AMO answers 409.
const ALREADY_PUBLISHED_PATTERNS = [
  /version\s+\S+\s+already exists/i,
  /was uploaded before and deleted/i,
  /must be greater than the previous approved version/i
];

/** Every string anywhere in a DRF error body, flattened. */
function messageStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) messageStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) messageStrings(v, out);
  return out;
}

/**
 * True when a failed createVersion response means "this version is already on
 * AMO" — a re-run of an already-finished release, which is a skip, not a
 * failure that should fail the release job.
 */
export function isAlreadyPublished(res) {
  if (!res || res.ok) return false;
  // Status hint only: 4xx narrows the field, the message decides.
  if (res.status < 400 || res.status >= 500) return false;
  const haystack = messageStrings(res.json ?? {}).concat(res.text ? [res.text] : []);
  return haystack.some((s) => ALREADY_PUBLISHED_PATTERNS.some((re) => re.test(s)));
}

// ── publish ───────────────────────────────────────────────────────────

/**
 * Sign → upload → poll validation → create version.
 *
 * Returns { store, ok, status, message, data } with
 * status ∈ 'submitted' | 'skipped' | 'failed' | 'dry-run'.
 * Never throws for an API or credential failure.
 */
export async function publish({
  zipPath,
  version,
  releaseNotes,
  dryRun = false,
  env,
  fetchImpl,
  log = console.log
} = {}) {
  // Starts empty and is filled inside the try below. Both credentialsFor() and
  // secretValues() read ~/.config/sonomos/release.env through loadEnv(), which
  // throws if that path is a directory or unreadable (EACCES) — resolving them
  // out here would throw a credential failure straight past the try and out of
  // publish(), which is exactly what the contract forbids. Until they resolve,
  // the empty list still scrubs `JWT <token>` by pattern.
  let secrets = [];
  // Every publisher self-prefixes with its store key (never its label), so
  // three concurrent publishers interleave into one readable stream and
  // scripts/publish.mjs does not have to prefix again.
  const say = (msg) => log(redact(`[${store}] ${msg}`, secrets));

  // Results are redacted, not just log lines: `message` and `data` are written
  // to dist/publish-report.json and printed to stdout, and both carry text AMO
  // wrote — a 4xx/5xx body can echo the request, JWT and all.
  const done = (ok, status, message, data = {}) => ({
    store,
    ok,
    status,
    message: redact(String(message), secrets),
    data: scrub(data, secrets)
  });
  const fail = (message, data) => done(false, 'failed', message, data);

  try {
    // Redaction list built once: the known store secrets, plus the JWT secret
    // from this run's env in case it was injected rather than resolved.
    const creds = credentialsFor(store, { env });
    secrets = [...secretValues({ env }), creds.values.AMO_JWT_SECRET].filter(Boolean);

    const checks = preflight({ env });
    for (const w of checks.warnings) say(`warning: ${w}`);
    if (!checks.ok) {
      // A failed preflight is a failure even under --dry-run: the point of the
      // dry run is to find exactly this before a release window opens.
      for (const p of checks.problems) say(`problem: ${p}`);
      return fail(`preflight failed (${checks.problems.length} problem(s))`, { problems: checks.problems });
    }

    const manifest = readManifest();
    const gecko = manifest.browser_specific_settings.gecko;
    const guid = gecko.id;
    const minVersion = gecko.strict_min_version || FALLBACK_MIN_VERSION;
    const target = version ?? manifest.version;
    if (version && version !== manifest.version) {
      // Not fatal — AMO takes the version from the packaged manifest, not from
      // us — but a mismatch means the caller's bookkeeping has drifted.
      say(`warning: requested version ${version} != manifest version ${manifest.version}; AMO will use the packaged manifest's value`);
    }

    if (!zipPath || !existsSync(zipPath)) {
      return fail(`artifact not found: ${zipPath ?? '(no zipPath given)'} — run npm run package first`);
    }
    const bytes = statSync(zipPath).size;

    if (dryRun) {
      // Stops here on purpose. An AMO upload is NOT side-effect-free: a
      // successful POST creates a server-side validation job and a uuid tied
      // to the account, so "just checking it works" would leave debris.
      say(`dry run: would upload ${basename(zipPath)} (${bytes} bytes) to ${guid} on the ${CHANNEL} channel, min Firefox ${minVersion}`);
      return done(true, 'dry-run', `dry run OK — credentials and manifest are submission-ready for ${guid} ${target}`, {
        guid, version: target, minVersion, channel: CHANNEL, zipPath, bytes
      });
    }

    const token = tokenFactory({ issuer: creds.values.AMO_JWT_ISSUER, secret: creds.values.AMO_JWT_SECRET });

    say(`uploading ${basename(zipPath)} (${bytes} bytes) on the ${CHANNEL} channel…`);
    const upload = await uploadPackage({ zipPath, token, fetchImpl });
    say(`upload accepted: uuid ${upload.uuid}`);

    const processed = upload.processed
      ? upload
      : await pollUpload({
          uuid: upload.uuid,
          token,
          fetchImpl,
          onTick: ({ ticks }) => say(`waiting for addons-linter… (poll ${ticks})`)
        });

    if (processed.valid !== true) {
      // Gate on `valid`, never on "no warnings". addons-linter emits warnings
      // for perfectly signable add-ons (unrecognised keys, permission
      // advisories); only `valid === false` blocks signing, and treating
      // warnings as fatal would make every release depend on linter churn.
      const summary = summarizeValidation(processed.validation);
      say(`validation FAILED\n${summary}`);
      return fail('package failed AMO validation', {
        uuid: upload.uuid,
        validation: summarizeValidation(processed.validation)
      });
    }
    say('validation passed (warnings, if any, do not block signing)');

    if (processed.submitted === true) {
      // A uuid can be attached to an add-on exactly once. Seeing this means
      // the version already went through — treat it as a completed release.
      return done(true, 'skipped', `upload ${upload.uuid} was already submitted — version ${target} is already on AMO`, {
        guid, uuid: upload.uuid, version: target
      });
    }

    say(`creating version ${target} for ${guid}…`);
    const res = await createVersion({
      guid,
      uuid: upload.uuid,
      releaseNotes,
      minVersion,
      token,
      fetchImpl
    });

    if (isAlreadyPublished(res)) {
      const detail = messageStrings(res.json ?? {}).join('; ') || truncate(res.text);
      say(`already published: ${detail}`);
      // `detail` is AMO's own error text, so it goes out through done() like
      // every other returned message rather than being interpolated raw.
      return done(true, 'skipped', `version ${target} is already on AMO: ${detail}`, {
        guid, uuid: upload.uuid, version: target, status: res.status
      });
    }

    if (!res.ok) {
      say(`version creation FAILED: HTTP ${res.status} ${truncate(res.text)}`);
      return fail(`version creation failed: HTTP ${res.status}`, {
        guid,
        uuid: upload.uuid,
        status: res.status,
        body: truncate(res.text)
      });
    }

    const created = res.json ?? {};
    // No source upload is sent, and none is required: the extension is
    // unbundled, unminified and dependency-free, so the package IS the source.
    // The moment anyone adds a bundler or minifier, AMO's policy requires a
    // separate multipart `PATCH addons/addon/{guid}/versions/{id}/` carrying a
    // `source` field, and a release without it will be rejected in review.
    say(`submitted: version ${created.version ?? target} (id ${created.id ?? '?'})`);
    say('AMO signs and publishes valid packages automatically; the human review happens afterwards, so there is no approval state to wait for here.');

    return done(true, 'submitted', `version ${created.version ?? target} submitted to AMO (id ${created.id ?? 'unknown'})`, {
      guid,
      uuid: upload.uuid,
      version: created.version ?? target,
      id: created.id,
      url: created.url ?? upload.url,
      channel: created.channel ?? CHANNEL
    });
  } catch (err) {
    // Includes network failures, poll timeouts and upload rejections. The
    // release runner gets a result, not a thrown error, so the other stores
    // still get their turn. Also catches loadEnv() blowing up on an unreadable
    // release.env — a credential failure must come back as a result too.
    // No redact() here: say() and fail() each apply it on the way out.
    const message = err?.message ?? String(err);
    say(`failed: ${message}`);
    return fail(message, { error: message });
  }
}

/**
 * Redact every string anywhere inside a result's `data`.
 *
 * Redacting `message` alone is not enough: `data` is serialised into
 * dist/publish-report.json too, and it carries AMO-authored text (validation
 * summaries, error bodies). Walking the structure removes the "which field did
 * I forget this time" question. Non-plain values are returned untouched —
 * numbers and nulls cannot hide a secret, and stringifying them here would
 * change the report's shape.
 */
function scrub(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  }
  return value;
}

// Error bodies from AMO can be an entire HTML error page; keep logs readable.
function truncate(text, max = 500) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
