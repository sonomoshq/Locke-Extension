# Risk register

A risk register for the Sonomos Desktop Connector browser extension,
laid out in the style of ISO 27001 and SOC 2. Each risk is rated on a
1–5 scale for likelihood and impact; the net score is
`likelihood × impact`. Mitigations cite the implementing artifact
(file or workflow).

Sonomos holds neither certification and has started no engagement for
either; the resemblance is a borrowed format, not a borrowed
assurance. Every rating and every mitigation below is self-asserted
and has never been examined by a third party — R-19 is that gap,
carried as a risk rather than left implicit. R-20 does the same for
export classification.

This register is reviewed quarterly per
[`docs/security/MANAGEMENT-REVIEW.md`](MANAGEMENT-REVIEW.md). The
next review date is the first quarter boundary after the most
recent commit to this file.

| ID | Risk | Likelihood | Impact | Net | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R-01 | Outbound exfiltration to non-Sonomos host | 1 | 5 | 5 | `manifest.json::host_permissions` is loopback-only (`http://127.0.0.1/*` — all loopback ports; match patterns cannot carry a port). The manifest check is `scripts/store-build.mjs::validate` via `npm run validate`, `scripts/package.mjs` and the `preflight.mjs` pre-push hook; `ci.yml::Host permissions are loopback-only` re-asserts it and now runs on every push and pull request rather than on manual dispatch. **Mitigation strengthened 2026-09-01**: the manifest checks bound what the extension may *request*, not what the code contains, and nothing checked the code. `quality.yml::payload-audit` now runs `scripts/audit-payload.mjs` over the **staged payload** on every push and fails on any absolute URL that is not loopback or the `https://sonomos.ai/` product link — so an exfiltration endpoint added in a source file, not just in the manifest, fails the build. `tests/audit-payload.test.js` (14 tests) proves the check bites. Caveat that keeps this from being closed: no CI run has completed in this repository yet, and branch protection does not require the job, so it fails a run without blocking a merge. **None of these asserts a port** — the port bound is the CSP `connect-src http://127.0.0.1:18795` (`SECURITY.md` A1) | Eng |
| R-02 | Port-squatter on `127.0.0.1:18795` receives the presence beacon | 2 | 1 | 2 | **Rerated 2026-08-21.** The old entry priced a plaintext-PII leak to a port-squatter and credited an HMAC handshake — both belonged to a retired architecture. PII does not travel over loopback at all (native messaging → `0600` UDS), so the only thing on that port is a `{ browser, version }` beacon whose response the extension never reads. **No mitigation and none warranted** (`SECURITY.md` A2) | Eng |
| R-03 | Compromised dependency injects code | 1 | 5 | 5 | Zero JS deps; Trivy + dependency-review-action; SHA-pinned Actions (`SECURITY.md` A4) | Eng |
| R-04 | Compromised CI publishes poisoned release | 1 | 5 | 5 | **Rerated 2026-08-21 — mitigation was overstated.** The old entry credited "Sigstore keyless signing + SLSA L3 provenance" as live controls. `release.yml` holds both steps and no release has been published through it (no tag, no GitHub release), so neither has ever mitigated anything. Note 2026-08-31: that workflow runs on push to `main` — but nothing has shipped through it yet, so this stays true. What actually holds today: the reproducible build (`scripts/zip.mjs` + `store-build.mjs::entries`), which as of 2026-09-01 is verified rather than asserted — `quality.yml::reproducible-build` builds twice under a fixed `SOURCE_DATE_EPOCH` and fails unless the zips are byte-identical, and `LICENSE` (PolyForm Strict 1.0.0) permits noncommercial use, so an outside reviewer may rebuild and compare bytes without our cooperation. That is the control that would let someone *detect* a poisoned release. Also holding: per-job least-privilege workflow permissions, and `quality.yml::actions-pinned`, which fails the run if any `uses:` is not a 40-character SHA — closing the "compromised action tag" path into the release job. **Restated 2026-08-31 — the second half of this mitigation is withdrawn.** It used to read "CI cannot publish a poisoned release because CI does not publish releases — a human runs the local pre-push gate", and the likelihood of 1 rested on that. It is no longer true: publication is automatic from `main`, driven by repository secrets, with no human approval step (`docs/security/RELEASE-POLICY.md`). Anything that can merge to `main`, or that can run as the release workflow, can publish. **The likelihood has not been re-scored** — that is an owner decision, not a documentation one (`SECURITY.md` A5) | Eng |
| R-05 | Tampered native-messaging manifest hijacks the host | 2 | 4 | 8 | **UNMITIGATED, corrected 2026-08-21.** The cited `selfcheck.rs` does not exist in this architecture; nothing re-verifies the native-messaging manifest after the Locke desktop app's installer writes it. What does hold is browser-enforced: `allowed_origins` bounds which extension IDs may connect, and an ID cannot be forged (`SECURITY.md` A3) | Eng |
| R-06 | Local same-user process reaches the desktop app's sockets directly | 5 | 2 | 10 | No token exists to steal (that was the retired daemon's). Those UDS are per-user mode `0600`; a *different* OS user cannot open them. Same-user access is accepted, out-of-scope for extension defenses (`SECURITY.md` A6) | Customer endpoint |
| R-07 | MAIN-world shim runs on attacker-controlled page | 1 | 4 | 4 | `manifest.json::content_scripts.matches` scoped to the 24 catalog hosts (48 patterns — bare + `*.` per host; the count read "17" until 2026-08-21 and had drifted); `store-build.mjs::validate` rejects a wildcard host at build and at push | Eng |
| R-08 | In-page toast spoofed by hostile site | 1 | 3 | 3 | Toast in closed shadow DOM (`content/content-script.js::ensurePromptRoot`); CSP `frame-ancestors 'none'` on extension pages | Eng |
| R-09 | ~~Auth token leaks via long-lived cache~~ | — | — | — | **RETIRED 2026-08-21.** There is no auth token. The cited `TOKEN_TTL_MS` and the `chrome.storage.session` token cache went with the retired daemon in the 2026-06 mesh rewrite; nothing in the extension holds a secret today | Eng |
| R-10 | Adapter coverage gap masks request as a no-op | 3 | 3 | 9 | Drift canary in `content/shim.js`; `coverage-gap` audit-log entry; safe-mode prompts user on repeated drift | Eng |
| R-11 | False-negative in PII detector leaks PII to LLM provider | 3 | 4 | 12 | Detection happens in the desktop app and is evaluated by its own suite; user can configure stricter detection. The extension applies verdicts and cannot compensate for a miss | Eng |
| R-12 | Audit log fills with noise, important events lost | 2 | 2 | 4 | `AUDITED_KINDS` whitelist limits logged events to 7 high-signal kinds (`background/service-worker.js`) | Eng |
| R-13 | ~~Managed policy attacker pushes a malicious `daemonUrl`~~ | — | — | — | **RETIRED 2026-08-21.** `daemonUrl` was removed from `MANAGED_KEYS` in the 2026-06 mesh rewrite and `isLoopbackUrl` no longer exists — there is no URL for a policy to mis-point. Capture reaches the desktop app over native messaging and a UDS, neither of which a managed policy can redirect (`shared/constants.js::MANAGED_KEYS`) | Eng |
| R-14 | Residual reputational damage from unfixed-vuln headline | 2 | 4 | 8 | 48h ack / 30d fix SLA in `SECURITY.md`; bug-bounty scope at `docs/security/BUG-BOUNTY.md` | Sec/Comms |
| R-15 | One-person release process bypasses review | 3 | 4 | 12 | **Restated 2026-08-31 — the mitigation named here no longer exists.** The two-person release rule was withdrawn when publication moved to automatic-on-merge: a merge to `main` publishes, so merging *is* releasing and there is no approval step after it. What remains is pull-request review under `CODEOWNERS`, which branch protection does not enforce, so a single account with write access can still ship. **The rating has not been re-scored** — it needs the risk owner, and it is very likely too low (`docs/security/RELEASE-POLICY.md`) | Eng/Sec |
| R-16 | Vendor-side breach exposes customer PII | 1 | 5 | 5 | No customer PII on Sonomos infrastructure (loopback architecture); `SECURITY.md` A1 | Eng |
| R-17 | Customer DPA blocked by missing legal docs | 4 | 3 | 12 | DPA template (`docs/legal/DPA-template.md`), DPIA template, sub-processor list, retention policy in repo. Drafts pending legal review (see `TODO.md`) | Legal |
| R-18 | Extension store rejects listing on submission | 3 | 3 | 9 | `docs/security/PERMISSIONS.md` pre-answers store-submission justifications; deferred per `TODO.md` until product is more built out | Product |
| R-19 | Enterprise buyer requires third-party security assurance we do not have | 4 | 4 | 16 | **UNMITIGATED, added 2026-08-21.** Sonomos holds no SOC 2 report, no ISO 27001 certificate and no independent penetration test, and **no engagement for any of them has been started** — no auditor selected, no gap assessment, no observation window, no date. Several documents used to describe SOC 2 as "in progress"/"in process"; that was never true and is corrected across `SUB-PROCESSORS.md`, `CONTROL-CATALOG.md`, `DPA-template.md`, `MANAGEMENT-REVIEW.md`, `HONEST.md` and `TODO.md`. What exists instead is self-assertion an auditor can check: this register, `CONTROL-CATALOG.md`, `docs/architecture/DATA-FLOW.md` and `SECURITY.md`, each naming the file that implements the control. The architecture reduces what a buyer must take on trust — no PII leaves the endpoint, so there is less for an attestation to cover — but it does not substitute for one, and a buyer with a hard policy requirement will not be satisfied. Not accepted, not mitigated; the only close-out is starting an engagement, which is a business decision no one has taken | Legal/Exec |
| R-20 | Software distributed with no export classification of record | 3 | 4 | 12 | **UNMITIGATED, added 2026-08-21.** `EXPORT_CONTROL_NOTICE.md` used to assert ECCN 5D002 and a TSU notification "filed on 2026-03-13" by the parent desktop product. Both are withdrawn: no classification record and no filing receipt exists on disk or in any repository, and no one can confirm the filing was made. Sonomos therefore has **no evidenced export determination or filing for any product**. The extension is the low-risk half — it implements and invokes no cryptography, verified by source read. The exposure is the **desktop product**, which does carry cryptographic implementations of its own and has never been analysed at all. If it is 5D002, a §742.15(b) self-classification report may already be overdue, and nothing in the release process gates on export status. Cannot be closed by engineering: it needs counsel to take a first determination | Legal/Exec |

