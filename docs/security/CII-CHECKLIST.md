# CII Best Practices — pre-filled checklist

The Linux Foundation's [Core Infrastructure Initiative Best Practices
badge][cii] is a free self-certification recognised by most enterprise
IT teams as a baseline trust signal. This file pre-fills the answers
so submission is a 15-minute paste job.

[cii]: https://www.bestpractices.dev/

> **State of these answers, 2026-09-01.** Eight of the nine workflows in
> `.github/workflows/` now carry real triggers — `ci.yml`, `codeql.yml`,
> `semgrep.yml`, `gitleaks.yml` and `quality.yml` on `push` to `main`
> and/or `pull_request`; `dependency-review.yml` on `pull_request`;
> weekly schedules on `codeql.yml`, `semgrep.yml`, `gitleaks.yml` and
> `scorecard.yml`; a monthly one on `sbom.yml`. Until recently all of
> them were `workflow_dispatch`-only, and the answers below were written
> against that. **`release.yml` remains `workflow_dispatch`-only on
> purpose** (Sonomos #190) — a release is dispatched by a person, not
> triggered by a merge.
>
> Two things follow, and the answers keep them apart. **Checks that gate
> by failing a job** — the payload audit and the reproducible-build
> comparison in the new `quality.yml` — are controls, and the answers
> that depend on them have moved. **Scanners** are enabled but have
> produced nothing: this repository is newly public and **no workflow
> run has completed here yet**, so any answer that would rest on a scan
> result says "enabled, no run yet" rather than "yes".
>
> Earlier revisions of this file recounted workflow runs with counts and
> baselines. Those belong to the private repository this code was
> developed in and cannot be opened from here, so they have been dropped
> rather than cited. Do **not** answer a CII form from a run history a reviewer
> cannot see: these answers are a public attestation, and an overstated
> one is worse than no badge — which, per the licence note below, is not
> available to this project in any case.

## How to submit

1. Sign in at <https://www.bestpractices.dev/> with the GitHub account
   that admins this repo.
2. Click "Get your project's badge" and enter the repo URL.
3. Walk the form, copying each answer below. Most fields auto-detect
   from the repo (CI presence, license, etc.); only the free-text
   fields below need a paste.
4. After submission, paste the badge markdown into `README.md` (we've
   already added the badge placeholder).

## Passing tier — answers

### Basics

- **Project URL**: <https://github.com/sonomoshq/Locke-Extension>
- **Description**: Browser extension that holds an AI request until the
  local Sonomos desktop app has screened it, then applies the verdict.
  MV3; page data reaches the app over native messaging and a user-only
  `0600` Unix domain socket, never a network socket. (Corrected
  2026-08-21: read "via the local Sonomos Desktop daemon … per-install
  HMAC handshake".)
- **Primary language**: JavaScript. (Corrected 2026-08-31: read
  "JavaScript (Rust for the native host)". The native messaging host is
  not part of this repository — it is installed by the Locke desktop
  app — so nothing in this checklist can be answered about its source.)
- **License**: PolyForm Strict License 1.0.0 — see `LICENSE`. Not OSI-approved
  and not an open-source licence.
  **This makes the project ineligible for a CII Best Practices badge**, which
  requires an OSI-approved or FSF-free licence. The rest of this checklist is
  retained because the underlying practices are worth meeting on their own
  merits, but the badge itself is not available and should not be pursued.
  (Historic note — the entry below predates the licence decision:
  currently no LICENSE file in repo;
  set this when adding one back.)

### Project website

- **Web reachable**: yes — <https://sonomos.ai>
- **Uses HTTPS**: yes
- **Front-page describes what the project does**: yes
- **Front-page provides info on how to contribute / report**: yes
  (`SECURITY.md`, GitHub Issues)

### Documentation

- **Basic documentation**: `README.md`, `docs/architecture/DATA-FLOW.md`
- **Interface documentation**: `docs/security/PERMISSIONS.md` (manifest
  surface), `docs/architecture/DATA-FLOW.md` (the native-messaging hop
  and what crosses it). Corrected 2026-08-21: cited a design document
  that does not exist.
- **Contributor documentation**: `CONTRIBUTING.md` in this repo

### Other

- **Public version control**: yes — GitHub
- **Unique version identifier per release**: yes — semver tags
- **Release notes**: yes — `CHANGELOG.md`

### Bug reporting

- **Bug reporting process**: yes — GitHub Issues for bugs,
  `SECURITY.md` private channel for vulns
- **Acknowledgement**: yes — within 48h per `SECURITY.md`

### Vulnerability reporting

- **Vulnerability reporting process**: yes — `SECURITY.md` +
  `docs/security/security.txt`
- **Private vulnerability reporting**: yes — GitHub Security Advisories
  + `security@sonomos.ai`
- **Acknowledgement timeline**: 48h ack, 30d fix target for high-severity

### Build

- **Public build instructions**: yes — `npm run package` produces both
  store artifacts; `docs/store/RELEASE-PIPELINE.md` is the canonical
  recipe. *(Corrected 2026-08-12: `release.yml` was cited as the
  canonical recipe. It is not — all it does for the build is pin
  `SOURCE_DATE_EPOCH` and call `npm run package`. Restated 2026-09-01:
  that workflow now runs on push to `main`, but the recipe is still
  `npm run package` and still needs no CI.)*
- **Standard build system**: no build system needed (no-bundler MV3)

### Automated tests

- **Test suite present**: yes — `tests/*.test.js` under Node's
  built-in `node:test` runner, run with `npm test`; coverage spans
  the shared helpers, the shim's hold-and-enforce paths, the store
  packaging transforms and the three store publishers.
  *(Corrected 2026-08-12: previously "partial — extension has CI lint
  + manifest validation"; no CI gates a PR, and the suite is
  substantially larger than that answer implied.)*
- **Tests run automatically**: yes, as of 2026-09-01 — `ci.yml` runs
  `npm test` on every push to `main` and on every pull request against
  it, and `release.yml::gate`/`release` will not publish without it.
  `npm test` is also invoked by `scripts/preflight.mjs`, which the local
  `scripts/hooks/pre-push` hook runs on every push; that hook remains
  bypassable with `git push --no-verify`, which is why the server-side
  trigger matters. Caveat for the form: no CI run has completed in this
  repository yet, and whether the job is *required* to merge is a branch
  protection setting this file cannot attest to.
- **New functionality has tests**: roadmap — formal test policy in
  CONTRIBUTING.md needs writing

### New functionality / change process

- **Code review for changes**: yes as process (`CONTRIBUTING.md`,
  `CODEOWNERS`) — but branch protection is not configured, so the
  review requirement is not enforced by the forge. *(Corrected
  2026-08-12.)*
- **Automated tests on PRs**: **yes, as of 2026-09-01.** *(This
  answered "no" while `ci.yml`, `gitleaks.yml`, `semgrep.yml`,
  `codeql.yml` and `dependency-review.yml` were dispatch-only and
  nothing ran on a PR. All of them now run on `pull_request` against
  `main`, joined by `quality.yml`.)* Two caveats a reviewer is entitled
  to: no run has completed in this repository yet, so no PR has actually
  been gated; and branch protection requiring these jobs is a repository
  setting, not something the workflow files can assert — until it is
  configured, a failing check is visible but not blocking.

### Quality

- **Coding standards documented**: partial — `ruff` enforced for
  Python; ESLint config TBD for JS
- **Build warnings clean**: yes
- **One person can release**: **yes.** *(Restated 2026-08-31; sharpened
  2026-09-01.)*
  Publishing is a manual dispatch of `release.yml` against `main`, which
  builds, tests and then publishes to Chrome Web Store, Edge Add-ons and
  AMO whenever this repository has no `v<version>` release tag for
  `manifest.json::version` (`scripts/release-gate.mjs`). One person can
  merge their own change and dispatch the release themselves, so there is
  still **no human approval step** on the publish — only a deliberate
  one. The two-person release rule that used to answer this
  question has been withdrawn (`docs/security/RELEASE-POLICY.md`). The
  only remaining review is pull-request review under `CODEOWNERS`, and
  branch protection is not configured, so it is a process commitment
  rather than a server-side rule.

### Security

- **Secure development knowledge**: yes — see `SECURITY.md`,
  `docs/security/`
- **Crypto practices**: yes — only standard primitives; constant-time
  compare; never roll our own. See ASVS V6.
- **Secured delivery**: partial. *(This answered "yes — sigstore
  keyless signing + SLSA L3 provenance". Those steps exist in
  `release.yml`, which a person dispatches on `main`, but **no release
  has been published through it**, so no shipped artifact is signed or
  attested and the answer stays partial.)* What is true: the two store
  artifacts are byte-reproducible (`SOURCE_DATE_EPOCH`, deterministic
  ZIP writer), and as of 2026-09-01 that is checked rather than
  asserted — `quality.yml::reproducible-build` builds twice on every
  push and fails unless the zips are byte-identical. End users receive
  the artifacts over the stores' own signed distribution channels.
- **Used CVE in last year**: declare during submission
- **High-severity vulns resolved within 60 days**: yes — `SECURITY.md`
  pledges 30-day target

### Analysis

- **Static analysis tool**: **enabled, no result yet.** *(This answered
  "yes — Semgrep + CodeQL", then "not yet running" while both were
  dispatch-only. As of 2026-09-01 `semgrep.yml` and `codeql.yml` run on
  `push` to `main`, on `pull_request` and weekly. No run has completed
  in this repository, so there is no finding and no clean result to
  report — do not answer this "yes" on the form until a run exists.)*
  One analysis in this repository is **not** a scanner and does gate:
  `quality.yml::payload-audit` runs `scripts/audit-payload.mjs` over the
  staged payload and fails the run on `eval`, `new Function`, a remote
  dynamic `import()`, `document.write`, `innerHTML` built by
  concatenation, or any absolute URL that is not loopback or the
  `https://sonomos.ai/` product link. `tests/audit-payload.test.js`
  (14 tests) proves each of those checks fires.
- **Dynamic analysis tool**: N/A — the extension has none; dynamic
  analysis of the desktop product is out of scope for this repo
- **Supply-chain analysis**: **enabled, no result yet.** *(This
  answered "yes — Trivy + dependency-review-action", then "not running
  today" while both were dispatch-only. As of 2026-09-01 `ci.yml`'s
  Trivy job runs on every push and pull request and
  `dependency-review.yml` runs on `pull_request`; dependency review is
  available on public repositories, which is the constraint that used to
  defeat it. No run has completed here yet.)*
  The exposure either would cover is structurally small: `package.json`
  declares zero `dependencies` and zero `devDependencies`, the
  extension ships no third-party runtime code, and there is no lockfile
  in this repository with a third-party package in it —
  `quality.yml::package-smoke` asserts what does and does not enter the
  shipped payload. (Corrected 2026-08-31: this sentence used to close by
  citing the native messaging host's Rust lockfile as further evidence.
  That host is not part of this repository, so the claim cannot be
  checked from here and is withdrawn rather than restated.)

## Silver tier — gaps to close

After Passing badge, Silver requires:

- [ ] Documented coding standard (style guide) for JS
- [ ] Documented test policy
- [ ] At least 80% test coverage on critical paths (detection coverage
      lives in the desktop app, not here)
- [ ] Two-person review on all releases. **Further away than it was**:
      the two-person rule was withdrawn on 2026-08-31. Publication moved
      to automatic-on-merge and then, on 2026-09-01, to a manual
      dispatch; neither introduced a second person. Meeting this needs
      two things — branch protection on `main` requiring a non-author
      CODEOWNER approval, and required reviewers on the `store-publish`
      GitHub Environment so the dispatch itself waits for somebody
      else
- [ ] Cryptographic agility / algorithm upgrade path documented — N/A
      as written: the extension uses no cryptography (`SECURITY.md` A1,
      `ASVS-MAPPING.md` V6). Corrected 2026-08-21 from a reference to a
      design document that does not exist

## Gold tier — gaps to close

After Silver, Gold requires:

- [ ] Two active maintainers from different orgs (currently single-org)
- [ ] Reproducible builds verified by independent third party. The
      mechanism is in place via `scripts/zip.mjs` — fixed timestamps by
      default, sorted entries from `scripts/store-build.mjs::entries` —
      with `SOURCE_DATE_EPOCH` pinning mtimes to the release commit when
      a rebuilder needs the published bytes exactly. `release.yml` only
      wraps that recipe; `npm run package` is the whole of it.
      **Upgraded 2026-09-01 on two counts.** First, the property is now
      checked rather than asserted: `quality.yml::reproducible-build`
      builds twice under a fixed `SOURCE_DATE_EPOCH` and fails the run
      unless the zips are byte-identical, so a regression cannot land
      silently. Second, `LICENSE` (PolyForm Strict 1.0.0) **permits
      noncommercial use**, which includes running and rebuilding this
      software to verify it — an earlier note here said an outside
      verifier would need build rights granted separately, and that is
      no longer the case. What is still missing, and is why the box is
      unticked, is the *third party* half: nobody outside the project has
      published a rebuild attestation, and no release exists to rebuild.
- [ ] SLSA build provenance actually emitted. `release.yml` contains the
      attestation step and now runs on push to `main`, but **no release
      has been published through it**, so no version has provenance at
      any level. The README carries no SLSA, Scorecard or CII badge, by
      decision: each would assert a rating with no run behind it. Put a
      badge back when a release has actually emitted an attestation that
      verifies, not when a workflow is merely enabled.

The Passing tier is the realistic short-term target; Silver becomes
realistic after the test suite expands and a second maintainer is
formally listed.
