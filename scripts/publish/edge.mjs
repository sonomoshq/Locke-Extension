// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Edge Add-ons publisher — Microsoft Edge Add-ons Update REST API, "v1.1".
//
// Two things about that version label trip people up, so they are stated once
// here and repeated at the call sites:
//
//   1. "v1.1" describes the CREDENTIAL GENERATION (API key + client ID minted
//      in Partner Center → Publish API), not a URL segment. Every path below
//      is `/v1/...`. If you "fix" them to `/v1.1/` you get 404s.
//   2. v1.1 is the ONLY path. The v1 flow authenticated with Azure AD / Entra
//      client credentials (client_secret → OAuth token → Bearer); Microsoft
//      retired that on 2025-01-10 and it now fails auth outright. There is
//      deliberately no token-minting code in this file — if you find yourself
//      wanting one, you are reading pre-2025 documentation.
//
// The publish path is two asynchronous operations back to back: upload the zip
// into the draft submission, wait for it to validate, then create the
// submission and wait for that to be accepted. Both hand back an operation ID
// and are polled; neither tells you anything about certification, which
// happens later and out of band (see PUBLISH STATUS note near submitDraft).
//
// Everything that touches the network takes `fetchImpl` so the whole flow can
// be driven against a fake in tests — there is no sandbox tenant for this API,
// so a fake is the only way to exercise the error paths that matter.

import { readFileSync } from 'node:fs';

import { poll, request } from '../lib/http.mjs';
import { credentialsFor, loadEnv, redact, secretValues } from '../lib/creds.mjs';

export const store = 'edge';
export const label = 'Edge Add-ons';

export const BASE_URL = 'https://api.addons.microsoftedge.microsoft.com';

// Microsoft's own guidance: poll every ~5s, give up after ~10 minutes. Package
// validation on a small MV3 zip is usually seconds; the ceiling exists so a
// stuck operation fails the release instead of hanging CI forever.
export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 600000;

// The API key's lifetime is fixed and the key itself is an opaque string with
// no readable expiry — the only defence is calendar discipline, which is why
// preflight nags unconditionally.
export const API_KEY_LIFETIME_DAYS = 72;
export const API_KEY_WARN_DAYS = 14;

// Certification notes have no documented length limit. 5000 is our own
// ceiling: long enough for a real changelog, short enough that a runaway
// generated string can't turn a submission into a 413 mid-release.
export const MAX_NOTES_CHARS = 5000;

/**
 * Failure codes the operation endpoints return in `errorCode`, and what a
 * release run should DO about each.
 *
 * `outcome: 'skipped'` means "this run has nothing to do", not "this run
 * broke" — a nightly/tag pipeline that publishes to three stores must not go
 * red because Edge is still certifying yesterday's build. That distinction is
 * the entire reason this table exists rather than a boolean.
 */
export const ERROR_CODES = Object.freeze({
  // The API can update an existing product but can never create one. First
  // publish is always a human in Partner Center.
  CreateNotAllowed: Object.freeze({
    outcome: 'failed',
    hint: 'the Update API cannot create a product — create the extension once in Partner Center, then set EDGE_PRODUCT_ID'
  }),
  // Byte-identical to what is already published: nothing to submit.
  NoModulesUpdated: Object.freeze({
    outcome: 'skipped',
    hint: 'no changes since the last publish — the draft matches what is already live'
  }),
  // The common CI collision: a previous submission is still in certification,
  // which can take days. Nothing is wrong; this build simply cannot go now.
  InProgressSubmission: Object.freeze({
    outcome: 'skipped',
    hint: 'a previous submission is still in certification — retry once it clears (certification can take up to 7 business days)'
  }),
  UnpublishInProgress: Object.freeze({
    outcome: 'failed',
    hint: 'the extension is being unpublished — wait for that to finish before submitting again'
  }),
  ModuleStateUnPublishable: Object.freeze({
    outcome: 'failed',
    hint: 'the draft is not in a publishable state — open Partner Center and complete the listing/availability sections'
  }),
  SubmissionValidationError: Object.freeze({
    outcome: 'failed',
    hint: 'the package failed validation — see the errors listed above'
  })
});

