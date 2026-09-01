// Copyright © 2026 Sonomos, Inc. All rights reserved.
export const ext = (typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime)
  ? globalThis.browser
  : globalThis.chrome;

if (!ext?.runtime) {
  throw new Error('WebExtensions API not available in this environment.');
}
