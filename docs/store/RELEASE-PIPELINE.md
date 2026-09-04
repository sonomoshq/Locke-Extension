# Release pipeline — operator's guide

How a Locke Extension version gets from a version bump to three store
submissions, what the machinery does at each step, and what to do when a
store says no.

This is the operational companion to
[`docs/security/RELEASE-POLICY.md`](../security/RELEASE-POLICY.md), which
states the *policy*.  This file states the *mechanics*.  Credentials have
their own file: [`CREDENTIALS.md`](CREDENTIALS.md).

> **The publish trigger changed on 2026-08-31.**  A merge to `main`
> publishes to the Chrome Web Store, Edge Add-ons and AMO automatically,
> with **no human approval step**.  There is no tag push to perform and no
> "now publish" command to remember.  The two-person release rule is
> withdrawn; the only review before users get the code is pull-request
> review.  See [The release sequence](#the-release-sequence).

## The two artifacts

`npm run package` wipes `dist/` and writes exactly two zips:

| Artifact | Consumed by | Manifest differences |
|---|---|---|
| `dist/locke-extension-<version>-chromium.zip` | Chrome Web Store **and** Edge Add-ons | `background.scripts` and `browser_specific_settings` stripped (both Gecko-only) |
| `dist/locke-extension-<version>-firefox.zip` | Firefox AMO | `background.service_worker`, `minimum_chrome_version` and `storage` stripped (all Chromium-only) |

Three stores, two zips — not a shortcut.  Edge is code-compatible with
Chrome MV3 and consumes the identical package, so building a third artifact
would only create a way for the Chrome and Edge submissions to drift apart.
`scripts/publish.mjs` encodes the mapping in one frozen object
(`ZIP_FOR_STORE`).

## The build layer

Four modules, each owning exactly one thing:

| Module | Owns |
|---|---|
| `scripts/store-build.mjs` | `TARGETS` (the per-target manifest transforms), `stage()`, `entries()`, `validate()` and `buildAll()` — what goes into a zip, and what a store will accept |
| `scripts/zip.mjs` | `writeZip()` — the deterministic archive format, and nothing that knows about extensions |
| `scripts/package.mjs` | `npm run package`: the sequence stage → validate → zip, refusing to emit a zip for any target that fails |
| `scripts/validate-store.mjs` | `npm run validate`: the same staging and the same checks into a throwaway `dist/.validate`, writing no artifact |

Because both the transforms and the store rules live in `store-build.mjs`
alone, the packager, `npm run validate`, the preflight gate and
`tests/store-build.test.js` cannot disagree about what is inside a store zip.
`scripts/preflight.mjs::checkManifest` re-implements none of it: it stages
both targets into a temp directory through `buildAll` and reports whatever
that validator says.  `npm run validate` is the form to reach for while you
work — it fails on a store-rule regression in seconds without touching
`dist/` or writing a byte.

`validate()` runs against the *staged* tree, not the repo, so it judges the
artifact that actually ships.  It covers the store rules proper — field
limits, icons whose pixels match their declared size, the keys that get an
upload auto-rejected (`update_url`, `key`), a CSP with no `unsafe-eval` or
remote `script-src`, remote-code smells, every file the manifest references
actually being present, the AMO `data_collection_permissions` declaration and
the extension-specific privacy-policy link — plus the two security invariants
the compliance docs cite by name: loopback-only `host_permissions`, and no
wildcard content-script host in any spelling.

Only the runtime payload is staged: the transformed `manifest.json`,
`background/`, `content/`, `popup/`, `shared/`, the PNG icons, and — for
chromium only — `managed-schema.json`, since `storage.managed_schema` is a
Chrome key and Firefox delivers managed storage through a native manifest
instead.  `docs/`, `tests/`, `scripts/`, the Markdown files and
`package.json` never enter a store zip.  The icon SVGs are dropped
because no manifest key references them, and `shared/ai-surfaces.json` is
dropped because it is a build input for `npm run generate` with no runtime
consumer — shipping either only hands a reviewer extra surface to ask about.

## The release sequence

1. **Bump.**  `npm run bump -- patch` (or `minor`, `major`, or an explicit
   `X.Y.Z`).  It writes all five version sites —
   `manifest.json`, `package.json`, both sites inside `package-lock.json`,
   and a dated `## [X.Y.Z] — YYYY-MM-DD` heading in `CHANGELOG.md` — and
   refuses to run if those sites already disagree, because the rewrite only
   replaces strings that currently equal the manifest's version.  It
   deliberately does **not** commit and does **not** tag.
2. **Write the changelog entry.**  The bump inserts a `TODO` placeholder
   **above** whatever was under `[Unreleased]`, which becomes this version's
   body.  `scripts/publish.mjs` reads that section, drops any leading HTML
   comments (a forgotten placeholder never hides the notes beneath it), and
   sends what is left as AMO release notes and Edge certification notes.  A
   section that is empty apart from the placeholder is *no notes at all*.
   Store reviewers read these — and AMO shows release notes on the public
   listing — so write a short reviewer-facing summary at the top and end it
   with a line containing only `<!-- store-notes-end -->`; everything below
   that line stays in the changelog and is never sent.  Edge cuts
   certification notes at 5000 characters and reports the cut in the
   publish report as `notesTruncated`.
3. **PR.**  Open the bump against `main`.
4. **Review.**  A CODEOWNER who is not the PR author reviews and approves.
   Read this as reviewing a *release*, because it is the last look anybody
   gets — see below.
5. **Merge to `main`.**  Nothing ships yet.
6. **Dispatch the Release workflow on `main`** — Actions → Release → "Run
   workflow".  *This* is the publish action.  Nothing else happens and nobody
   else approves.

## What a release dispatch does

Full operator walkthrough — the ten repository secrets, the `store-publish`
environment, how to re-drive a single failed store — is in
[`AUTOMATED-RELEASE.md`](AUTOMATED-RELEASE.md).  The short version:

**First, a gate decides whether this dispatch is a release at all.**
`scripts/release-gate.mjs` (`.github/workflows/release.yml::gate`) asks whether
this repository already has a `v<version>` release tag for
`manifest.json::version`.  Tagged → nothing is built and nothing ships, and the
job is green.  Untagged → it is a release, and the workflow creates that tag as
part of publishing.  So bumping the version is what makes the next dispatch a
release, and re-dispatching afterwards is a safe no-op.  The gate is
fail-closed — a shallow clone, an unreadable tag list, or a dispatch on any ref
but `main` all mean "do not publish" — and it is covered by
`tests/release-gate.test.js`.

If the gate says release, the pipeline runs, in this order:

1. `release.yml::Validate version matches manifest`.
2. `npm test`.
3. `scripts/preflight.mjs` — version-site consistency, both store manifest
   transforms, listing assets.
4. Build the two reproducible zips — `scripts/package.mjs` →
   `scripts/store-build.mjs` → `scripts/zip.mjs` — then sha256 sidecars,
   CycloneDX and SPDX SBOMs, cosign signatures, a SLSA provenance
   attestation, a CI-created tag and a GitHub release.
5. `scripts/publish.mjs` in the `store-publish` job — all three publishers
   concurrently.

**Below the gate, each publisher also refuses to re-submit a version its
store already has.**  That is a safety net, not the gate, and it is what
makes re-driving a failed store safe:

| Store | How it detects "already at this version" | Result |
|---|---|---|
| Chrome | `scripts/publish/chrome.mjs` reads `:fetchStatus`; `classifyStatus().publishedVersion` equals the manifest version (CWS rejects a re-upload of an existing `crxVersion` regardless) | `skipped`, `ok: true` |
| Edge | The Update API answers `NoModulesUpdated` — the draft is byte-identical to what is live — mapped in `scripts/publish/edge.mjs::ERROR_CODES` | `skipped`, `ok: true` |
| Firefox | AMO answers with the "version already exists" family, matched by `ALREADY_PUBLISHED_PATTERNS` in `scripts/publish/firefox.mjs` | `skipped`, `ok: true` |

Only Chrome can genuinely read a live version; Edge and Firefox only answer
at submission time.  That asymmetry is why the gate compares against git
rather than querying three stores — `AUTOMATED-RELEASE.md` sets out the
reasoning.

A `skipped` run is green.  That is the whole reason `ok` is not
`status === 'submitted'` (see
[Reading `dist/publish-report.json`](#reading-distpublish-reportjson)): a
no-op run must not turn the pipeline red, or nobody will read it when it
matters.

Credentials arrive as repository secrets read by the `store-publish` job.  `scripts/lib/creds.mjs` reads
`process.env` before `~/.config/sonomos/release.env`, so this needs no code
change — but two of those secrets expire on a fixed clock and will break
unattended publishing on their own schedule.  Read
[`CREDENTIALS.md`](CREDENTIALS.md) before assuming the pipeline is
self-sufficient: the Chrome refresh token lasts **7 days** while the OAuth
consent screen is in Testing, and the Edge API key lasts **72 days** with no
server-side warning.

**There is no approval gate on the dispatch.**  Clicking Run workflow is a
deliberate act, not a reviewed one: the person who merged the change can be
the person who releases it, seconds later.  Review still has to happen in
pull-request review.  A published version cannot be re-cut — every store
rejects a re-upload of an existing version — so the fix for a bad release is
always a new version, never a withdrawal.

The workflow that invokes the steps above is
`.github/workflows/release.yml`.  If you are auditing this, read that file:
it, not this page, is what actually runs.  Two facts from it that this page
cannot make true on its own — the `store-publish` job's GitHub Environment
carries **no protection rules** (that absence is what makes publishing
unattended), and the tag is created by CI from the manifest version, is
lightweight, and nothing signs it.

## What the pre-push hook does

`scripts/hooks/pre-push` reads the ref list git hands it on stdin and
branches on what is being pushed.  Deletions (an all-zero local sha) and
pushes that contain neither a branch nor a `v*` tag are ignored outright.

| You are pushing | The hook runs |
|---|---|
| Any feature branch | `node scripts/preflight.mjs --checks=version,manifest,tests` |
| `main` | The same checks locally — but **the publish now happens server-side, after the merge lands**, not in this hook |
| `refs/tags/v*` | Working-tree checks, ancestry check, then full preflight (`--tag=… --stores=all`), then a real publish to all three stores |

`[corrected 2026-08-31]` — this section used to end "publishing is bound to
the tag, not to the branch, so a merge to `main` can never accidentally
submit to a store."  **That is no longer true and was the reassuring half of
the old model.**  A merge to `main` is exactly what submits to a store now.
The local hook is a pre-merge safety net only; it cannot gate what happens
after the merge, and it is bypassable with `--no-verify`.

The `native-host` preflight check that used to appear in the branch row is
gone: it cross-checked the pinned host name and the published extension IDs
against the native messaging host's manifest templates, and those templates
are not part of this repository.  `scripts/preflight.mjs` records why in a
comment where the check used to be.

Before a tag publishes, the hook first proves that the tag and the tree
being packaged are the same thing.  `npm run package` zips the **working
tree**, not the tagged commit, so the hook refuses unless `HEAD` is exactly
the tagged sha and `git status --porcelain` is empty.  Without those two
checks, tagging a reviewed merge commit while carrying uncommitted debug
code would ship that code to three stores under a tag that does not contain
it — and would quietly void the reproducible-build claim, since
`SOURCE_DATE_EPOCH` pins timestamps but nothing pins content.

Then the hook fetches `<remote>/main` and requires the
tagged commit to be an ancestor of it.  It cannot verify *who* approved the
PR — no client-side hook can — but it can prove the commit being shipped is
one the remote already has, which rules out publishing a build from a commit
nobody else has ever seen.  If the fetch fails, the hook refuses rather than
assuming.

### The five-second abort window

`scripts/publish.mjs` prints what it is about to submit and then waits
`ABORT_WINDOW_MS` (5000 ms) before the first upload, giving you a window to
hit Ctrl-C.  It applies only when all three of these hold: this is not a dry
run, `--yes`/`-y` was not passed, and stdin is a TTY (so it never stalls a
non-interactive run).

That last condition is why the hook runs the publisher with `</dev/tty`.
Git feeds the hook its ref list on stdin, so the publisher would otherwise
inherit a pipe, `process.stdin.isTTY` would be `undefined`, and the window
would be skipped on the one code path that actually submits — leaving it
active only for a manual `node scripts/publish.mjs`, which needs it least.
When there is no controlling terminal at all (a scripted push, a CI runner)
the hook falls through without it: there is nobody to prompt.

Note what that means for the automated pipeline: **there is no abort window
on a merge-triggered publish.**  A CI runner has no TTY, so the condition is
false by construction and the publisher goes straight to the first upload.
The five seconds only ever existed for a human at a terminal.

Five seconds looks like theatre until you price the alternative: a mistyped
tag burns a review cycle at all three stores at once, and Edge restarts its
seven-business-day certification clock on republish.

### The bypass

`git push --no-verify` skips the pre-push hook entirely — no preflight, no
tests, and for a `v*` tag, no publish.  That is git's behaviour, not
something this repo can gate.  It also skips the crux hook in the same
stroke, for the same reason.

### Installing the hook

```sh
npm run install-hooks            # or: npm run install-hooks -- --force
```

`scripts/install-hooks.mjs` copies everything in `scripts/hooks/` into
`$(git rev-parse --git-common-dir)/hooks/` and marks it `0755`.  It also runs
as npm's `prepare` script, so a plain `npm install` installs the hook.  An
existing hook that does not carry the `Locke Extension pre-push gate` marker
is left alone with a warning — a postinstall step that silently overwrote
someone's own hook would be a hostile thing to do — which is what `--force`
overrides.

After copying, the installer checks whether the hook can actually **run**,
and exits non-zero if it cannot.  This is not paranoia.  A global
`core.hooksPath` overrides the repository's hooks directory entirely;
well-behaved tools install a shim there that delegates back to the
repo-local hook, but those shims guard against infinite recursion by
`grep`-ing the local hook for their own vendor name — so a repo hook that
merely *mentions* the tool in a comment matches that grep and is skipped.
This exact failure shipped once here: the gate was installed, reported
success, and never ran, while `git push` exited 0 and said nothing.  The
installer now replays the shim's own `grep -q` guards against the hook text
and refuses to call the install a success if any of them match.  If you edit
the comments in `scripts/hooks/pre-push`, re-run `npm run install-hooks` and
read its output.

`--git-common-dir`, not `--git-dir`.  In a linked worktree, `--git-dir`
points at the worktree's private `.git/worktrees/<name>` directory, whose
`hooks/` git does not consult; `--git-common-dir` points at the shared `.git`
that every worktree of this repo actually reads.  Installing to the wrong one
produces a hook that exists, is executable, and never runs.

**Do not set a repo-local `core.hooksPath`.**  This machine has a *global*
`core.hooksPath` pointing at the crux shims in `~/.config/crux/git-hooks`,
and those shims delegate to the repo-local hook and propagate its exit
status — so installing into `$(git rev-parse --git-common-dir)/hooks/` chains
both.  `core.hooksPath` holds a single path, not a search list: a repo-local
value would win over the global one and silently disable crux for this repo,
with no error and no warning.

The npm scripts, for reference:

| Script | Runs |
|---|---|
| `npm test` | `node --test tests/*.test.js` |
| `npm run package` | `scripts/package.mjs` |
| `npm run preflight` | `scripts/preflight.mjs` |
| `npm run publish-stores` | `scripts/publish.mjs` |
| `npm run bump` | `scripts/bump-version.mjs` |
| `npm run install-hooks` | `scripts/install-hooks.mjs` |

The publish alias is `publish-stores`, not `publish`: npm reserves
`npm publish` for registry publication, and an alias by that name would make
a typo mean something very different from what was intended.

## Dry runs

```sh
npm run publish-stores -- --dry-run
```

A dry run still runs the *full* preflight (including the credential check for
every selected store) and still builds `dist/` unless you pass `--no-build`.
It skips the abort window, since nothing is submitted.  What it does per
store differs, because the three APIs offer different amounts of read-only
surface:

| Store | Network touched | What it proves |
|---|---|---|
| Chrome | Yes — mints a real OAuth access token, then one read-only `:fetchStatus` | The refresh token is alive, the item exists, and whether a submission is already queued.  Nothing is uploaded. |
| Edge | No | Credentials are present, and the product ID and notes are the ones you expect.  Edge exposes no read-only status endpoint — every other verb mutates the draft — so a dry run genuinely cannot check more. |
| Firefox | No | Credentials, `gecko.id`, `data_collection_permissions` and the artifact are submission-ready.  It stops before uploading on purpose: an accepted AMO upload creates a server-side validation job and a uuid tied to the account, so "just checking" would leave debris. |

The Chrome dry run consumes a refresh-token round trip.  That is worth
knowing while the OAuth consent screen is in Testing status — see
[`CREDENTIALS.md`](CREDENTIALS.md).

Useful narrower forms:

```sh
npm run preflight -- --skip-tests             # everything but npm test
npm run preflight -- --stores=firefox --json  # machine-readable
npm run publish-stores -- --store=chrome,edge --dry-run
```

## Reading `dist/publish-report.json`

Every run of `scripts/publish.mjs` writes `dist/publish-report.json`,
whether it succeeded or not:

```json
{
  "version": "2.0.1",
  "dryRun": false,
  "releaseNotes": true,
  "results": [
    { "store": "chrome",  "ok": true,  "status": "submitted", "message": "…", "data": {} },
    { "store": "edge",    "ok": true,  "status": "skipped",   "message": "…", "data": {} },
    { "store": "firefox", "ok": false, "status": "failed",    "message": "…", "data": {} }
  ],
  "at": "2026-08-12T00:00:00.000Z"
}
```

- `releaseNotes: false` means the CHANGELOG section for this version was
  missing or still held the `TODO` placeholder.  The release goes out; AMO
  and Edge just get no notes.  Fix the changelog before merging.
- `status` is one of `submitted`, `skipped`, `dry-run` or `failed`.
- `ok` is **not** `status === 'submitted'`.  A `skipped` result is `ok: true`
  on purpose — "Edge is still certifying yesterday's build" is a scheduling
  fact, not a broken release, and it must not turn a three-store run red.
  It is also what makes an unrelated merge a green no-op rather than a
  failure.
- The process exits 1 if any result has `ok: false`.  One store failing never
  cancels the others; all three publishers run concurrently and each returns
  a result object rather than throwing.
- `data` carries the per-store forensics: the Chrome `:fetchStatus`
  classification, the Edge `packageOperationId` / `submissionOperationId`, the
  AMO upload uuid and validation summary.
- Secrets are redacted from every message before it is written or logged —
  both the known values from the environment and any `Bearer`/`JWT`/`ApiKey`
  token that appears in an error body.

`submitted` never means *live*.  Chrome enters review, Edge enters
certification (up to seven business days, with no API to poll), and AMO signs
and publishes automatically but reviews afterwards — `nativeMessaging` all
but guarantees a human will look.

## Reproducible builds

`scripts/zip.mjs` is a pure-Node deterministic ZIP writer: forward slashes
always, fixed external attributes, fixed deflate level, no extra fields, no
archive comment, and one DOS timestamp shared by every entry.  It writes
entries in the order it is handed them; the sorting happens upstream in
`scripts/store-build.mjs::entries`, which walks the staged tree and sorts by
name.  Same input tree, identical bytes.

That is true with nothing exported — the default stamp is a fixed constant
(2020-01-01), so an ad-hoc `npm run package` is already reproducible.
`SOURCE_DATE_EPOCH` is honoured only when it is set, and it overrides the
constant.  It is not what makes the build deterministic; it is what makes a
local rebuild byte-identical to a *release* build, which pins the value to
the published commit's committer time:

```sh
git checkout <the commit that published this version>
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)
npm run package
sha256sum dist/locke-extension-2.0.1-*.zip
```

Skip the `export` and you still get the same two zips every time, just
stamped 2020-01-01 rather than matching the published artifacts.  A value
below 315532800 (1980-01-01Z) is clamped up to it, because that is the floor
the DOS date field can represent.

Note who is licensed to do this.  The repository is published under a
PolyForm Strict 1.0.0 licence (`LICENSE`), which permits noncommercial use of the
Software, so the recipe above is published for inspection rather than as an
invitation — see `docs/security/RELEASE-POLICY.md`, "Reproducible builds".

This replaced `Compress-Archive` and `zip` for two independent reasons.
PowerShell's `Compress-Archive` writes entry names with backslash separators,
which every store validator reads as one flat filename — so `manifest.json`
is "not at the archive root" and the upload is rejected, silently and only on
Windows-built artifacts.  And neither tool is reproducible: both stamp the
current wall clock into every entry.

## Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| chrome `skipped`: item is already `PENDING_REVIEW` | A submission is queued; CWS refuses an upload while one is | Wait for the review to finish, then re-run `npm run publish-stores -- --store=chrome`.  Not a failure. |
| chrome `skipped`: version already published | CWS always rejects a re-upload of an existing `crxVersion` | Bump to a new version and merge again.  A re-run against a finished release is expected to skip. |
| chrome `skipped`: unreleased `STAGED` revision | A reviewed-but-unreleased build occupies the draft slot; uploading would discard it | Release or cancel it in the Developer Dashboard, then re-run. |
| chrome `failed`: `token refresh failed — invalid_grant` | The refresh token expired (7 days, while the consent screen is in Testing) or was revoked | Mint a new `CWS_REFRESH_TOKEN`; see `CREDENTIALS.md`.  On an unattended pipeline this is the failure you should expect most often. |
| edge `skipped`: `InProgressSubmission` | A previous submission is still in certification, which can take 7 business days | Retry once it clears.  Nothing is wrong. |
| edge `skipped`: `NoModulesUpdated` | The draft is byte-identical to what is already live | Nothing to submit.  This is the normal result of a merge that did not change the extension. |
| edge `failed`: `CreateNotAllowed` | The Update API can update a product but can never create one | Create the extension once by hand in Partner Center, then set `EDGE_PRODUCT_ID`. |
| edge `failed`: `ModuleStateUnPublishable` | The Partner Center listing/availability sections are incomplete | Finish the listing by hand, then re-run. |
| edge `failed`: HTTP 401 blaming the API key | Either the key is past its 72-day life, or the `X-ClientID` header was "normalised" to `X-Client-ID` | Check `EDGE_API_KEY_ISSUED` first; the header spelling in `scripts/publish/edge.mjs` is correct as written — do not change it. |
| firefox `skipped`: version already exists / already submitted | AMO already has this version, or the upload uuid was already attached (a uuid may be attached exactly once) | Nothing to do.  This is what a re-run against a finished release looks like. |
| firefox `failed`: package failed AMO validation | `addons-linter` returned `valid: false`; the report carries the first ten errors | Fix the package.  Linter *warnings* never block signing — only `valid: false` does. |
| firefox `failed`: `data_collection_permissions` missing | AMO blocks submission outright without it | Set `gecko.data_collection_permissions.required` to `["none"]` when nothing is collected. |
| Any store `failed`: artifact missing | `dist/` was not built, or the version in the filename does not match the manifest | `npm run package`, or re-run publish without `--no-build`. |
| `node --test tests/` dies with `Cannot find module …\tests` | Node 24 resolves the bare directory as a module. This is not a preflight bug — `checkTests` enumerates `tests/*.test.js` itself, because `execFileSync` does not expand a glob the way npm's shell does | Run `npm test`.  Verified on Node 24.11.0, 2026-08-12. |
| preflight warns that `CWS_EXTENSION_ID` is unset | It is a required Chrome credential.  *(As of 2026-08-31 it no longer doubles as an `allowed_origins` cross-check — see below.)* | Set it from the dashboard item ID; `CREDENTIALS.md`. |
| The extension installs from a store but native messaging never connects | The published extension IDs are not listed in the native-messaging host's `allowed_origins`.  **Nothing in this repository checks this any more** — the host's manifest templates are not here, so the check moved to where the host is built | Add the real IDs on the host side after the first publish.  This is still the most likely "shipped and instantly broken" failure, and it is now *unwarned* on this side and published without a human in the loop. |

## GitHub Actions

Nine workflows are committed under `.github/workflows/` — `ci.yml`,
`codeql.yml`, `dependency-review.yml`, `gitleaks.yml`, `quality.yml`,
`release.yml`, `sbom.yml`, `scorecard.yml`, `semgrep.yml`.

`[updated 2026-09-01]` — this section used to open "**every one of them is
`workflow_dispatch`-only**", and later "all but `release.yml`".  **Eight of
the nine now carry real triggers**: `push` to `main` and/or `pull_request`
for `ci.yml`, `codeql.yml`, `semgrep.yml`, `gitleaks.yml` and `quality.yml`;
`pull_request` for `dependency-review.yml`; weekly schedules on `codeql.yml`,
`semgrep.yml`, `gitleaks.yml` and `scorecard.yml`; monthly on `sbom.yml`.
The `─── uncomment on open-source day ───` markers are gone with them.

**`release.yml` is the ninth and stays `workflow_dispatch`-only** (Sonomos
#190).  It briefly ran on push to `main`, which made merging the publish
action — the one thing on this page that should never happen by accident.

The dispatch-only arrangement was a billing decision: GitHub bills Actions
minutes on private repositories, so while this repo was private the workflows
had to consume exactly zero.  Actions are free on public repositories, which
this now is, so the reason no longer applies.

Two honest qualifications, both of which matter more than the triggers:

1. **Nothing has run here yet.**  This is a fresh public repository with no
   run history.  A workflow that is enabled will run from the first push; it
   has not produced a finding, a clean result, or a score.  Do not read a
   live trigger as a passing check.
2. **Nothing is a *required* check.**  Branch protection on `main` is still
   not configured, so a failing job is visible but does not block a merge —
   and the release dispatch does not read those checks either, so a red
   `main` can still be released from.  `docs/security/RELEASE-POLICY.md`
   records which checks are in which state.

Nothing has been published through `release.yml`, so nothing this repo has
shipped is cosign-signed, carries a SLSA attestation, or has an SBOM bound to
a version.

**`quality.yml` is new and is the part of this pipeline that actually
gates.**  Its jobs fail the run rather than reporting findings:

| Job | Fails when |
|---|---|
| `payload-audit` | the **staged** payload contains an absolute URL that is not `127.0.0.1`/`localhost` or the `https://sonomos.ai/` product link, or contains `eval`, `new Function`, a remote dynamic `import()`, `document.write`, or `innerHTML` built by concatenation.  Covered by `tests/audit-payload.test.js` (14 tests, including proof it fails on an exfiltration endpoint and on `eval`) |
| `reproducible-build` | two builds under a fixed `SOURCE_DATE_EPOCH` are not byte-identical |
| `actions-pinned` | any `uses:` is not a 40-character commit SHA (51 references today, all pinned) |
| `generated-drift` | `npm run generate` is not a no-op — the manifest's declared matches cannot silently disagree with the surface catalog |
| `package-smoke` | either zip fails to build, a zip exceeds the 5 MB tripwire, or `shared/ai-surfaces.json` reaches the payload |
| `amo-lint` | Mozilla's own `addons-linter` (`web-ext lint --warnings-as-errors`) rejects the Firefox payload — so an AMO policy violation is caught before an automated submission, not days later by a reviewer |
| `permission-diff` | never — it is non-failing by design, and renders any change to `permissions`, `host_permissions` or content-script matches into the PR summary |

The local pre-push hook still runs and is still bypassable with
`git push --no-verify`; it is no longer the *only* check, which it was
until 2026-09-01.

`[updated 2026-08-31]` — the *publishing* half is a different story, and it
is the wrong way round.  Publication is now automatic on merge to `main`
(see [What a merge to `main` does](#what-a-merge-to-main-does)), so the part
of the pipeline that ships to users runs server-side and unattended, while
the parts that would gate it — required status checks, required review,
branch protection — are the parts that are still off.  Read that as the
finding it is, not as a transition state that will resolve itself.

Three of the workflows are additionally blocked by repository visibility, not
just by their triggers: CodeQL result upload and dependency-review both need
GitHub Advanced Security on a private repo (free on public), and OpenSSF
Scorecard's `publish_results` only works on a public repo.

You can still dispatch a workflow by hand.  `release.yml` builds, generates
CycloneDX and SPDX SBOMs, cosign-signs each zip into a `.sigstore.bundle`,
emits a SLSA build-provenance attestation, and creates the GitHub release.

**Do not describe its `store-publish` environment as an approval gate.**
This section used to say a human has to approve before anything reaches a
store.  Under the merge-to-`main` model that is not the shape of the system:
publication happens without a human approving it.  If a required-reviewer
gate is configured on that environment it applies to *that* job only, and
the honest statement of the pipeline as a whole is that nothing stands
between a merge and three store submissions.  Read
`.github/workflows/release.yml` for what actually runs; this page describes
the intent, and the file is the authority.

Nothing in this pipeline needed rewriting when the repository went public.
The hook and the workflows call the same `scripts/preflight.mjs` and
`scripts/publish.mjs` entry points.  What changed is where they run and who
can skip them.  Status of that list as of 2026-09-01:

- ~~Uncomment the `on: push` / `on: pull_request` triggers~~ — **done.**
  All nine workflows carry real triggers.
- **Still open: flip `publish_results` to `true` in `scorecard.yml`.**  It
  is `false` today, so a Scorecard run writes a SARIF artifact and publishes
  no score and earns no badge.  Turning it on writes to the public OpenSSF
  dataset, which is a deliberate decision nobody has taken yet.
- Move the store credentials from `~/.config/sonomos/release.env` into
  repository secrets (`scripts/lib/creds.mjs` reads `process.env` first, so
  no code changes).  Note the consequence for the threat model: unattended
  publishing means those credentials live in the repository's Actions
  secrets, which is a different exposure from a file on one laptop
  (`docs/security/RISK-REGISTER.md` R-04).
- **Still open, and now the item that matters most: configure branch
  protection on `main` with the CI jobs as *required* status checks.**
  Enabling a trigger makes a check run; it does not make it block.  A merge
  to `main` publishes, so until this is configured an unprotected `main` is
  an unprotected publish button (`docs/security/RISK-REGISTER.md` R-15).
  At minimum require the `quality.yml` gates and `ci.yml`.
- **Still open: confirm the first completed run of each workflow.**  No run
  has happened in this repository.  Until one has, every "enabled" statement
  in `docs/security/` describes wiring, not a result.
- `ci.yml`'s native-host job has nothing left to check in this repository:
  the native messaging host is built and installed by the Locke desktop app
  and its sources are not here.  Whatever remains of that job should move to
  the repository that builds the host, and this file no longer cites it.

Do not rename the remaining jobs or steps in those files while doing it.
`ci.yml::lint-js`, `lint-python`, `validate-manifest`, `trivy`,
`release.yml::Validate version matches manifest` / `Build extension zip
(reproducible)` / `Sign artifacts`, and the `quality.yml` job names
(`payload-audit`, `reproducible-build`, `actions-pinned`,
`generated-drift`, `permission-diff`, `package-smoke`, `amo-lint`) are cited
verbatim by `RELEASE-POLICY.md`, `CONTROL-CATALOG.md`, `ASVS-MAPPING.md`,
`HONEST.md` and the legal templates, and a rename silently breaks both the
audit trail and the branch-protection config.