/**
 * Auth headers for every call.
 *
 * The client-ID header is spelled `X-ClientID` — capital I, capital D, no
 * hyphen before ID. `X-Client-ID` (the spelling every other API in this repo
 * would suggest) is silently ignored and the request comes back 401 with a
 * body that blames the API key, which is a spectacular waste of an afternoon.
 * Do not "normalise" this header name.
 */
export function authHeaders({ apiKey, clientId }) {
  return {
    Authorization: `ApiKey ${apiKey}`,
    'X-ClientID': clientId
  };
}

// Both operation endpoints answer with the same document shape, so only the
// path differs. `/v1/`, not `/v1.1/` — see the file header.
export const operationUrl = ({ productId, operationId, kind }) => (
  kind === 'submission'
    ? `${BASE_URL}/v1/products/${productId}/submissions/operations/${operationId}`
    : `${BASE_URL}/v1/products/${productId}/submissions/draft/package/operations/${operationId}`
);

/**
 * Normalise an operation document into a decision.
 *
 * Pure and total: takes whatever JSON the API returned (or null, when the body
 * was empty or not JSON) and answers the only three questions a caller has.
 * `errors[]` is folded into `message` because SubmissionValidationError puts
 * the actionable detail there and leaves `message` generic.
 *
 * An unrecognised or absent status yields all three flags false, which the
 * poller reads as "keep waiting" — better to hit the timeout than to declare
 * success on a body we did not understand.
 */
export function classifyOperation(json) {
  const status = String(json?.status ?? '').trim().toLowerCase();

  const parts = [];
  if (json?.message) parts.push(String(json.message));
  for (const err of Array.isArray(json?.errors) ? json.errors : []) {
    if (typeof err === 'string') parts.push(err);
    else {
      const detail = [err?.code, err?.message].filter(Boolean).join(': ');
      parts.push(detail || JSON.stringify(err));
    }
  }

  return {
    inProgress: status === 'inprogress',
    succeeded: status === 'succeeded',
    failed: status === 'failed',
    errorCode: json?.errorCode ?? null,
    message: parts.join(' | ')
  };
}

/** What a given errorCode means for the run. Unknown codes are hard failures. */
export function describeErrorCode(errorCode) {
  return ERROR_CODES[errorCode] ?? { outcome: 'failed', hint: null };
}

/**
 * Pull the operation ID out of a 202's Location header.
 *
 * The header holds a BARE GUID, not a URL — unlike every other async REST API
 * you have used, you cannot just follow it. The operations path has to be
 * assembled by hand (see operationUrl). The trailing-segment split is pure
 * defence in case a proxy ever rewrites it into an absolute URL.
 */
export function operationIdFrom(headers = {}) {
  const raw = headers.location ?? headers.Location ?? '';
  const id = String(raw).trim().replace(/\/+$/, '').split('/').pop();
  return id || null;
}

/**
 * Trim absurd release notes rather than letting the API reject the submission.
 *
 * Returns { text, truncated } instead of just the string: whether the notes
 * were cut is not recoverable from the result. Notes that are exactly
 * MAX_NOTES_CHARS long come back untouched, so a caller comparing
 * `text.length === MAX_NOTES_CHARS` reports a truncation that never happened —
 * and that claim ends up in the publish report.
 */
