# Sub-processor declaration

> **DRAFT — pending revision and review by the legal reviewer.** See
> `TODO.md`.

## Product PII

The Sonomos Locke browser extension and the Locke desktop app process
customer Personal Data **entirely on the customer's endpoint**.
Detection and masking happen on the user's own machine; no Personal
Data is transmitted to Sonomos infrastructure or to any third party
engaged by Sonomos.

**Sonomos engages no sub-processors that touch customer Personal
Data processed by the product.**

### What an auditor will actually find

Corrected 2026-08-21. This section previously told an auditor the
extension's outbound surface was constrained to one named loopback
port by the manifest. That was wrong in both
halves, and wrong in the direction that matters: `manifest.json` does
not contain that port, and the grant it does contain is wider than the
one advertised. An auditor following the instruction would have
falsified the claim on the first file they opened. The accurate
statement is:

1. **Personal Data never crosses a network socket.** A held request
   leaves the browser over OS native messaging (stdio) to the same-user
   native messaging host, which relays it to the Locke desktop app
   over a user-only (`0600`) Unix domain socket. Not loopback HTTP — no
   socket an off-box party could address. See
   `docs/architecture/DATA-FLOW.md`.
2. **The manifest's `host_permissions` is `http://127.0.0.1/*`** — all
   loopback ports. Match patterns cannot carry a port at all (Firefox
   treats a ported pattern as matching nothing, Bugzilla 1362809), so
   the port-free spelling is deliberate and the grant is genuinely
   wider than what the extension uses.
3. **The port bound that does exist is the extension-pages CSP**, which
   pins `connect-src` to `http://127.0.0.1:18795`. That port carries
   one thing: a `{ browser, version }` presence beacon to the Locke
   desktop app, fire-and-forget, no Personal Data. It is the only
   `fetch` in the extension.
4. **The tripwires assert loopback, not a port.**
   `scripts/store-build.mjs::validate` rejects any non-loopback
   `host_permissions` entry and runs locally via `npm run validate`,
   `scripts/package.mjs` and the `scripts/preflight.mjs` pre-push hook.
   `.github/workflows/ci.yml::Host permissions are loopback-only`
   re-asserts the same rule and, as of 2026-09-01, runs on every push
   and pull request rather than on manual dispatch. No check anywhere
   asserts a port, so no document should promise one.
5. **The shipped code is audited for endpoints, not just the manifest**
   `[added 2026-09-01]`. The manifest tripwires bound what the
   extension may *request*; until now nothing checked what the code
   *contains*. `scripts/audit-payload.mjs` walks the staged payload —
   the bytes that go into the zip, not the repository — and fails on any
   absolute URL that is not `http://127.0.0.1`, `http://localhost` or
   the `https://sonomos.ai/` link the popup opens in a tab, and on
   `eval`, `new Function`, a remote dynamic `import()`,
   `document.write` or `innerHTML` built by concatenation. An
   unrecognised URL fails closed. `quality.yml::payload-audit` runs it
   on both store payloads on every push and pull request, and
   `tests/audit-payload.test.js` (14 tests) demonstrates that it catches
   an exfiltration endpoint, a lookalike of the allowed product link,
   and a URL hidden in a template literal.

Points 1, 4 and 5 are what carry the sub-processor claim: Personal Data
has no network path off the endpoint, the surface that could acquire one
is gated at build and at push, and — new as of 2026-09-01 — a code-level
check on the shipped payload gates it in CI as well. The honest limit:
this repository is newly public and no CI run has completed in it yet,
so the CI half of that is enforced by a job that will run, not by a run
anyone can point at.

## Corporate-operations sub-processors

For corporate operations (billing, support, infrastructure,
analytics, marketing) Sonomos engages the sub-processors listed at:

> <https://sonomos.ai/sub-processors>

**None of these have access to customer Personal Data processed by
the product.** They may have access to customer-organisation
metadata (company name, billing contact, support ticket subject
lines) under separate processing agreements covered by the master
services agreement.

## Notification of changes

Sonomos commits to publishing changes to the corporate-operations
sub-processor list at the URL above with at least 30 days' notice
before the new sub-processor begins processing customer data.
Customers may object to a new sub-processor under the terms of the
master services agreement.

Because the product engages no sub-processors for product PII, no
sub-processor change notification is required for product
processing — the answer remains "none."

## Verification by customers

A customer's auditor may request:

1. The current declaration at <https://sonomos.ai/sub-processors>.
2. Evidence that Personal Data has no network path off the endpoint —
   point to `docs/architecture/DATA-FLOW.md` (native messaging →
   `0600` UDS), `scripts/store-build.mjs::validate` and
   `scripts/preflight.mjs` for the loopback tripwire that actually
   runs, `manifest.json`, and the threat model in `SECURITY.md` (A1).
   Read `manifest.json` expecting `http://127.0.0.1/*`, not a port.
3. Confirmation that audit logs (`docs/security/PERMISSIONS.md`,
   "audit log" entry) contain no PII.

**There is no third-party audit report to request.** Sonomos holds no
SOC 2 report, no ISO 27001 certificate and no equivalent independent
attestation; no such engagement has been started and no auditor has
been selected. Every item above is a self-assertion an auditor can
check against this repository — which is why each one names the file
that implements it rather than a framework that would vouch for it.

---

**See also:**
- `docs/legal/DPA-template.md` — Article 28 processor agreement
- `docs/legal/DPIA-template.md` — Article 35 impact assessment
- `docs/legal/RETENTION.md` — storage-limitation evidence
