// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multipart, poll, request } from '../scripts/lib/http.mjs';
import { STORES, credentialsFor, parseEnvFile, redact, secretValues } from '../scripts/lib/creds.mjs';
import { releaseNotesFor } from '../scripts/publish.mjs';
import * as chrome from '../scripts/publish/chrome.mjs';
import * as edge from '../scripts/publish/edge.mjs';
import * as firefox from '../scripts/publish/firefox.mjs';

// A fake fetch that records every call and replays scripted responses. Real
// `Response` objects, so header casing, body reading and `ok` behave exactly
// as they will against the live APIs.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    for (const route of routes) {
      if (route.match(String(url), init)) {
        const { status = 200, body = '', headers = {} } = typeof route.reply === 'function'
          ? route.reply(calls.length)
          : route.reply;
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
      }
    }
    throw new Error(`unrouted request: ${init.method ?? 'GET'} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const ENV = Object.freeze({
  CWS_PUBLISHER_ID: 'pub-1',
  CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  CWS_CLIENT_ID: 'client-1',
  CWS_CLIENT_SECRET: 'chrome-secret-value-0123456789',
  CWS_REFRESH_TOKEN: 'chrome-refresh-token-0123456789',
  EDGE_PRODUCT_ID: 'd34f98f5-f9b7-42b1-bebb-98707202b21d',
  EDGE_CLIENT_ID: 'edge-client',
  EDGE_API_KEY: 'edge-api-key-0123456789abcdef',
  AMO_JWT_ISSUER: 'user:123456:78',
  AMO_JWT_SECRET: 'amo-secret-value-0123456789abcdef'
});

function fixtureZip() {
  const dir = mkdtempSync(join(tmpdir(), 'locke-pub-'));
  const path = join(dir, 'locke-extension-2.0.0-chromium.zip');
  writeFileSync(path, Buffer.from('PK not a real zip, publishers only read bytes'));
  return { dir, path };
}

// ── Credentials ───────────────────────────────────────────────────────

test('creds: every store declares the variables it needs', () => {
  assert.deepEqual(STORES, ['chrome', 'edge', 'firefox']);
  for (const store of STORES) {
    const result = credentialsFor(store, { env: {} });
    assert.equal(result.ok, false);
    // A missing credential must name itself AND say where to get it —
    // "CWS_CLIENT_ID is unset" alone sends the operator hunting.
    for (const v of result.missing) assert.ok(v.note && v.note.length > 5, `${v.name} has no note`);
  }
  assert.equal(credentialsFor('chrome', { env: ENV }).ok, true);
});

test('creds: process.env wins over the release.env file', () => {
  const parsed = parseEnvFile('# comment\nexport AMO_JWT_ISSUER="from-file"\nEDGE_CLIENT_ID=\'quoted\'\nbroken line\n');
  assert.equal(parsed.AMO_JWT_ISSUER, 'from-file');
  assert.equal(parsed.EDGE_CLIENT_ID, 'quoted');
  assert.equal(Object.keys(parsed).length, 2);
});

test('creds: redact removes secrets and bearer-shaped tokens', () => {
  const secrets = secretValues({ env: ENV });
  const line = `Authorization: Bearer ya29.a0AfH6SMBexample_token_value_long
secret=${ENV.CWS_CLIENT_SECRET} amo=${ENV.AMO_JWT_SECRET}`;
  const clean = redact(line, secrets);
  assert.ok(!clean.includes(ENV.CWS_CLIENT_SECRET));
  assert.ok(!clean.includes(ENV.AMO_JWT_SECRET));
  assert.ok(!clean.includes('ya29.a0AfH6SMBexample_token_value_long'));
  // Non-secret context must survive, or a redacted log is useless.
  assert.match(clean, /Authorization: Bearer/);
});

// ── HTTP helpers ──────────────────────────────────────────────────────

test('http: retries a 429 and then succeeds', async () => {
  let calls = 0;
  const impl = async () => {
    calls++;
    return calls === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
      : new Response('{"ok":true}', { status: 200 });
  };
  const res = await request('https://example.test/x', { fetchImpl: impl, backoffMs: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(res.json, { ok: true });
});

test('http: a non-2xx is returned, not thrown', async () => {
  // Edge returns real errors inside a 200 and the legacy CWS API did too, so
  // the publishers must be able to read failure bodies.
  const impl = async () => new Response('{"error":{"code":403}}', { status: 403 });
  const res = await request('https://example.test/x', { fetchImpl: impl, retries: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.json.error.code, 403);
});

test('http: a non-JSON body does not blow up', async () => {
  // 204 is what Edge and CWS return from several operations; Response
  // forbids a body with it, which is exactly the shape being tested.
  const impl = async () => new Response(null, { status: 204 });
  const res = await request('https://example.test/x', { fetchImpl: impl, retries: 0 });
  assert.equal(res.json, null);
  assert.equal(res.text, '');
});

test('http: poll gives up at the deadline', async () => {
  await assert.rejects(
    () => poll(async () => ({ status: 'InProgress' }), {
      done: (v) => v.status === 'Succeeded',
      intervalMs: 1,
      timeoutMs: 5,
      label: 'test operation'
    }),
    /test operation did not finish/
  );
});

test('http: multipart leaves the boundary to fetch', () => {
  const form = multipart({ channel: 'listed', upload: { data: new Uint8Array([1, 2]), filename: 'a.zip' } });
  assert.equal(form.get('channel'), 'listed');
  assert.ok(form.get('upload') instanceof Blob);
});

// ── Every publisher honours the same contract ─────────────────────────

const PUBLISHERS = [chrome, edge, firefox];

test('publishers: shared export contract', () => {
  for (const p of PUBLISHERS) {
    assert.equal(typeof p.store, 'string');
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.preflight, 'function');
    assert.equal(typeof p.publish, 'function');
  }
  assert.deepEqual(PUBLISHERS.map((p) => p.store), STORES);
});

test('publishers: preflight names every missing credential, without network', async () => {
  for (const p of PUBLISHERS) {
    const result = p.preflight({ env: {} });
    assert.equal(result.ok, false, `${p.store} preflight should fail on an empty env`);
    assert.ok(result.problems.length > 0);
    assert.ok(Array.isArray(result.warnings));
  }
});

test('publishers: missing credentials return failed rather than throwing', async () => {
  const { dir, path } = fixtureZip();
  try {
    for (const p of PUBLISHERS) {
      const impl = fakeFetch([]); // any request at all would throw "unrouted"
      const result = await p.publish({ zipPath: path, version: '2.0.0', env: {}, fetchImpl: impl, log: () => {} });
      assert.equal(result.ok, false, `${p.store}`);
      assert.equal(result.status, 'failed');
      assert.equal(impl.calls.length, 0, `${p.store} must not call the network without credentials`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishers: a dry run never uploads', async () => {
  const { dir, path } = fixtureZip();
  try {
    for (const p of PUBLISHERS) {
      const impl = fakeFetch([
        // Read-only gates are allowed in a dry run; anything that mutates is
        // routed to an explicit failure.
        { match: (url) => url.includes(':fetchStatus'), reply: { body: { itemId: 'x' } } },
        { match: (url) => url.includes('oauth2'), reply: { body: { access_token: 'tok', expires_in: 3600 } } },
        { match: () => true, reply: () => { throw new Error('a dry run must not mutate'); } }
      ]);
      const result = await p.publish({
        zipPath: path, version: '2.0.0', dryRun: true, env: ENV, fetchImpl: impl, log: () => {}
      });
      assert.equal(result.status, 'dry-run', `${p.store} returned ${result.status}`);
      assert.equal(result.ok, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishers: nothing they log contains a secret', async () => {
  const { dir, path } = fixtureZip();
  const lines = [];
  try {
    for (const p of PUBLISHERS) {
      const impl = fakeFetch([
        { match: (url) => url.includes(':fetchStatus'), reply: { body: { itemId: 'x' } } },
        { match: (url) => url.includes('oauth2'), reply: { body: { access_token: 'ya29.super-secret-token-value', expires_in: 3600 } } },
        { match: () => true, reply: { status: 500, body: 'server error' } }
      ]);
      await p.publish({ zipPath: path, version: '2.0.0', dryRun: true, env: ENV, fetchImpl: impl, log: (l) => lines.push(String(l)) });
    }
    const joined = lines.join('\n');
    for (const secret of secretValues({ env: ENV })) {
      assert.ok(!joined.includes(secret), `a publisher logged ${secret.slice(0, 6)}…`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishers: an API error returns failed, and its message carries no secret', async () => {
  // The returned `message` is the OTHER channel: publish.mjs writes it to
  // dist/publish-report.json and prints it. Store APIs echo request context
  // into error bodies — an Edge 401 will hand back the Authorization header
  // it just rejected — so the log channel being clean proves nothing here.
  const { dir, path } = fixtureZip();
  const echoed = JSON.stringify({
    error: { code: 401, message: 'unauthorized' },
    headers: {
      Authorization: `ApiKey ${ENV.EDGE_API_KEY}`,
      'X-Debug-Secret': ENV.CWS_CLIENT_SECRET,
      'X-Amo': ENV.AMO_JWT_SECRET
    }
  });
  try {
    for (const p of PUBLISHERS) {
      const impl = fakeFetch([
        { match: (url) => url.includes('oauth2'), reply: { body: { access_token: 'ya29.minted-token-value-secret', expires_in: 3600 } } },
        { match: () => true, reply: { status: 401, body: echoed } }
      ]);
      const result = await p.publish({ zipPath: path, version: '2.0.0', env: ENV, fetchImpl: impl, log: () => {} });

      assert.equal(result.ok, false, `${p.store} should report an API failure`);
      assert.equal(result.status, 'failed', `${p.store} returned ${result.status}`);

      const exposed = `${result.message}\n${JSON.stringify(result.data ?? {})}`;
      for (const secret of secretValues({ env: ENV })) {
        assert.ok(!exposed.includes(secret), `${p.store} leaked a secret in its returned message/data`);
      }
      assert.ok(!exposed.includes('ya29.minted-token-value-secret'), `${p.store} leaked a minted token`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Chrome Web Store ──────────────────────────────────────────────────

test('chrome: an item in review is skipped, not failed', () => {
  // A pending review cannot accept an upload. That is a normal state to
  // re-run into, not a broken release.
  const inReview = chrome.classifyStatus({
    publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '2.0.0' }] },
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '2.0.1' }] }
  });
  assert.equal(inReview.inReview, true);
  assert.equal(inReview.safeToUpload, false);

  const clean = chrome.classifyStatus({
    publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '2.0.0' }] }
  });
  assert.equal(clean.inReview, false);
  assert.equal(clean.safeToUpload, true);
  assert.equal(clean.publishedVersion, '2.0.0');
});

test('chrome: a rejected or taken-down item is a hard failure', () => {
  assert.equal(chrome.classifyStatus({ submittedItemRevisionStatus: { state: 'REJECTED' } }).rejected, true);
  assert.equal(chrome.classifyStatus({ takenDown: true }).takenDown, true);
});

test('chrome: the happy path is token, status, upload, publish — in that order', async () => {
  const { dir, path } = fixtureZip();
  try {
    const impl = fakeFetch([
      { match: (url) => url.includes('oauth2.googleapis.com/token'), reply: { body: { access_token: 'tok', expires_in: 3600 } } },
      { match: (url) => url.includes(':fetchStatus'), reply: { body: { itemId: 'x', publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.9.0' }] } } } },
      { match: (url) => url.includes(':upload'), reply: { body: { itemId: 'x', crxVersion: '2.0.0', uploadState: 'SUCCEEDED' } } },
      { match: (url) => url.includes(':publish'), reply: { body: { itemId: 'x', state: 'PENDING_REVIEW' } } }
    ]);
    const result = await chrome.publish({ zipPath: path, version: '2.0.0', env: ENV, fetchImpl: impl, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'submitted');

    const urls = impl.calls.map((c) => c.url);
    assert.match(urls[0], /oauth2\.googleapis\.com\/token$/);
    assert.match(urls[1], /:fetchStatus$/);
    assert.match(urls[2], /\/upload\/v2\/publishers\/pub-1\/items\/[a-p]{32}:upload$/);
    assert.match(urls[3], /\/v2\/publishers\/pub-1\/items\/[a-p]{32}:publish$/);
    // V1 dies 2026-10-15; nothing may address it.
    for (const url of urls) assert.ok(!url.includes('chromewebstore/v1.1'), `V1 endpoint used: ${url}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Edge Add-ons ──────────────────────────────────────────────────────

test('edge: the Location header is a bare GUID, not a URL', () => {
  const id = edge.operationIdFrom({ location: '5b2a1a44-0f21-4f97-8b5e-2b7c1f3a9d21' });
  assert.equal(id, '5b2a1a44-0f21-4f97-8b5e-2b7c1f3a9d21');
  assert.equal(edge.operationIdFrom({}), null);
});

test('edge: operation classification', () => {
  assert.equal(edge.classifyOperation({ status: 'InProgress' }).inProgress, true);
  assert.equal(edge.classifyOperation({ status: 'Succeeded' }).succeeded, true);
  const failed = edge.classifyOperation({ status: 'Failed', errorCode: 'InProgressSubmission', message: 'busy' });
  assert.equal(failed.failed, true);
  assert.equal(failed.errorCode, 'InProgressSubmission');
});

test('edge: a submission already in certification is skipped, and CreateNotAllowed is fatal', () => {
  // Republishing during certification cancels the in-flight review and
  // restarts the 7-business-day clock — colliding is worse than waiting.
  assert.equal(edge.describeErrorCode('InProgressSubmission').outcome, 'skipped');
  assert.equal(edge.describeErrorCode('NoModulesUpdated').outcome, 'skipped');
  // The API cannot create a product; only Partner Center can.
  assert.equal(edge.describeErrorCode('CreateNotAllowed').outcome, 'failed');
  assert.equal(edge.describeErrorCode('SomethingNobodyHasSeen').outcome, 'failed');
});

test('edge: auth headers use X-ClientID exactly', () => {
  // A reported 401 came from sending X-Client-ID. The casing is not ours to
  // improve.
  const headers = edge.authHeaders({ apiKey: 'k', clientId: 'c' });
  assert.equal(headers.Authorization, 'ApiKey k');
  assert.ok('X-ClientID' in headers);
  assert.ok(!('X-Client-ID' in headers));
});

test('edge: the API key expiry maths matches the 72-day lifetime', () => {
  const now = Date.parse('2026-08-12T00:00:00Z');
  const fresh = edge.apiKeyExpiry('2026-08-01T00:00:00Z', now);
  assert.equal(fresh.known, true);
  assert.equal(fresh.daysRemaining, 72 - 11);
  const dead = edge.apiKeyExpiry('2026-01-01T00:00:00Z', now);
  assert.ok(dead.daysRemaining < 0);
});

test('edge: preflight always warns about the 72-day key expiry', () => {
  const result = edge.preflight({ env: ENV });
  assert.ok(result.warnings.join(' ').includes('72'), 'the expiry cliff must be stated even when the key is fine');
});

// ── Firefox AMO ───────────────────────────────────────────────────────

test('firefox: the JWT carries exactly the claims AMO accepts', () => {
  const token = firefox.signJwt({ issuer: 'user:1:2', secret: 's3cret-value-long-enough', now: 1700000000, jti: 'nonce' });
  const [header, payload, signature] = token.split('.');
  assert.equal(token.split('.').length, 3);
  assert.ok(signature.length > 0);

  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(decoded).sort(), ['exp', 'iat', 'iss', 'jti']);
  assert.equal(decoded.iss, 'user:1:2');
  // AMO rejects any token whose lifetime exceeds 300 seconds.
  assert.equal(decoded.exp - decoded.iat, firefox.JWT_LIFETIME_SECONDS);
  assert.ok(decoded.exp - decoded.iat <= 300);
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg, 'HS256');
});

