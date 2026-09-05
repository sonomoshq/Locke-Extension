// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { ext } from './browser.js';
import { NATIVE_HOST } from './constants.js';

// One port per request: closing it releases the browser's host process as
// well as our callbacks. Abandoning sendNativeMessage only releases neither.
// No shared connection survives a timeout, and no captured bytes are retried.
export function nativeRequest(payload, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
