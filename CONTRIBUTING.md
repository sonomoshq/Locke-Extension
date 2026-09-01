# Contributing

This document covers everything a Sonomos maintainer needs to land a
change in the Locke Extension. It is written for people working inside
the organisation — see "Licensing of contributions" below for why an
outside pull request cannot be accepted, and what *is* welcome.

Bug reports and security reports are welcome from anyone.

## Reporting bugs and feature requests

Use [GitHub Issues](https://github.com/sonomoshq/Locke-Extension/issues)
for non-security bugs and feature requests.

**Do not file public issues for security vulnerabilities.** Use the
private channel documented in [SECURITY.md](SECURITY.md):

- Email `security@sonomos.ai` (PGP key at <https://sonomos.ai/.well-known/pgp-key.asc>)
- Or open a private security advisory on
  [this repository](https://github.com/sonomoshq/Locke-Extension/security/advisories/new).
  (Corrected 2026-08-21: an earlier version of this link pointed at a
  repository that is now archived.)

We acknowledge security reports within 48 hours and aim to ship
fixes within 30 days for high-severity issues. See
[`docs/security/BUG-BOUNTY.md`](docs/security/BUG-BOUNTY.md) for
program scope and safe-harbour terms.

## Development setup

1. Install and run the Locke desktop app. The extension has nothing to
   talk to without it. There is no HTTP daemon and no port to point at:
   the app listens on a user-only Unix domain socket, and the extension
   reaches it through the native messaging host over that socket.

   The desktop app is also what installs and registers that host
   (`ai.sonomos.desktop`) with each browser. Neither the host nor its
   installer lives in this repository, so there is nothing to build or
   register here — if native messaging is not working, the desktop-side
   install is where to look.
2. Build the per-browser artifacts, then load **from `dist/`**:

   ```sh
   npm run package
   ```

   - Chrome / Edge / Brave: `chrome://extensions` → Developer mode →
     Load unpacked → select `dist/chromium/`.
   - Firefox: `about:debugging` → This Firefox → Load Temporary
     Add-on → select `dist/firefox/manifest.json`.

   **Do not load the repository root.** The manifest at the root is a
   deliberate superset: it carries *both* background families
   (`service_worker` for Chromium and `scripts` for Firefox's event
   page) plus per-family keys, so it is not a valid manifest for
   either browser as it stands. `npm run package` applies the
   per-browser transform (`scripts/store-build.mjs`) and stages a
   loadable tree under `dist/chromium/` and `dist/firefox/`. Re-run it
   after editing `manifest.json` or anything under `background/`,
   `content/`, `popup/`, `shared/` or `icons/`.
3. Chromium-family only: get your unpacked load's extension ID
   authorised. Chromium derives an unpacked extension's ID (32 letters
   a–p) from the absolute path it was loaded from, so every checkout
   gets its own — and the native-messaging manifest the desktop app
   writes allows only the published store IDs by default. Copy the ID
   `chrome://extensions` shows for your load and authorise it through
   the desktop app's installer; the command for that ships with the
   desktop app, not with this repository.

   Skip this and the browser refuses to start the native host
   ("access to the specified native messaging host is forbidden"),
   which the extension reports as its Setup state. Firefox is
   unaffected — a temporary add-on keeps the fixed gecko ID the
   manifest already allows.

   Treat the authorised-ID list as a trust surface: every entry is an
   origin allowed to start the native host, and an unpacked load moved
   to a new path gets a new ID and leaves the old one behind, still
   authorised. Clear out IDs you no longer use.
4. Verify the toolbar badge clears within 30 seconds; that confirms
   the native-messaging host is wired up and can reach the desktop app.
   The badge is not the beacon — the `{ browser, version }` presence
   heartbeat the extension POSTs to `127.0.0.1:18795` only tells the
   Locke desktop app you are installed, and it is fire-and-forget.
5. Install the pre-push hook so your pushes get the same checks a
   release does:

   ```sh
   npm run install-hooks
   ```

   `npm install` also does this via the `prepare` script. It copies
   `scripts/hooks/*` into `$(git rev-parse --git-common-dir)/hooks/` —
   `--git-common-dir`, not `--git-dir`, because a linked worktree's
   private `.git` directory has a `hooks/` that git never consults.
   An existing hook that is not ours is left alone with a warning;
   `-- --force` replaces it. Do not set a repo-local
   `core.hooksPath`: it holds a single path rather than a search
   list, so it would override the global hooks path and silently
   disable whatever is installed there.

There is no bundler, minifier or transpiler. The extension is plain
MV3 with zero JS dependencies, and `npm run package` only copies,
rewrites the manifest, and zips — so the package a store reviews is
the source you wrote.

## npm scripts

| Script | What it does |
|---|---|
| `npm test` | `node --test tests/*.test.js` |
| `npm run generate` | Regenerates `content/web-surfaces.generated.js` from `shared/ai-surfaces.json` |
| `npm run validate` | Stages both targets and applies the store rules without writing any artifact — the cheap form of the `npm run package` gate |
| `npm run package` | Wipes `dist/`, stages `dist/{chromium,firefox}/`, writes both store zips deterministically |
| `npm run install-hooks` | Installs `scripts/hooks/*` into the repo's real hooks directory (also runs as `prepare`) |
| `npm run bump -- <major\|minor\|patch\|X.Y.Z>` | Writes all five version sites and opens a dated `CHANGELOG.md` section. Does not commit or tag. |
| `npm run preflight` | The full release gate: version sites, both manifest transforms, the native-messaging host name pin, listing assets, store credentials, tests. Takes `--skip-tests`, `--checks=…`, `--stores=…`, `--json`. |
| `npm run publish-stores -- --dry-run` | Submits nothing; see `docs/store/RELEASE-PIPELINE.md` for what each store's dry run does and does not touch. |

The publish alias is `publish-stores`, not `publish` — npm reserves
`npm publish` for registry publication, and a typo should not mean
something that different.

## Branch and PR policy

- **All changes go through a Pull Request.** No direct commits to
  `main`.
- **Branch protection on `main`** is **not configured yet**, and no
  workflow runs on a push or a pull request. Treat the following as the
  house rules, enforced by review rather than by the forge, and see
  [`docs/security/RELEASE-POLICY.md`](docs/security/RELEASE-POLICY.md)
  for which of them have a mechanism behind them today:
  - Passing checks — today that means the pre-push hook's preflight
    (version sites, manifest transforms, the native-messaging host
    name pin, `npm test`).
    SAST, secret scanning and dependency review are not implemented.
  - At least one approving review from a CODEOWNER (see
    [`CODEOWNERS`](CODEOWNERS)).
  - Resolved conversations.
  - Up-to-date branch (rebase or merge `main` before merging).
- **PR description** should explain *why*, not just *what*. Link
  to the issue or design doc when applicable.
- **Commit messages** follow conventional style:
  `<type>(<scope>): <summary>`. Types in use: `feat`, `fix`,
  `chore`, `docs`, `refactor`, `test`, `ci`, `security`.
- **Signed commits** (`git commit -S`) are required for releases;
  recommended for all commits.

## Release process

Policy in [`docs/security/RELEASE-POLICY.md`](docs/security/RELEASE-POLICY.md);
mechanics in
[`docs/store/RELEASE-PIPELINE.md`](docs/store/RELEASE-PIPELINE.md).
Summary:

- Releases are tagged `vX.Y.Z` matching `manifest.json::version`, and
  pushing that tag is what submits to the three extension stores.
- Two-person release: the tagger and the approving CODEOWNER must
  be different individuals.
- Artifacts are byte-reproducible from a tag (`SOURCE_DATE_EPOCH`).
  Nothing shipped so far is sigstore-signed or carries SLSA
  provenance — an earlier version of this section said otherwise.
  The release workflow in `.github/workflows/` carries those steps,
  but it is not triggered by a push.

## Testing

Run the suite with **`npm test`**:

```sh
npm test
```

Not `node --test tests/`. That form is what this section used to
recommend and it fails outright on Node 24 — the runner resolves the
bare directory as a module and dies with
`Error: Cannot find module …\tests`. The npm script passes the glob
`tests/*.test.js`, which works.

- **Unit tests**: `tests/` uses Node's built-in `node:test` runner
  with no third-party libraries. Add a test alongside any new pure
  function in `shared/` or `content/`.
- **Store-rule tripwires**: `scripts/store-build.mjs::validate` is the
  single implementation of what ships. It enforces loopback-only
  `host_permissions`, no wildcard content-script host in any of its
  spellings (`<all_urls>`, `*://*/*`, `https://*/*`, a bare `*.com`),
  each target's background family — so the superset manifest must keep
  both — the AMO `data_collection_permissions` key, and no
  `update_url` or `key`. Alongside those it applies the store rules
  proper: field limits, icons whose pixels match their declared size, a
  CSP with no `unsafe-eval`/`unsafe-inline` and no remote `script-src`,
  every file the manifest references actually shipping, and the
  extension-specific privacy-policy link. It runs against the *staged*
  tree in `npm run validate` (the no-artifacts form), in
  `npm run package`, in `scripts/preflight.mjs` — which stages both
  targets through `buildAll` rather than re-deriving any of it — and in
  `tests/store-build.test.js`. One implementation, so the packager and
  the gate cannot disagree.
- **Native-messaging host name pin**: the host name lives in exactly
  one place on this side, `shared/constants.js::NATIVE_HOST`, and it
  has to match the registration the Locke desktop app writes. That
  registration is not in this repository, so nothing here can check
  the pair. A drift means the browser launches nothing and the
  extension fails closed for every user, and it surfaces at run time
  rather than at build time.
- **What runs automatically**: the local pre-push hook, and only
  that. `.github/workflows/` holds workflows covering CI, static
  analysis, secret and dependency scanning, SBOM generation and
  release, but **none of them is triggered by a push or a pull
  request**, so nothing there gates one. In practice there is no lint
  job, no SAST, no secret scanning and no dependency review on your
  PR. An earlier version of this section described all of those as
  running on every push.
  Activating them is tracked in
  [`docs/security/MANAGEMENT-REVIEW.md`](docs/security/MANAGEMENT-REVIEW.md).

For UI changes, manually verify the change works end-to-end in a
real browser before requesting review. The CI pipeline does not
exercise the popup or content-script DOM.

## Documentation

If your change affects:

- **Security posture** → update [`SECURITY.md`](SECURITY.md) and
  the relevant `docs/security/` files (especially
  `ASVS-MAPPING.md`, `RISK-REGISTER.md`).
- **Permissions surface** → update
  [`docs/security/PERMISSIONS.md`](docs/security/PERMISSIONS.md).
- **Data flow** → update
  [`docs/architecture/DATA-FLOW.md`](docs/architecture/DATA-FLOW.md).
- **External dependencies, threat model, audit log shape** → update
  [`SECURITY.md`](SECURITY.md) and call out the change in PR
  description for security review.
- **Anything legal** (DPA, DPIA, retention, sub-processors,
  export-control) → flag in the PR for legal review per
  [`TODO.md`](TODO.md). Do not merge legal-doc changes without
  explicit legal sign-off.

Add or update entries in [`CHANGELOG.md`](CHANGELOG.md) for any
user-visible or operator-visible change.

## Licensing of contributions

The repository is published under the **PolyForm Strict License 1.0.0** —
see [`LICENSE`](LICENSE). It permits noncommercial use, and forbids
distribution and modification. It is **not** an open-source licence.

**Sonomos does not accept unsolicited external contributions.** There is
no contributor licence agreement in place, and the licence grants no
right to modify the Software or to prepare derivative works — so an
outside pull request cannot be merged even if the change is a good one,
because submitting it would require a right the licence does not give.
This document is written for maintainers working inside the
organisation.

If you have found a bug or a security issue, that is genuinely welcome:
open an issue, or follow [`SECURITY.md`](SECURITY.md) for anything
security-sensitive. Reports do not require a licence grant. Enquiries
about any use beyond reading: `info@sonomos.ai`.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct][cov].
Report violations to `info@sonomos.ai`.

[cov]: https://www.contributor-covenant.org/version/2/1/code_of_conduct/
