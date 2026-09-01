# Management review

A management-review cadence for the Sonomos Desktop Connector,
modelled on ISO 27001 Clause 9.3 and SOC 2 CC5.1. This document
defines the review cycle, the inputs each review must consider, and
the outputs that must be produced.

**Modelled on is not measured against.** Sonomos is not certified to
ISO 27001 and holds no SOC 2 report; no engagement for either has been
started and no auditor has examined this cadence or its outputs. The
clause numbers above say where the shape of this process came from,
and nothing more.

This is a process control. The review itself is conducted by the
named owners on the calendar dates below; the artifacts of each
review are committed to this repo as appendices to this file.

## Cadence

- **Quarterly review** — formal, ~60 minutes, outputs committed.
- **Ad-hoc review** — triggered by any of:
  - A high-severity vulnerability disclosure (`SECURITY.md`)
  - A new risk added to `RISK-REGISTER.md` with net score ≥ 12
  - A material change to the threat model in `SECURITY.md`
  - A failed release-pipeline assertion — today, a preflight failure
    or a `failed` (not `skipped`) store result in
    `dist/publish-report.json` on a tag push; once the workflows
    exist, a sigstore, SLSA or SBOM failure too
  - A request from a customer auditor or regulator

## Owners

| Role | Responsibility |
|---|---|
| Engineering lead | Convenes the review, prepares technical inputs |
| Security lead | Presents risk-register changes, vulnerability disclosures, audit log signals |
| Legal reviewer | Reviews legal-doc status (`docs/legal/`), confirms sub-processor list, flags upcoming regulatory changes |
| Operations / customer-facing | Brings customer-side feedback (vendor questionnaires received, IT reviews completed) |

In a small team one person may hold multiple roles; document the
combined sign-off.

## Inputs each review must consider

1. **Risk register changes** since last review (`RISK-REGISTER.md`)
2. **Open vulnerability disclosures** (`SECURITY.md`,
   `docs/security/DISCLOSURE-LOG.md`)
3. **Audit-log signals** from production fleets — any spike in
   `daemon-down`, `hmac-proof-failed`, `policy-rejected`, or
   `coverage-gap` event kinds (see
   `docs/security/PERMISSIONS.md::Audit log`)
4. **CI workflow health** — failing Scorecard checks, Trivy or
   dependency-review findings not yet remediated, plus the pass/fail
   record of the `quality.yml` gates (`payload-audit`,
   `reproducible-build`, `actions-pinned`, `generated-drift`,
   `package-smoke`, `amo-lint`). As of 2026-09-01 every workflow carries
   real triggers, so from the first push this input becomes real signal
   rather than a note about dormancy; **at the time of writing no run
   has completed in this repository**, so the first review after
   publication has a baseline to establish, not a trend to read. The
   local pre-push preflight's status, and whether it is still being
   bypassed with `--no-verify`, remains part of this input.
5. **TODO.md status** — items closed since last review, items
   still open, calendar slippage on any
6. **Customer questionnaires received** — recurring questions
   become follow-up actions for ASVS-MAPPING / CONTROL-CATALOG
7. **Legal-doc status** — DRAFTs not yet reviewed by the legal reviewer
8. **Threat-model deltas** — anything new in A1–A6 territory

## Outputs each review must produce

Committed to this file as a dated appendix:

1. **Decisions** taken (acceptance, mitigation, transfer, avoidance)
2. **New risks added** to `RISK-REGISTER.md`
3. **Risk re-ratings** (with reason)
4. **Action items** with owner and target date
5. **Sign-off** by the named roles above

## Calendar

The first formal management review is the next quarter boundary
after this commit. Subsequent reviews follow at quarterly intervals.
A reminder belongs in the team calendar; this file is not a
calendar substitute.

## Inputs from the parent product

Where relevant, changes in the Locke desktop app that affect the
extension (threat-model changes on its side, breaking protocol
changes) are summarised into the extension's quarterly review by the
engineering lead.

## Appendix — Review history

> Format for each review:
>
> ```
> ## YYYY-Qn Review (YYYY-MM-DD)
>
> Attendees: …
> Scope: quarterly | ad-hoc (trigger: …)
>
> ### Inputs reviewed
> - …
>
> ### Decisions
> - …
>
> ### Risk-register changes
> - …
>
> ### Action items
> | Action | Owner | Target |
> |---|---|---|
> | … | … | … |
>
> ### Sign-off
> - Engineering: …
> - Security: …
> - Legal reviewer: …
> - Operations: …
> ```

## 2026-Q2 Review (PRE-FILLED — pending human sign-off)

Pre-staged by the engineering lead on 2026-05-10. Conduct the review
itself when the team can convene the named owners. The "Decisions"
and "Sign-off" sections are intentionally blank for the meeting to
fill in; everything else is pre-populated from the current state of
the repo.

Attendees: TBD
Scope: quarterly (first formal review for this product line)

