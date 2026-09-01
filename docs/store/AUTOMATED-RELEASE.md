# Automated release — how a merge becomes a store update

**A push to `main` publishes to the Chrome Web Store, Edge Add-ons and Firefox
AMO. There is no human approval step.** Merging is the release.

## The rule

`release.yml` publishes when, and only when, `manifest.json`'s `version` differs
from the version at the previous commit. Everything else about the push is
irrelevant.

```
merge to main
  └─ gate            reads manifest.json at HEAD and at HEAD^
      ├─ unchanged   → stop. Nothing is built, nothing ships. Job is green.
      └─ changed     → release  → build, test, sign, attest, GitHub release
                     → store-publish → Chrome + Edge + AMO
```

So an ordinary merge — docs, CI, a refactor — ships nothing. To release, bump
the version in the pull request and merge it:

```sh
npm run bump -- patch     # or minor / major / an explicit X.Y.Z
```

The gate is `scripts/release-gate.mjs`, and it is tested
(`tests/release-gate.test.js`). Its failure posture is deliberate: when it
**cannot tell** what the previous version was — a shallow clone, a rewritten
history, no parent commit — it does **not** publish. A missing answer is not a
yes. `workflow_dispatch` with `force: true` overrides that.

### Why the comparison is against git and not against the stores

The obvious design is to ask each store what version is live. It does not work
uniformly. Chrome exposes a published version; Edge's Partner Center API is
submission-shaped and has no "what is live right now" read; AMO's answer lags
its own review pipeline. A gate that could only be evaluated for one store of
three is a gate in name only.

Git is the one source all three agree on, it is deterministic, and it cannot
fail because a store API is down. Chrome's live check still runs — as a safety
net inside the publish adapter, which refuses to re-upload a version that is
already published.

## What you must configure before the first release

### 1. Repository secrets

Ten, all under **Settings → Secrets and variables → Actions**. They are read by
the `store-publish` job, which is scoped to the `store-publish` environment.

| Secret | Where it comes from |
|---|---|
| `CWS_PUBLISHER_ID` | Chrome Developer Dashboard → Publisher → Settings |
| `CWS_EXTENSION_ID` | the 32-character item ID in the dashboard URL |
| `CWS_CLIENT_ID` | Google Cloud OAuth client (Web application type) |
| `CWS_CLIENT_SECRET` | the same OAuth client |
| `CWS_REFRESH_TOKEN` | minted via the OAuth playground |
| `EDGE_PRODUCT_ID` | Partner Center → Extension overview → Product ID (GUID) |
| `EDGE_CLIENT_ID` | Partner Center → Publish API |
| `EDGE_API_KEY` | Partner Center → Publish API |
| `AMO_JWT_ISSUER` | AMO → Manage API Keys → JWT issuer |
| `AMO_JWT_SECRET` | AMO → Manage API Keys → JWT secret |

Optional repository **variables** (not secrets): `EDGE_API_KEY_ISSUED` (the ISO
date the Edge key was generated) and `EDGE_EXTENSION_ID`.

### 2. Two credential expiries that will break this pipeline

These are the reason an automated pipeline here is not fire-and-forget. Neither
is fixable in code.

- **`CWS_REFRESH_TOKEN` expires after 7 days while the OAuth consent screen is
  in "Testing".** Unattended publishing will fail roughly weekly until that
  consent screen is moved to Production/published. **Do this before relying on
  the pipeline**, or every other release will fail at the Chrome step.
- **`EDGE_API_KEY` expires every 72 days**, with no server-side warning. Set
  `EDGE_API_KEY_ISSUED` so preflight can warn ahead of the expiry, and give the
  rotation an owner. Nothing in this repository can renew it.

### 3. The `store-publish` environment

The job targets a GitHub Environment called `store-publish`. It is created
implicitly on first run with no protection rules, which is what makes publishing
unattended.

**Adding required reviewers to that environment re-introduces an approval gate
with no change to any workflow file.** If you do that, update
`docs/security/RELEASE-POLICY.md` so the documentation stays true.

## What has no gate any more

The previous design required a signed tag and a two-person release. Both are
gone:

- The tag is now created **by CI** after the build, from the version in the
  manifest. It is a lightweight tag, not a human-signed one, and
  `gh release create --verify-tag` is correspondingly no longer used.
- There is no approval between merging and publishing.

**The consequence is that pull-request review is now the only review.** A change
that reaches `main` with a version bump reaches three public review queues
without anyone looking again. `docs/security/RELEASE-POLICY.md` records this.

## Failure modes worth knowing

**A partial publish is the realistic one.** Three stores, three independent
APIs, no transaction across them. Chrome can succeed while AMO fails, leaving
versions divergent. The `store-publish` job writes a per-store summary to the
run summary and uploads `dist/publish-report.json`; re-drive a failed store with
`workflow_dispatch` → `stores: <that store>` → `force: true`.

**A failed store upload does not turn the run red.** `store-publish` is
`continue-on-error: true` on purpose: by the time it runs, the build, the
signatures, the attestation and the GitHub release have already succeeded, and
whether a third-party API accepted an upload minutes later is not what `main`'s
health depends on. The failure is not swallowed — the `publish-failure-notice`
job opens or updates a GitHub issue for the version, and the report is uploaded
as an artifact. But do not read a green run as "it shipped": **check the issue
tracker, not the tick.** If nobody watches those issues, a failed release is
invisible.

**The `quality.yml` gates run on the same push, not before it.** A push to
`main` starts `release.yml` and `quality.yml` in parallel; there is no
dependency between them, and branch protection is not configured, so a
`payload-audit` or `reproducible-build` failure does not stop the publish that
is already running. Those gates protect the pull request, which is where they
have to catch a problem — they are not a last line of defence on `main`.

**Publishing is not reversible** the way a GitHub release is. Chrome and Edge
submissions enter review queues, and no store lets a version be re-uploaded.
Rolling back means shipping a new higher version.

**Store review still happens.** "Published" here means "submitted and accepted
by the API", not "live for users". Chrome and Edge review can take days; AMO
varies by whether a human review is triggered.

## Re-driving a failed release

`workflow_dispatch` on `release.yml`:

- `force: true` — publish even though the version did not change in the last
  commit. Necessary when re-driving, because the version bump is by then several
  commits back.
- `stores` — `all`, or a single store, so a successful store is not asked to
  accept a version it already has.

The tag and GitHub release steps are idempotent: an existing tag is left alone,
and an existing release has its assets replaced rather than erroring.
