# Release policy

How a Locke Extension release gets built and published. This policy is
a mix of automated guards and process commitments, and the two are
**not** currently enforced in the same place — see
[Enforcement status](#enforcement-status-2026-09-01) before treating
any line below as a control an auditor can rely on.

**Read [How a release publishes](#how-a-release-publishes) first.**
Publishing is a **manual dispatch**: somebody opens Actions → Release →
"Run workflow" on `main`, and that is what submits to the extension
stores. Merging does not publish. There is still **no second-person
approval step** — the two-person release rule this document used to
carry has been withdrawn and has not come back.

The operator-facing mechanics (commands, dry runs, store failure
modes) live in
[`docs/store/RELEASE-PIPELINE.md`](../store/RELEASE-PIPELINE.md);
credentials in
[`docs/store/CREDENTIALS.md`](../store/CREDENTIALS.md).

## Enforcement status (2026-09-01)

Until recently every workflow in `.github/workflows/` was
`workflow_dispatch`-only, with its real triggers commented out, and the
only checks that ran were local ones in the `scripts/hooks/pre-push` git
hook. **That has changed: eight of the nine workflows now carry real
triggers** — `push` to `main` and/or `pull_request` for `ci.yml`,
`codeql.yml`, `semgrep.yml`, `gitleaks.yml`, `quality.yml` and
`dependency-review.yml`, plus weekly schedules on `codeql.yml`,
`semgrep.yml`, `gitleaks.yml` and `scorecard.yml` and a monthly one on
`sbom.yml`.

`release.yml` is the ninth, and it is deliberately the exception:
**`workflow_dispatch` only** (Sonomos #190). It briefly ran on every push
to `main`, which made merging the publish action; that trigger has been
removed and `tests/release-gate.test.js` asserts that no workflow in the
repository pairs a push, pull-request or schedule trigger with a store
publish.

Two things a reader should not conflate:

1. **A workflow that runs is not a required check.** Branch protection
   on `main` is still not configured, so a failing job is visible but
   does not block a merge. It no longer blocks a *release* either, which
   is the more serious half: the release dispatch does not consult the
   status of the checks that ran on the commit it is building. That is
   the single largest gap in this policy (`RISK-REGISTER.md` R-15).
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

**Publication needs a deliberate human action, and nothing more than
that.** One person dispatching `release.yml` on `main` builds, tests,
runs preflight and publishes to three stores (see
[How a release publishes](#how-a-release-publishes)). Everything after
the click is unattended, and nobody else has to agree at any point. So
the honest description is: publication is *intentional* but *unreviewed*,
while the checks that would gate it are not yet required. Do not upgrade
"someone had to click it" into an approval step.

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
  publisher compares against the store's live version, so the version on
  `main` at dispatch time is the release identity.
- **The `v<version>` tag is now load-bearing, as a record rather than a
  trigger.** `scripts/release-gate.mjs` reads the tag set to answer "has
  this version already been released?", and `release.yml` creates the tag
  as part of publishing. Deleting a release tag therefore re-arms a
  version for republication — don't, unless that is precisely what you
  mean. Pushing a `v*` tag from a workstation publishes by a different
  route entirely (`scripts/hooks/pre-push`); the two paths compose,
  because a version already tagged that way is one the CI gate then
  declines to submit again.
- All five version sites MUST agree: `manifest.json`, `package.json`,
  both sites in `package-lock.json`, and the dated `CHANGELOG.md`
  heading. `npm run preflight -- --checks=version` fails on a mismatch
  (`scripts/lib/version.mjs::checkVersions`), and preflight runs in the
  publish path.
- `npm run bump -- <major|minor|patch|X.Y.Z>` writes all five sites at
  once. It deliberately does not commit and does not tag.

## How a release publishes

> **Changed 2026-09-01 (Sonomos #190). Publishing is a manual dispatch;
> merging ships nothing.** `release.yml` is `workflow_dispatch`-only. Its
> `push` trigger — which made every version-changing merge to `main` an
> unattended three-store submission — has been removed.
>
> **This is not an approval gate, and must not be cited as one.** The
> two-person release rule that used to sit in this section — "the person
> who tags a release MUST NOT be the same person who approved the release
> PR" — remains **withdrawn**, and every document that cited it as a
> control has been corrected (`CONTROL-CATALOG.md`, `ASVS-MAPPING.md`,
> `CII-CHECKLIST.md`, `RISK-REGISTER.md` R-04/R-15). One person can still
> review, merge and dispatch. What dispatch-only buys is narrower and
> worth naming precisely: **shipping is now an act somebody has to
> choose**, rather than a side effect of a merge that may have been about
> something else.

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
   is still the *only* review before the extension reaches users.
3. **Merge to `main`.** Nothing ships. No workflow submits anything to a
   store on a push, and `tests/release-gate.test.js` asserts that.
4. **Dispatch the Release workflow on `main`** — Actions → Release → "Run
   workflow", branch `main`. That is the publish action. It is deliberate,
   it is attributable to whoever clicked it in the run's metadata, and
   nobody else has to agree.
5. **The version gate decides whether this dispatch is a release.**
   `scripts/release-gate.mjs` (`.github/workflows/release.yml::gate`)
   asks whether this repository already has a `v<version>` release tag for
   `manifest.json::version`. Tagged → the pipeline stops, nothing ships,
   and the job is green, so re-dispatching to look at the workflow is
   safe. Untagged → it is a release, and `release.yml` creates the tag as
   part of publishing.

   The comparison used to be against the **parent commit** — right for a
   push trigger, wrong for a dispatch. Under dispatch the tip of `main` is
   routinely not the bump commit, so a parent-commit gate would answer
   "unchanged" on a perfectly good release and `force: true` would become
   the way every release is cut. An override used every time is not an
   override.

   The gate is **fail-closed in four directions**, all covered by
   `tests/release-gate.test.js`:
   - the version already has a release tag → no publish
   - a **shallow** clone, where a missing tag proves nothing → no publish
     (which is why the `gate` job checks out with `fetch-depth: 0`)
   - git unavailable or the tag list unreadable → no publish
   - a dispatch on **any ref but `main`** → no publish, and `--force`
     does **not** override this one. Dispatch, unlike the push trigger it
     replaced, lets the operator pick a branch; building a release from an
     unreviewed one would sign it under a sigstore identity that does not
     match the verification recipe published under
     [Artifact integrity](#artifact-integrity).

   `force: true` remains for exactly one case: re-driving a publish that
   failed *after* the tag was created.
6. If the gate says release, the pipeline runs, in this order:
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
7. **Per-store version checks are a safety net below the gate, not the
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
8. **`submitted` is still not `live`.** Chrome enters review, Edge
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
**still has to happen at pull-request review time.** Dispatch-only did
not add a checkpoint: it moved the moment of shipping, not the moment of
review, and the person who dispatches is typically the person who
merged. Concretely:

- The *dispatch* is what is irreversible, and it is irreversible in the
  direction that matters. Stores reject a re-upload of an existing
  version, so a bad release is corrected by publishing a *new* version,
  never by withdrawing the one that went out. What dispatch-only changes
  is that a merge is now recoverable: a mistake noticed after merging and
  before dispatching can be fixed with another merge, which was not true
  when the merge itself submitted to three stores.
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
  `main` and then dispatch a release from it, with nobody having looked
  at either step. This is the largest single gap in this policy and it is
  tracked as `RISK-REGISTER.md` R-15.
- **Who may dispatch is GitHub's `actions: write` permission, and
  nothing narrower.** There is no allowlist of release operators in this
  repository. Restricting the `store-publish` environment to named
  reviewers is still the change that would turn this into a real approval
  gate; see the note above about keeping this document true if you make
  it.

Do not describe any of the above to an auditor as separation of duties.
It is not. It is one review, unenforced, before a publish that one
person chooses to run.

### Credential expiry is a release-blocking hazard

Two known credential lifetimes are pipeline outages waiting to happen,
and neither has an owner yet. Dispatch-only softens the *symptom* and not
the problem: the failure now lands on somebody who is watching the run
they just started, rather than on a merge nobody was watching. It is
still a failed release either way.

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

This table matters. A merge to `main` no longer publishes, but a release
is dispatched from whatever `main` holds at that moment, and the gate
does not read the status of the checks that ran on it — so an unprotected
`main` is still what a release is built from.

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
  publication is driven by a dispatch against `main`, and the `v<version>`
  tag is created by CI *after* the build, so a tag signature is not on
  the path to a release even when one is cut.
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
in `release.yml`, which is dispatched by hand — but **no release has
been published through it**, so none of them has been produced for any
shipped version.

Every release produces:

| Artifact | Purpose | Verification | Status |
|---|---|---|---|
| `dist/locke-extension-<version>-chromium.zip` | Chrome Web Store **and** Edge Add-ons submission package | Rebuild the published commit with `SOURCE_DATE_EPOCH` and `sha256sum`-compare | Produced by `npm run package` |
| `dist/locke-extension-<version>-firefox.zip` | Firefox AMO submission package | Same | Produced by `npm run package` |
| `dist/publish-report.json` | Per-store submission outcome, secrets redacted | Read it; `ok:false` on any store exits 1 | Produced by `scripts/publish.mjs` |
| `<artifact>.zip.sha256` | Checksum sidecar | `sha256sum -c` | `release.yml::sha256 sidecars` — the step runs on a release dispatch, but no release has been published, so no sidecar exists yet |
| `<artifact>.zip.sigstore.bundle` | Keyless OIDC signature over each zip | `cosign verify-blob --bundle <artifact>.zip.sigstore.bundle --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp 'release\.yml@refs/heads/main'` — note the identity is a **branch** ref, not a tag: releases are built from `main`, not from a signed tag | `release.yml::Sign artifacts`; nothing shipped so far is signed |
| SLSA build provenance attestation | Provenance | `gh attestation verify <artifact> -R sonomoshq/Locke-Extension` | `release.yml::SLSA build provenance attestation`; nothing shipped so far is attested |
| `sbom.cyclonedx.json` / `sbom.spdx.json` | Dependency inventory | Standard CycloneDX / SPDX consumers | `release.yml` and `sbom.yml`; never published against a version. The extension declares zero runtime dependencies |
| Native-host tarball | — | — | **Not an artifact of this repository.** The native messaging host is built and shipped with the Locke desktop app; nothing here produces or verifies it |

The full IT-side verification recipe lives in
[`docs/enterprise/DEPLOYMENT.md`](../enterprise/DEPLOYMENT.md). `[updated
2026-09-01]` — it used to name artifacts no build here has ever produced;
it now lists exactly what `scripts/package.mjs` and `release.yml` emit,
with a column saying that none of it exists yet.

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
version, write the changelog entry, open a PR, merge, dispatch. Speed is
not a reason to skip the pull-request review — it is still the *only*
review, so skipping it under time pressure means nobody looked at the
release at all. Dispatch-only does not help here: the same person under
the same time pressure clicks the button.

## Release-pipeline failure handling

If publishing fails after the dispatch:

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
   the next patch (`2.0.1` → `2.0.2`) with the fix in it. Merge it and
   dispatch again — there is no way to "re-cut" the old number.
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
