// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Classifies the running browser from its user-agent string (plus the
// `navigator.brave` object, the only reliable Brave signal — Brave ships a
// stock Chrome UA). The id feeds the presence heartbeat to the Locke desktop
// app so its UI can say which browsers are connected; it is a display hint,
// never a security decision.
//
// Token order matters: Edge, Opera, and Vivaldi all embed `Chrome/` in their
// UAs, so their own tokens must be checked before the generic Chrome match.

/**
 * @param {string} userAgent - navigator.userAgent (or any UA string).
 * @param {object} [nav] - navigator-like object; only `.brave` is consulted.
 * @returns {'chrome'|'edge'|'firefox'|'opera'|'vivaldi'|'brave'|'other'}
 */
export function detectBrowser(userAgent, nav) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (ua.includes('Firefox/')) return 'firefox';
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('OPR/')) return 'opera';
  if (ua.includes('Vivaldi/')) return 'vivaldi';
  if (nav && nav.brave) return 'brave';
  if (ua.includes('Chrome/')) return 'chrome';
  return 'other';
}
