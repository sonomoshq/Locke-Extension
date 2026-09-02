# OWASP ASVS L1/L2 mapping

How this extension addresses each applicable requirement of the
[OWASP Application Security Verification Standard][asvs] v5.0,
Levels 1 and 2. Vendor security questionnaires are usually
re-skinned ASVS — having this doc on hand cuts review time
substantially.

[asvs]: https://owasp.org/www-project-application-security-verification-standard/

Notation:
- **Met**: requirement is implemented; cell points to file:line(s).
- **N/A**: requirement does not apply to this product. Reason given.
- **Wired**: the control is enabled in this repository and will run on
  the events named in the cell, but **no run has completed here yet**,
  so there is no result to show. Not creditable as met.
- **Roadmap**: not yet met; tracked elsewhere.

> **How to read the status column, 2026-09-01.** This repository is
> newly public, and eight of the nine workflows in `.github/workflows/`
> now carry real triggers. `ci.yml`, `codeql.yml`, `semgrep.yml`,
> `gitleaks.yml` and `quality.yml` run on `push` to `main` and/or
> `pull_request`; `codeql.yml`, `semgrep.yml`, `gitleaks.yml` and
> `scorecard.yml` also run weekly and `sbom.yml` monthly;
> `dependency-review.yml` runs on `pull_request`. Previously all of them
> were `workflow_dispatch`-only. **`release.yml` still is, deliberately**
> (Sonomos #190): publishing to three stores must not be a side effect of
> a merge.
>
> **Wired is not the same as has run.** Nothing has run in this
> repository yet — there is no run history here to cite, and no scan
> result to report. Rows below therefore distinguish two situations:
>
> - a check **enforced by code** that fails the run — the loopback-only
>   property, reproducible builds, action pinning — can be **Met**, and
>   the cell names what enforces it and what proves the check bites;
> - a **scanner** whose findings nobody has seen yet is *enabled*, not
>   met. Those cells say "enabled on `push`/`pull_request` from the
>   first commit of this repository; no run has completed yet".
>
> Earlier revisions of this file carried a long correction history about
> workflow runs, with run counts and clean baselines. Those runs belong
> to the private repository this code was developed in. A reader here
> cannot open them, so citing them as evidence would be misleading, and
> that history has been dropped in favour of stating the present state
> of this repository plainly.
>
> A new `quality.yml` (2026-09-01) adds seven jobs, two of which convert
> assertions in this document into mechanical gates: `payload-audit`
> (`scripts/audit-payload.mjs` over the staged payload — see 11.1.1) and
> `reproducible-build` (builds twice and fails unless the zips are
> byte-identical — see 14.1.1). The others are `actions-pinned`,
> `generated-drift`, `permission-diff`, `package-smoke` and `amo-lint`.
>
> `release.yml` is `workflow_dispatch`-only (2026-09-01, Sonomos #190) and
> publishes to the three stores when a person dispatches it on `main` and
> this repository has no `v<version>` release tag for
> `manifest.json`'s version, with **no human approval step** — see
> [`docs/store/AUTOMATED-RELEASE.md`](../store/AUTOMATED-RELEASE.md) and
> `RELEASE-POLICY.md`. **No release has been published through it yet**,
> so nothing shipped to date is signed, attested or SBOM'd; that is why
> the signing, provenance and SBOM rows have not moved.
>
> Where a control is enforced by the local `scripts/hooks/pre-push` hook
> rather than by CI, the evidence says so — that hook is bypassable with
> `git push --no-verify`. Branch protection requiring these jobs is a
> separate, repository-settings question this document cannot assert;
> see `docs/security/RELEASE-POLICY.md`.
>
> **Correction, 2026-08-31.** Several rows below cited a source path
> inside the native messaging host as their evidence. That host is not
> part of this repository — it is built and installed by the Locke
> desktop app — so those citations could not be followed by anyone
> reading this repository. Each affected row (2.1.1, 2.3.1, 14.2.2) has
> been restated against evidence that exists in this repository, and
> each says plainly which part of the requirement is now out of scope
> for this repository. No row was deleted and no "Met" was left
> standing on a citation a reader cannot open.

## V1 — Encoding & Sanitization

| Req | Status | Evidence |
|---|---|---|
| 1.2.1 Verified architecture documentation exists | Met | `docs/architecture/DATA-FLOW.md`, `SECURITY.md` — `[corrected 2026-08-21]` the third entry named a design document this repo has never contained |
| 1.2.2 Trust boundaries defined | Met | `SECURITY.md` (A1/A2/A3 adversaries); `DATA-FLOW.md` per-hop PII table |
| 1.4.1 No untrusted markup interpreted | Met | `popup/popup.js` uses `textContent`/`replaceChildren`; `popup.html` has zero `innerHTML` callers; CSP `script-src 'self'` blocks injected code |
| 1.4.4 Output encoded for context | Met | All popup writes use `textContent`; toast UI assembles via DOM nodes inside a closed shadow root |

## V2 — Validation, Sanitization & Encoding

| Req | Status | Evidence |
|---|---|---|
| 2.1.1 Centralised validation | Met | `content/content-script.js` rejects malformed capture messages, and `background/service-worker.js`'s single `runtime.onMessage` listener is the one entry point into the extension: it drops any untrusted sender (`isTrustedSender`), matches on exact `shared/constants.js::MSG` types, and requires `requestB64` to be a string — anything else falls through unhandled. `[corrected 2026-08-31]` — this cell also cited the host's own rejection of unknown message types and over-cap frames. That still happens downstream, but the host is not part of this repository, so it is no longer offered as evidence here; the requirement is met by the extension's own single validation point. `[corrected 2026-08-21]` — the previously cited `isLoopbackUrl` and managed `daemonUrl` are both gone: `daemonUrl` left `MANAGED_KEYS` in the 2026-06 mesh rewrite, and the retired Python host it named was replaced by the Rust one |
| 2.1.2 Downstream validation enforced | Met | The desktop app parses and screens each captured request independently; the extension never assumes its own framing was accepted and treats anything short of a clean verdict as a block (`docs/architecture/DATA-FLOW.md`). `[corrected 2026-08-21]` — there is no daemon and no "mask request" |
| 2.2.1 Identifiers safely handled | Met | Adapter IDs are static literals in `content/shim.js`'s `ADAPTER_REGISTRY`; never user-controlled |
| 2.2.2 No code interpreted from input | Met | No `eval`, no `Function()`, no `setTimeout(string, …)` anywhere in the shipped source. `[upgraded 2026-09-01]` — this used to be maintained by review, because the CodeQL and Semgrep workflows cited here were dispatch-only. It is now enforced by code: `scripts/audit-payload.mjs` fails on `eval(`, `new Function(`, a dynamic `import()` of a remote URL, `document.write(` and `innerHTML` built by concatenation, over the **staged** payload rather than the repository, and `quality.yml::payload-audit` runs it on every push and pull request. `tests/audit-payload.test.js` includes a test per forbidden pattern, so the check is known to bite rather than merely to exist. CodeQL and Semgrep are enabled on `push`/`pull_request` and weekly from the first commit of this repository, but no run has completed yet and this row does not rest on them |
| 2.3.1 String input limits | Met (partially — see cell) | `[restated 2026-08-31]` — this row cited a 16 MiB native-messaging frame cap in the host's source. The host is not part of this repository, so that cap cannot be evidenced here and is withdrawn as evidence. What is verifiable here is the extension-side limit that does the same job earlier: `content/shim.js::MAX_BODY` (8 MiB) refuses to capture a larger body and **blocks** the request rather than sending it unscreened (`uncapturable-oversize`), and `content/shim.js::REDACT_REPLY_BODY_LIMIT` bounds a rebuilt reply against the browser's 1 MB native-messaging reply cap (`receipt-too-large`). Both are in `docs/architecture/DATA-FLOW.md`. The limit downstream of the browser is real but out of scope for this repository |

## V3 — Web Frontend Security

| Req | Status | Evidence |
|---|---|---|
| 3.1.1 Strong CSP on extension pages | Met | `manifest.json::content_security_policy.extension_pages = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http://127.0.0.1:18795; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"`. `[corrected 2026-08-21]` — the quoted string omitted `connect-src`, which is the directive doing the load-bearing work: `host_permissions` grants all loopback ports and this is what narrows egress to one origin (`SECURITY.md` A1). `tests/manifest.test.js` pins it |
| 3.1.2 No inline JS | Met | All popup logic in `popup/popup.js`; no `<script>` with inline content |
| 3.4.1 Anti-clickjacking | Met | Extension pages set `frame-ancestors 'none'` in CSP; in-page toast lives in a closed shadow DOM (`content/content-script.js::ensurePromptRoot`) so a hostile page can't restyle/observe/spoof |

## V6 — Authenticated Cryptography

`[corrected 2026-08-21]` — **the extension performs no cryptography.**
Every function this section used to cite (`importHmacKey`,
`hmacSha256Hex`, `sha256Bytes`, `hexEqualsConstantTime`) implemented the
retired architecture's HMAC handshake and no longer exists in
`content/content-script.js`. There is no auth token to store. The
"roadmap" row pointed at a design document this repo has never
contained.

| Req | Status | Evidence |
|---|---|---|
| 6.1.1 No custom crypto primitives | Met (vacuously) | No crypto of any kind in the extension — nothing hand-rolled because nothing at all |
| 6.2.x Strong / approved algorithms | N/A | No algorithm is selected because none is used |
| 6.4.1 Secrets storage | N/A | The extension holds no secret. Confidentiality of the capture channel comes from OS process and file permissions — a `0600` UDS between two same-user processes — not from a key (`SECURITY.md` A1) |
| 6.5.x Confidentiality of bodies | Met by transport | Bodies never traverse a network socket; native messaging (stdio) → `0600` UDS (`docs/architecture/DATA-FLOW.md`). The threat this row was a roadmap for — a loopback HTTP body a port-squatter could read — no longer exists |

## V7 — Session Management

| Req | Status | Evidence |
|---|---|---|
| 7.1.x | N/A | Extension has no user sessions of its own — it relies on the page's session to the AI provider, which Sonomos does not interpose |
| 7.2.x | N/A | `[corrected 2026-08-21]` — this row described `TOKEN_TTL_MS` / `PROBE_TTL_MS`, the retired daemon handshake's timers. Neither symbol exists; there is no token and no probe TTL to expire |

## V8 — Authorization

| Req | Status | Evidence |
|---|---|---|
| 8.x | N/A — no user roles | The extension has no concept of user roles. `[corrected 2026-08-21]` — authorization on the capture channel is not an HMAC handshake but the browser's own `allowed_origins` check on the native-messaging host manifest, which an attacker cannot satisfy by forging an extension ID (`SECURITY.md` A3) |

## V11 — Communications

| Req | Status | Evidence |
|---|---|---|
| 11.1.1 TLS for all transports | Met for outbound | Extension never makes a non-loopback HTTP call. `[upgraded 2026-09-01]` — until now this rested on two things a reviewer could bypass: `scripts/store-build.mjs::validate` (rejects any `host_permissions` entry that is not `127.0.0.1`/`localhost`, applied to the *staged* artifact by `npm run validate`, by `scripts/package.mjs` before it will emit a zip, and by `scripts/preflight.mjs` in the pre-push hook, which `--no-verify` skips), and manifest review. Both still hold, and a third check now gates every push: `quality.yml::payload-audit` runs `scripts/audit-payload.mjs` over the staged Chromium and Firefox payloads and **fails on any absolute URL** that is not `http://127.0.0.1`, `http://localhost` or the `https://sonomos.ai/` link the popup opens in a tab. It reads the staged payload, so documentation and tests cannot launder a violation, and an unrecognised URL fails closed rather than being ignored. `tests/audit-payload.test.js` (14 tests) proves it catches an exfiltration endpoint, a non-loopback host that merely looks internal, a URL hidden in a template literal, and a lookalike of the allowed product link. This is the row that changed from "maintained by review, not by a tool" to a mechanical control |
| 11.1.x Loopback HTTP justified | Met | `[corrected 2026-08-21]` — the extension makes exactly one loopback HTTP call and it carries no user data: a `{ browser, version }` presence beacon to `127.0.0.1:18795`, fire-and-forget, response never read (`background/service-worker.js::sendPresenceBeacon`). Captured request bodies do not use HTTP at all. Nothing is authenticated because nothing on that channel is worth authenticating (`SECURITY.md` A2) |

## V12 — Malicious Code

| Req | Status | Evidence |
|---|---|---|
| 12.1.1 SAST in CI | Wired | `[was Roadmap; upgraded 2026-09-01]` — `semgrep.yml` and `codeql.yml` were `workflow_dispatch`-only, so no SAST gated anything. Both now run on `push` to `main`, on `pull_request` against `main`, and weekly on a schedule, from the first commit of this repository. **No run has completed yet**, so this file reports no findings and no clean result: there is nothing to report. Not **Met**, because a scanner that has produced no output is not a verified control. One older obstacle is gone rather than merely deferred — CodeQL's SARIF upload previously needed GitHub Advanced Security, which is available on public repositories at no cost, so the upload step is expected to work here; that expectation will be confirmed by the first run, not by this sentence. What holds independently of either scanner: 2.2.2's `payload-audit` gate, which is not a scanner but a hard check |
| 12.1.2 Secrets scanning | Wired | `[was Roadmap; upgraded 2026-09-01]` — `gitleaks.yml` (history) and `ci.yml`'s Trivy job (working tree) were dispatch-only. Gitleaks now runs on `push`, on `pull_request` and weekly; the Trivy job runs with `ci.yml` on `push` and `pull_request`. **No run has completed in this repository yet.** The structural mitigation is the part that is actually load-bearing today, and it is not a scan: `scripts/lib/creds.mjs` keeps release credentials outside the working tree entirely (`~/.config/sonomos/release.env`), so there is no repository secret for a scanner to find, and publisher output is redacted (`creds.mjs::redact`). Note that store-publishing credentials now live in repository Actions secrets as well, because `release.yml` publishes automatically — see `RISK-REGISTER.md` R-04 |
| 12.1.3 SCA / vulnerable deps | Wired | `[was Roadmap; upgraded 2026-09-01]` — `ci.yml`'s Trivy job and `dependency-review.yml` were dispatch-only. Trivy now runs on every push and pull request; dependency review runs on `pull_request`, and dependency review is available on public repositories, which is the constraint that previously made it fail. **No run has completed yet.** Residual exposure is small by construction regardless: `package.json` declares zero `dependencies` and zero `devDependencies`, and the extension ships no third-party runtime code — `quality.yml::package-smoke` asserts what does and does not enter the payload |

## V13 — API & Web Service

| Req | Status | Evidence |
|---|---|---|
| 13.1.x | N/A — no public APIs | Extension exposes no APIs. The native-messaging surface has **three** message types — `hello`, `status`, `capture` (`shared/constants.js::BRIDGE_MSG`) — each rejected if the shape doesn't match. `[corrected 2026-08-21]` — this row listed five names under a count of four, of which `proxy-fetch`, `get-token` and `start-daemon` were the retired daemon's |

## V14 — Configuration

| Req | Status | Evidence |
|---|---|---|
| 14.1.1 Build pipeline reproducible | Met | The mechanism does not depend on CI. `scripts/zip.mjs` is a deterministic ZIP writer (POSIX separators, fixed attributes and deflate level, and a **fixed** DOS timestamp on every entry); `scripts/store-build.mjs::entries` sorts the payload before handing it over, so the byte order is stable too. `npm run package` is the whole recipe and needs no environment. `SOURCE_DATE_EPOCH` is honoured *when set* and overrides the fixed stamp — it is not what makes a build deterministic, it is what lets `release.yml::Build extension zip (reproducible)` pin mtimes to the release commit so an auditor rebuilding it gets the published bytes. `[upgraded 2026-09-01]` — this used to be an assertion about a mechanism, checkable only by someone who ran it. It is now verified on every push: `quality.yml::reproducible-build` builds the payload twice under a fixed `SOURCE_DATE_EPOCH` and **fails the run unless the two zips are byte-identical**, so a non-determinism introduced by a future change cannot land quietly. Independently of CI, `LICENSE` (PolyForm Strict 1.0.0) permits noncommercial use, which includes running and rebuilding this software to verify the claim, so a reviewer can check the property without our cooperation |
| 14.1.2 SBOM published | Roadmap | `[restated 2026-09-01]` — `sbom.yml` now runs on `push` to `main` and monthly, and `release.yml` has CycloneDX and SPDX steps, but **no run has completed in this repository and no release has been published**, so no SBOM is bound to a version anyone can download. The *generated* half is wired; the *published* half — an SBOM attached to a release artifact — is what keeps this row at Roadmap. Earlier revisions cited SBOM artifacts produced in the private repository this code was developed in; those are not reachable from here and are no longer offered as evidence |
| 14.1.3 Build provenance | Roadmap | `[restated 2026-09-01]` — `release.yml` contains the cosign `Sign artifacts` and `SLSA build provenance attestation` steps, and the workflow now runs on push to `main` rather than on manual dispatch. But **no release has been published through it**, so there is not yet a signed or attested artifact; every artifact shipped to date is unsigned and carries no attestation. This row moves to **Met** when a release exists whose signature and attestation verify — not when the workflow runs. The README carries no SLSA, Scorecard or CII badge, deliberately: a badge asserts a rating that no run here has produced |
| 14.2.1 Dependencies up-to-date | N/A | There are no JS dependencies to be out of date: `package.json` declares empty `dependencies` and `devDependencies`, asserted by `ci.yml::no JS deps in package.json` (now running on every push and pull request) and by review (see the `_comment` in that file). `[restated 2026-09-01]` — this cell previously recounted Trivy's run history in the private repository it was developed in; that history is not verifiable from here and has been dropped. The N/A does not depend on it |
| 14.2.2 Dependencies pinned | Met | Every `uses:` in `.github/workflows/` is pinned to a 40-character commit SHA with a version comment — 51 references at the time of writing. `[upgraded 2026-09-01]` — this used to be true of the files as committed and checked only by review. `quality.yml::actions-pinned` now **fails the run** if any `uses:` is not a 40-character SHA, so an unpinned tag cannot be introduced silently. What holds regardless: zero JS dependencies, and no third-party package in `package-lock.json`. `[restated 2026-08-31]` — the native messaging host's own pinned dependency graph used to be cited here as well; that host is not part of this repository, so the claim about it is withdrawn rather than restated, and this row covers the extension only |
| 14.4.x Strict CSP | Met | See V3.1.1 |
| 14.5.x Origin / referrer policies | N/A | Extension pages aren't navigable by web origins; loopback fetches don't set Origin |

## V50 — Web Frontend (ASVS v5 specific)

| Req | Status | Evidence |
|---|---|---|
| 50.6.1 Subresource integrity | N/A | Extension loads zero remote scripts (CSP `script-src 'self'`) |
| 50.7.1 No third-party iframes | Met | CSP `frame-ancestors 'none'` |

## Release process (not an ASVS section — read it before citing one)

`[added 2026-08-31; restated 2026-09-01 for dispatch-only]` Publication
is a **manual dispatch of `release.yml` against `main`**, with no human
*approval* step: one person clicks Run workflow, and the run then builds,
tests, runs preflight, and publishes to Chrome Web Store, Edge Add-ons
and AMO when `scripts/release-gate.mjs` finds that this repository has no
`v<version>` release tag for `manifest.json::version` (`release.yml::gate`
→ `release` → `store-publish`). Merging publishes nothing; a dispatch on
an already-released version publishes nothing. The gate also refuses a
dispatch from any ref but `main`. Read the dispatch as *intent*, never as
*review*: the same person may merge and dispatch. The `store-publish` job is `continue-on-error`, so a
failed store upload does not fail the run or block `main`; it opens a
GitHub issue instead (`release.yml::publish-failure-notice`), which
means a publication failure is visible but not blocking. The two-person
release rule that this document
previously leaned on when discussing change control **has been
withdrawn** — see `docs/security/RELEASE-POLICY.md`. Do not answer a
questionnaire's separation-of-duties question from this file; the honest
answer is that there is none on release, and the only review before code
reaches users is pull-request review, which branch protection does not
enforce (`RISK-REGISTER.md` R-15).

---

This mapping is reviewed each release. If a newly-introduced
requirement isn't met, it's filed as a roadmap item with a tracking
issue rather than left silently `N/A`.
