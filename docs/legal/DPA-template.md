# Data Processing Addendum (DPA) — template

> **DRAFT — pending revision and review by the legal reviewer.** See
> `TODO.md` for the legal review checklist. The version in force is
> the one signed by both parties; do not deliver this template to a
> customer without legal sign-off.

**Status: template, not a binding agreement.** The version in force is
the one signed by both parties. Procurement / legal teams should ask
for the executed copy at `info@sonomos.ai`.

This template exists so a customer's procurement team can do a first-
pass review without waiting on us. It mirrors the structure of the
GDPR Article 28 DPA but is jurisdiction-neutral; jurisdiction-specific
addenda (UK GDPR IDTA, EU SCCs, Swiss FADP) are appended at execution
time.

## 1. Parties

- **Customer**: the legal entity executing the Master Services
  Agreement or Subscription Agreement with Sonomos.
- **Processor**: Sonomos, Inc. (the legal entity behind the Sonomos
  Desktop product family, including the Sonomos Desktop Connector
  browser extension).

## 2. Scope

This DPA covers Personal Data that the Customer's authorised users
process via the Sonomos Locke browser extension and the companion
Sonomos Locke desktop application installed on their endpoints.

## 3. Roles

- The **Customer** is the Controller (or, where applicable, the
  Processor for its own customers' data).
- **Sonomos** is the Processor when handling Personal Data through
  Sonomos software. **Sonomos is not the Processor for any Personal
  Data sent to third-party LLM providers** by the Customer — that
  relationship is between the Customer and the LLM provider, governed
  by the LLM provider's own DPA.

## 4. Subject matter and duration

Sonomos processes Personal Data only for the purpose of detecting and
masking it before it leaves the Customer's endpoint, and rehydrating
it on response. Processing occurs in-memory on the Customer's own
device; Sonomos's hosted infrastructure is **not** part of the data
plane for this product.

Duration: for the term of the underlying agreement.

## 5. Categories of Personal Data

The extension is designed to detect and mask:

- Direct identifiers (names, email addresses, phone numbers,
  government-issued IDs).
- Indirect identifiers (location, employer, role, demographic data).
- Free-form text fields where any of the above may appear.

The extension does not target or have visibility into:

- Health data, biometric data, or other Article 9 GDPR special
  categories — unless they appear in free-form text the user submits
  to an AI provider, in which case standard PII-detection rules apply.
- Children's data (the product is not directed at users under 16).

## 6. Sub-processors

Because all data plane processing happens on the Customer's endpoint,
Sonomos does **not** engage sub-processors for the Personal Data
covered by this DPA.

For corporate operations (billing, support ticketing, software update
delivery), Sonomos engages sub-processors listed at
<https://sonomos.ai/privacy>. None of these have access to Customer
PII processed by the product.

## 7. Security measures

See `SECURITY.md` in the Sonomos Desktop Connector repository for the
threat model and the mitigations in force. Summary of relevant
controls:

- **No network path for Personal Data**: a held request leaves the
  browser over OS native messaging and reaches the local desktop app
  over a user-only (`0600`) Unix domain socket. It never traverses a
  network socket, loopback included.
- **Network isolation of what remains**: the extension's only HTTP
  call is a `{ browser, version }` presence beacon to `127.0.0.1` —
  no Personal Data. `manifest.json::host_permissions` is loopback-only
  (all loopback ports; match patterns cannot express one), enforced at
  build and at push by `scripts/store-build.mjs::validate`.
- **Local IPC identity**: the browser's own `allowed_origins` check
  bounds which extension may speak to the native host; extension IDs
  are browser-derived and cannot be forged.

  *(Corrected 2026-08-21: the first two bullets previously described a
  per-install HMAC-SHA256 handshake and a mode-`0600` token shared
  between the extension, a Python native bridge and a daemon. That
  architecture was retired in the 2026-06 mesh rewrite; no such
  handshake or token exists.)*
- **Encryption at rest**: none, and none is required here.
  *(Corrected 2026-08-21: this bullet claimed a "per-install FF1 key,
  sealed under the OS keystore". No such key exists — `FF1` appears
  nowhere in any Sonomos repository. It described the retired
  retired daemon's format-preserving-encryption scheme, which went
  with it in the 2026-06 mesh rewrite. Claiming an unimplemented
  cipher as an Article 32 technical measure, in contract text, is not a
  defensible error to leave standing.)* What holds instead is that the
  extension persists no Personal Data at all: capture crosses native
  messaging to a same-user helper and a mode-`0600` Unix domain socket,
  and the extension's own storage holds settings and a ~100-entry audit
  log that contains no PII (`docs/legal/RETENTION.md`). Confidentiality
  here rests on file and process permissions, not on a cipher — see
  `EXPORT_CONTROL_NOTICE.md` for the verified cryptographic inventory.
- **Encryption in transit** (extension ↔ provider): the user's own
  TLS to the LLM provider; Sonomos does not interpose.
- **Vulnerability disclosure**: 48h acknowledgement, 30-day fix
  target for high-severity issues.
- **Software bill of materials**: CycloneDX + SPDX SBOM generation runs
  on every push to `main` and monthly (`.github/workflows/sbom.yml`),
  and the release workflow generates both formats per release. As of
  2026-09-01 **no SBOM has been published against any version**: the
  workflows were manual-dispatch-only until now, no run has completed in
  this repository, and no release has been published to attach one to.
  Do not represent an SBOM as available to Customer until one is
  attached to a release (`docs/security/CONTROL-CATALOG.md`).

## 8. International transfers

No transfer occurs at the data plane layer — Personal Data does not
leave the Customer's endpoint via Sonomos software. Where the
Customer's chosen LLM provider transfers the *masked* (de-identified)
data internationally, that transfer is governed by the LLM provider's
own DPA.

## 9. Data subject rights

Because Sonomos does not retain Personal Data, requests for access,
rectification, erasure, restriction, portability, or objection are
satisfied at the Customer endpoint or with the LLM provider, as
appropriate. Sonomos will assist the Customer in responding to data
subject requests within reasonable timeframes.

## 10. Breach notification

Sonomos will notify the Customer without undue delay (and in any case
within 48 hours) of becoming aware of a Personal Data Breach affecting
the Customer's data, including:

- A description of the nature of the breach.
- Likely consequences.
- Measures taken to address it.

## 11. Audit rights

The Customer (or its mandated auditor, bound by appropriate
confidentiality obligations) may audit Sonomos' compliance with this
DPA once per year on reasonable notice. Sonomos holds no independent
attestation — no SOC 2 report, no ISO 27001 certificate, no equivalent
— and no such engagement has been started, so there is nothing Sonomos
can offer a Customer in lieu of that audit. What Sonomos can provide is
its own evidence: the control catalogue, risk register and data-flow
documentation in the product repository, all of it self-asserted.
A Customer who requires third-party assurance should treat that as
unavailable rather than pending.

## 12. Return / deletion

On termination, Sonomos has nothing to return or delete — Personal
Data was never transferred to Sonomos infrastructure. See
`docs/legal/RETENTION.md` for the complete inventory of what is and
isn't held.

## 13. Indemnification

> **Placeholder — pending legal drafting.** Customers'
> procurement teams should expect, at minimum, mutual indemnification
> for third-party IP claims arising out of either party's
> contributions to the executed agreement. Liability caps,
> carve-outs (gross negligence, wilful misconduct, breach of
> confidentiality), and the relationship between this DPA and the
> MSA's general indemnity clauses are governed by the MSA.

## 14. Governing law

To be agreed at execution. Defaults to the governing law of the
underlying Master Services Agreement (see §15).

## 15. Relationship to the Master Services Agreement

This DPA is incorporated into and forms part of the Master Services
Agreement (MSA) executed between the parties. Where this DPA is
silent on a point covered by the MSA, the MSA governs. Where this
DPA conflicts with the MSA on data-protection matters, this DPA
controls.

The MSA template is available on request from `info@sonomos.ai`;
its public summary lives at <https://sonomos.ai/msa> (when
published — see `TODO.md`).

## 16. End-User Licence Agreement

Use of the Sonomos Desktop Connector by an end-user is governed by
the EULA published at <https://sonomos.ai/eula>. The EULA covers
the user-facing terms of use; this DPA covers the controller-
processor relationship between the customer organisation and
Sonomos. The two are complementary, not redundant.

---

For the executed version, contact `info@sonomos.ai`.
For privacy details, see <https://sonomos.ai/locke/privacy>.
For end-user terms, see <https://sonomos.ai/eula>.
