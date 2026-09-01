# Control catalog

ISO 27001-style mapping of security controls to where they're
implemented. Auditors reading this should be able to point at any
common control area and find the implementing artifact in this
repo.

For ASVS-specific mappings, see
[`ASVS-MAPPING.md`](ASVS-MAPPING.md). This catalog is broader —
covering process and operational controls in addition to
application security controls.

> **How to read the evidence column, 2026-09-01.** Rows in this catalog
> cite `.github/workflows/*.yml` jobs as the implementing artifact for
> loopback pinning, content-script scoping, SAST, secret scanning, SCA,
> SBOM, provenance, signing, reproducible builds and Scorecard
> monitoring. Until now all nine workflows were `workflow_dispatch`-only
> and those pointers described intent rather than operation. **Every one
> of them now carries real triggers** — `push` to `main` and/or
> `pull_request` for `ci.yml`, `codeql.yml`, `semgrep.yml`,
> `gitleaks.yml`, `quality.yml`, `release.yml` and
> `dependency-review.yml`; weekly schedules on `codeql.yml`,
> `semgrep.yml`, `gitleaks.yml` and `scorecard.yml`; monthly on
> `sbom.yml`.
>
> Rows below therefore use three markers, and the distinction between
> the last two is the whole point:
>
> - **GATES** — the control fails a job when violated, and the row names
>   what enforces it and what proves the check bites. This is the only
>   marker that means "implemented".
> - **ENABLED, NO RUN YET** — the workflow will run from the first push,
>   but **this repository is newly public and no run has completed
>   here**, so there is no finding, no clean result and nothing to cite.
>   Not creditable as an operating control.
> - **NOT YET EXERCISED** — the recipe exists and its trigger is live,
>   but the event it depends on (a published release, for signing and
>   provenance) has not happened.
>
> Earlier revisions carried a run history — per-workflow run counts,
> pass/fail records and clean baselines. Those runs happened in the
> private repository this code was developed in, and a reader here
> cannot open them, so citing them as evidence would be misleading. They
> have been removed rather than restated. Where a row still depends on something outside CI, it names
> it: `scripts/preflight.mjs` and its libraries, invoked by the local
> `scripts/hooks/pre-push` git hook, which any contributor can bypass
> with `git push --no-verify`. See
> [`RELEASE-POLICY.md`](RELEASE-POLICY.md) for the enforcement status of
> the pipeline as a whole.
>
> **A new `quality.yml` (2026-09-01) adds seven jobs**, and two of them
> convert long-standing assertions in this catalog into gates:
> `payload-audit` (loopback-only egress and no dynamic code, over the
> staged payload) and `reproducible-build` (two builds compared byte for
> byte). The others are `actions-pinned`, `generated-drift`,
> `permission-diff`, `package-smoke` and `amo-lint`.
>
> **`release.yml` runs on push to `main`** and publishes to the three
> stores when `manifest.json`'s version differs from the previous
> commit's, with **no human approval step** — see
> [`docs/store/AUTOMATED-RELEASE.md`](../store/AUTOMATED-RELEASE.md) and
> [`RELEASE-POLICY.md`](RELEASE-POLICY.md). **No release has been
> published through it**, which is why the signing, provenance and SBOM
> rows have not moved.
>
> **Correction, 2026-08-31 — two changes affect rows below.**
>
> 1. **The native messaging host is not part of this repository.** It is
>    built and installed by the Locke desktop app. Rows that cited a
>    host source path as their evidence were citing a file no reader of
>    this repository can open. Each such row has been re-pointed at
>    in-repo evidence where the control still holds here, or marked
>    **out of scope for this repository** where the control genuinely
>    lived in the host. None has been deleted, and none has been left
>    "Met" on evidence that cannot be followed.
> 2. **The two-person release rule has been withdrawn.** Publication is
>    now automatic on merge to `main`, with no human approval step
>    (`RELEASE-POLICY.md`). The "Two-person release" row below no longer
>    claims it.