### Inputs reviewed

**Risk-register changes since baseline**
- Initial register seeded with 18 risks (R-01 through R-18). See
  `docs/security/RISK-REGISTER.md`. No retirements; no re-ratings
  yet (this is the first review).

**Open vulnerability disclosures**
- None. `docs/security/DISCLOSURE-LOG.md` is empty. The bug-bounty
  program (`docs/security/BUG-BOUNTY.md`) is in kudos-only mode;
  paid submissions not yet accepted.

**Audit-log signals from production fleets**
- No production fleets yet (pre-pilot). Audit-log mechanism is in
  place (`background/service-worker.js::appendAudit`, 8 event kinds,
  popup-export); no signals to review.

**CI workflow health**

> **RESTATED 2026-09-01.** A much earlier pre-fill recorded seven
> workflows as "green" when no `.github/` directory existed at all; a
> later correction replaced it with a per-workflow run history from the
> private repository this code was developed in. **Neither belongs
> here.** This repository is newly public and has **no run history**: a
> reader cannot open those runs, so citing them — even accurately —
> would be presenting evidence nobody can check. The section below
> states what is wired and what has produced a result, and nothing else.
> The review meeting should treat "confirm the first run of each
> workflow" as an open action, not a completed control.

- **Every workflow now carries real triggers (2026-09-01).** Until now
  all of them were `workflow_dispatch`-only and gated nothing. Current
  wiring, and what each has produced **in this repository**:
  - `ci.yml` — lint, manifest tripwires, unit tests, Trivy — `push`
    (`main`), `pull_request`. No run completed yet
  - `gitleaks.yml` — secret scan — `push`, `pull_request`, weekly. No
    run completed yet
  - `semgrep.yml` — SAST — `push`, `pull_request`, weekly. No run
    completed yet
  - `codeql.yml` — SAST — `push`, `pull_request`, weekly. No run
    completed yet. Its SARIF upload needs code scanning, which is
    available on public repositories; the first run confirms it
  - `dependency-review.yml` — `pull_request`. No run completed yet;
    available on public repositories. The repo declares zero JS
    dependencies, so it has little to find
  - `scorecard.yml` — `push`, weekly, `branch_protection_rule`. No run
    completed yet, and **`publish_results` is still `false`** in that
    file, so even a successful run writes a SARIF artifact rather than
    publishing to the public OpenSSF dataset. **There is no published
    score**, and the README deliberately carries no Scorecard badge.
    Turning `publish_results` on is a decision for the review meeting
  - `sbom.yml` — `push` (`main`), monthly. No run completed yet, and no
    SBOM is published *against a version*, because no release exists to
    attach one to
  - `quality.yml` — **new**: `payload-audit`, `reproducible-build`,
    `actions-pinned`, `generated-drift`, `permission-diff`,
    `package-smoke`, `amo-lint`. `push`, `pull_request`. These are the
    jobs that fail on a violation rather than reporting findings, and
    two of them turn documented claims into controls: the loopback-only
    egress property (`ASVS-MAPPING.md` 11.1.1, `SECURITY.md` A1) and the
    reproducible build (`ASVS-MAPPING.md` 14.1.1). Covered by
    `tests/audit-payload.test.js` and `tests/permission-diff.test.js`
  - `release.yml` — `push` (`main`). **No release has been published
    through it**, so no shipped artifact is sigstore-signed or carries a
    SLSA attestation. This is the line that matters most, and it has not
    changed: publication is now automatic, but it has not yet happened
- **Trivy HIGH/CRITICAL findings**: none outstanding, and none found —
  because no scan has completed in this repository. Do not read that as
  a clean result; read it as no result. The first `ci.yml` run
  establishes the baseline.
- What *does* run today: `scripts/preflight.mjs`, invoked by the
  pre-push git hook on every push — version-site consistency, both
  store manifest transforms, listing assets, store credentials, and the
  `npm test` suite. It is local and bypassable with
  `git push --no-verify`, so it is a safety net rather than an enforced
  control. `[corrected 2026-08-31]` — the native-messaging host name pin
  is no longer in that list: it cross-checked the host's manifest
  templates, which are not part of this repository. **Also corrected:
  "what runs today" is no longer only the hook.** `release.yml` now runs
  on push to `main` and publishes to three stores when the version
  changed, with no approval step (`docs/security/RELEASE-POLICY.md`). So
  the shipping half of the pipeline is live and server-side while the
  scanning half is still dormant, which is the wrong way round and is
  the standing action item below.

**`TODO.md` status**
- Closed since baseline:
  - ~~Client-side encryption layer — implemented with feature
    detection~~ **Withdrawn 2026-08-21: this was never true and is not
    true now.** There is no encryption layer and no key agreement of
    any kind anywhere in the extension, verified by source read. The
    design document `CHANGELOG.md` cites has never existed in this
    repository. Whatever was closed here, it was not a shipped
    cryptographic layer
  - Async Clipboard API protection — closed (keystroke-guard audit)
  - Late-stylesheet rescan via MutationObserver — closed
  - HONEST.md — written
