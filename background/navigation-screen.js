// Copyright © 2026 Sonomos, Inc.
// All rights reserved.

// ── prompts carried by a top-level navigation ─────────────────────────────
//
// Google AI Mode started from the search bar is not a fetch the shim can hold:
// the browser itself loads `/search?…&udm=50&q=<prompt>`, and that request is
// on the wire before any page script runs (HAR 2026-11-12). The catalog names
// it with a query-qualified capture path, `/search?udm=50`, so plain search
// (no `udm=50`) is never touched.
//
// Every such pattern in SONOMOS_CAPTURE_PATHS becomes one declarativeNetRequest
// rule that redirects the matching main-frame GET to screen/navigation.html.
// That page hands the URL back here; it goes to the guard exactly as the shim
// sends a bodyless fetch (screenBodylessQuery): `GET <target>` with an empty
// body and `coverage: capture_path`. Then the tab continues to the original or
// the redacted URL through a one-shot allow rule, so it is not redirected
// again.
//
// Failure posture is the shim's for a prompt in a URL: only the guard's
// content block, or a redaction we cannot apply, stops the navigation. Our own
// failures (no desktop app, timeout, a malformed reply) let it continue, as it
// always has.

import { ext } from '../shared/browser.js';
import { CAPTURE_PATHS } from '../shared/web-surfaces.generated.js';
import { INFRASTRUCTURE_REASONS } from '../shared/vocab.generated.js';

// The shim's isInfrastructureBlock: an outage and a refusal both arrive as
// `block`; `blockCause` (or, unset, the reason text) tells them apart.
function isInfrastructureBlock(r) {
  if (r.blockCause === 'infrastructure') return true;
  if (r.blockCause === 'policy') return false;
  const reason = typeof r.reason === 'string' ? r.reason : '';
  return INFRASTRUCTURE_REASONS.some((f) => reason.includes(f));
}

export const NAV_PAGE = 'screen/navigation.html';
const REDIRECT_RULE_BASE = 9100;
const REDIRECT_RULE_MAX = 50;
const ALLOW_RULE_BASE = 9200;
const ALLOW_RULE_SLOTS = 50;
const ALLOW_TTL_MS = 15_000;

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The catalog's query-qualified patterns: [{ host, path, pairs }].
export function navigationPrompts(table = CAPTURE_PATHS) {
  const out = [];
  for (const [host, patterns] of Object.entries(table || {})) {
    for (const pattern of patterns || []) {
      const i = pattern.indexOf('?');
      if (i < 0) continue;
      const path = pattern.slice(0, i);
      const pairs = pattern.slice(i + 1).split('&').filter((p) => p.indexOf('=') > 0);
      // A `*` segment would need a regex per segment; no catalog entry has one
      // with a qualifier today, so refuse rather than guess.
      if (pairs.length === 0 || path.includes('*')) continue;
      out.push({ host, path, pairs });
    }
  }
  return out;
}

// Does `url` match one of `prompts`? Same rule as the shim's patternAdmits and
// sonomos-vocab's target_matches_pattern: exact host and path, every
// qualifier pair present in the query as sent.
export function matchesNavigationPrompt(url, prompts = navigationPrompts()) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const query = u.search.slice(1).split('&').filter((p) => p !== '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return prompts.some((p) =>
    u.hostname.toLowerCase() === p.host &&
    path.toLowerCase() === p.path.replace(/\/+$/, '') &&
    p.pairs.every((pair) => query.includes(pair)));
}

// RE2 (declarativeNetRequest): no lookahead, so the regex requires the FIRST
// pair only; the page re-checks every pair with matchesNavigationPrompt and
// continues untouched when one is missing.
export function redirectRules(pageUrl, prompts = navigationPrompts()) {
  return prompts.slice(0, REDIRECT_RULE_MAX).map((p, i) => ({
    id: REDIRECT_RULE_BASE + i,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${pageUrl}#\\0` } },
    condition: {
      regexFilter: `^https://${reEscape(p.host)}${reEscape(p.path)}/?\\?([^#]*&)?${reEscape(p.pairs[0])}(&[^#]*)?(#.*)?$`,
      isUrlFilterCaseSensitive: false,
      resourceTypes: ['main_frame'],
      requestMethods: ['get']
    }
  }));
}