## Access control

| Control | Implementation | Evidence |
|---|---|---|
| Loopback-only network surface | manifest pin + packager/preflight tripwire + **payload audit in CI** | **GATES `[upgraded 2026-09-01]`.** Two layers. The manifest layer: `manifest.json::host_permissions`, with `scripts/store-build.mjs::validate` rejecting any non-loopback entry in the staged manifest, blocking the zip and the push — reached by `npm run validate`, `npm run package` and `scripts/preflight.mjs`, covered by `tests/store-build.test.js`. The code layer, new and the reason this row moved: `scripts/audit-payload.mjs` walks the **staged** payload and fails on any absolute URL that is not `http://127.0.0.1`, `http://localhost` or the `https://sonomos.ai/` link the popup opens in a tab; an unrecognised URL fails closed. `quality.yml::payload-audit` runs it on both store payloads on every push and pull request, and `tests/audit-payload.test.js` (14 tests) proves it catches an exfiltration endpoint, a lookalike of the allowed link, and a URL hidden in a template literal. Until 2026-09-01 the only server-side check was a `ci.yml` assertion that never ran, leaving the manifest pin and the bypassable pre-push hook as the whole control |
| Capture channel is not a network channel | native messaging (stdio) → the same-user native host → the Locke desktop app over a user-only `0600` UDS | `manifest.json::host_permissions` (loopback only) and `manifest.json::content_security_policy` (`connect-src`, one loopback origin), `background/service-worker.js` (the capture path uses `sendNativeMessage`, never `fetch`), `docs/architecture/DATA-FLOW.md`, `SECURITY.md` A1. **The extension half is verifiable here; the host half is not** — the host's source is not in this repository, so what happens after the stdio frame leaves the browser is asserted from here rather than evidenced (corrected 2026-08-31, which is when the host source path came out of this cell). Corrected 2026-08-21: this row read "Authenticated daemon channel / per-install HMAC handshake / `content/content-script.js::probeDaemon`". No such function, no such handshake, no such daemon; they retired in the 2026-06 mesh rewrite |
| Caller identity on the native-messaging channel | `allowed_origins` in the native-messaging host manifest; extension IDs are browser-derived and cannot be forged | **OUT OF SCOPE for this repository (2026-08-31).** The control is real and browser-enforced, but everything implementing it — the host manifest, the installer that writes `allowed_origins`, the remembered-ID store — ships with the Locke desktop app and is not in this repository, so the evidence has to be produced there. What is checkable here is only the extension's end of the pin: `shared/constants.js::NATIVE_HOST` (`tests/constants.test.js`). `SECURITY.md` A3, including its unmitigated gap: nothing re-verifies the manifest after installation |
| Token storage | none — the extension holds no secret | corrected 2026-08-21: the session-cached auth token and its `TOKEN_TTL_MS` no longer exist (`docs/legal/RETENTION.md`) |
| Managed-policy isolation | `chrome.storage.managed` only readable by extension | `managed-schema.json`, `background/service-worker.js::getManagedSettings` |
| Native-messaging host pinning | one pinned constant on the extension side; the cross-check is not possible here | **OUT OF SCOPE for this repository (2026-08-31).** The check compared `shared/constants.js::NATIVE_HOST` against the host's manifest templates, which are not in this repository — so the comparison cannot be made from here. `scripts/preflight.mjs` no longer offers a `native-host` check and records why in a comment where it used to sit. What remains verifiable here is the single pinned constant `shared/constants.js::NATIVE_HOST`, asserted by `tests/constants.test.js`: a declaration, not a cross-check |

## Cryptographic controls

**Corrected 2026-08-21: the extension performs no cryptography.** Every
row that used to sit here (`importHmacKey`, `hexEqualsConstantTime`,
`randomNonceHex`) named a function in `content/content-script.js` that
no longer exists — they implemented the retired architecture's HMAC
handshake and retired with it. The "roadmap" row pointed at a design
document this repo has never contained, for a plan to encrypt bodies
on a loopback channel that no longer carries them.

