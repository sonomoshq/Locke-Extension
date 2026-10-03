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
// One of those causes is told apart from the rest, and only so the block can
// explain itself: an extension reload orphans this script for the life of the
// tab, so the answer is "reload the page" rather than "try again" (see
// DEAD_CHANNEL). It is still a block — the reply is the same fail-closed shape
// with a reason attached, never a send.
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
  const SHIM_SETTING_KEYS = ['debugLogging', 'enforceTimeoutMs', 'allowedProviders'];
  // `allowedProviders: []` means "no restriction", matching DEFAULTS. It is a
  // real default rather than an omission, so a profile with nothing stored
  // screens every catalog surface — the safe direction for a subtractive knob.
  const SHIM_DEFAULTS = { debugLogging: false, enforceTimeoutMs: 200000, allowedProviders: [] };
  // Desktop-owned, not a setting: the service worker writes it from the native
  // host's status reply (shared/constants.js DISABLED_WEB_HOSTS_KEY). Read from
  // storage.local only — never storage.managed, because it is not a policy
  // knob, and never merged into `settings`, because nothing here may edit it.
  const DISABLED_WEB_HOSTS_KEY = 'disabledWebHosts';

  // Loaded by the manifest in THIS isolated world, independently of the
  // page's mutable MAIN-world globals. Provider labels are untrusted page
  // input; only identities from this shipped catalog may leave the relay.
  // Missing catalog data costs attribution, never screening.
  const providerIds = new Set(Object.values(globalThis.SONOMOS_WEB_PROVIDERS || {}));

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

  // ── "this tab's channel is dead" vs "the worker is asleep" ─────────────
  //
  // Both arrive here as a failed sendMessage, both block the send, and the
  // difference is the only thing the user can act on.
  //
  // Reloading, updating or re-enabling the extension orphans every content
  // script already injected into an open tab. THIS script keeps running — it
  // is page-lifetime, not extension-lifetime — but its `runtime` port belongs
  // to a generation of the extension that no longer exists, so every later
  // relay fails and every in-scope request in this tab blocks for the rest of
  // the tab's life. Retrying cannot clear it. Nothing in the browser says so,
  // and the popup cannot see it either: the worker is never reached, so no
  // capture failure is ever recorded for it. The one fix is a page reload,
  // which injects a live content script — and until we said that, a correct
  // fail-closed block on a healthy install was indistinguishable from Locke
  // being broken.
  //
  // The other shape ("Could not establish connection. Receiving end does not
  // exist") is an MV3 service worker that had been evicted, which the next
  // send wakes. Same block, opposite advice, so they must not share a
  // sentence.
  //
  // Matched on the browser's own message text because that is the only signal
  // there is: `runtime.id` reads `undefined` in an orphaned Chromium context
  // but is not specified to, and touching `runtime` at all can throw here.
  // An unrecognised message keeps the old, weaker answer — a null verdict —
  // rather than claiming a cause we did not observe.
  const DEAD_CHANNEL = /context invalidated/i;

  // What we hand the shim for a dead channel, instead of a bare null.
  //
  // It is the service worker's own relay-failure shape, which the shim
  // already routes through `RELAY_BLOCK_REASON` (content/shim.js) — and every
  // entry in that table blocks. So this buys the user a sentence and can
  // never buy the page a send: `ok: false` reaches the same fail-closed
  // branch a null does, one reason string better off. `message` is our own
  // fixed text, never the browser's, so nothing from this tab rides out.
  const DEAD_CHANNEL_VERDICT = Object.freeze({
    ok: false,
    code: 'extension-reloaded',
    message: 'the extension was reloaded, updated or re-enabled after this page was opened'
  });

  const isDeadChannel = (e) => {
    try {
      return DEAD_CHANNEL.test(String((e && e.message) || ''));
    } catch {
      // A thrown getter on a hostile error object is not evidence of a
      // reload. Fall back to the unattributed block.
      return false;
    }
  };

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

    // A page can put arbitrary content in this field. Keep only an exact
    // catalog identity; do not log, truncate or otherwise preserve unknown
    // labels. The request and verdict still travel normally without a label.
    const provider = typeof data.provider === 'string' && providerIds.has(data.provider)
      ? data.provider : null;

    const reply = (verdict) => {
      try {
        // the receiving DOCUMENT's origin, not by listener, so every script in this
        // document could read this post whatever we passed; and location.origin throws
        // or is silently dropped in the opaque-origin frames the manifest opts into.
        // Deliberate: targetOrigin filters by the receiving DOCUMENT origin, not
        // by listener, so narrowing it hides nothing; and location.origin throws
        // or is dropped in the opaque-origin frames the manifest opts into. Full
        // reasoning at the SAME_WINDOW declaration above.
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
        window.postMessage({ type: VERDICT, callId: data.callId, verdict }, SAME_WINDOW);
      } catch { /* page gone — nothing to answer */ }
    };

    // Relay to the service worker and answer the shim with its verdict. Any
    // failure (context invalidated, no receiving end during an SW restart)
    // blocks the request: a null verdict, or — for the one cause whose remedy
    // is not "try again" — the relay-failure shape carrying its reason. Both
    // land in the shim's fail-closed branches; neither can produce a send.
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
          // block the send, and neither is visible anywhere else — so the
          // first gets named, because its remedy is a page reload and the
          // other's is nothing at all. See DEAD_CHANNEL.
          const dead = isDeadChannel(e);
          warn(dead ? 'extension-reloaded' : 'relay-rejected', e && e.message);
          reply(dead ? DEAD_CHANNEL_VERDICT : null);
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
      // Firefox's `browser.runtime.sendMessage` throws synchronously on a
      // torn-down context rather than returning a rejected promise, so the
      // dead channel arrives here as often as it arrives above. Same
      // attribution, or the remedy would depend on which browser the user
      // happened to be in.
      const dead = isDeadChannel(e);
      warn(dead ? 'extension-reloaded' : 'relay-threw', e && e.message);
      reply(dead ? DEAD_CHANNEL_VERDICT : null);
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
        // the receiving DOCUMENT's origin, not by listener, so every script in this
        // document could read this post whatever we passed; and location.origin throws
        // or is silently dropped in the opaque-origin frames the manifest opts into.
        // Deliberate: targetOrigin filters by the receiving DOCUMENT origin, not
        // by listener, so narrowing it hides nothing; and location.origin throws
        // or is dropped in the opaque-origin frames the manifest opts into. Full
        // reasoning at the SAME_WINDOW declaration above.
        // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
        window.postMessage({ type: CONFIG, config }, SAME_WINDOW);
      } catch { /* page gone */ }
    }).catch(() => { /* the shim's own defaults hold */ });
  }

  try {
    api.storage.onChanged.addListener(pushConfig);
  } catch { /* no storage events — the initial push still lands */ }
  pushConfig();
})();
