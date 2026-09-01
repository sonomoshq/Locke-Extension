// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Chrome Web Store publisher — API **v2** only.
//
// v1 (www.googleapis.com/chromewebstore/v1.1) is deprecated and is switched
// off on 2026-10-15, so implementing it would buy a code path with a known
// expiry date. v2 is also the only version that can answer "is this item
// already in review?" before we upload (:fetchStatus), which is the single
// check that turns most failed releases into a clean skip — v1 could only
// find out by uploading and reading the rejection. So: v2, no fallback.
//
// The release-shaped facts that drive the code below:
//   * An item with a submission PENDING_REVIEW cannot accept an upload. That
//     is a scheduling fact, not a broken release, so we skip rather than fail.
//   * Re-uploading a crxVersion that is already published is always rejected
//     ("version already exists"), so the version gate short-circuits it.
//   * Upload may complete asynchronously; the terminal state then shows up on
//     :fetchStatus as lastAsyncUploadState, not in the upload response.
//   * v2 has no publishTarget/trustedTesters knob, and item visibility cannot
//     be changed through the API at all — a testers-only or unlisted item stays
//     that way and must be flipped by hand in the Developer Dashboard.
//
// DRY RUN IS NOT OFFLINE HERE. Unlike edge.mjs and firefox.mjs, which stop at
// credential resolution, `--dry-run` for Chrome mints a real OAuth access token
// (POST oauth2.googleapis.com/token) and then calls :fetchStatus. Both are
// read-only — nothing is uploaded, submitted, or otherwise mutated, so the
// no-side-effects contract still holds — but each dry run spends a refresh-token
// round trip, and while the OAuth consent screen is in "Testing" that refresh
// token only lives 7 days. That cost buys the one thing Chrome can check ahead
// of time and the other two stores cannot: whether the item is already in
// review, already at this version, or taken down. Do not loop dry runs.
//
// Everything that touches the network takes `fetchImpl` and passes it down, so
// tests drive the whole flow against a fake without a credential or a socket.

import { readFileSync } from 'node:fs';

import { request, poll } from '../lib/http.mjs';
import { credentialsFor, redact } from '../lib/creds.mjs';

export const store = 'chrome';
export const label = 'Chrome Web Store';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://chromewebstore.googleapis.com/v2';
// Uploads go to the /upload/ prefix — the same host with the plain /v2 path
// answers 404 for :upload, which reads like a wrong item ID if you don't know.
const UPLOAD_API = 'https://chromewebstore.googleapis.com/upload/v2';

// Upload states, as an allow-list of exactly one.
//
// This used to be a positive list of in-flight states (IN_PROGRESS,
// UPLOAD_IN_PROGRESS, UPLOAD_STATE_UNSPECIFIED) with a fall-through to
// :publish for everything else — which meant an absent uploadState, a body we
// could not parse (uploadState → null), or any state name Google adds after
// this was written all published immediately against a draft the store was
// still ingesting. The docs do not even agree with themselves on the spelling
// of the busy state (the reference enum says `IN_PROGRESS`, the prose on the
// same page says `UPLOAD_IN_PROGRESS`), which is exactly why an allow-list of
// busy states is the wrong shape: guessing wrong publishes a half-ingested
// package. SUCCEEDED is the only green light; everything else waits.
const UPLOAD_SUCCEEDED = 'SUCCEEDED';
// States that end the wait. FAILED/NOT_FOUND are hard failures and never reach
// the poll (uploadPackage already returns ok:false for them); they are listed
// so a *late* FAILED arriving on lastAsyncUploadState also stops the poll
// instead of running out the clock.
const UPLOAD_TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'NOT_FOUND']);
const UPLOAD_FAILED = new Set(['FAILED', 'NOT_FOUND']);

const itemPath = (publisherId, extensionId) => `publishers/${publisherId}/items/${extensionId}`;

/** Uniform publisher return value — the release runner switches on `status`. */
const outcome = (ok, status, message, data = {}) => ({ store, ok, status, message, data });