## Heat map

Rebuilt 2026-08-21, then recomputed the same day when R-19 and R-20
were added. An earlier grid had entries filed under the wrong impact
column (R-17 sat at Impact 5 with a 4×3 score), so this is computed
from the likelihood and impact columns above rather than patched.

| | Impact 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| **Likelihood 5** | | R-06 (10) | | | |
| **4** | | | R-17 (12) | R-19 (16) | |
| **3** | | | R-10 (9), R-18 (9) | R-11 (12), R-15 (12), R-20 (12) | |
| **2** | R-02 (2) | R-12 (4) | | R-05 (8), R-14 (8) | |
| **1** | | | R-08 (3) | R-07 (4) | R-01 (5), R-03 (5), R-04 (5), R-16 (5) |

Retired: R-09, R-13.

R-19 enters at the top of the register. That is the honest consequence
of deleting an "in progress" that was doing mitigation work it had no
right to do: the risk it was covering did not go away when the claim
did, it simply became visible.

## Top risks (net ≥ 10)

| ID | Risk | Net | Trend since last review |
|---|---|---|---|
| R-19 | No third-party security assurance | 16 | New — the risk is not new, only its entry here |
| R-11 | False-negative PII detection | 12 | — |
| R-15 | One-person release | 12 | Mitigation withdrawn 2026-08-31 (two-person rule gone; merging now publishes). Score unchanged only because it has not been re-scored |
| R-17 | Missing legal-review sign-off | 12 | — |
| R-20 | No export classification of record | 12 | New — the risk is not new, only its entry here |
| R-06 | Local same-user process | 10 | — |