function dnr() {
  return ext.declarativeNetRequest && typeof ext.declarativeNetRequest.updateDynamicRules === 'function'
    ? ext.declarativeNetRequest : null;
}

// Install (or refresh) the redirect rules; drop any one-shot allows left by a
// worker that died before removing them. Never throws.
export async function installNavigationRules(log = () => {}) {
  const api = dnr();
  if (!api) { log('navigation-rules-unsupported'); return false; }
  try {
    const rules = redirectRules(ext.runtime.getURL(NAV_PAGE));
    const existing = await api.getDynamicRules();
    const removeRuleIds = existing
      .map((r) => r.id)
      .filter((id) => id >= REDIRECT_RULE_BASE && id < REDIRECT_RULE_BASE + REDIRECT_RULE_MAX);
    await api.updateDynamicRules({ removeRuleIds, addRules: rules });
    const session = await api.getSessionRules();
    const stale = session.map((r) => r.id)
      .filter((id) => id >= ALLOW_RULE_BASE && id < ALLOW_RULE_BASE + ALLOW_RULE_SLOTS);
    if (stale.length) await api.updateSessionRules({ removeRuleIds: stale });
    return true;
  } catch (e) {
    log('navigation-rules-failed', e?.message);
    return false;
  }
}

let allowSlot = 0;

// Let exactly `url`, in `tabId`, through once: a higher-priority allow rule,
// removed after the load or after a short TTL.
async function allowOnce(tabId, url) {
  const api = dnr();
  if (!api) return;
  const id = ALLOW_RULE_BASE + (allowSlot++ % ALLOW_RULE_SLOTS);
  const condition = {
    regexFilter: `^${reEscape(url)}$`,
    resourceTypes: ['main_frame']
  };
  if (Number.isInteger(tabId) && tabId >= 0) condition.tabIds = [tabId];
  await api.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{ id, priority: 2, action: { type: 'allow' }, condition }]
  });
  setTimeout(() => { api.updateSessionRules({ removeRuleIds: [id] }).catch(() => {}); }, ALLOW_TTL_MS);
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function rebuiltTarget(requestB64) {
  try {
    const line = atob(requestB64).split('\r\n', 1)[0];
    const parts = line.split(' ');
    return parts.length === 3 ? parts[1] : null;
  } catch {
    return null;
  }
}

// The redacted URL, only if it is the same endpoint with a new query.
function sameEndpoint(url, target) {
  try {
    const next = new URL(target, url);
    if (next.origin !== url.origin || next.pathname !== url.pathname) return null;
    next.hash = url.hash;
    return next.href;
  } catch {
    return null;
  }
}

// Screen one navigation. Returns `{ go: url, decision }` or `{ block: reason }`.
// `capture(requestB64, provider, coverage)` is the service worker's
// captureViaHost.
export async function screenNavigation(rawUrl, tabId, capture, providerOf = () => null) {
  let url;
  try { url = new URL(rawUrl); } catch { return { block: 'navigation-malformed' }; }
  if (!matchesNavigationPrompt(url.href)) {
    await allowOnce(tabId, url.href).catch(() => {});
    return { go: url.href, decision: 'not-a-prompt' };
  }
  const target = url.pathname + url.search;
  const raw = `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/html\r\n\r\n`;
  let res;
  try {
    res = await capture(b64(raw), providerOf(url.hostname), 'capture_path');
  } catch {
    res = null;
  }
  const r = res && res.ok === true ? res.receipt : null;
  if (r && r.decision === 'block' && !isInfrastructureBlock(r)) {
    return { block: 'decision-block' };
  }
  if (r && r.decision === 'redact') {
    const t = typeof r.requestB64 === 'string' ? rebuiltTarget(r.requestB64) : null;
    const next = t ? sameEndpoint(url, t) : null;
    if (!next) return { block: 'redact-malformed' };
    await allowOnce(tabId, next).catch(() => {});
    return { go: next, decision: 'redact', redactedCount: r.redactedCount ?? null };
  }
  // allow, an infrastructure block, or our own failure: continue as before.
  await allowOnce(tabId, url.href).catch(() => {});
  return { go: url.href, decision: r ? String(r.decision) : `relay-${res?.code || 'failed'}` };
}