test('firefox: every request signs a fresh token', () => {
  // Polling routinely outlives a 240-second token, and AMO rejects a
  // replayed jti, so a cached token would fail mid-release.
  const factory = firefox.tokenFactory({ issuer: 'user:1:2', secret: 'secret-value-long-enough' });
  assert.notEqual(factory(), factory());
});

test('firefox: a duplicate version is already-published, not a failure', () => {
  for (const message of [
    'Version 2.0.0 already exists.',
    'Version 2.0.0 was uploaded before and deleted.',
    'Version 2.0.0 must be greater than the previous approved version 2.1.0.'
  ]) {
    assert.equal(firefox.isAlreadyPublished({ status: 400, json: { version: [message] } }), true, message);
  }
  // A genuine validation error must NOT be swallowed as "already shipped".
  assert.equal(firefox.isAlreadyPublished({ status: 400, json: { license: ['Invalid license.'] } }), false);
});

test('firefox: preflight demands the AMO-mandatory manifest keys', () => {
  const result = firefox.preflight({ env: ENV });
  assert.equal(result.ok, true, result.problems.join('; '));
});

// ── Orchestrator ──────────────────────────────────────────────────────

test('publish: release notes come from the CHANGELOG section for this version', () => {
  const changelog = `# Changelog

## [Unreleased]

## [2.0.1] — 2026-08-20

### Fixed
- A thing.

## [2.0.0] — 2026-08-10

### Added
- Another thing.
`;
  assert.match(releaseNotesFor('2.0.1', changelog), /^### Fixed\n- A thing\.$/);
  assert.match(releaseNotesFor('2.0.0', changelog), /Another thing/);
  assert.equal(releaseNotesFor('9.9.9', changelog), null);
  // The placeholder `npm run bump` writes is not release notes.
  assert.equal(releaseNotesFor('2.0.2', '## [2.0.2] — 2026-09-01\n\n<!-- TODO: describe this release before tagging. -->\n'), null);
});

test('publish: the bump placeholder lands on top of the inherited [Unreleased] body and must not hide it', () => {
  // This is the exact layout `npm run bump` produces when [Unreleased] was
  // not empty: heading, placeholder, then a thousand lines of real notes.
  const changelog = `## [Unreleased]

## [2.0.2] — 2026-09-01

<!-- TODO: describe this release before tagging. -->

### Fixed — a real thing
- Real.

## [2.0.1] — 2026-08-20
`;
  assert.match(releaseNotesFor('2.0.2', changelog), /^### Fixed — a real thing\n- Real\.$/);
  // Several stacked comments are still just comments.
  assert.equal(releaseNotesFor('2.0.2', '## [2.0.2] — d\n\n<!-- a -->\n<!-- b -->\n'), null);
});

test('publish: <!-- store-notes-end --> ends the store-facing notes; the rest of the section stays in the changelog', () => {
  const changelog = `## [2.0.2] — 2026-09-01

**Summary.** What a reviewer should read.

<!-- store-notes-end -->

### Fixed — the long engineering log
- Line the reviewer should not get.

## [2.0.1] — 2026-08-20
`;
  const notes = releaseNotesFor('2.0.2', changelog);
  assert.equal(notes, '**Summary.** What a reviewer should read.');
  assert.doesNotMatch(notes, /engineering log/);
  // Marker directly under the placeholder: nothing above it, so no notes.
  assert.equal(releaseNotesFor('2.0.2', '## [2.0.2] — d\n\n<!-- TODO -->\n\n<!-- store-notes-end -->\n\n### Fixed\n- x\n'), null);
  // The marker is only honoured on its own line, so prose mentioning it is safe.
  assert.match(releaseNotesFor('2.0.2', '## [2.0.2] — d\n\nThe `<!-- store-notes-end -->` marker is documented here.\n'), /documented here/);
});