R-13 (managed-policy abuse, was 10) left this table by being retired,
not by being mitigated: the attack surface it named was deleted.

## Risk treatment summary

- **Accept**: R-06 (out of extension's control plane) and R-02 (a
  squatter learns browser family and version; nothing further).
- **Unmitigated and named**: R-05 — nothing verifies the
  native-messaging manifest after install. It is not accepted and not
  mitigated; it has no owner-side control today. R-19 — no independent
  attestation exists and none is being pursued; it cannot be closed by
  engineering work, only by a business decision to start an
  engagement. R-20 — no export classification of record for any
  Sonomos product, and no evidenced filing; it needs counsel, not
  code.
- **Mitigate**: all others — see Mitigation column.
- **Transfer**: none currently. Cyber-liability insurance status is
  a corporate-level question, not an engineering one.
- **Avoid**: none.

## Change log

Update this list when a risk is added, retired, or its rating
changes.

| Date | Change | Author |
|---|---|---|
| 2026-05-10 | Initial register | Eng |
| 2026-08-31 | Release-model change: publication became automatic on merge to `main`, with no human approval gate. R-04 and R-15 mitigations restated — both cited controls ("CI does not publish", the two-person rule) are withdrawn. Neither row was re-scored; both need the risk owner. R-05 evidence re-pointed away from a path that is not in this repository | Eng |
| 2026-08-21 | Migrated off the retired daemon architecture. R-01 restated (loopback grant is all ports; no tripwire asserts a port). R-02 rerated 8 → 2 (no PII on loopback). R-05 marked unmitigated (`selfcheck.rs` never existed here). R-06 restated (no token exists). R-07 host count corrected 17 → 24. R-09 and R-13 retired (auth token and `daemonUrl` both deleted in the 2026-06 mesh rewrite). R-11 eval path corrected. Heat map recomputed | Eng |
