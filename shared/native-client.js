// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { ext } from './browser.js';
import { NATIVE_HOST } from './constants.js';
import { consentIsCurrent, DATA_CONSENT_REQUIRED, requiresDataConsent, onDataConsentChanged, readDataConsent } from './data-consent.js';

// One port per request: closing it releases the browser's host process as
// well as our callbacks. Abandoning sendNativeMessage only releases neither.
// No shared connection survives a timeout, and no captured bytes are retried.
export function nativeRequest(payload, timeoutMs, timeoutCode) {
  // Keep Chrome's synchronous port creation unchanged. Firefox and Edge check the
  // persisted choice at the LAST boundary before any native app receives data.
  if (!requiresDataConsent()) return connect(payload, timeoutMs, timeoutCode);
  return readDataConsent().then(consent => {
    if (!consent.granted || !consentIsCurrent(consent)) throw new Error(DATA_CONSENT_REQUIRED);
    // The disabled-sites acknowledgement is optional settings/interaction
    // metadata. Health and request screening still work without sending it.
    const outgoing = payload.type === 'status' && !consent.technical
      ? { type: 'status' } : payload;
    return connect(outgoing, timeoutMs, timeoutCode, consent);
  });
}

function connect(payload, timeoutMs, timeoutCode, consent) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (port) {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        try { port.disconnect(); } catch { /* already disconnected */ }
      }
      if (error) reject(error); else resolve(value);
    };
    const onMessage = (response) => finish(null, response);
    const onDisconnect = () => {
      // Chromium exposes lastError only inside this callback; Firefox uses
      // port.error. Consume it before cleanup so neither browser loses it.
      const error = ext.runtime.lastError || port?.error;
      finish(new Error(error?.message || 'Native host disconnected.'));
    };
    const timer = setTimeout(() => finish(new Error(timeoutCode)), timeoutMs);
    if (consent) {
      unsubscribe = onDataConsentChanged(() => finish(new Error(DATA_CONSENT_REQUIRED)));
      if (!consentIsCurrent(consent)) { finish(new Error(DATA_CONSENT_REQUIRED)); return; }
    }
    try {
      port = ext.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      port.postMessage(payload);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('native-error'));
    }
  });
}
