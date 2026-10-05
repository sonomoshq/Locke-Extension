// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { ext } from './browser.js';
import { detectBrowser } from './browser-info.js';

// A versioned, explicit choice, never inferred from installation, existing
// settings, enterprise policy, native-host approval, or a browser restart.
// Increment the version when the disclosed data or purpose changes.
export const DATA_CONSENT_KEY = 'dataSharingConsent';
export const DATA_CONSENT_VERSION = 1;
export const DATA_CONSENT_REQUIRED = 'data-consent-required';
export const TECHNICAL_DATA = 'technicalAndInteraction';
export const isFirefox = () => typeof ext.runtime.getBrowserInfo === 'function';
// This runs in an extension-owned context; a website cannot override its UA.
// Both Chromium stores share a package, so scope the added consent to Edge.
export const requiresDataConsent = () => isFirefox() ||
  detectBrowser(globalThis.navigator?.userAgent, globalThis.navigator) === 'edge';

let generation = 0;
const listeners = new Set();
function invalidate() {
  generation++;
  for (const listener of listeners) listener();
}
if (requiresDataConsent()) {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[DATA_CONSENT_KEY]) invalidate();
  });
  // Browser-side changes take effect even while the consent page is closed.
  for (const event of [ext.permissions?.onAdded, ext.permissions?.onRemoved]) {
    event?.addListener(change => {
      if (change.data_collection) invalidate();
    });
  }
}

export function onDataConsentChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function consentIsCurrent(consent) {
  return !consent.required || consent.generation === generation;
}

export async function readDataConsent() {
  if (!requiresDataConsent()) return { required: false, granted: true, technical: true };
  const current = generation;
  const denied = { required: true, granted: false, technical: false, decided: false, generation: current };
  try {
    const stored = (await ext.storage.local.get(DATA_CONSENT_KEY))?.[DATA_CONSENT_KEY];
    // Mozilla's documented feature detection, not a UA version comparison.
    // A failed lookup is not evidence of an old browser: fail closed.
    const permissions = isFirefox() ? await ext.permissions.getAll() : {};
    const builtin = Array.isArray(permissions.data_collection);
    const decided = stored?.version === DATA_CONSENT_VERSION && typeof stored.granted === 'boolean';
    if (current !== generation) return denied;
    const granted = decided && stored.granted === true;
    return {
      ...denied, decided, granted, builtin,
      technical: granted && stored.technical === true &&
        (!builtin || permissions.data_collection.includes(TECHNICAL_DATA))
    };
  } catch {
    return { ...denied, unavailable: true };
  }
}

export async function saveDataConsent(granted, technical = false) {
  if (!requiresDataConsent()) return;
  await ext.storage.local.set({ [DATA_CONSENT_KEY]: {
    version: DATA_CONSENT_VERSION,
    granted: granted === true,
    technical: granted === true && technical === true
  } });
}

export async function showDataConsentIfNeeded() {
  const consent = await readDataConsent();
  if (consent.required && !consent.decided) {
    await ext.tabs.create({ url: ext.runtime.getURL('popup/consent.html'), active: true });
  }
}
