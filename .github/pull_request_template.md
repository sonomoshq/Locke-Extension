<!--
  Security vulnerabilities do NOT belong in a pull request description.
  See SECURITY.md — email security@sonomos.ai or open a private advisory.
-->

## Why

<!-- CONTRIBUTING.md: "PR description should explain *why*, not just
     *what*." Link the issue or design doc. -->

## What changed

<!-- Short summary. The diff covers the detail. -->

## Type

<!-- Matches the conventional-commit types in CONTRIBUTING.md. -->

- [ ] `feat` — user-visible capability
- [ ] `fix` — bug fix
- [ ] `security` — hardening or vulnerability fix
- [ ] `chore` / `refactor` / `test` / `ci` / `docs`

## Checklist

- [ ] Commit messages follow `<type>(<scope>): <summary>`
- [ ] `npm test` passes locally (`node --test tests/`)
- [ ] A test was added alongside any new pure function in `shared/`
- [ ] `CHANGELOG.md` updated for any user- or operator-visible change
- [ ] Manually verified end-to-end in a real browser if this touches the
      popup or a content script (CI does not exercise the DOM)

## Security-surface review

Tick every line that this PR leaves TRUE. If you have to untick one, say
why in "Why" above — these are the invariants CI enforces as tripwires and
that `docs/security/` promises to auditors.

- [ ] `package.json` still declares **zero** dependencies and
      devDependencies (`ci.yml::lint-js` → "no JS deps in package.json")
- [ ] `manifest.json::host_permissions` is still **loopback-only**
      (`ci.yml::validate-manifest` → "Host permissions are loopback-only")
- [ ] No content script gained `<all_urls>` scope, and none in the MAIN
      world did (`ci.yml::validate-manifest` → "No content_script uses
      `<all_urls>` in MAIN world")
- [ ] The native-messaging host name is unchanged, or changed in **all**
      pinned locations together
- [ ] No new outbound network destination was introduced
- [ ] No secret, token, or credential appears in the diff
- [ ] Any new GitHub Action is pinned to a full commit SHA with the
      version in a trailing comment (SECURITY.md A4)

## Documentation

Per CONTRIBUTING.md "Documentation", tick what this change required:

- [ ] Security posture → `SECURITY.md`, `docs/security/ASVS-MAPPING.md`,
      `docs/security/RISK-REGISTER.md`
- [ ] Permissions surface → `docs/security/PERMISSIONS.md`
- [ ] Data flow → `docs/architecture/DATA-FLOW.md`
- [ ] Legal (DPA, DPIA, retention, sub-processors, export control) —
      **flag for the legal reviewer; do not merge without explicit legal
      sign-off** (`TODO.md`)
- [ ] None of the above

## Release note

<!-- If this is a release PR: RELEASE-POLICY.md's two-person rule applies.
     The person who tags MUST NOT be the person who approved this PR.
     There is no "I'll do it myself this once" exception. -->

- [ ] This is a release PR (`manifest.json::version` bump + `CHANGELOG.md`
      entry). I understand a different person must tag it.
