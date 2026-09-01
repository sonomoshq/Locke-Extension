# Data Protection Impact Assessment (DPIA) — template

> **DRAFT — pending revision and review by the legal reviewer.** This
> template is a starting point for customers whose own counsel
> requires a DPIA before deployment. See `TODO.md` for the
> outstanding legal-review items.

This template covers the Sonomos Desktop Connector browser extension
and its companion daemon. It addresses GDPR Article 35 (and the
equivalent UK GDPR Article 35) DPIA requirements.

A DPIA is required under Article 35(1) when processing is "likely to
result in a high risk to the rights and freedoms of natural persons."
Sonomos's processing position is unusual: PII never leaves the user's
endpoint via Sonomos software, so the residual processing risk is
materially lower than for a typical SaaS PII handler. We provide this
DPIA template so customers whose own internal policy mandates a DPIA
(regardless of risk level) can complete one quickly.

## 1. Description of processing

### Nature, scope, context, and purpose

- **Nature**: detection and masking of personal data in free-form
  text the user is about to send to a third-party large-language-
  model service. The browser extension holds the outbound request and
  routes it, over OS native messaging and a user-only Unix domain
  socket, into the on-device Sonomos desktop app, where detection and
  redaction happen. The extension applies the verdict returned — send
  as held, send the rebuilt request, or block — and the user's browser
  then completes the request with placeholders in place of PII.
  Anything short of a clean verdict blocks. (Corrected 2026-08-21: this
  described a loopback HTTP daemon that no longer exists.)
- **Scope**: the categories of personal data the user voluntarily
  types into AI chat surfaces or search-engine queries on the host
  list at `manifest.json::content_scripts.matches`. The product does
  not initiate processing on its own.
- **Context**: end-user deployment, optionally fleet-managed via
  Chrome `ExtensionSettings` / Firefox `policies.json`. See
  `docs/enterprise/DEPLOYMENT.md`.
- **Purpose**: data minimisation. Reducing the PII content of LLM-
  bound traffic protects the user from inadvertent disclosure to the
  LLM provider, satisfies the customer's own compliance obligations
  (GDPR Article 5(1)(c) data minimisation), and limits regulatory
  exposure if the LLM provider suffers a breach.

### Categories of data subjects and personal data

- **Data subjects**: the end-user, their colleagues whose details
  appear in the user's prompts, and any third parties named in those
  prompts.
- **Personal data categories**: direct identifiers (name, email,
  phone, government ID), indirect identifiers (location, employer,
  role), and free-form text that may contain any of the above.
- **Special categories (GDPR Art. 9)**: health, biometric, or
  political/religious data may appear incidentally in user prompts;
  the product treats them under the same masking rules as ordinary
  PII. The product is not designed to process special categories
  systematically and does not target them.

## 2. Necessity and proportionality

- **Lawful basis (GDPR Art. 6)**: the processing is performed on
  the user's own device, on data the user has voluntarily entered
  into a free-form input field. The lawful basis is most often
  Article 6(1)(a) consent (user installs the extension) or Article
  6(1)(b) contract performance (employer-mandated deployment).
- **Data minimisation**: the product *increases* compliance with
  Art. 5(1)(c) by reducing the PII payload of every outbound LLM
  request. It introduces no additional data collection.
- **Storage limitation (Art. 5(1)(e))**: see `docs/legal/RETENTION.md`.
  Corrected 2026-08-31: there is no auth token — it retired with the
  daemon architecture, and the extension now stores no secret of any
  kind. The managed-storage cache and the shape-only audit ring buffer
  are the only persistent artefacts; both are local.
- **Purpose limitation (Art. 5(1)(b))**: PII detected in transit is
  used solely to produce a masked replacement and is held in the
  screening service's memory for the duration of one request.

## 3. Risk assessment

| Risk | Likelihood | Severity | Net | Mitigation |
|---|---|---|---|---|
| PII leaks to LLM provider despite masking (false-negative in detector) | Medium | Medium | Medium | Detection models are tuned and evaluated in the desktop app's own evaluation suite; user can configure stricter detection thresholds; the extension fails closed on anything short of a clean verdict |
| Local port-squatter receives PII | Low | High | Low | The extension exposes no local network listener, and PII does not travel over HTTP: it relays only to a same-user native-messaging host over a `0600` UDS. It does make one HTTP call — a `{ browser, version }` presence beacon to `127.0.0.1:18795`, no Personal Data, response never read (`SECURITY.md` A2). Corrected 2026-08-21: the cell previously said "makes no HTTP calls", which overshot in the other direction |
| Compromised dependency injects code into the masking path | Low | High | Medium | Zero JS runtime deps; the native host is Rust with a `Cargo.lock`-pinned graph and tag-pinned Sonomos crates (`SECURITY.md` A4). `[restated 2026-09-01]` — Trivy, dependency-review and SBOM generation were manual-dispatch-only and gated nothing; all three now run automatically (Trivy on push and pull request, dependency-review on pull request, SBOM on push and monthly). **No run has completed in this repository**, so the dependency picture is unexamined by tooling rather than clean — the mitigation above rests on there being nothing to examine, not on a scan result. One check does now gate this path mechanically: `quality.yml::payload-audit` fails the build if the shipped payload gains `eval`, `new Function`, a remote dynamic `import()`, or any non-loopback endpoint, which is the shape a dependency compromise would have to take to reach the masking path |
| Tampered native-messaging manifest hijacks the host | Low | High | Medium | **Unmitigated** — nothing re-verifies the native-messaging manifest after the Locke desktop app's installer writes it (`SECURITY.md` A3). Requires write access to the user's own home directory |
| Audit log leaks user activity to a different OS user | Very Low | Low | Very Low | Audit log lives in `chrome.storage.local`, mode-protected by the browser profile directory; shape-only, no PII content |
| Sonomos infrastructure exposes customer data | Negligible | High | Negligible | Sonomos has no data plane for product PII — it never leaves the customer endpoint |

The architecture's loopback-only constraint (`SECURITY.md` A1)
limits the universe of failure modes that can produce a Sonomos-
caused breach. Most of the above risks are user-endpoint risks the
extension *reduces* relative to a baseline of "user types PII into
ChatGPT directly."

## 4. Consultation

- **Internal stakeholders**: engineering (Sonomos), security review
  (Sonomos), legal review (see `TODO.md`).
- **External**: customer DPOs as required; this DPIA template is
  designed to be completed by the deploying organisation rather
  than by Sonomos.

## 5. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Customer Data Protection Officer | | | |
| Customer Information Security Officer | | | |
| Sonomos legal review | | | (template only — replace with executed sign-off) |

---

**See also:**
- `SECURITY.md` — threat model
- `docs/architecture/DATA-FLOW.md` — per-hop PII visibility
- `docs/legal/DPA-template.md` — Article 28 processor agreement
- `docs/legal/RETENTION.md` — storage-limitation evidence
- `docs/legal/SUB-PROCESSORS.md` — Sonomos's sub-processor declaration
