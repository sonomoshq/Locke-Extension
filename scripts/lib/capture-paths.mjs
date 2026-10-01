// Copyright © 2026 Sonomos, Inc. All rights reserved.
//
// The reduction from shared/ai-surfaces.json to `SONOMOS_CAPTURE_PATHS` — the
// per-host table content/shim.js reads to decide which bodied requests on a
// covered host are HELD at all.
//
// It lives apart from scripts/generate-surfaces.mjs so the tests can run the
// same code the generator runs: tests/honest-capture-paths.test.js compares the
// generated file to this reduction (catching a hand edit of the generated
// file), and tests/generate-surfaces.test.js pins the rules below against both
// the live catalog and synthetic ones.
//
// Two catalog fields feed the table, and they fail in opposite directions:
//
//   capture_path_allowlist   NARROWS a host to the listed paths. Absent means
//                            capture-everything. An empty list reads as absent
//                            (catalog: `unrecognised_means_passthrough`), so a
//                            half-written entry cannot switch screening off.
//
//   web_screening: "none"    says a provider's web_hosts have NO screened
//                            submission path — what a user types there leaves
//                            as a top-level navigation. Those hosts get an
//                            EMPTY allow-list: narrowed to nothing, so the
//                            shim's isScreenedPath falls through to passthrough
//                            exactly as it does for a path a real allow-list
//                            declines.
//
// Why the second rule exists: the shim held EVERY bodied request on
// www.google.com — Maps, Flights, account XHRs, every telemetry beacon — and
// each one cost a native-host round trip, or a BLOCK when the desktop app was
// not running. The catalog said all along that nothing on those hosts is
// screened; the shim just never read the field.
//
// Why the hosts STAY in web_hosts, and therefore in SONOMOS_WEB_HOSTS and the
// manifest: `web_hosts` is also the shim's request-TARGET scope set, and duck.ai's
// chat XHRs target duckduckgo.com (sonomos-vocab's
// `unscreened_hosts_stay_in_web_hosts_because_that_is_also_the_shims_scope_set`).
// The shim honours an empty allow-list only on the unscreened surface's OWN
// pages — see `isScreenedPath` in content/shim.js — so that cross-page chat is
// still held. The one case this file must handle itself is the subdomain one
// below.

// The modes the catalog defines (`web_screening_modes`). Absent means "body".
// The catalog says an unrecognised value must be read as NOT screened; here
// that is a build error rather than a guess, because the two readings of "not
// screened" — hold everything (fail closed) and hold nothing (passthrough) —
// are opposite capture decisions, and a generator must not pick one silently.
export const WEB_SCREENING_MODES = Object.freeze(['body', 'none']);

export function webScreeningOf(provider) {
  const mode = provider.web_screening === undefined ? 'body' : provider.web_screening;
  if (!WEB_SCREENING_MODES.includes(mode)) {
    throw new Error(
      `ai-surfaces.json: provider "${provider.id}" declares web_screening ${JSON.stringify(mode)}, ` +
        `which this generator does not recognise (known: ${WEB_SCREENING_MODES.join(', ')}). ` +
        'Teach scripts/lib/capture-paths.mjs the new mode rather than guessing a capture decision for it.'
    );
  }
  return mode;
}

const lower = (h) => String(h).replace(/\.+$/, '').toLowerCase();

// The key `allowlistFor` in content/shim.js would pick for `host`: the longest
// entry that is the host itself or a suffix of it on a label boundary.
function longestKeyFor(table, host) {
  let best = null;
  for (const entry of Object.keys(table)) {
    if ((host === entry || host.endsWith(`.${entry}`)) && (best === null || entry.length > best.length)) {
      best = entry;
    }
  }
  return best;
}

// The explicit allow-lists, exactly as the generator has always emitted them.
export function explicitAllowlists(surfaces) {
  const table = {};
  for (const p of surfaces.providers) {
    const hostsForProvider = (p.capture_path_allowlist || {}).hosts || {};
    for (const [entry, paths] of Object.entries(hostsForProvider)) {
      // Empty lists are dropped BEFORE specificity is considered: a half-written
      // entry must behave as if never typed, not as a more-specific "declares
      // nothing" shadowing a real list on a broader key.
      if (Array.isArray(paths) && paths.length) table[lower(entry)] = paths;
    }
  }
  return table;
}

/**
 * What happens to each web_host of a `web_screening: "none"` provider.
 *
 * Returns `{ narrowed, kept }`:
 *   narrowed  hosts that get an empty allow-list (nothing on their own pages is
 *             held);
 *   kept      hosts left with NO entry — still capture-everything — each with
 *             the reason. Two reasons exist:
 *       explicit   some provider declares a real allow-list for the host. The
 *                  explicit list is the more specific statement and is what
 *                  the catalog uses to say "this one path on an otherwise
 *                  unscreened host carries a prompt" — it is already in the
 *                  table, so there is nothing to add.
 *       shadows    a body-screened provider's web_host sits UNDER this host
 *                  (assistant.kagi.com under the `search` entry's kagi.com)
 *                  and has no allow-list of its own, so the shim's
 *                  longest-suffix lookup would hand it the apex's empty list
 *                  and silently stop screening a surface the catalog says is
 *                  screened. The apex keeps capture-everything, as it always
 *                  had. The catalog can lift this by giving the screened
 *                  subdomain an allow-list of its own.
 */
export function unscreenedWebHosts(surfaces) {
  const explicit = explicitAllowlists(surfaces);
  const screenedHosts = [];
  const unscreenedProviders = [];
  for (const p of surfaces.providers) {
    const hosts = (p.web_hosts || []).map(lower);
    if (webScreeningOf(p) === 'none') unscreenedProviders.push({ id: p.id, hosts });
    else screenedHosts.push(...hosts);
  }

  const narrowed = [];
  const kept = [];
  for (const p of unscreenedProviders) {
    for (const host of p.hosts) {
      if (longestKeyFor(explicit, host) === host) {
        kept.push({ host, provider: p.id, reason: 'explicit' });
        continue;
      }
      const shadows = screenedHosts.find((s) => {
        if (s === host || !s.endsWith(`.${host}`)) return false;
        const own = longestKeyFor(explicit, s);
        return own === null || own.length <= host.length;
      });
      if (shadows) {
        kept.push({ host, provider: p.id, reason: 'shadows', screened: shadows });
        continue;
      }
      narrowed.push(host);
    }
  }
  return { narrowed: [...new Set(narrowed)].sort(), kept };
}

/**
 * The complete `SONOMOS_CAPTURE_PATHS` table: explicit allow-lists plus an
 * empty list for every unscreened host. Keys sorted, so the generated file is
 * stable across catalog reorderings.
 */
export function capturePathsFor(surfaces) {
  const table = explicitAllowlists(surfaces);
  for (const host of unscreenedWebHosts(surfaces).narrowed) table[host] = [];
  return Object.fromEntries(Object.keys(table).sort().map((h) => [h, table[h]]));
}
