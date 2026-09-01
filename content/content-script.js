// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Runs in the content-script isolated world at document_start.
//
// shim.js (MAIN world) intercepts an outbound AI request, holds it, and posts
// the synthesized raw HTTP request (base64) to this world tagged with a callId.
// Our job is the round-trip: relay it to the service worker (which forwards it
// to the Locke desktop app through the native messaging host), then post the
// verdict back to the shim under the same callId so it can act — send as held,
// send the rebuilt request, or block.
//
// The base64 payload is the full request (sensitive): relayed, never logged.
//
// FAIL CLOSED: if the service worker can't be reached (extension reload, SW
// restart, torn-down context), we reply with a null verdict, which the shim
// treats as "block". We never leave a held request without an answer.
//
// We are also the shim's only route to its own settings: a MAIN-world script
// has no chrome.* APIs, so we read them here and post them across (see
// pushConfig at the bottom).

(() => {
  'use strict';

  // Duplicated from shared/constants.js on purpose — a content script cannot
  // import an ES module. Keep them in step (PAGE_MSG, SETTINGS_KEY,
  // SHIM_SETTING_KEYS, and the two DEFAULTS values).
  const CAPTURE = 'SONOMOS_CAPTURE';
  const VERDICT = 'SONOMOS_VERDICT';
  const CONFIG = 'SONOMOS_CONFIG';
  const SETTINGS_KEY = 'settings';
  const SHIM_SETTING_KEYS = ['debugLogging', 'enforceTimeoutMs'];
  const SHIM_DEFAULTS = { debugLogging: false, enforceTimeoutMs: 45000 };
  // Desktop-owned, not a setting: the service worker writes it from the native
  // host's status reply (shared/constants.js DISABLED_WEB_HOSTS_KEY). Read from
  // storage.local only — never storage.managed, because it is not a policy
  // knob, and never merged into `settings`, because nothing here may edit it.
  const DISABLED_WEB_HOSTS_KEY = 'disabledWebHosts';

  // The `targetOrigin` both posts below use — '*', and deliberately. The full
  // reasoning lives next to the same constant in content/shim.js: the target
  // is this very window, `location.origin` names the frame URL's origin rather
  // than the document's, and in a frame with an opaque origin (`about:blank`,
  // `about:srcdoc`, `data:`, anything sandboxed — all of which the manifest's
  // `match_about_blank` / `match_origin_as_fallback` keys opt us into) passing
  // it either throws or is silently dropped, which left the shim holding a
  // request nobody could answer. Nothing is given away: the page's own
  // document is the only receiver either way.
  const SAME_WINDOW = '*';

  // Warnings only, and shape-only: which relay hop failed and why. The base64
  // payload never appears here. Mirrors the shim's `[sonomos] reason=…` format
  // so both halves of the chain grep alike.
  function warn(reason, detail) {
    try {
      const suffix = detail ? ` detail=${JSON.stringify(String(detail).slice(0, 120))}` : '';
      console.warn(`[sonomos] reason=${reason} via=content-script action=block${suffix}`);
    } catch { /* no console */ }
  }

  // Content scripts are classic scripts and can't import shared/browser.js, so
  // the namespace pick is inlined. Firefox exposes BOTH `browser` (promises)
  // and a Chrome-compat `chrome` (callbacks only — `sendMessage` there returns
  // undefined, not a promise), so preferring `browser` is what keeps Firefox
  // from failing closed on every in-scope request.
  const isGecko = typeof globalThis.browser !== 'undefined' && !!globalThis.browser?.runtime;
  const api = isGecko ? globalThis.browser : globalThis.chrome;

  // The two dialects can't share one call shape, and guessing wrong is not
  // cheap: `browser.runtime.sendMessage(message, fn)` reads that second
  // argument as the *options* object and rejects a function, while sending
  // once per dialect would relay the same held request twice.
  // So branch on the namespace and use each one's native contract.
  function askWorker(message) {
    if (isGecko) return api.runtime.sendMessage(message);
    return new Promise((resolve, reject) => {
      try {
        api.runtime.sendMessage(message, (response) => {
          const err = api.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  window.addEventListener('message', (event) => {
    // Only trust messages from this window (the MAIN-world shim), not from
    // embedded frames or other origins.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== CAPTURE || typeof data.callId !== 'number' ||
        typeof data.requestB64 !== 'string') return;

    // Which catalog surface the shim attributed this to. Metadata, not
    // content: a short id from a list the extension ships. A page cannot
    // forge its way past screening with it — it only ever labels which surface
    // a capture is attributed to — but a non-string is still dropped rather
    // than relayed, so only the shim's own shape gets through.
    const provider = typeof data.provider === 'string' && data.provider ? data.provider : null;

    const reply = (verdict) => {
      try {
        window.postMessage({ type: VERDICT, callId: data.callId, verdict }, SAME_WINDOW);
      } catch { /* page gone — nothing to answer */ }
    };

    // Relay to the service worker and answer the shim with its verdict. Any
    // failure (context invalidated, no receiving end during an SW restart)
    // resolves to a null verdict → the shim fails closed and blocks the request.
    try {
      // Omitted, not nulled, when the shim attributed nothing — an
      // unattributed capture stays the exact message older builds sent.
      const resp = askWorker({
        type: 'capture',
        requestB64: data.requestB64,
        ...(provider ? { provider } : {})
      });
      if (resp && typeof resp.then === 'function') {
        resp.then((v) => reply(v ?? null), (e) => {
          // The classic one: "Extension context invalidated" after a reload,
          // or "Could not establish connection" while the SW restarts. Both
          // block the send, and neither is visible anywhere else.
          warn('relay-rejected', e && e.message);
          reply(null);
        });
      } else {
        // askWorker's Chromium branch always hands back a promise, so this is
        // the Gecko one answering with something that is not thenable: the
        // messaging API is not behaving as documented, and we treat that as
        // unreachable rather than guessing what came back.
        warn('relay-no-promise', null);
        reply(null);
      }
    } catch (e) {
      warn('relay-threw', e && e.message);
      reply(null);
    }
  });

  // ── settings → the MAIN-world shim ──────────────────────────────────────
  //
  // Precedence matches the service worker's getSettings(): DEFAULTS <
  // storage.local < storage.managed, so an admin policy always wins. Re-posted
  // on every storage change, so flipping debugLogging takes effect on the next
  // request without reloading the page.

  function pick(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const key of SHIM_SETTING_KEYS) {
      if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
  }

  // Read through `api`, not `chrome`, for the same reason the relay does: on
  // Firefox the Chrome-compat namespace is callback-only, so awaiting
  // `chrome.storage.local.get(…)` there yields undefined and every profile
  // would silently fall back to SHIM_DEFAULTS — including an admin policy.
  async function readShimConfig() {
    const config = { ...SHIM_DEFAULTS };
    try {
      const local = await api.storage.local.get([SETTINGS_KEY, DISABLED_WEB_HOSTS_KEY]);
      Object.assign(config, pick(local?.[SETTINGS_KEY]));
      // `{ hosts, ignoredCount }` — the worker stores the count alongside so
      // it can be acked; only the hosts concern the shim. Omitted rather than
      // sent empty when we have nothing stored, so the shim keeps whatever it
      // already applied instead of a missing read silently putting a surface
      // the user excluded back in scope.
      const disabled = local?.[DISABLED_WEB_HOSTS_KEY];
      if (disabled && Array.isArray(disabled.hosts)) config.disabledWebHosts = disabled.hosts;
    } catch { /* nothing stored yet — defaults stand */ }
    try {
      // storage.managed throws when no managed schema is configured for this
      // profile (the common case on a personal install). A policy lookup must
      // never change behaviour by failing — same rule as the service worker.
      Object.assign(config, pick(await api.storage.managed.get(SHIM_SETTING_KEYS)));
    } catch { /* no policy */ }
    return config;
  }

  function pushConfig() {
    readShimConfig().then((config) => {
      try {
        window.postMessage({ type: CONFIG, config }, SAME_WINDOW);
      } catch { /* page gone */ }
    }).catch(() => { /* the shim's own defaults hold */ });
  }

  try {
    api.storage.onChanged.addListener(pushConfig);
  } catch { /* no storage events — the initial push still lands */ }
  pushConfig();
})();