| Control | Implementation | Evidence |
|---|---|---|
| No cryptography in the extension | The transport is confidential by construction, not by cipher: a `0600` UDS between two same-user processes | `docs/architecture/DATA-FLOW.md`, `SECURITY.md` A1 |
| No homemade crypto | Vacuously — there is none of any kind | `EXPORT_CONTROL_NOTICE.md` |

## Supply-chain controls

| Control | Implementation | Evidence |
|---|---|---|
| Action pinning | Every `uses:` SHA-pinned with a version comment, enforced by a job | **GATES `[upgraded 2026-09-01]`.** `quality.yml::actions-pinned` fails the run if any `uses:` in `.github/workflows/` is not a 40-character commit SHA. Verified locally across all nine workflow files: 51 action references, all pinned. Until now this was a review convention checked by eye |
| Zero-dependency posture | `package.json` declares empty `dependencies` and `devDependencies`; the extension ships no third-party runtime code | `package.json::_comment` (SECURITY.md A4); `package-lock.json` declares no third-party package. Corrected 2026-08-31: this cell also cited the native messaging host's lockfile. That host is not in this repository, so its dependency graph cannot be evidenced from here; the claim is withdrawn rather than restated, and this row now covers the extension only |
| Dependency vulnerability scanning | Trivy (push, PR) + dependency-review (PR) | **ENABLED, NO RUN YET `[2026-09-01]`.** `.github/workflows/ci.yml`'s Trivy job runs on every push to `main` and every pull request; `.github/workflows/dependency-review.yml` runs on `pull_request`, and dependency review is available on public repositories, which is the constraint that previously defeated it. Both were `workflow_dispatch`-only until now, and no run has completed in this repository, so there is no scan result to cite. The exposure is structurally small regardless — see the zero-dependency row above |
| Secret scanning | Gitleaks (history, push/PR/weekly) + Trivy (working tree) | **ENABLED, NO RUN YET `[2026-09-01]`.** `.github/workflows/gitleaks.yml` runs on `push`, `pull_request` and weekly; `ci.yml`'s Trivy job covers the working tree on push and PR. Both were dispatch-only until now and no run has completed here. The load-bearing mitigation today is structural, not a scan: release credentials never enter the working tree (`scripts/lib/creds.mjs` reads `~/.config/sonomos/release.env`) and publisher output is redacted (`creds.mjs::redact`). Note that automatic publishing puts store credentials in repository Actions secrets — a different exposure, tracked at `RISK-REGISTER.md` R-04 |
| SBOM | CycloneDX + SPDX per release | **NOT YET EXERCISED `[2026-09-01]`.** `.github/workflows/sbom.yml` now runs on push to `main` and monthly, and `release.yml` carries CycloneDX and SPDX steps. No run has completed in this repository, and — the part that keeps this row open — **no release has been published, so no SBOM is bound to any version anyone can download**. Generation is wired; publication is not evidenced |
| Build provenance | SLSA build provenance attestation | **NOT YET EXERCISED `[2026-09-01]`.** `.github/workflows/release.yml::SLSA build provenance attestation` now runs on push to `main`, but no release has been published through it, so every artifact shipped to date carries no attestation |
| Reproducible builds | fixed timestamps + sorted entries; `SOURCE_DATE_EPOCH` for release rebuilds; **two-build comparison in CI** | **GATES `[upgraded 2026-09-01]`.** The mechanism needs no CI and no environment variable: `scripts/zip.mjs` (deterministic writer — fixed DOS stamp, fixed deflate level, POSIX separators), `scripts/store-build.mjs::entries` (sorts the payload before it is zipped), `scripts/package.mjs`. `SOURCE_DATE_EPOCH` is honoured only when set, and exists so `release.yml::Build extension zip (reproducible)` can pin mtimes to the release commit before calling `npm run package`. What changed: the property used to be an assertion about that mechanism. `quality.yml::reproducible-build` now builds twice under a fixed `SOURCE_DATE_EPOCH` on every push and pull request and **fails unless the two zips are byte-identical**, so a change that breaks determinism cannot merge unnoticed. Independently, `LICENSE` (PolyForm Strict 1.0.0) permits noncommercial use, so a reviewer may rebuild and check the bytes without our cooperation |
| Release signing | Sigstore keyless (OIDC) | **NOT YET EXERCISED `[2026-09-01]`.** `.github/workflows/release.yml::Sign artifacts` now runs on push to `main`, but nothing has been published through it; artifacts shipped to date are unsigned by us (the stores sign their own distributions) |
| Store submission integrity | One code path for all three stores; preflight gates before a byte is uploaded; secrets redacted from logs and report | `scripts/publish.mjs`, `scripts/preflight.mjs`, `docs/store/RELEASE-PIPELINE.md` |