/**
 * Credential check only — deliberately no network.
 *
 * Preflight runs for every store before the first byte is uploaded, so it has
 * to be fast and side-effect free; a token mint here would burn a refresh
 * token round trip (and fail noisily on an expired one) before the operator
 * has even been told which variables they are missing.
 */
export function preflight({ env } = {}) {
  const creds = credentialsFor(store, env ? { env } : {});
  const problems = creds.missing.map((v) => `${v.name} is not set — ${v.note}`);
  const warnings = [];

  // Not fatal, but the failure it causes ("invalid_grant") is opaque enough
  // that it is worth naming up front while the operator is still reading.
  if (creds.ok) {
    warnings.push('CWS_REFRESH_TOKEN expires after 7 days while the OAuth consent screen is in Testing');
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Pull a human-usable message out of a google.rpc.Status envelope.
 *
 * Google answers errors as {"error":{code,message,status,details}} — but only
 * usually: OAuth failures come back as {error, error_description}, and a
 * proxy/5xx can return HTML. Never let a publisher's failure message be
 * "undefined" when the body said exactly what was wrong.
 */
export function apiError(res) {
  const err = res?.json?.error;
  if (err && typeof err === 'object') {
    const detail = Array.isArray(err.details) && err.details.length
      ? ` (${err.details.map((d) => d.reason ?? d['@type'] ?? JSON.stringify(d)).join(', ')})`
      : '';
    return `${err.status ?? res.status}: ${err.message ?? 'no message'}${detail}`;
  }
  if (typeof err === 'string') {
    // OAuth token endpoint shape.
    return `${err}: ${res.json.error_description ?? 'no description'}`;
  }
  const body = (res?.text ?? '').trim().replace(/\s+/g, ' ');
  return `HTTP ${res?.status ?? '?'}${body ? `: ${body.slice(0, 300)}` : ''}`;
}

/**
 * Exchange the long-lived refresh token for a ~1h access token.
 *
 * Form-encoded, not JSON — the Google token endpoint rejects a JSON body with
 * an unhelpful invalid_request. Returns a result object rather than throwing
 * so `publish` can report a dead credential as a normal failed release.
 */
export async function accessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl,
  onRetry
} = {}) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new TypeError('accessToken requires clientId, clientSecret and refreshToken');
  }

  const body = new URLSearchParams({
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId
  }).toString();

  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    // A dead refresh token is a 400 and will be a 400 forever; only the
    // transient classes in http.mjs are retried, so this is cheap.
    retries: 2,
    timeoutMs: 30000,
    fetchImpl,
    onRetry
  });

  if (!res.ok || !res.json?.access_token) {
    return { ok: false, token: null, expiresIn: 0, status: res.status, error: apiError(res) };
  }
  return {
    ok: true,
    token: res.json.access_token,
    expiresIn: Number(res.json.expires_in) || 0,
    status: res.status,
    error: null
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * GET :fetchStatus — the read-only gate.
 *
 * Cheap, safe to call repeatedly, and the only way to learn (a) what version
 * is live, (b) whether a submission is already queued for review, and (c) how
 * an async upload finished.
 */
export async function fetchStatus({
  publisherId,
  extensionId,
  token,
  fetchImpl,
  retries = 3,
  onRetry
} = {}) {
  if (!publisherId || !extensionId || !token) {
    throw new TypeError('fetchStatus requires publisherId, extensionId and token');
  }

  const res = await request(`${API}/${itemPath(publisherId, extensionId)}:fetchStatus`, {
    method: 'GET',
    headers: bearer(token),
    retries,
    timeoutMs: 60000,
    fetchImpl,
    onRetry
  });

  return { ok: res.ok, status: res.status, json: res.json, error: res.ok ? null : apiError(res) };
}

/**
 * Classify a :fetchStatus body. Pure — no I/O, no clock — so tests can pin
 * every branch with a literal, and so the decision to skip a release is
 * reviewable without reading HTTP code.
 *
 * `submittedItemRevisionStatus` being absent (UNSET) is the signal that
 * nothing is queued and the item can accept an upload. CANCELLED counts as
 * nothing queued too: a withdrawn submission no longer holds the draft.
 */
export function classifyStatus(body) {
  const doc = body ?? {};
  const published = doc.publishedItemRevisionStatus ?? null;
  const submitted = doc.submittedItemRevisionStatus ?? null;
  const publishedState = published?.state ?? null;
  const submittedState = submitted?.state ?? null;

  const inReview = submittedState === 'PENDING_REVIEW';
  // Only the SUBMITTED revision gates this run. A rejected submitted revision
  // is the draft slot we are about to write into, so it blocks. A rejected
  // PUBLISHED revision is history: an item that was once rejected, then fixed
  // and published, keeps that state on the published revision indefinitely, and
  // reading it as a block used to make every future release fail forever with
  // nothing an operator could do about it in the dashboard. Both states stay on
  // the returned object (publishedState/submittedState) so the message can name
  // them; only the submitted one decides.
  const rejected = submittedState === 'REJECTED';
  const takenDown = Boolean(doc.takenDown);

  // Anything other than "no meaningful submitted revision" occupies the draft
  // slot; STAGED in particular is a reviewed-but-unreleased build that an
  // upload would silently discard.
  const queued = submittedState !== null
    && submittedState !== 'ITEM_STATE_UNSPECIFIED'
    && submittedState !== 'CANCELLED';

  return {
    inReview,
    rejected,
    takenDown,
    publishedVersion: crxVersionOf(published),
    submittedVersion: crxVersionOf(submitted),
    safeToUpload: !queued && !takenDown && !rejected,
    // Extras the caller uses for messages; not part of the decision above.
    publishedState,
    submittedState,
    warned: Boolean(doc.warned),
    lastAsyncUploadState: doc.lastAsyncUploadState ?? null,
    itemId: doc.itemId ?? null
  };
}

// crxVersion hangs off the distribution channels, not the revision, because an
// item can be rolled out at different versions per channel. For our purposes
// (single default channel, no staged rollout) the first version present is the
// one that matters.
function crxVersionOf(revision) {
  for (const channel of revision?.distributionChannels ?? []) {
    if (channel?.crxVersion) return channel.crxVersion;
  }
  return null;
}

/**
 * POST :upload with the raw zip as the request body.
 *
 * Not multipart, not base64 — the bytes go up as-is. `zipBytes` wins over
 * `zipPath` so tests never need a fixture on disk.
 */
export async function uploadPackage({
  publisherId,
  extensionId,
  token,
  zipPath,
  zipBytes,
  fetchImpl,
  retries = 2,
  timeoutMs = 600000,
  onRetry
} = {}) {
  if (!publisherId || !extensionId || !token) {
    throw new TypeError('uploadPackage requires publisherId, extensionId and token');
  }
  if (!zipBytes && !zipPath) throw new TypeError('uploadPackage requires zipPath or zipBytes');

  const bytes = zipBytes ?? readFileSync(zipPath);

  const res = await request(`${UPLOAD_API}/${itemPath(publisherId, extensionId)}:upload`, {
    method: 'POST',
    // Content-Length is set by fetch from the buffer; setting it by hand here
    // is how you get a mismatch when the zip changes under you.
    headers: { ...bearer(token), 'Content-Type': 'application/zip' },
    body: bytes,
    // Re-uploading is idempotent (it replaces the draft), so a retry after a
    // transient 5xx is safe — just slow, hence the small count and long
    // timeout for a multi-megabyte body on a bad connection.
    retries,
    timeoutMs,
    fetchImpl,
    onRetry
  });

  const uploadState = res.json?.uploadState ?? null;
  return {
    ok: res.ok && uploadState !== 'FAILED' && uploadState !== 'NOT_FOUND',
    status: res.status,
    json: res.json,
    uploadState,
    crxVersion: res.json?.crxVersion ?? null,
    error: res.ok ? (uploadState === 'FAILED' || uploadState === 'NOT_FOUND' ? `upload state ${uploadState}` : null) : apiError(res)
  };
}

/**
 * POST :publish — submits the uploaded draft for review.
 *
 * `blockOnWarnings: true` on purpose: a warning here means the CWS reviewer
 * flagged something (new permission, host scope) and we would rather the
 * release stop and be read by a human than sail into a review that gets the
 * item taken down. DEFAULT_PUBLISH is the only target v2 exposes — there is no
 * trustedTesters publishTarget in this API, and visibility is dashboard-only.
 */
export async function publishItem({
  publisherId,
  extensionId,
  token,
  blockOnWarnings = true,
  fetchImpl,
  retries = 1,
  onRetry
} = {}) {
  if (!publisherId || !extensionId || !token) {
    throw new TypeError('publishItem requires publisherId, extensionId and token');
  }

  const res = await request(`${API}/${itemPath(publisherId, extensionId)}:publish`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings }),
    // A retried :publish that actually landed the first time answers with a
    // plain error rather than double-submitting, so one retry is safe.
    retries,
    timeoutMs: 120000,
    fetchImpl,
    onRetry
  });

  const warnings = res.json?.warningInfo?.warnings ?? [];
  return {
    ok: res.ok,
    status: res.status,
    json: res.json,
    state: res.json?.state ?? null,
    warnings,
    error: res.ok ? null : apiError(res)
  };
}

