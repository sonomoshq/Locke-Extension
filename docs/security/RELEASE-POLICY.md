# Release policy

How a Locke Extension release gets built and published. This policy is
a mix of automated guards and process commitments, and the two are
**not** currently enforced in the same place — see
[Enforcement status](#enforcement-status-2026-09-01) before treating
any line below as a control an auditor can rely on.

**Read [How a release publishes](#how-a-release-publishes) first.** A
push to `main` publishes to the extension stores automatically, with no
human approval step. The two-person release rule this document used to
carry has been withdrawn.

The operator-facing mechanics (commands, dry runs, store failure
modes) live in
[`docs/store/RELEASE-PIPELINE.md`](../store/RELEASE-PIPELINE.md);
credentials in
[`docs/store/CREDENTIALS.md`](../store/CREDENTIALS.md).

## Enforcement status (2026-09-01)

Until now every workflow in `.github/workflows/` was
`workflow_dispatch`-only, with its real triggers commented out, and the
only checks that ran were local ones in the `scripts/hooks/pre-push` git
hook. **That has changed: all nine workflows now carry real triggers**
— `push` to `main` and/or `pull_request` for `ci.yml`, `codeql.yml`,
`semgrep.yml`, `gitleaks.yml`, `quality.yml`, `release.yml` and
`dependency-review.yml`, plus weekly schedules on `codeql.yml`,
`semgrep.yml`, `gitleaks.yml` and `scorecard.yml` and a monthly one on
`sbom.yml`.

Two things a reader should not conflate:

1. **A workflow that runs is not a required check.** Branch protection
   on `main` is still not configured, so a failing job is visible but
   does not block a merge — and merging is what publishes. That is the
   single largest gap in this policy (`RISK-REGISTER.md` R-15).
2. **Nothing has run here yet.** This repository is newly public and has
   no run history. A row marked `[live]` will run from the first push;
   it has not yet produced a result.

Statements below are marked:

- `[live]` — the job runs on `push`/`pull_request` from the first commit
  of this repository. **No run has completed yet**, and it is not a
  required status check until branch protection says so
- `[gate]` — the check fails the run when violated *and* the row names
  what proves it bites. The strongest marker in this file
- `[hook]` — runs locally in the pre-push hook, bypassable with
  `--no-verify`
- `[pending]` — a commitment with no mechanism behind it yet

**Publication is the piece that is fully automatic.** A merge to `main`
builds, tests, runs preflight and publishes, with no human approval step
(see [How a release publishes](#how-a-release-publishes)). So the part
of the pipeline that ships to users is server-side and unattended, while
the checks that would gate it are not yet required. That is the wrong
way round, and it is stated here rather than smoothed over.

**No release has been published through `release.yml`**, so nothing
shipped to date is signed, attested or SBOM'd — that is why those rows
have not moved.

Earlier revisions of this file recounted which workflows had run and how
many times. Those runs belong to the private repository this code was
developed in and cannot be opened from here, so they are no longer cited
as evidence.

## Versioning

- Releases follow `vMAJOR.MINOR.PATCH` (semver-shaped, but the
  product follows the Sonomos Desktop release cadence rather than
  strict semver — breaking changes can land in MINOR if the
  desktop app coordinates).
- `manifest.json::version` is what publishes. It is the value each
  publisher compares against the store's live version, so the version
  in the merge commit is the release identity — a git tag, if one is
  cut, records the release rather than causing it.
- All five version sites MUST agree: `manifest.json`, `package.json`,
  both sites in `package-lock.json`, and the dated `CHANGELOG.md`
  heading. `npm run preflight -- --checks=version` fails on a mismatch
  (`scripts/lib/version.mjs::checkVersions`), and preflight runs in the
  publish path.
- `npm run bump -- <major|minor|patch|X.Y.Z>` writes all five sites at
  once. It deliberately does not commit and does not tag.

## How a release publishes

> **Changed 2026-08-31. There is no human approval gate on publication.**
> A push to `main` publishes. The two-person release rule that used to
> sit in this section — "the person who tags a release MUST NOT be the
> same person who approved the release PR" — has been **withdrawn**, and
> every document that cited it as a control has been corrected
> (`CONTROL-CATALOG.md`, `ASVS-MAPPING.md`, `CII-CHECKLIST.md`,
> `RISK-REGISTER.md` R-04/R-15). Do not cite it. There is no separation
> of duties on release any more.

### The mechanism

1. A pull request against `main` carries:
   - the `manifest.json::version` bump (via `scripts/bump-version.mjs`,
     which writes all five version sites at once)
   - the `CHANGELOG.md` entry under a new dated heading — this text is
     submitted verbatim as AMO release notes and Edge certification
     notes, so "see git log" does not survive a store review
   - any user-facing release-notes content
2. The pull request is reviewed. See
   [Where the review happens now](#where-the-review-happens-now) — this
   is the *only* review before the extension reaches users.
3. **Merge to `main`.** That is the publish action. Nothing else has to
   happen and nobody else has to agree.
4. **The version gate decides whether this merge is a release.**
   `scripts/release-gate.mjs` (`.github/workflows/release.yml::gate`)
   compares `manifest.json::version` at the merge commit against the
   version at the previous commit. Unchanged → the pipeline stops and
   nothing ships, and the job is green. Changed → it is a release. So an
   ordinary merge — docs, CI, a refactor — publishes nothing, and
   bumping the version in the PR is what makes merging it a release.
   The gate is **fail-closed**: when it cannot determine the previous
   version (shallow clone, rewritten history, no parent) it does not
   publish. Covered by `tests/release-gate.test.js`.
5. If the gate says release, the pipeline runs, in this order:
   - `release.yml::Validate version matches manifest`
   - `npm test` (`release.yml::Unit tests (node:test)`)
   - `scripts/preflight.mjs` — version sites, both store manifest
     transforms, listing assets
   - build the two reproducible zips (`scripts/package.mjs` →
     `scripts/store-build.mjs` → `scripts/zip.mjs`), sha256 sidecars,
     SBOMs, cosign signatures, a SLSA provenance attestation, a
     CI-created tag and a GitHub release
   - `scripts/publish.mjs`, all three publishers concurrently, in the
     `store-publish` job
6. **Per-store version checks are a safety net below the gate, not the
   gate.** Each publisher also refuses to re-submit a version a store
   already has, which is what makes a re-drive safe:
   - Chrome — `scripts/publish/chrome.mjs` reads `:fetchStatus` and
     returns `skipped` when `classifyStatus().publishedVersion` equals
     the manifest version (CWS rejects a re-upload of an existing
     `crxVersion` anyway)
   - Edge — the Update API answers `NoModulesUpdated`, mapped to
     `skipped` in `scripts/publish/edge.mjs::ERROR_CODES`
   - Firefox — AMO answers with the "version already exists" family,
     matched by `ALREADY_PUBLISHED_PATTERNS` in
     `scripts/publish/firefox.mjs` and mapped to `skipped`

   A `skipped` result is `ok: true`, so these never turn a run red. Note
   that only Chrome can actually read a live version; Edge and Firefox
   answer at submission time. That asymmetry is why the gate is a git
   comparison rather than a three-store query —
   [`docs/store/AUTOMATED-RELEASE.md`](../store/AUTOMATED-RELEASE.md)
   sets out the reasoning.
7. **`submitted` is still not `live`.** Chrome enters review, Edge
   enters certification (up to 7 business days, with no API to poll),
   and AMO signs automatically but reviews afterwards. Watch each
   console and record the outcome in the release's changelog entry.
   A partial release — one store updated, two behind — is the realistic
   failure and has no transaction to roll back.

Credentials reach the pipeline as repository secrets read by the
`store-publish` job. `scripts/lib/creds.mjs` reads `process.env` before
it reads `~/.config/sonomos/release.env`, so this needs no code
change — but it does mean the secrets that publish to three stores now
live in the repository's settings rather than on one operator's machine.
Two of them expire on their own; see
[Credential expiry is now a release-blocking hazard](#credential-expiry-is-now-a-release-blocking-hazard).

The operator-facing walkthrough of all of this — the secrets to set, the
`store-publish` environment, how to re-drive a failed store — is
[`docs/store/AUTOMATED-RELEASE.md`](../store/AUTOMATED-RELEASE.md). One
thing there is worth repeating in a policy document: the `store-publish`
GitHub Environment has **no protection rules**, and that absence is what
makes publishing unattended. Adding required reviewers to it would
re-introduce an approval gate without touching a workflow file — and
would make this section wrong, so update it in the same change.

### Where the review happens now

The review that used to happen at release time — a second person
looking at what was about to ship, after the code was already merged —
**has to happen at pull-request review time instead, because merging is
what ships.** There is no later checkpoint. Concretely:

- A merge is irreversible in the direction that matters. Stores reject
  a re-upload of an existing version, so a bad release is corrected by
  publishing a *new* version, never by withdrawing the one that went
  out.
- The tag is now cut **by CI**, after the build, from the version in the
  manifest. It is a lightweight tag and nothing signs it, so a tag no
  longer carries any human assertion about the release — do not read one
  as evidence that somebody approved it.
- The reviewer of a version-bumping PR is reviewing a release, and
  should read it as one: the changelog text (store reviewers read it),
  the manifest diff, and anything that changed since the last published
  version — not just the diff of the bump commit.
- **Branch protection on `main` is not configured** (see below), so
  even the pull-request review is a process commitment, not a
  server-side rule. An account with write access can push straight to
  `main`, and that publishes. This is the largest single gap in this
  policy and it is tracked as `RISK-REGISTER.md` R-15.

Do not describe any of the above to an auditor as separation of duties.
It is not. It is one review, unenforced, before an automatic publish.

### Credential expiry is now a release-blocking hazard

Unattended publishing turns two known credential lifetimes from
operator annoyances into pipeline outages. Neither has an owner yet.

| Credential | Lifetime | What happens when it lapses |
|---|---|---|
| `CWS_REFRESH_TOKEN` | **7 days**, while the OAuth consent screen is in "Testing" status | Chrome publishing breaks **weekly**. The symptom is an opaque `invalid_grant` from the token endpoint. `scripts/publish/chrome.mjs::preflight` warns about it unconditionally, because the eventual error will not. Publishing the consent screen (moving it out of Testing) is what stops the 7-day clock; until then an unattended pipeline cannot publish to Chrome for more than a week at a time |
| `EDGE_API_KEY` | **72 days**, with no server-side warning | Edge publishing breaks with an HTTP 401 mid-release. The key carries no readable expiry and the API never warns, which is why `EDGE_API_KEY_ISSUED` exists purely for bookkeeping: `scripts/preflight.mjs` warns from day 58 and fails at day 72, and `scripts/publish/edge.mjs` warns on every run. That bookkeeping is only as good as whoever updates the date with the key |

No rotation procedure is documented here, because none exists that can
be verified from this repository. What is stated is the constraint:
**both credentials expire on a fixed clock, an unattended pipeline will
hit both, and neither has a named owner.** Assigning one is the fix;
writing a procedure nobody is accountable for is not. Details of where
each value comes from are in
[`docs/store/CREDENTIALS.md`](../store/CREDENTIALS.md).

## Branch protection

Required on `main`. **None of this is configured today** — branch
protection has not been set up, so every row below is `[pending]`
until the workflows land and the rules are turned on. The middle column
records what, if anything, covers the same ground in the meantime.

This table matters more than it used to. A merge to `main` publishes to
three stores, so an unprotected `main` is an unprotected publish
button.

| Rule | Covered today by | Status |
|---|---|---|
| Pull request required (no direct push) | Nothing mechanical — process commitment only | `[pending]` |
| CI lint (`ci.yml::lint-js`, `lint-python`) | The jobs are SHA-pinned and now run on every push to `main` and every pull request | `[live]` |
| Manifest validation (`ci.yml::validate-manifest`) | `preflight --checks=manifest` in the pre-push hook, covering both store transforms; the CI job now runs on push and PR too | `[hook]` + `[live]` |
| ~~Native host name pin~~ | **Out of scope for this repository, 2026-08-31.** The check cross-checked `shared/constants.js::NATIVE_HOST` and the published extension IDs against the native messaging host's manifest templates. Those templates are installed by the Locke desktop app and are not part of this repository, so neither half of the contract is readable here; `scripts/preflight.mjs` no longer offers a `native-host` check and says so in a comment where it used to live. The check belongs with the host | *(withdrawn)* |
| Unit tests | `preflight --checks=tests` in the pre-push hook (`npm test`); `ci.yml::Unit tests (node:test)` now runs on push and PR | `[hook]` + `[live]` |
| Version-site consistency | `preflight --checks=version` in the pre-push hook | `[hook]` |
| Payload audit (`quality.yml::payload-audit`) | `scripts/audit-payload.mjs` over the staged payload: fails on any non-loopback absolute URL outside the `https://sonomos.ai/` product link, and on `eval`, `new Function`, remote dynamic `import()`, `document.write` or concatenated `innerHTML`. `tests/audit-payload.test.js` (14 tests) proves each check fires | `[gate]` |
| Reproducible build (`quality.yml::reproducible-build`) | Builds twice under a fixed `SOURCE_DATE_EPOCH` and fails unless the zips are byte-identical | `[gate]` |
| Action pinning (`quality.yml::actions-pinned`) | Fails if any `uses:` is not a 40-character commit SHA. 51 references, all pinned | `[gate]` |
| Generated-file drift (`quality.yml::generated-drift`) | `npm run generate` must be a no-op, so the manifest's declared matches cannot silently disagree with the surface catalog | `[gate]` |
| Package smoke (`quality.yml::package-smoke`) | Both zips build; 5 MB size tripwire; asserts `shared/ai-surfaces.json` never ships | `[gate]` |
| AMO lint (`quality.yml::amo-lint`) | Mozilla's own `addons-linter` via `web-ext lint --warnings-as-errors` on the Firefox payload, so a policy violation is caught before an automated submission rather than by a reviewer days later | `[gate]` |
| Permission diff (`quality.yml::permission-diff`) | Renders any change to `permissions`, `host_permissions` or content-script matches into the PR summary. **Non-failing by design** — it informs review, it does not gate | `[live]` |
| Trivy scan (`ci.yml::trivy`) | Now runs on every push to `main` and pull request. No run has completed in this repository | `[live]` |
| Gitleaks secret scan | Now runs on push, pull request and weekly. No run has completed in this repository | `[live]` |
| Semgrep SAST | Now runs on push, pull request and weekly. No run has completed in this repository | `[live]` |
| CodeQL SAST | Now runs on push, pull request and weekly. Result upload needed GitHub Advanced Security, which is available on public repositories — to be confirmed by the first run | `[live]` |
| Dependency review | Now runs on `pull_request`; available on public repositories. The repo declares zero JS dependencies, so it has little to find | `[live]` |
| All CODEOWNER paths reviewed | `CODEOWNERS` exists; enforcement needs branch protection | `[pending]` |
| Conversation resolution required | Nothing | `[pending]` |
| Up-to-date branch required | Nothing | `[pending]` |
| Force pushes disallowed | Nothing | `[pending]` |
| Deletion disallowed | Nothing | `[pending]` |
| Linear history required | Nothing | `[pending]` |

Every `[hook]` row is bypassable with `git push --no-verify`. Every
`[live]` and `[gate]` row runs server-side from the first push — but
**none of them is a required status check**, because branch protection
is not configured, and **none of them has run yet** in this repository.
A `[gate]` row will fail its job when the property it guards is
violated, and the test suites named beside it show the check bites; a
`[live]` scanner row has produced nothing so far. Do not represent any
row here to an auditor as an *enforced* merge requirement until branch
protection lists it.

Job and step names in `.github/workflows/` are load-bearing: this
table, `CONTROL-CATALOG.md` and `ASVS-MAPPING.md` cite them verbatim,
and branch protection will eventually be configured against them.
Renaming one breaks both the audit trail and the required-checks
config.

## Signed commits

- **Nothing enforces a signature on anything today.** `[pending]` —
  publication is driven by the merge commit on `main`, not by a tag, so
  a tag signature is not on the path to a release even when one is cut.
  Sign tags (`git tag -s`) as a matter of practice; do not represent it
  as a control.
- **Recommended for all commits.** Branch protection should require
  signed commits; verify on the GitHub repo settings page.

## Artifact integrity

**Correction, 2026-08-12; restated 2026-09-01.** The artifact names
below were once stale: this table listed `sonomos-extension-<v>.zip` and
a tarball for the native messaging host, neither of which any build in
this repo has ever produced. `scripts/package.mjs` emits exactly two
files. The sigstore bundles, SLSA attestation and SBOMs are real steps
in `release.yml`, which now runs on push to `main` — but **no release
has been published through it**, so none of them has been produced for
any shipped version.

Every release produces:

| Artifact | Purpose | Verification | Status |
|---|---|---|---|
| `dist/locke-extension-<version>-chromium.zip` | Chrome Web Store **and** Edge Add-ons submission package | Rebuild the published commit with `SOURCE_DATE_EPOCH` and `sha256sum`-compare | Produced by `npm run package` |
| `dist/locke-extension-<version>-firefox.zip` | Firefox AMO submission package | Same | Produced by `npm run package` |
| `dist/publish-report.json` | Per-store submission outcome, secrets redacted | Read it; `ok:false` on any store exits 1 | Produced by `scripts/publish.mjs` |
| `<artifact>.zip.sha256` | Checksum sidecar | `sha256sum -c` | `release.yml::sha256 sidecars` — the step runs on push to `main`, but no release has been published, so no sidecar exists yet |
| `<artifact>.zip.sigstore.bundle` | Keyless OIDC signature over each zip | `cosign verify-blob --bundle <artifact>.zip.sigstore.bundle --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp 'release\.yml@refs/heads/main'` — note the identity is a **branch** ref, not a tag: releases are built from `main`, not from a signed tag | `release.yml::Sign artifacts`; nothing shipped so far is signed |
| SLSA build provenance attestation | Provenance | `gh attestation verify <artifact> -R sonomoshq/Locke-Extension` | `release.yml::SLSA build provenance attestation`; nothing shipped so far is attested |
| `sbom.cyclonedx.json` / `sbom.spdx.json` | Dependency inventory | Standard CycloneDX / SPDX consumers | `release.yml` and `sbom.yml`; never published against a version. The extension declares zero runtime dependencies |
| Native-host tarball | — | — | **Not an artifact of this repository.** The native messaging host is built and shipped with the Locke desktop app; nothing here produces or verifies it |

The full IT-side verification recipe lives in
[`docs/enterprise/DEPLOYMENT.md`](../enterprise/DEPLOYMENT.md), and
needs the same correction applied where it names artifacts.

## Reproducible builds

Both zips are built by `scripts/zip.mjs`, a pure-Node deterministic
writer: forward slashes always, fixed external attributes, fixed
deflate level, no extra fields, no archive comment, and one DOS
timestamp shared by every entry. The payload reaches it already sorted
by name — `scripts/store-build.mjs::entries` walks the staged tree and
sorts it, and the writer preserves the order it is given. Same input
tree, identical bytes.

That holds with nothing exported: the default timestamp is a fixed
constant, so a bare `npm run package` is already reproducible.
`SOURCE_DATE_EPOCH` is honoured only when it is set.

**As of 2026-09-01 this is checked on every push, not merely asserted.**
`quality.yml::reproducible-build` builds the payload twice under a fixed
`SOURCE_DATE_EPOCH` and fails the run unless the two zips are
byte-identical, so a change that reintroduces non-determinism cannot
land quietly. No run has completed in this repository yet, but this is a
`[gate]` rather than a `[live]` scanner: the check either passes or
fails the job, and it needs no external service to do so.

Who can act on this. The repository is published under PolyForm Strict
1.0.0 (`LICENSE`), which **permits noncommercial use** — running and
rebuilding the software to verify it is squarely within that, so an
outside reviewer or auditor may reproduce the build themselves and
compare bytes. The licence does not grant the right to redistribute or
modify the software, so what a verifier may do is check the claim, not
ship the result. The release build pins `SOURCE_DATE_EPOCH` to the
published commit's committer time (`git log -1 --pretty=%ct`) and then
calls the same recipe, so a verifier reproduces the release by
exporting the same value.

Documentation for downstream verifiers:

```bash
git checkout <the commit that published this version>
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)
npm run package
sha256sum dist/locke-extension-2.0.1-*.zip
```

With `SOURCE_DATE_EPOCH` unset the writer pins to 315532800
(1980-01-01Z, the ZIP epoch floor), so an ad-hoc local build is still
deterministic — just not identical to a release build. There is no
published `.sha256` sidecar to compare against yet, because no release
has been published; compare against the artifact you submitted. The
`quality.yml::reproducible-build` job performs the same two-build
comparison on every push, so determinism itself is checked continuously
even before a release exists to check against.

## Hotfix releases

A hotfix (e.g. `2.0.1` after `2.0.0`) follows the same flow: bump the
version, write the changelog entry, open a PR, merge. The merge
publishes. Speed is not a reason to skip the pull-request review — it
is now the *only* review, so skipping it under time pressure means
nobody looked at the release at all.

## Release-pipeline failure handling

If publishing fails after the merge:

1. **The version is spent either way.** Stores reject a re-upload of an
   existing version, so a version that reached any store cannot be
   re-cut under the same number.
2. Diagnose from `dist/publish-report.json` and the console output.
   Distinguish the two shapes first: a `skipped` result is `ok:true`
   and means the store had nothing to do (already published, still
   certifying, submission already queued) — no action is needed. Only
   `failed` results need a fix. The per-store failure modes and their
   remedies are tabulated in
   [`docs/store/RELEASE-PIPELINE.md`](../store/RELEASE-PIPELINE.md).
3. If the fix is operational (an expired credential, a queued
   submission that has since cleared), re-run the publisher for the
   affected store only:
   `npm run publish-stores -- --store=edge`. The version is unchanged,
   so nothing about the release identity moves. A store that already
   accepted the version answers `skipped`, which is why re-running all
   three is also safe.
4. If the fix requires a code or manifest change, open a PR bumping to
   the next patch (`2.0.1` → `2.0.2`) with the fix in it. Merging that
   PR publishes the new version — there is no way to "re-cut" the old
   number.
5. The changelog entry for the new version should explain the failed
   predecessor.

The failed version may exist on some stores and not others. Record
which, in the changelog entry for the follow-up — a partial three-store
release is the normal shape of a failure here, and papering over it
makes the next release harder to reason about.

## Coordination with the parent product

If a release breaks compatibility with the Locke desktop app, the
release notes MUST state the minimum desktop-app version required, and
the release SHOULD be coordinated with a desktop-app release that
publishes the matching protocol bump.

Particular attention needed for:

- Any change to the native-messaging message types
  (`shared/constants.js::BRIDGE_MSG`) or to the envelope the host
  speaks to the desktop app
- Any change to the protocol version the native messaging host speaks.
  That host is not part of this repository — it ships with the Locke
  desktop app — so a bump on its side is invisible here and has to be
  coordinated rather than detected
- Changes to the browser-surface list the desktop app and this extension
  both rely on
