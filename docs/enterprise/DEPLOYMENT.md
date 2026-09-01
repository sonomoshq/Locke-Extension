# Enterprise deployment guide

For IT administrators rolling Sonomos Desktop Connector to a managed
fleet. The extension is a thin client that talks — over the browser's
native-messaging channel — to the local Sonomos host installed by
Sonomos Desktop, which does the screening on the device. See the
parent product's enterprise docs for deploying the host and the app.

## What this extension does that IT cares about

- **No network egress**: the extension makes no outbound network
  requests. It reaches the local Sonomos host only over the browser's
  native-messaging channel (stdio) — there is no HTTP endpoint, no
  telemetry endpoint, no analytics, and no remote configuration server.
- **Native messaging**: requires the Sonomos native-messaging host
  (installed by Sonomos Desktop) to be registered on the same machine.
  Without it, the extension can't capture — observe mode passes traffic
  through, enforce mode holds the request (fails closed).
- **MAIN-world content scripts** are scoped to a fixed list of AI
  provider hosts (OpenAI, Anthropic, Google, etc.) — see
  `manifest.json`. The extension does not patch `fetch`/`XHR` on
  arbitrary websites.
- **No network port to attack**: the browser launches the host binary
  directly via the OS-registered native-messaging manifest, so there is
  no local port for a squatter to impersonate. See `SECURITY.md` for the
  threat model.

## Distribution channels

Pick whichever your fleet management already supports.

| Channel | Best for | Notes |
|---|---|---|
| Chrome Web Store | Most Chrome / Edge fleets | Simplest force-install. Requires a verified-publisher listing. |
| Edge Add-ons | Edge-only fleets | Same `ExtensionInstallForcelist` mechanism. |
| Mozilla AMO | Firefox ESR fleets | Use `ExtensionSettings` + `install_url`. |
| Self-hosted CRX/XPI | Fleets that can't use stores | Sign with your own key, host on an internal HTTPS server, distribute the `update_url`. |

## Force-install

Use the templates in `templates/` as starting points.

### Chrome / Chromium / Brave / Arc

Linux: drop `templates/chrome-managed-policy.json` into
`/etc/opt/chrome/policies/managed/sonomos.json`.

macOS: convert and place at
`/Library/Managed Preferences/com.google.Chrome.plist` (or use the
provided `com.google.Chrome.SonomosDesktop.plist` directly via your
MDM).

Windows: import the ADMX/ADML pair (`templates/Sonomos.admx` +
`templates/en-US/Sonomos.adml`) into your Group Policy Central Store,
then configure under *Computer Configuration → Administrative Templates
→ Google → Sonomos Desktop Connector*.

### Microsoft Edge

Same shape as Chrome but under `Software\Policies\Microsoft\Edge` on
Windows, `com.microsoft.Edge.plist` on macOS, or
`/etc/opt/edge/policies/managed/` on Linux. Use
`templates/edge-managed-policy.json`.

### Firefox

Drop `templates/firefox-policies.json` at the path matching your OS
(see the comment block in the file). Managed-storage values for the
extension itself live in a *separate* file —
`templates/firefox-managed-storage.json` — at a different path.
This is a Firefox quirk, not a Sonomos design.

## Available managed settings

All settings are documented authoritatively in `managed-schema.json`
at the repo root. Quick summary:

| Property | Type | Default | Effect |
|---|---|---|---|
| `allowedProviders` | string[] | `[]` (= all) | Whitelist of adapter IDs the shim is allowed to operate on. |
| `keystrokeGuardEnabled` | bool | `true` | Per-page tracker blocker. Turning off removes the MAIN-world keystroke guard from all pages. |
| `telemetryEnabled` | bool | `true` | Local-only shape telemetry to the SW console. No network egress. |
| `heartbeatSeconds` | int (10–600) | `30` | Host health-check cadence. |
| `lockedSettings` | string[] | `[]` | Property names the user is not allowed to override in the popup UI. |

## Verifying releases