/**
 * Full release for one store.
 *
 * Never throws for an API or credential failure — a broken store must not take
 * down the other two publishers in the same run, so every remote failure comes
 * back as { ok:false, status:'failed' } with a message the operator can act on.
 * Bad arguments still throw: that is our bug, not the store's.
 *
 * `releaseNotes` is accepted and intentionally unused. CWS v2 has no
 * release-notes field anywhere in :upload or :publish (the store shows the
 * listing description, edited in the dashboard); the parameter exists so the
 * three publishers share one call signature.
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
  if (!version) throw new TypeError('publish requires version');
  // A dry run never reads the zip, so it is allowed to omit the path — that is
  // what makes `--dry-run` usable before `npm run package` has been run.
  if (!zipPath && !dryRun) throw new TypeError('publish requires zipPath');

  // Redact against THIS run's secrets rather than the ambient environment: an
  // injected `env` (tests, CI matrix) would otherwise not be covered, and the
  // minted access token is pushed on below so it is masked from the moment it
  // exists. `say` closes over the binding, not the value, so the list can be
  // filled in after the credentials resolve inside the try.
  let secrets = [];
  const say = (message) => log(redact(`[${store}] ${message}`, secrets));

  try {
    // Credential resolution belongs INSIDE the try. credentialsFor() falls
    // through to loadEnv(), which reads ~/.config/sonomos/release.env and
    // throws for reasons that have nothing to do with a programmer error:
    // EACCES on the file, the path being a directory, or the file being
    // replaced by a directory between the existsSync and the readFileSync.
    // The contract is that a credential failure comes back as
    // { ok:false, status:'failed' } — a throw from here would escape publish()
    // and abandon the other two stores mid-run. (edge.mjs has always resolved
    // its env inside the try for the same reason.)
    const creds = credentialsFor(store, env ? { env } : {});
    secrets = [creds.values.CWS_CLIENT_SECRET, creds.values.CWS_REFRESH_TOKEN].filter(Boolean);

    if (!creds.ok) {
      const names = creds.missing.map((v) => v.name).join(', ');
      return outcome(false, 'failed', `missing credentials: ${names}`, { missing: creds.missing });
    }

    const {
      CWS_PUBLISHER_ID: publisherId,
      CWS_EXTENSION_ID: extensionId,
      CWS_CLIENT_ID: clientId,
      CWS_CLIENT_SECRET: clientSecret,
      CWS_REFRESH_TOKEN: refreshToken
    } = creds.values;

    say(`minting access token for item ${extensionId}`);
    const auth = await accessToken({ clientId, clientSecret, refreshToken, fetchImpl });
    if (!auth.ok) {
      return outcome(false, 'failed', `token refresh failed — ${auth.error}`, { step: 'token' });
    }
    secrets.push(auth.token);
    const token = auth.token;

    const gate = await fetchStatus({ publisherId, extensionId, token, fetchImpl });
    if (!gate.ok) {
      return outcome(false, 'failed', `:fetchStatus failed — ${gate.error}`, { step: 'fetchStatus' });
    }

    const state = classifyStatus(gate.json);
    say(`published=${state.publishedVersion ?? 'none'} (${state.publishedState ?? 'unset'}) submitted=${state.submittedState ?? 'unset'} takenDown=${state.takenDown}`);

    // Order matters only for the message the operator reads; each of these is
    // a terminal decision for this run.
    if (state.inReview) {
      return outcome(true, 'skipped',
        `item is already PENDING_REVIEW (submitted ${state.submittedVersion ?? 'unknown'}) — CWS refuses an upload while a submission is queued; re-run after the review completes`,
        { step: 'gate', state });
    }
    if (state.takenDown) {
      return outcome(false, 'failed',
        'item is taken down in the Chrome Web Store — resolve the takedown in the Developer Dashboard before publishing',
        { step: 'gate', state });
    }
    // `state.rejected` reflects the SUBMITTED revision only (see
    // classifyStatus): that is the draft slot this run would overwrite, and a
    // rejection sitting on it needs a human to read before we push again. A
    // REJECTED state left on the *published* revision is stale history and must
    // not block — it never clears, so treating it as fatal bricked every
    // subsequent release. Both states are still printed, because when the
    // submitted one is the blocker the published one is useful context.
    if (state.rejected) {
      return outcome(false, 'failed',
        `the submitted revision was REJECTED (submitted=${state.submittedState ?? 'unset'} published=${state.publishedState ?? 'unset'}) — read the rejection in the dashboard before re-submitting`,
        { step: 'gate', state });
    }
    if (state.publishedVersion === version) {
      return outcome(true, 'skipped',
        `version ${version} is already published — CWS rejects an upload of an existing crxVersion, so there is nothing to do`,
        { step: 'gate', state });
    }
    if (!state.safeToUpload) {
      return outcome(true, 'skipped',
        `item has an unreleased ${state.submittedState} revision (${state.submittedVersion ?? 'unknown'}) — uploading would discard it`,
        { step: 'gate', state });
    }

    if (dryRun) {
      // Reached only AFTER a real access token was minted and a real
      // :fetchStatus was issued — see the DRY RUN note in the file header.
      // Both calls are read-only, so a dry run still mutates nothing and the
      // contract holds; the cost is one refresh-token round trip per run
      // against a token that lives 7 days while the consent screen is in
      // "Testing". The gates above are the reason it is worth paying: they are
      // the only pre-flight facts (in review / already published / taken down)
      // that no offline check can give us. Do not move the network calls above
      // this branch behind a flag without deciding what a dry run is for.
      say(`dry run — would upload ${zipPath ?? '<no zip given>'} and publish ${version}`);
      return outcome(true, 'dry-run',
        `would upload ${zipPath ?? '(zip not built)'} and publish ${version} over ${state.publishedVersion ?? 'nothing'}`,
        { step: 'dry-run', state, wouldUpload: zipPath ?? null, wouldPublish: { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true } });
    }

    let zipBytes;
    try {
      zipBytes = readFileSync(zipPath);
    } catch (err) {
      // A missing artifact is an operator error (forgot `npm run package`),
      // not a programmer error, so it reports like any other release failure.
      return outcome(false, 'failed', `cannot read ${zipPath}: ${err.message}`, { step: 'zip' });
    }

    say(`uploading ${zipPath} (${zipBytes.length} bytes)`);
    const upload = await uploadPackage({
      publisherId,
      extensionId,
      token,
      zipBytes,
      fetchImpl,
      onRetry: ({ attempt, waitMs }) => say(`upload retry ${attempt + 1} in ${waitMs}ms`)
    });
    if (!upload.ok) {
      return outcome(false, 'failed', `upload failed — ${upload.error}`, { step: 'upload', uploadState: upload.uploadState });
    }

    // SUCCEEDED is the ONLY state that lets us publish straight away. Anything
    // else waits: IN_PROGRESS/UPLOAD_IN_PROGRESS/UPLOAD_STATE_UNSPECIFIED
    // obviously, but equally an absent uploadState, a body that did not parse
    // (null), and any state name Google adds later. The upload response only
    // ever tells us ingestion *started*; publishing a draft the store has not
    // finished unpacking submits the previous build for review under this
    // version's name, and nobody notices until the reviewer does. FAILED and
    // NOT_FOUND never reach here — uploadPackage already returned ok:false for
    // them and we bailed above.
    if (upload.uploadState !== UPLOAD_SUCCEEDED) {
      // What "done" looks like. `crxVersion` comes back on the upload response
      // when the store has parsed the manifest; fall back to the version we
      // were asked to ship.
      const expectedCrx = upload.crxVersion ?? version;
      say(`upload is ${upload.uploadState ?? 'unreported'}; polling :fetchStatus for ingestion`);
      const settled = await poll(
        () => fetchStatus({ publisherId, extensionId, token, fetchImpl }),
        {
          // Two independent proofs, because the documented one is not always
          // there. lastAsyncUploadState is only present if there was an async
          // upload in the last 24h, so an upload that the store ingested
          // synchronously can leave it absent forever — which used to burn the
          // full 600s and then fail a release whose upload had actually
          // succeeded. The submitted revision now carrying the crxVersion we
          // just pushed is the same fact seen from the other side, so either
          // one ends the wait. A failed :fetchStatus also stops the poll, so a
          // dead credential is reported rather than retried to the deadline.
          done: (r) => {
            if (!r.ok) return true;
            const seen = classifyStatus(r.json);
            return UPLOAD_TERMINAL.has(seen.lastAsyncUploadState)
              || (expectedCrx != null && seen.submittedVersion === expectedCrx);
          },
          intervalMs: 5000,
          timeoutMs: 600000,
          label: 'chrome upload ingestion'
        }
      );
      if (!settled.ok) {
        return outcome(false, 'failed', `:fetchStatus failed while waiting for upload — ${settled.error}`, { step: 'upload-poll' });
      }
      const after = classifyStatus(settled.json);
      // A terminal failure outranks the version check: a package can be
      // rejected at ingestion after its version was already recorded on the
      // revision, and that must not read as success.
      const ingested = !UPLOAD_FAILED.has(after.lastAsyncUploadState)
        && (after.lastAsyncUploadState === UPLOAD_SUCCEEDED
          || (expectedCrx != null && after.submittedVersion === expectedCrx));
      if (!ingested) {
        return outcome(false, 'failed',
          `upload did not reach SUCCEEDED (lastAsyncUploadState=${after.lastAsyncUploadState ?? 'absent'}, submitted revision=${after.submittedVersion ?? 'none'}) — the package was rejected before review, so there is nothing safe to publish`,
          { step: 'upload-poll', state: after });
      }
      // Note the missing else: if neither proof ever arrives, poll() throws at
      // its deadline and the catch below turns that into a failed release. An
      // unresolved ingestion must never fall through to :publish.
      say(`upload ingestion confirmed (${after.lastAsyncUploadState ?? `submitted revision is ${expectedCrx}`})`);
    }

    say(`publishing ${upload.crxVersion ?? version} (blockOnWarnings)`);
    const submitted = await publishItem({ publisherId, extensionId, token, fetchImpl });
    if (!submitted.ok) {
      const warned = submitted.warnings.map((w) => `${w.reason}: ${w.description}`).join('; ');
      return outcome(false, 'failed',
        `:publish failed — ${submitted.error}${warned ? ` [warnings: ${warned}]` : ''}`,
        { step: 'publish', warnings: submitted.warnings });
    }

    // Warnings can also come back on a successful publish; surface them, since
    // they are the early sighting of the thing a reviewer will object to.
    for (const w of submitted.warnings) say(`warning ${w.reason}: ${w.description}`);

    say(`submitted ${version} → state ${submitted.state ?? 'unknown'}`);
    return outcome(true, 'submitted',
      `submitted ${version} to the Chrome Web Store (state ${submitted.state ?? 'unknown'})`,
      { step: 'publish', state: submitted.state, warnings: submitted.warnings, crxVersion: upload.crxVersion });
  } catch (err) {
    // request() throws once retries are exhausted, and poll() throws on its
    // deadline. Both are release failures, not crashes — the runner still has
    // two more stores to try.
    return outcome(false, 'failed', redact(`unexpected error: ${err.message}`, secrets), { step: 'exception' });
  }
}
