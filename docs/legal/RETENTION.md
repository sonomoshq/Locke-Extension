# Extension data retention inventory

> **DRAFT — legal review required.** Source reviewed on 2026-10-05.

This describes the browser extension's storage, not the desktop app's
retention or a conclusion about legal compliance. Local processing includes
personal data; absence of an extension cloud endpoint does not mean there is
nothing to disclose or erase. For the complete product policy, including
desktop metadata, logs and crash handling, see
<https://sonomos.ai/locke/privacy>.

## Persistent browser-profile items

| Item | Location / source | Lifetime / deletion |
|---|---|---|
| Diagnostic audit buffer | `storage.local.auditLog`; `appendAudit` in `background/service-worker.js` | Most recent 100 entries (`AUDIT_MAX_ENTRIES`); no time-based expiry. Older entries are evicted as new ones arrive. Browser removal/clearing of extension data deletes this copy. |
| Disabled-site configuration | `storage.local.disabledWebHosts`; `storeDisabledWebHosts` | Last applied host list and ignored-entry count from the desktop app. Persists across browser restarts and host outages; replaced when a changed configuration arrives, or removed with extension data. |
| Local settings, if present | `storage.local.settings`; `getSettings` | Read and merged with defaults and managed policy; no automatic expiry. Replaced/cleared by configuration changes or removal of extension data. |
| Legacy popup theme, if present | Extension-origin Web Storage `sonomosPopupTheme`; `popup/theme-init.js` | Current popup reads an existing value; it has no theme-toggle writer. Persists until that browser storage is cleared. This is not `storage.local`. |
| Managed policy | `storage.managed`; `getManagedSettings` | Read-only policy supplied by the browser/OS; governed by the administrator. Removing the extension does not remove the administrator's policy. |

Audit entries are timestamped diagnostic events: connection failures/recovery,
policy-key names, screening availability and CSP violations. CSP entries can
contain `blockedURI`, `documentURI`, `sourceFile`, a directive and line number;
error metadata is also recorded. The buffer does not contain captured request
bodies. “Shape-only” does not guarantee anonymous data or that every URL is
free of identifying information. Do not publish a diagnostic export without
reviewing its contents.

## Browser-session items

`background/service-worker.js` uses `storage.session` for:

- `connectionState`: health status, error/latency metadata and timestamps,
  with the current screening summary
- `screeningState`: recent screening evidence, timestamps and counters for
  unchecked sends, withheld/redacted items and policy-blocked sends
- `backoff`: health-check scheduling state
- `registrationLastAttempt`: Chromium registration retry timestamp

These survive service-worker eviction. Browser-session storage is cleared by
the browser on restart; it is not a disk-persistent request archive. The
10-minute screening-evidence freshness limit affects what the popup can
claim, not an automatic deletion deadline for the stored record or counters.

## Request content and diagnostics

The extension copies and relays in-scope request bodies, including supported
file bytes, plus method, destination, path/query and page-set headers, to the
local native app for screening. The cross-origin upload screening copy omits
the presigned URL query; the browser-added Cookie header is not captured.
Request and rebuilt-body copies are held in memory for handling the request;
the extension has no persistence path for those bodies. This is not a claim
of immediate secure erasure from memory or a statement about desktop storage.
The extension does not capture the website's response bodies.

Console diagnostics are separate from `auditLog`. They include request shape,
host/path, sizes, verdicts and errors; telemetry handling can also log a tab ID,
a tab URL (up to 200 characters) and CSP metadata. Browser devtools, logging
settings or a user-created export can retain these independently. No fixed
retention period or automatic erasure of those copies is implemented here.

The page sends allowed/redacted requests to the original website, which has
its own retention practices. Uninstalling the extension does not erase data
held by the desktop app, an AI provider, the administrator or an exported log.
For rights requests and product-wide retention, use the product privacy policy
rather than claiming erasure is unnecessary because screening is local.

## Verification

1. Inspect `storage.local` and `storage.session` in the extension's devtools;
   inspect extension-origin Web Storage separately for the legacy theme key.
2. Compare the values with `shared/constants.js`, the service-worker storage
   calls, `popup/theme-init.js` and the [data flow](../architecture/DATA-FLOW.md).
3. Check browser restart, worker eviction, configuration replacement and
   extension removal separately. The current popup has no audit-export link;
   inspecting browser storage is the verification route, not a promised UI.
4. Review desktop retention separately before publishing product-wide claims.