- Still open:
  - Legal docs awaiting the legal reviewer (high priority)
  - ~~Encryption-layer coordination with the parent product~~
    **Closed as moot 2026-08-21.** Not in flight: the component it
    would coordinate with was retired in the 2026-06 mesh rewrite.
    Nothing is tracking this and nothing is building it
  - SOC 2 Type II — **not started, and not on any calendar**
    `[corrected 2026-08-21]`. This line read "— calendar", which
    implied a scheduled engagement. There is none: no auditor, no
    gap assessment, no observation window, no date
  - Chrome/Edge/Firefox store listings — deferred
  - Live bug-bounty listing on huntr.com or similar — deferred
  - CII Best Practices submission — pending human-time
    submission (15-min paste from the pre-filled checklist)
  - ~~Two-person release in operational practice~~ — **withdrawn
    2026-08-31, not achieved.** Publication became automatic on merge to
    `main`, so there is no release-time approval to staff a second
    person into. The successor item is branch protection on `main`
    requiring a non-author CODEOWNER approval, because merging now
    publishes
  - Trademark policy — awaiting registration
  - LICENSE files — strategic decision

**Customer questionnaires received**
- None yet (pre-pilot).

**Legal-doc status**
- All DRAFT. None presented to a customer. See `TODO.md` for the
  legal-review checklist.

**Threat-model deltas**
- A4–A6 added in the round-2 IT-friendliness pass (see
  `SECURITY.md`). No other threat-model changes since baseline.

### Decisions

*(For the meeting to fill — proposed defaults below; cross out and
replace if discussion lands elsewhere.)*

- **Top-risk acceptance vs mitigation status:**
  - R-11 (false-negative PII detection, net 12) — proposed: keep as
    "mitigate", action item to schedule a quarterly detection-quality
    review with the desktop-app team
  - R-15 (one-person release, net 12) — proposed: keep as
    "mitigate", action item to staff a second CODEOWNER before next
    release
  - R-17 (legal-review gating, net 12) — proposed: keep as
    "mitigate", action item to schedule a legal-review block
- **Risk-register additions:** None proposed by engineering.
- **Risk re-ratings:** None proposed.

### Risk-register changes

*(For the meeting to fill — none proposed by engineering at this
pre-fill.)*

### Action items

*(For the meeting to fill. Below is the engineering team's proposal;
add/remove/adjust during the review.)*

| Action | Owner | Target |
|---|---|---|
| Schedule a legal-review block to walk the legal-review checklist in `TODO.md` | Operations | 2026-Q2 end |
| Submit CII Best Practices badge form (15-min paste from `docs/security/CII-CHECKLIST.md`) | Engineering | 2026-Q2 mid |
| ~~Activate `.github/workflows/`~~ — **closed 2026-09-01**: all nine workflows now carry real triggers | Engineering | *done* |
| Review the first completed run of each workflow and record the baseline — nothing has run in this repository, so every "enabled" row in `CONTROL-CATALOG.md` and `ASVS-MAPPING.md` is unconfirmed until this happens (added 2026-09-01) | Engineering | First push after publication |
| Configure branch protection on `main` with the CI jobs — at minimum the `quality.yml` gates and `ci.yml` — as required status checks, and required reviewers on the `store-publish` environment, so the release policy stops being advisory. **Now the highest-value open item**: the triggers are live but a failing check does not block a merge, and a merge publishes | Engineering | Before the first automated release |
| Publish one release through `release.yml` so at least one artifact is signed, attested and SBOM'd — still open: no release has been published. Until it happens the README carries no supply-chain badge, by design | Engineering | Next release |
| Run first OpenSSF Scorecard cycle and review the score — `scorecard.yml` is now scheduled weekly. Decide separately whether to set `publish_results: true`, which is still `false`: without it the score stays a private SARIF artifact and no badge is earned | Engineering | First scheduled cycle |
| Configure branch protection on `main` requiring a non-author CODEOWNER approval — **now the only review before a store submission**, since a merge to `main` publishes (added 2026-08-31) | Engineering | Before the first automated release |
| Give the Chrome `CWS_REFRESH_TOKEN` (7-day life while the OAuth consent screen is in Testing) and the `EDGE_API_KEY` (72-day life, no server-side warning) a named owner — unattended publishing breaks on both clocks and neither has one (added 2026-08-31) | Operations | Before the first automated release |
| Identify a second CODEOWNER candidate for code review | Operations | 2026-Q2 end |

### Sign-off

*(For the meeting.)*

- Engineering: ___
- Security: ___
- Legal reviewer: ___
- Operations: ___

---

*(No additional reviews recorded yet — second review due 2026-Q3.)*
