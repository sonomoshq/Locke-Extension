# Data retention policy

> **DRAFT — pending revision and review by the legal reviewer.** See
> `TODO.md`.

This document satisfies GDPR Art. 5(1)(e) "storage limitation" by
declaring exactly what the Sonomos Desktop Connector extension
stores, where, for how long, and what triggers deletion.

The product is on-device. Sonomos infrastructure has no copy of any
of the items below.

## Persistent items

| Item | Where | When written | Lifetime | Trigger for deletion |
|---|---|---|---|---|
| Connection-state cache | `chrome.storage.session` (in-memory; cleared on browser process exit) | On each health check (a native-messaging round trip) | Single browser session (≤ days for a long-lived browser) | Browser restart; service-worker eviction; explicit `chrome.storage.session.clear()` |
| Theme preference | `chrome.storage.local` | When user toggles theme in popup | Until user changes it again | User toggles theme; uninstalls extension |
| Managed-policy cache | `chrome.storage.managed` (read-only; provided by OS policy framework) | When admin-pushed via GPO/MDM | Until admin removes the policy | Admin policy change |
| Audit log | `chrome.storage.local`, key `auditLog` | On the 7 audited event kinds (see `docs/security/PERMISSIONS.md`) | Ring buffer capped at 100 entries (`AUDIT_MAX_ENTRIES`) | Eviction by ring buffer; uninstall |

## Items not retained

| Item | Why not |
|---|---|
| Auth token | **Corrected 2026-08-21: no such item.** A mode-`0600` daemon token cached in `chrome.storage.session` under `TOKEN_TTL_MS` used to be listed above. It retired with the daemon in the 2026-06 mesh rewrite; the extension stores no secret of any kind. |
| Request bodies (PII) | Never persisted by the extension. Held in the screening service's memory for one request, then discarded. |
| Response bodies | Same. |
| User identity | The extension has no user concept. There is no account, no login, no session. |
| Browsing history | The extension does not observe pages outside its `content_scripts.matches` list (the AI web-surface hosts), and it runs nowhere else. |
| LLM prompts after masking | Forwarded by the user's browser to the user's chosen LLM provider. Sonomos does not interpose. |
| LLM responses | Same. |

## Items on Sonomos infrastructure

**None for product PII.** The architecture is loopback-only.

For corporate operations (billing, support tickets), Sonomos retains
customer-organisation metadata per the retention schedule on the
public privacy policy at <https://sonomos.ai/privacy>. This metadata
does not include customer Personal Data processed by the product.

## Statutory retention obligations

Sonomos has no statutory obligation to retain product Personal Data
because the product holds no product Personal Data on Sonomos
infrastructure. Customers operating in regulated industries
(healthcare, financial services) may have their own statutory
retention obligations on their endpoints; those are the customer's
responsibility and unrelated to this product.

## Right to erasure

Because Sonomos retains no product Personal Data, an Article 17
right-to-erasure request directed at Sonomos for product data is
satisfied trivially (there is nothing to erase). For data held by
the customer organisation on its endpoints, the customer is the
controller and handles the request directly.

## Audit-log export

The audit log (one of the persistent items above) is exportable by
the user from the popup ("Audit log" link). It contains shape-only
events and no PII. A customer's IT admin pulling this log during
incident response will see entries like:

```json
{
  "ts": 1715367600000,
  "kind": "daemon-down",
  "details": { "from": "connected", "error": "daemon-timeout" }
}
```

No request bodies, no user-typed text appears (and no auth tokens —
there are none to appear). The `daemon-` prefix on that event kind is a
legacy spelling kept in `AUDITED_KINDS` so existing exported logs stay
parseable; it means the Locke desktop app became unreachable.

## Verification

`docs/security/PERMISSIONS.md` lists every storage-using API and why.
Auditors can verify the storage claims by:

1. Inspecting `chrome.storage.local` and `chrome.storage.session`
   contents from the browser's devtools (Application → Storage).
2. Reading the audit log via the popup export.
3. Reviewing the source files referenced in the table above.