export function truncateNotes(notes) {
  const text = String(notes ?? '').trim();
  if (text.length <= MAX_NOTES_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_NOTES_CHARS - 15)}... [truncated]`, truncated: true };
}

/**
 * Days left on the API key, given the ISO date it was issued.
 *
 * Optional: EDGE_API_KEY_ISSUED is something the operator maintains by hand,
 * because the key carries no expiry we can read. When it is absent we still
 * warn — a 72-day fuse nobody is watching is how a release night gets ruined.
 */
export function apiKeyExpiry(issuedISO, now = Date.now()) {
  if (!issuedISO) return { known: false };
  const issued = Date.parse(issuedISO);
  if (!Number.isFinite(issued)) return { known: false, invalid: String(issuedISO) };
  const expiresAt = issued + API_KEY_LIFETIME_DAYS * 86400000;
  return {
    known: true,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    daysRemaining: Math.floor((expiresAt - now) / 86400000)
  };
}

/**
 * Credential and configuration check. No network: there is nothing to call.
 *
 * Returns { ok, problems, warnings }. Problems block a run; warnings are
 * printed and ignored.
 */
export function preflight({ env } = {}) {
  const resolved = env ?? loadEnv();
  const creds = credentialsFor(store, { env: resolved });

  const problems = [];
  const warnings = [];

  for (const v of creds.missing) problems.push(`${v.name} is not set — ${v.note}`);

  // Unconditional, every run, even when everything is green: the key expires
  // 72 days after it is minted and nothing in the request or the response ever
  // says so. The first symptom is a 401 in the middle of a release.
  warnings.push(
    `EDGE_API_KEY expires ${API_KEY_LIFETIME_DAYS} days after it is issued and exposes no expiry — ` +
    'rotate it in Partner Center → Publish API and record the date in EDGE_API_KEY_ISSUED (ISO date)'
  );

  const expiry = apiKeyExpiry(resolved.EDGE_API_KEY_ISSUED);
  if (expiry.invalid) {
    warnings.push(`EDGE_API_KEY_ISSUED is not a parseable date (${expiry.invalid}) — expiry not tracked`);
  } else if (expiry.known) {
    if (expiry.daysRemaining < 0) {
      problems.push(
        `EDGE_API_KEY expired ${Math.abs(expiry.daysRemaining)} day(s) ago (issued ${expiry.issuedAt}) — ` +
        'mint a new key in Partner Center → Publish API'
      );
    } else if (expiry.daysRemaining < API_KEY_WARN_DAYS) {
      warnings.push(
        `EDGE_API_KEY expires in ${expiry.daysRemaining} day(s) (${expiry.expiresAt}) — rotate it soon`
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Upload the zip into the draft submission.
 *
 * Raw zip bytes as the body with Content-Type: application/zip — NOT
 * multipart, unlike AMO. Success is 202 plus a Location header; the response
 * body is empty, so there is nothing to parse on the happy path.
 *
 * `zipBytes` exists so tests (and any caller that already has the buffer) can
 * skip the filesystem; normal callers pass `zipPath`.
 */
export async function uploadPackage({
  productId,
  zipPath,
  zipBytes,
  apiKey,
  clientId,
  fetchImpl,
  timeoutMs = 300000,
  // No retries. request() retries 429s and 5xx, but a POST that answers 502 may
  // already have been accepted server-side — the retry then opens a SECOND
  // draft-package operation against the same draft, and the first one is left
  // running with nobody polling it. The polling GETs keep their retries; only
  // the non-idempotent POST gives them up.
  retries = 0
}) {
  const body = zipBytes ?? readFileSync(zipPath);
  const url = `${BASE_URL}/v1/products/${productId}/submissions/draft/package`;

  const res = await request(url, {
    method: 'POST',
    headers: { ...authHeaders({ apiKey, clientId }), 'Content-Type': 'application/zip' },
    body,
    fetchImpl,
    timeoutMs,
    retries
  });

  const operationId = operationIdFrom(res.headers);
  return {
    ok: res.ok && Boolean(operationId),
    status: res.status,
    operationId,
    bytes: body.length,
    // Failure bodies are the only place the API explains itself, so they are
    // carried out rather than dropped — the caller redacts before logging.
    message: res.ok
      ? (operationId ? '' : 'upload returned 2xx without a Location header (no operation to poll)')
      : `upload failed: HTTP ${res.status} ${res.text || '(empty body)'}`,
    response: res
  };
}

/**
 * Create the submission from the current draft.
 *
 * The body is `{"notes": "..."}` — certification notes for the reviewer. It is
 * effectively optional (an empty object submits fine), which is just as well,
 * because Microsoft's published sample shows `{ "notes"="..." }`, i.e. not
 * JSON at all. Send real JSON.
 *
 * PUBLISH STATUS: a `Succeeded` operation means "submission created and queued
 * for certification". It does NOT mean the extension is live. Certification
 * takes up to 7 business days and this API exposes no endpoint for its state —
 * the only signal is Partner Center / the store listing.
 */
export async function submitDraft({
  productId,
  notes = '',
  apiKey,
  clientId,
  fetchImpl,
  timeoutMs = 120000,
  // No retries, for the same reason as uploadPackage — and here the cost is
  // worse. A 502 on a submit does not mean the submit was refused, so retrying
  // creates a SECOND submission, which is precisely the InProgressSubmission
  // collision the rest of this file works to avoid: the run then skips on a
  // collision it caused itself.
  retries = 0
}) {
  const url = `${BASE_URL}/v1/products/${productId}/submissions`;

  const res = await request(url, {
    method: 'POST',
    headers: { ...authHeaders({ apiKey, clientId }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: truncateNotes(notes).text }),
    fetchImpl,
    timeoutMs,
    retries
  });

  const operationId = operationIdFrom(res.headers);
  return {
    ok: res.ok && Boolean(operationId),
    status: res.status,
    operationId,
    // A rejected submit sometimes carries the same errorCode vocabulary as an
    // operation document (InProgressSubmission in particular arrives this way),
    // so the classification is handed back for the caller to route.
    classification: classifyOperation(res.json),
    message: res.ok
      ? (operationId ? '' : 'submit returned 2xx without a Location header (no operation to poll)')
      : `submit failed: HTTP ${res.status} ${res.text || '(empty body)'}`,
    response: res
  };
}

/**
 * Poll one operation to a terminal state.
 *
 * `kind` selects the endpoint: 'package' (upload validation) or 'submission'
 * (publish). Both return the same document, so the same classifier serves
 * both. Resolves with the classification plus the raw JSON; throws only when
 * the deadline passes, which the caller converts into a failed result.
 */
export async function pollOperation({
  productId,
  operationId,
  kind = 'package',
  apiKey,
  clientId,
  fetchImpl,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
  onTick
}) {
  const url = operationUrl({ productId, operationId, kind });

  const probe = async () => {
    const res = await request(url, {
      headers: authHeaders({ apiKey, clientId }),
      fetchImpl,
      retries: 3,
      timeoutMs: 60000
    });
    return { res, ...classifyOperation(res.json) };
  };

  return poll(probe, {
    done: (v) => v.succeeded || v.failed,
    intervalMs,
    timeoutMs,
    label: `${kind} operation ${operationId}`,
    onTick
  });
}

/**
 * Full publish: upload → wait → submit → wait.
 *
 * Never throws for an API, credential, or timeout failure — a release runner
 * publishes to several stores in one pass and needs a result object per store,
 * not an exception that abandons the others. Programmer errors (a bad argument
 * shape) are the only thing that can still escape, and even those are caught
 * and reported rather than propagated.
 */
export async function publish({
  zipPath,
  version,
  releaseNotes,
  dryRun = false,
  env,
  fetchImpl,
  log = console.log,
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS
} = {}) {
  // Secrets are collected from the SAME resolved env the run uses, so an
  // injected env (CI, tests) redacts as reliably as an ambient one. Until then
  // the empty list still scrubs `ApiKey <token>` by pattern.
  let secrets = [];
  const say = (msg) => log(redact(String(msg), secrets));
  // Every result goes through redaction, not just the log line. `message` and
  // `data` are written to dist/publish-report.json and printed to stdout, and
  // the failure messages below carry raw response bodies — a 401 from this API
  // echoes the request headers back, `Authorization: ApiKey <key>` included, so
  // an unredacted result is a live credential in an artifact.
  const result = (ok, status, message, data = {}) => ({
    store,
    ok,
    status,
    message: redact(String(message), secrets),
    data: scrub(data, secrets)
  });

  try {
    const resolvedEnv = env ?? loadEnv();
    secrets = secretValues({ env: resolvedEnv });

    const check = preflight({ env: resolvedEnv });
    for (const w of check.warnings) say(`[edge] warning: ${w}`);
    if (!check.ok) {
      for (const p of check.problems) say(`[edge] problem: ${p}`);
      return result(false, 'failed', `preflight failed: ${check.problems.join('; ')}`, { problems: check.problems });
    }

    const { values } = credentialsFor(store, { env: resolvedEnv });
    const productId = values.EDGE_PRODUCT_ID;
    const auth = { apiKey: values.EDGE_API_KEY, clientId: values.EDGE_CLIENT_ID };
    const { text: notes, truncated: notesTruncated } =
      truncateNotes(releaseNotes ?? (version ? `Locke Extension ${version}` : ''));

    if (dryRun) {
      // Credentials only. Edge has no read-only status endpoint to probe —
      // there is no "get current submission" call and every other verb mutates
      // the draft — so a dry run genuinely cannot verify more than this
      // without publishing something.
      say(`[edge] dry run: would upload ${zipPath ?? '(no zip given)'} to product ${productId}`);
      return result(true, 'dry-run', `would upload ${zipPath ?? '(no zip given)'} to Edge product ${productId}`, {
        productId,
        zipPath,
        version,
        notes,
        notesTruncated
      });
    }

    if (!zipPath) {
      return result(false, 'failed', 'no zipPath given — run `npm run package` first', { productId });
    }

    say(`[edge] uploading ${zipPath} to product ${productId}`);
    const upload = await uploadPackage({ productId, zipPath, ...auth, fetchImpl });
    if (!upload.ok) {
      return result(false, 'failed', upload.message, { productId, status: upload.status });
    }
    say(`[edge] upload accepted (${upload.bytes} bytes), operation ${upload.operationId}`);

    const uploaded = await pollOperation({
      productId,
      operationId: upload.operationId,
      kind: 'package',
      ...auth,
      fetchImpl,
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
      onTick: () => say('[edge] package validation still in progress...')
    });
    if (!uploaded.succeeded) {
      return terminal(uploaded, say, result, {
        productId,
        phase: 'package',
        packageOperationId: upload.operationId
      });
    }
    say('[edge] package validated');

    const submitted = await submitDraft({ productId, notes, ...auth, fetchImpl });
    if (!submitted.ok) {
      // An immediate rejection can carry a routable errorCode (a still-certifying
      // submission is usually refused here, not at the operation), so it goes
      // through the same mapping instead of being a flat failure.
      if (submitted.classification.errorCode) {
        return terminal(submitted.classification, say, result, {
          productId,
          phase: 'submit',
          packageOperationId: upload.operationId
        });
      }
      return result(false, 'failed', submitted.message, { productId, status: submitted.status });
    }
    say(`[edge] submission created, operation ${submitted.operationId}`);

    const published = await pollOperation({
      productId,
      operationId: submitted.operationId,
      kind: 'submission',
      ...auth,
      fetchImpl,
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
      onTick: () => say('[edge] submission still in progress...')
    });
    if (!published.succeeded) {
      return terminal(published, say, result, {
        productId,
        phase: 'submission',
        packageOperationId: upload.operationId,
        submissionOperationId: submitted.operationId
      });
    }

    say('[edge] submitted for certification (not live yet — certification can take up to 7 business days)');
    return result(true, 'submitted', `submitted ${version ?? zipPath} to ${label} for certification`, {
      productId,
      version,
      zipPath,
      packageOperationId: upload.operationId,
      submissionOperationId: submitted.operationId
    });
  } catch (err) {
    // Includes the poll deadline and any network failure that outlived its
    // retries. Still a result, never a throw.
    say(`[edge] failed: ${err.message}`);
    return result(false, 'failed', err.message, { error: err.name });
  }
}

/**
 * Turn a terminal (non-succeeded) classification into a publish result.
 *
 * Split out because three call sites need identical routing, and because the
 * skipped-vs-failed decision is the one piece of behaviour a reviewer will
 * want to read on its own.
 *
 * `result` is threaded in rather than building the object here so that this
 * path cannot quietly skip the redaction publish() applies — `detail` is
 * assembled from an operation document the API wrote.
 */
function terminal(classification, say, result, data = {}) {
  const { errorCode, message } = classification;
  const { outcome, hint } = describeErrorCode(errorCode);
  const detail = [errorCode, message, hint].filter(Boolean).join(' — ') || 'operation did not succeed';

  say(`[edge] ${outcome}: ${detail}`);
  return result(outcome === 'skipped', outcome, detail, { ...data, errorCode });
}

/**
 * Redact every string anywhere inside a result's `data`.
 *
 * Redacting `message` alone is not enough: `data` is serialised into
 * dist/publish-report.json too, and it carries API-authored text (error codes,
 * validation detail, preflight problems). Walking the structure removes the
 * "which field did I forget this time" question. Non-plain values are returned
 * untouched — numbers and nulls cannot hide a key, and stringifying them here
 * would change the report's shape.
 */
function scrub(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  }
  return value;
}