**Correction, 2026-08-12; restated 2026-09-01.** This section once named
`sonomos-extension-<version>.zip`, an artifact no build in this repo has
ever produced, and pointed `cosign` at the wrong GitHub organisation. It
also stated flatly that releases *are* published with sigstore. They are
not yet: the signing and attestation steps are real
(`.github/workflows/release.yml`) and that workflow now runs on every
push to `main`, but **no release has been published through it**, so **no
shipped version is signed, attested, or accompanied by an SBOM**. Treat
the `cosign` recipe below as the procedure that applies from the first
signed release onward — the rebuild-and-compare recipe after it works
today — and see
[`../security/RELEASE-POLICY.md`](../security/RELEASE-POLICY.md)
for the per-artifact status.

`npm run package` produces exactly two artifacts, and their names carry
the version and the target:

| Artifact | Goes to |
|---|---|
| `locke-extension-<version>-chromium.zip` | Chrome Web Store **and** Edge Add-ons |
| `locke-extension-<version>-firefox.zip` | Firefox AMO |

To verify a downloaded zip on an air-gapped machine, install `cosign`
and run (substituting the version you downloaded):

```bash
cosign verify-blob \
  --bundle locke-extension-2.0.0-chromium.zip.sigstore.bundle \
  --certificate-identity-regexp 'release\.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  locke-extension-2.0.0-chromium.zip
```

Note the identity is a **branch** ref, not a tag: releases are built from
a push to `main`, not from a signed tag, so an identity regexp matching
`refs/tags/v.*` will not verify. A `Verified OK` line means the zip was
built by this repository's release workflow on `main`. Mismatch means do
not deploy.

The build is reproducible, which is the check that does not depend on a
release having been signed. Since 2026-09-01 it is also checked on every
push: `.github/workflows/quality.yml::reproducible-build` builds the
payload twice under a fixed `SOURCE_DATE_EPOCH` and fails the run unless
the two zips are byte-identical. You do not have to take that on trust —
`LICENSE` (PolyForm Strict 1.0.0) permits noncommercial use, which
includes rebuilding this software to verify it, so an evaluating IT team
may run the comparison itself. Rebuild the published commit and compare:

```bash
git checkout v2.0.0
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) npm run package
sha256sum dist/locke-extension-2.0.0-chromium.zip
```

The hash must equal the published artifact's. `SOURCE_DATE_EPOCH` is what
pins the archive timestamps to the release commit; without it the writer
uses its own fixed stamp, which is still deterministic but will not match
a release build. The tag `v2.0.0` above is created by the release
workflow at the commit it published, so checking it out gets you the
right commit.

Once a release has been published, the same release also ships a CycloneDX
SBOM (`sbom.cyclonedx.json`) and an SPDX SBOM (`sbom.spdx.json`) for
vulnerability scanners to consume, and SLSA build provenance verifiable
with `gh attestation verify <artifact> -R sonomoshq/Locke-Extension`.

## Finding the extension ID

Substitute `<EXTENSION_ID>` (and `<EDGE_EXTENSION_ID>`) in the
templates with the real value:

- **Chrome Web Store install**: ID is in the listing URL,
  `chrome.google.com/webstore/detail/<name>/<EXTENSION_ID>`.
- **Edge Add-ons install**: ID is in the listing URL,
  `microsoftedge.microsoft.com/addons/detail/<name>/<EDGE_EXTENSION_ID>`.
- **Self-hosted (Chrome)**: add a `key` field to `manifest.json` (your
  signing-key public modulus, base64). The ID is then
  `sha256(key)[:32]` mapped to `a-p`. Chrome's `chrome://extensions`
  page also shows the ID once installed.

## Incident response

- Security contact: see `SECURITY.md` (`security@sonomos.ai`).
- Vulnerability disclosure: GitHub private security advisory at
  <https://github.com/sonomoshq/Locke-Extension/security/advisories/new>.
- Privacy questions: <https://sonomos.ai/locke/privacy>.
