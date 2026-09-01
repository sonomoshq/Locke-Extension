// Copyright © 2026 Sonomos, Inc. All rights reserved.
// HTTP helpers for the store publishers — Node's built-in fetch only, so the
// repo's zero-dependency rule survives contact with three REST APIs.
//
// Every publisher gets: bounded retries with exponential backoff on the
// failures that are genuinely transient (429 + 5xx + network resets), a hard
// per-attempt timeout so a hung upload can't wedge a release, and a polling
// helper for the two stores whose submit is asynchronous.
//
// `fetchImpl` is injectable on every entry point. That is what lets
// tests/publish.test.js exercise request shaping and status parsing against a
// fake without a network or a credential.

export class HttpError extends Error {
  constructor(response, bodyText) {
    super(`${response.method} ${response.url} → ${response.status} ${response.statusText}`);
    this.name = 'HttpError';
    this.status = response.status;
    this.url = response.url;
    this.body = bodyText;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * One HTTP round trip with retries.
 *
 * Returns { status, statusText, headers, text, json } — `json` is null when
 * the body is not JSON, which several of these APIs do on error paths.
 * Non-2xx does NOT throw unless `throwOnError` is set: the publishers need to
 * read failure bodies (Edge returns its real errors inside a 200, and the
 * legacy CWS API did the same) rather than have them swallowed.
 */
export async function request(url, {
  method = 'GET',
  headers = {},
  body,
  retries = 4,
  backoffMs = 1000,
  timeoutMs = 180000,
  throwOnError = false,
  fetchImpl = globalThis.fetch,
  onRetry
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON. Several of these endpoints answer with an empty body on
        // success (Edge's operations, CWS setPublishedDeployPercentage), so
        // this is normal, not an error.
      }

      const out = {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        headers: Object.fromEntries(res.headers),
        text,
        json,
        url,
        method
      };

      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const wait = retryAfterMs(out.headers) ?? backoffMs * 2 ** attempt;
        onRetry?.({ attempt, status: res.status, waitMs: wait });
        await sleep(wait);
        continue;
      }
      if (!res.ok && throwOnError) throw new HttpError(out, text);
      return out;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Network-level failure or our own timeout abort.
      lastError = err;
      if (attempt >= retries) break;
      const wait = backoffMs * 2 ** attempt;
      onRetry?.({ attempt, error: err.message, waitMs: wait });
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`${method} ${url} failed after ${retries + 1} attempts: ${lastError?.message ?? 'unknown error'}`);
}

// Honour Retry-After when the server sends one — both seconds and HTTP-date
// forms are legal, and 429s from Google use the seconds form.
function retryAfterMs(headers) {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * Poll `probe` until `done(value)` returns truthy, or the deadline passes.
 *
 * Used by Edge (operation status) and AMO (upload validation). Chrome's V2
 * publish is synchronous enough not to need it, but its :fetchStatus gate
 * uses the same shape when waiting out an async upload.
 */
export async function poll(probe, {
  done,
  intervalMs = 5000,
  timeoutMs = 600000,
  label = 'operation',
  onTick,
  now = () => Date.now()
} = {}) {
  const deadline = now() + timeoutMs;
  let ticks = 0;

  for (;;) {
    const value = await probe();
    ticks++;
    if (done(value)) return value;
    onTick?.({ ticks, value });
    if (now() >= deadline) {
      throw new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)}s (${ticks} polls)`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Build a multipart/form-data body without a dependency.
 *
 * AMO's upload endpoint is the only multipart consumer here. Node 18+ ships
 * FormData/Blob, so this is a thin wrapper that keeps field-name typos in one
 * place — and, importantly, does NOT set Content-Type: fetch must generate
 * the boundary itself, and an explicitly-set header breaks the body.
 */
export function multipart(fields) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) form.append(name, value);
    else if (value?.data instanceof Uint8Array) {
      form.append(name, new Blob([value.data], { type: value.type ?? 'application/octet-stream' }), value.filename);
    } else form.append(name, String(value));
  }
  return form;
}
