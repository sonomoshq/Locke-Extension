# Native-host rescue: prepared, not executed

## Status

This branch contains migration tooling and its tests only. The actual native-host
source has NOT been imported. No desktop packaging references have been changed.
Do not merge this as a completed migration or archive the source repository.

The requested destination is `sonomoshq/Locke-Extension/native-host/`. Only the
native host and its original licence should move. The obsolete browser extension,
private Git history, and other private dependency repositories must not move.

## Pinned source

- Repository: `sonomoshq/Depreciated-Desktop-Extension`.
- PR: #84, open and draft when inspected on September 10, 2026.
- Commit: `c379b85e37456c50fb0ccd128fb3f8d3610d1b77`.
- Branch: `release/beta1-readiness-20260908`.
- Snapshot: 11 files under `native-host/`, plus the source root `LICENSE`.
- Full per-file Git blob hashes are pinned in `scripts/rescue-native-host.py`.

Using old main would miss the native-host fixes in PR #84. Conversely, importing
this snapshot incorporates pending work; it does not mean PR #84 was merged or
that its release dependencies have completed review.

The source root licence is Sonomos Source-Available Licence (View Only), not the
PolyForm Strict licence used by the browser extension. The tool copies the
original licence into `native-host/LICENSE` and does not relicense the component.
A source disclosure review remains necessary before the actual public import.
Hash checking proves copy integrity, not absence of secrets or security defects.

## Import on an authorized development machine

Requirements: Python 3.9+, Git, both local repository checkouts, and a clean
non-default migration branch in Locke-Extension. No Rust or private dependency
fetch is needed for the copy itself. Rust and authorized private dependency access
are required for subsequent build and runtime checks.

From the directory containing both checkouts, first obtain the source snapshot
and this preparation branch using your normal Git credentials:

```sh
git -C Depreciated-Desktop-Extension fetch origin release/beta1-readiness-20260908
git -C Locke-Extension fetch origin codex/rescue-native-host-20260910
git -C Locke-Extension switch codex/rescue-native-host-20260910
```

Inspect the dry-run:

```sh
python Locke-Extension/scripts/rescue-native-host.py --source Depreciated-Desktop-Extension --destination Locke-Extension
```

Then write the verified source locally:

```sh
python Locke-Extension/scripts/rescue-native-host.py --source Depreciated-Desktop-Extension --destination Locke-Extension --apply
```

The tool reads committed Git objects, not dirty working-tree files. It refuses a
wrong repository, a default/detached destination branch, a dirty destination, an
existing host directory, a missing source commit, a changed inventory, a symlink,
or a blob-hash mismatch. It preserves bytes and executable flags, adds provenance
and licence documentation, and ignores the native build target directory.
It does not stage, commit, push, install, fetch, merge, or delete the source.
Do not run concurrent writers against the destination while importing.

## Remaining migration work

1. Review the imported source for public disclosure, preserving licence and
   copyright notices. Reconcile any later PR #84 changes deliberately.
2. Restore native-host registration/manifest checks in this repository. Inspect
   the source repo's host-specific JavaScript/PowerShell installer tests and move
   necessary tests and helpers without overwriting current browser tests.
3. Keep the browser package allowlist strict. Native-host source, binaries,
   Cargo caches, and private dependencies must not enter the browser-store ZIP.
4. Update current README, contribution and security/release documentation that
   still describes the host as outside this repository. Retain historical notes
   as history instead of globally replacing old names.
5. Prepare coordinated private-repository PRs for Locke's checked host entry,
   source resolvers, pinned packaging/submodules, Desktop-Frontend's host staging,
   and any Inspector references. Search both the renamed and old Desktop-Extension
   spellings. Preserve installed names, native host ID, browser IDs and paths.
6. Keep Extension-Bridge as a separate service and private dependency. Keep the
   host a stdio-launched mesh client. Do not add a network listener or change
   screening deadlines, error handling, admission or fail-closed behavior.
7. Run the native host's locked Cargo tests, fmt and clippy on supported native
   platforms, the browser test suite, registration/manifest checks, and package
   inspection. Validate real browser reconnection and desktop install/upgrade.
8. Only after destination and downstream PRs are validated and merged should
   source retirement be proposed. Preserve old Git objects for historical pins.

No GitHub Actions workflow is added or manually dispatched by this preparation.

## Validation actually performed

`python -m unittest discover -s tests -p test_rescue_native_host.py -v`

13 tests passed locally against temporary real Git repositories on Linux. They
cover exact-byte copying (including CRLF and Unicode), executable flags, original
licence preservation, keeping existing app files and source unchanged, no staging
or commits, and refusal paths. The missing-behavior baseline failed first.

This is evidence for the migration tool only. The real source import, native Rust
build, Windows/macOS checks, full browser suite, installer tests, disclosure scan,
and cross-repository integration have NOT been run in this session. Existing PR
#84 validation is upstream-reported evidence, not a fresh run here.