## Application security controls

| Control | Implementation | Evidence |
|---|---|---|
| Static analysis (SAST) | Semgrep + CodeQL | **ENABLED, NO RUN YET `[2026-09-01]`.** `.github/workflows/semgrep.yml` and `.github/workflows/codeql.yml` run on `push` to `main`, on `pull_request` and weekly; both were dispatch-only until now. No run has completed in this repository, so there is no finding and no clean result. CodeQL's SARIF upload previously needed GitHub Advanced Security, which is available on public repositories at no cost — expected to work here, to be confirmed by the first run rather than by this cell |
| Dynamic-code and egress audit of the shipped payload | `scripts/audit-payload.mjs`, run over the staged payload | **GATES `[added 2026-09-01]`.** Distinct from SAST: not a rule engine over the repository but a hard check over exactly the bytes that ship. Fails on `eval(`, `new Function(`, a dynamic `import()` of a remote URL, `document.write(`, `innerHTML` built by concatenation, and any absolute URL outside the loopback/product-link allowlist. `quality.yml::payload-audit` runs it on both store payloads on every push and pull request; `tests/audit-payload.test.js` covers all 14 cases including the negative ones |
| Strict CSP | extension-pages CSP `default-src 'none'` | `manifest.json::content_security_policy` |
| Anti-clickjacking | `frame-ancestors 'none'` + closed shadow DOM toast | `manifest.json`, `content/content-script.js::ensurePromptRoot` |
| Input validation | centralised in the service worker; the host and the desktop app validate again downstream | `content/content-script.js` (rejects malformed capture messages), `background/service-worker.js`'s `runtime.onMessage` listener (rejects any untrusted sender via `isTrustedSender`, matches on exact `shared/constants.js::MSG` types and requires `requestB64` to be a string; anything else falls through unhandled). Corrected 2026-08-31: a host-side frame cap and message-type rejection used to be cited here to a host source path. That validation still happens — it is simply not evidenced from this repository, and nothing in the extension's own fail-closed posture depends on it. Corrected 2026-08-21: the cited `isLoopbackUrl` and the retired Python host's handler are both gone (`daemonUrl` left `MANAGED_KEYS` in the 2026-06 rewrite, taking its validator with it) |
| Output encoding | `textContent` everywhere in popup | `popup/popup.js` |
| Limited content-script scope | fixed named-host list, no `<all_urls>` on MAIN | `manifest.json::content_scripts.matches`, `scripts/store-build.mjs::validate` (rejects a wildcard host on *any* content script — `<all_urls>`, `*://*/*`, `https://*/*` and a wildcard over a single label such as `*.com` — at build and at push, naming the MAIN world in the failure), covered by `tests/store-build.test.js`. `[updated 2026-09-01]` — `ci.yml::No content_script uses <all_urls> in MAIN world` re-asserts it and now runs on every push and pull request rather than on manual dispatch, though no run has completed here yet. Separately, `quality.yml::permission-diff` renders any change to `permissions`, `host_permissions` or content-script matches into the pull-request summary; it is non-failing by design, so it informs review rather than gating it |

## Operational controls

| Control | Implementation | Evidence |
|---|---|---|
| Audit logging | 100-entry ring buffer, 7 audited kinds | `background/service-worker.js::appendAudit`, `docs/security/PERMISSIONS.md` |
| Audit log export | Popup → "Audit log" link | `popup/popup.js::exportAuditLog` |
| Health monitoring | Periodic native-messaging round trip that asks the host whether it can reach the Locke desktop app (30 s, backing off to 5 min) | `background/service-worker.js::runCheck`, `shared/health-client.js` |
| Presence signalling | Fixed 30 s `{ browser, version }` beacon to `127.0.0.1:18795`, fire-and-forget, response never read. Deliberately not on the health alarm so its backoff cannot silence "I am installed" | `background/service-worker.js::sendPresenceBeacon`, `shared/constants.js::PRESENCE_URL` |
| Fail-closed default | User-prompted "send unmasked / cancel" | `content/content-script.js::handleMaskRequest`, `SECURITY.md` |
| Vulnerability disclosure | Documented process + 48h ack / 30d fix | `SECURITY.md`, `docs/security/security.txt`, `docs/security/BUG-BOUNTY.md` |

## Process controls

| Control | Implementation | Evidence |
|---|---|---|
| Change management | PR review required; branch protection on `main` | `CONTRIBUTING.md`, `CODEOWNERS` — **branch protection is not configured** (2026-08-12); the review requirement is a process commitment, not a server-side rule |
| ~~Two-person release~~ | **WITHDRAWN 2026-08-31 — this control does not exist.** Publication is automatic on merge to `main` with no human approval step, so nothing separates authorising a change from shipping it: merging is shipping | `docs/security/RELEASE-POLICY.md` ("How a release publishes"), `RISK-REGISTER.md` R-15. The only review before a release reaches users is pull-request review under `CODEOWNERS`, and branch protection is not configured, so that review is a process commitment rather than a rule. There is no compensating control; do not cite one |
| Code review on critical paths | `CODEOWNERS` for security-relevant files | `CODEOWNERS` |
| Risk register maintenance | Quarterly review | `docs/security/RISK-REGISTER.md`, `docs/security/MANAGEMENT-REVIEW.md` |
| Threat-model maintenance | Reviewed each release | `SECURITY.md`, `docs/security/MANAGEMENT-REVIEW.md` |
| ASVS coverage | L1/L2 mapping kept current | `docs/security/ASVS-MAPPING.md` |
| Posture monitoring | OpenSSF Scorecard, weekly | **ENABLED, NO RUN YET, AND STILL NOT PUBLISHED `[2026-09-01]`.** `.github/workflows/scorecard.yml` runs weekly, on push to `main` and on `branch_protection_rule`, having been dispatch-only until now. Two things keep this from being posture monitoring: no run has completed in this repository, **and `publish_results` is still `false`** in that file, so even once it runs the score goes to a SARIF artifact rather than to the public OpenSSF dataset. Turning it on is a deliberate decision that has not been taken. The README carries no Scorecard badge — nor CII or SLSA — because each would assert a rating with no run behind it |

## Legal and compliance controls

| Control | Implementation | Evidence | Status |
|---|---|---|---|
| Data Processing Addendum | Article 28-shaped template | `docs/legal/DPA-template.md` | DRAFT — pending legal review |
| Data Protection Impact Assessment | Article 35-shaped template | `docs/legal/DPIA-template.md` | DRAFT — pending legal review |
| Sub-processor declaration | Public list at sonomos.ai/sub-processors | `docs/legal/SUB-PROCESSORS.md` | DRAFT — pending legal review |
| Data retention policy | Per-item lifetime + deletion triggers | `docs/legal/RETENTION.md` | DRAFT — pending legal review |
| Export-control classification | **No control here `[corrected 2026-08-21]`.** This row claimed "ECCN 5D002, TSU notification status documented". No ECCN has been determined for any Sonomos software, and the 5D002 assertion has been withdrawn as unevidenced; no prior filing can be evidenced either. What the notice documents is the crypto inventory (the extension implements and invokes none), not a classification | `EXPORT_CONTROL_NOTICE.md` | **UNCLASSIFIED — pending counsel.** `RISK-REGISTER.md` R-20 |
| End-User Licence Agreement | Hosted at sonomos.ai/eula, linked from popup | `popup/popup.html`, `https://sonomos.ai/eula` | live |
| Privacy policy | Extension-specific policy at sonomos.ai/locke/privacy, linked from popup and submitted to all three stores (the company-wide policy at sonomos.ai/privacy does not cover the extension) | `popup/popup.html`, `https://sonomos.ai/locke/privacy` | **met** — verified returning HTTP 200 on 2026-09-01 |

## Coverage gaps (open)

These are tracked in [`TODO.md`](../../TODO.md):

- **Native-messaging manifest integrity (added 2026-08-21).** Nothing
  re-verifies `ai.sonomos.desktop.json` after the Locke desktop app's
  installer writes it. `SECURITY.md` A3 / `RISK-REGISTER.md` R-05,
  unmitigated. Any fix belongs with the host, not with this
  repository.
  (This replaces the former body-encryption and "active token
  rotation" entries: both were gaps in the retired daemon's loopback
  channel, which no longer carries request bodies or tokens.)
- ~~LICENSE files (currently absent)~~ — closed 2026-08-31: `LICENSE` is
  present. It is **PolyForm Strict 1.0.0** — noncommercial use is permitted;
  distribution and modification are not. Readers may read and run the source
  and nothing else. This is not an open-source project, and practices
  in this catalog that assume outside participation are constrained by
  it — external contribution and redistribution are not permitted. One
  that is **not** constrained, and matters here: a noncommercial
  reviewer may run and rebuild the software, so the reproducible-build
  claim is independently checkable. See `RELEASE-POLICY.md`,
  "Reproducible builds".
- **Independent security assurance (corrected 2026-08-21).** This entry
  read "SOC 2 attestation (in process)". Nothing is in process: no SOC 2
  engagement has been started, no auditor has been selected and no
  observation window has opened. Every control in this catalog is
  self-asserted and evidenced by a file in this repository; none of it
  has been examined by a third party. `RISK-REGISTER.md` R-19.
- Live bug-bounty program (scope defined, listing pending)
- ~~Two-person release in operational practice~~ — **not an open gap;
  a removed control.** The rule was withdrawn 2026-08-31. What is open
  in its place: branch protection on `main` requiring a non-author
  CODEOWNER approval, because merging now publishes.
- Trademark policy
- ~~**CI/CD activation (added 2026-08-12)**~~ — **closed 2026-09-01.**
  All nine workflows now carry real triggers, so SAST, secret scanning,
  SCA, SBOM generation and Scorecard are wired to `push`,
  `pull_request` and schedules rather than to a manual button. What
  replaces this gap is narrower and still open: **no run has completed
  in this repository**, so none of those tools has produced a result
  here yet, and signing and provenance remain unexercised because no
  release has been published. The first push settles the first half; a
  published release settles the second.
- **First-run confirmation (added 2026-09-01).** Every "enabled, no run
  yet" row above becomes citable, or becomes a defect to fix, on the
  first completed run. Nobody should read a green trigger as a green
  result until then. Tracked as an action item in
  `MANAGEMENT-REVIEW.md`.
- **Branch protection on `main` (added 2026-08-12; escalated
  2026-08-31).** Not configured, so no check in this catalog is
  enforced server-side — and since a push to `main` now publishes to the
  Chrome Web Store, Edge Add-ons and AMO, an unprotected `main` is an
  unprotected publish button. `RISK-REGISTER.md` R-15.
