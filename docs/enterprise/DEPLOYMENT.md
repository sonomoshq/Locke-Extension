# Enterprise deployment guide

For IT administrators rolling the Locke extension out to a managed
fleet. The extension is a thin client that talks — over the browser's
native-messaging channel — to the local Locke native-messaging host
installed by the Locke desktop app, which does the screening on the
device. See the parent product's enterprise docs for deploying the host
and the app.

The former product name — Sonomos Desktop Connector — survives in two
places, for different reasons. The Firefox add-on id is
`desktop-connector@sonomos.ai` (`manifest.json`,
`browser_specific_settings.gecko.id`) and cannot change without orphaning
every existing install. The macOS template here is still called
`com.google.Chrome.SonomosDesktop.plist`; that one is only a filename,
and renaming it is deferred rather than impossible. Everything else says
Locke.

## What this extension does that IT cares about

- **Hold-and-enforce, fail-closed.** When a page makes a bodied
  `fetch`/`XHR` to an AI web surface, the page-world shim **holds** it,
  ships the raw request to the Locke desktop app through the
  native-messaging host, and applies the verdict: send as held (`allow`),
  send the app's rebuilt request (`redact`), or block. Anything short of
  a clean verdict — timeout, no host registered, an unreadable body, a
  half-parsed receipt, a bug in our own scoping — **blocks the request**.
  A blocked request fails the way a network error would; the page shows
  its own error. Plan for that: if the desktop app is not deployed and
  running, in-scope AI traffic stops rather than flowing unscreened.

  `[corrected 2026-09-01]` This section used to say the extension had an
  **observe mode** that "passes traffic through" when it cannot capture,
  and it named a `keystrokeGuardEnabled` setting. Neither exists. Observe
  mode and page-side masking were replaced by hold-and-enforce, and the
  keystroke-guard subsystem was deleted outright, both in **2.0.0**
  (`CHANGELOG.md`). There is no configuration anywhere in this extension
  that makes an in-scope request pass through unscreened. The one path by
  which content leaves a machine unexamined is the **user's explicit,
  time-boxed fail-open window, which lives in the Locke desktop app** —
  not here, and no managed key in this repository turns it on or off. If
  your deployment needs that window closed, close it on the desktop side.

- **No remote network egress; one loopback POST.** The extension opens no
  connection to any Sonomos server, telemetry endpoint, analytics
  endpoint or remote configuration server. Screened traffic reaches the
  desktop app over stdio through the native-messaging host, never over a
  socket. The single exception is a loopback HTTP POST to
  `http://127.0.0.1:18795/heartbeat` carrying `{ browser, version }` —
  a fire-and-forget presence beacon so the desktop app can tell whether a
  browser half is installed — and, when the native host refuses this
  extension's id, a `{ id, browser, version }` POST to
  `/register-extension` on the same loopback origin so the desktop app
  can prompt the user to authorise it. `manifest.json` declares exactly
  one host permission, `http://127.0.0.1/*`, and
  `quality.yml::payload-audit` fails the job on any absolute URL in the
  staged payload that is not `http://127.0.0.1`, `http://localhost`, or
  the `https://sonomos.ai/` links the popup opens in a tab (its privacy
  notice and EULA).

  `[corrected 2026-09-01]` This bullet used to claim the extension "makes
  no outbound network requests" and that "there is no HTTP endpoint".
  Both overstated it: the loopback beacon is an HTTP request, and the
  desktop app listens on port 18795 to receive it. What is true is
  narrower and still worth having — nothing leaves the machine.

- **MAIN-world content scripts are scoped** to a fixed list of AI web
  surfaces generated from `shared/ai-surfaces.json` (see
  `manifest.json`'s `content_scripts.matches`). The extension does not
  patch `fetch`/`XHR` on arbitrary websites, and
  `scripts/store-build.mjs::validate` rejects a wildcard host match — in
  any of its spellings — at build time.

- **No network port to attack.** The browser launches the host binary
  directly through the OS-registered native-messaging manifest, so there
  is no local port for a squatter to impersonate and no URL a policy
  could redirect. See `SECURITY.md` for the threat model.

## Distribution channels

Pick whichever your fleet management already supports.

| Channel | Best for | Notes |
|---|---|---|
| Chrome Web Store | Most Chrome / Edge fleets | Simplest force-install. Requires a verified-publisher listing. |
| Edge Add-ons | Edge-only fleets | Same `ExtensionInstallForcelist` mechanism. |
| Mozilla AMO | Firefox ESR fleets | Use `ExtensionSettings` + `install_url`. |
| Self-hosted CRX/XPI | Fleets that cannot use stores | Talk to Sonomos first — see the paragraph below. |

**Self-hosting is not a supported path today, and the obstacle is not
technical.** A self-hosted Chrome CRX needs a `key` and an `update_url`
in the manifest; `scripts/store-build.mjs::validate` rejects both, so no
artifact this repository builds carries them, and adding them means
modifying the extension — which `LICENSE` (PolyForm Strict 1.0.0) does
not permit. The licence allows you to *read and rebuild* this software
to verify it, not to ship a modified derivative. If your fleet cannot use
the stores, raise it with Sonomos (`info@sonomos.ai`) rather than
re-signing a modified build. `[added 2026-09-01]`

## Force-install

Use the templates in `templates/` as starting points. Each one carries a
comment block explaining which settings it sets and which it deliberately
leaves out; read that before pasting.

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
→ Google → Locke extension (Sonomos)*.

The ADMX covers only the **scalar** settings — `heartbeatSeconds`,
`debugLogging`, `enforceTimeoutMs`. `allowedProviders` is a list, which
Chrome reads from a single registry value holding JSON and which this
ADMX has no element type for: set it through the JSON template or the
equivalent registry value instead.

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

`managed-schema.json` at the repository root is authoritative for every
key, its type and its bounds. `shared/constants.js::MANAGED_KEYS` is the
list of names the extension will actually read out of managed storage;
anything else you set is ignored on arrival, deliberately, so that a
schema that drifts wider than intended cannot widen what a policy can
reach.

Precedence is `DEFAULTS < storage.local < storage.managed`
(`background/service-worker.js::getSettings`, and the same order again in
`content/content-script.js` for the three settings the page-world shim
needs — `shared/constants.js::SHIM_SETTING_KEYS`), so a managed value
always wins over anything on the machine. A
managed-storage lookup that *fails* — the normal case on an unmanaged
profile, where `chrome.storage.managed` throws — is treated as "no
policy" rather than as an error; a policy lookup must never be able to
brick the extension.

**Four keys are enforced. Two are accepted and then ignored.** Both
groups are listed, because the second group is the dangerous one: an
admin who sets an inert key and files the deployment as done has bought a
control that does not exist.

| Property | Type | Default | Status | What it actually does |
|---|---|---|---|---|
| `allowedProviders` | string[] of catalog provider ids | `[]` — every catalog surface is screened | **Enforced** | Narrows which catalog providers the shim screens. See below; this one has a security cost. |
| `heartbeatSeconds` | integer, 10–600 | `30` | **Enforced** | How often the service worker probes the desktop app for health, and the base the failure backoff walks out from. Does not affect screening: an in-scope request is screened when it is sent, whatever this is. |
| `debugLogging` | boolean | `false` | **Enforced** | Prints the capture path's *healthy* decisions (allow / redact / out-of-scope) to the browser console. Warnings for a **blocked or unscreened** send print regardless — that is the case a user needs explained, and it must not depend on a flag. Shape-only either way: host, path, byte counts, media types, decisions. Never bodies or header values. |
| `enforceTimeoutMs` | integer, 1000–120000 | `45000` | **Enforced** | The fail-closed ceiling: how long the shim holds a request waiting for a verdict before **blocking** it. Must exceed worst-case screening time on the slowest machine in the fleet, or healthy sends start failing there. |
| `telemetryEnabled` | boolean | `true` | **Accepted and inert** | Nothing reads it. `background/service-worker.js::handleTelemetry` writes its `console.debug` line unconditionally, so setting this to `false` suppresses nothing. Turning it *on* likewise buys nothing that is not already happening. |
| `lockedSettings` | string[] | `[]` | **Accepted and inert** | Nothing reads it, and there is nothing for it to lock: the popup renders connection and screening **status** only — it has no editable settings, so no field can be made read-only. `managed-schema.json` describes listed names as rendering "read-only in the popup with a 'managed by your organisation' hint"; that describes a UI this extension does not have. |

`[documented 2026-09-01]` The inert pair is stated here rather than
quietly left to look live. They are still declared in
`managed-schema.json` and still merged into the settings object, so a
policy that sets them is accepted rather than rejected — which is exactly
why an admin needs to be told. Wiring them, or removing them, is a
separate decision that has not been taken. Until it is, treat both as
documentation of an intent, not as controls: **do not cite either in a
deployment review or a compliance answer.** The enterprise policy
templates in `templates/` therefore omit both, on purpose.

Three names that appeared in older policy examples are gone entirely and
are not accepted at all: `daemonUrl` (removed when the extension stopped
talking to an HTTP daemon — there is no URL left for a policy to
mis-point), `failMode` and `keystrokeGuardEnabled` (both removed in
2.0.0). A policy that still sets them is silently ignored.

### `allowedProviders`, and what narrowing it costs

Values are **catalog provider ids** from `shared/ai-surfaces.json` — the
`id` of a provider entry that has `web_hosts`. They are not product
nicknames (`claude-ai`, `gemini`), not API-endpoint identifiers
(`openai-api`, `bedrock-us-east-1`), and not hostnames. The accepted set
is the enum in `managed-schema.json`; read it there rather than from a
list in prose, because `tests/shim.test.js` pins that enum against the
catalog and nothing pins a copy in a document. Matching is
case-insensitive and trimmed, and the list is capped at 64 entries.

**An empty array, or an unset key, means every catalog surface is
screened.** That is the default and the recommended setting. A non-empty
list is **subtractive**: it can only ever *remove* surfaces from
screening, never add one, because the content scripts are declared
against the catalog at build time and no policy value can reach a host
the manifest does not already inject into. A host the catalog cannot
attribute to a provider stays screened, so a typo'd id narrows nothing —
the failure mode is a policy that does less than you meant, never one
that screens somewhere it should not.

Say the cost out loud before you set it: **a provider you leave off the
list is not screened at all.** Prompts to it leave the machine
unexamined — no hold, no verdict, no redaction, and nothing in the popup
counting what went out. This is a knob that reduces protection, and it is
the only knob here that does. Set it where somebody has accepted that
loss in writing, and not otherwise.

Where the enforcement lives, if you want to read it: the key is in
`shared/constants.js::SHIM_SETTING_KEYS`, which is what makes
`content/content-script.js` read it and push it into the page world as
`SONOMOS_CONFIG`; `content/shim.js::isProviderAllowed()` applies it inside
`isScreenedHost()`, the single chokepoint every scope decision goes
through.

`[corrected 2026-09-01]` Until this release `allowedProviders` was
declared, accepted and merged into settings while **no runtime code read
it** — an admin could push it and screening carried on over every catalog
surface exactly as before. It is genuinely enforced now. The policy
templates in `templates/` shipped example values from an enum the catalog
has never used (`openai-api`, `chatgpt`, `claude`, `gemini`,
`anthropic-api`); those values would now match nothing, so they have been
replaced.

### Confirming a policy actually landed

Two checks, both on the machine:

1. `chrome://policy` (or `edge://policy`, or `about:policies` on Firefox)
   → find the extension by id and read the values the browser resolved.
   This tells you the browser accepted your policy file, not that the
   extension liked it.
2. The extension's own audit ring buffer records a `policy-loaded` entry
   naming **which keys** arrived (once per service-worker lifetime), so a
   key you set that does not appear there never reached the extension —
   usually a name not in `MANAGED_KEYS`, or a file at the wrong path.

## Verifying releases

**Correction, 2026-08-12; restated and corrected again 2026-09-01.** This
section once named `sonomos-extension-<version>.zip`, an artifact no
build in this repo has ever produced, and pointed `cosign` at the wrong
GitHub organisation. It then said releases were "built from a push to
`main`" and that `release.yml` "runs on every push to `main`". That is no
longer true either: as of 2026-09-01 `release.yml` is
**`workflow_dispatch`-only** (Sonomos #190). Merging to `main` publishes
nothing; a human opens Actions → Release → "Run workflow" on `main`, and
that is what submits to the stores.

**No release has been published through that workflow.** The signing,
attestation and SBOM steps are real and sit in
`.github/workflows/release.yml`, but they have never run against a
shipped version, so **no version you can install today is signed,
attested, checksummed by a published sidecar, or accompanied by an
SBOM**. There is nothing yet to compare a download against. Treat the
`cosign` and `gh attestation` recipes below as the procedure that applies
from the first published release onward; the rebuild-and-compare recipe
after them is the one that works today.
[`../security/RELEASE-POLICY.md`](../security/RELEASE-POLICY.md) is the
authority on the per-artifact status and is kept current.

`npm run package` produces exactly two artifacts, and their names carry
the version and the target:

| Artifact | Goes to | Exists today? |
|---|---|---|
| `dist/locke-extension-<version>-chromium.zip` | Chrome Web Store **and** Edge Add-ons | Yes — any checkout can build it |
| `dist/locke-extension-<version>-firefox.zip` | Firefox AMO | Yes — any checkout can build it |

A release dispatch adds these, and only these:

| Artifact | Produced by | Exists today? |
|---|---|---|
| `<zip>.sha256` | `release.yml::sha256 sidecars` | No — no release has been published |
| `<zip>.sigstore.bundle` | `release.yml::Sign artifacts` | No |
| SLSA build provenance attestation | `release.yml::SLSA build provenance attestation` | No |
| `sbom.cyclonedx.json`, `sbom.spdx.json` | `release.yml::Generate SBOMs (CycloneDX)` / `(SPDX)` | No — never bound to a version |
| `dist/publish-report.json` | `scripts/publish.mjs` (per-store outcome, secrets redacted) | Only in a run that publishes |

There is no native-messaging host tarball in this list, and there never
will be: the host is built and shipped by the Locke desktop app, and
nothing in this repository produces or verifies it.

To verify a downloaded zip once signed releases exist, install `cosign`
and run (substituting the version you downloaded):

```bash
cosign verify-blob \
  --bundle locke-extension-2.0.0-chromium.zip.sigstore.bundle \
  --certificate-identity-regexp 'release\.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  locke-extension-2.0.0-chromium.zip
```

Note the identity is a **branch** ref, not a tag: the release build runs
from a dispatch on `main`, so an identity regexp matching `refs/tags/v.*`
will not verify. (`release.yml` does create a `v<version>` tag, but
afterwards, as a record of what published — the build is not driven from
it.) A `Verified OK` line means the zip was built by this repository's
release workflow on `main`. Mismatch means do not deploy. Provenance is
the companion check, and it is equally unavailable until the first
release:

```bash
gh attestation verify locke-extension-2.0.0-chromium.zip -R sonomoshq/Locke-Extension
```

**The reproducible build is the check that does not depend on a release
having been signed, and you can run it today.** Two builds of the same
commit are byte-identical: `scripts/zip.mjs` is a deterministic writer
(fixed attributes, fixed deflate level, no extra fields, sorted entries,
one shared timestamp). Since 2026-09-01 this is also asserted in CI —
`quality.yml::reproducible-build` builds the payload twice under a fixed
`SOURCE_DATE_EPOCH` and fails the run unless the two zips match — though
this repository is newly public and **no CI run has completed in it yet**,
so treat that as a gate that will bite rather than as evidence that it
has. You do not have to take any of it on trust: `LICENSE` (PolyForm
Strict 1.0.0) permits noncommercial use, which includes rebuilding this
software to verify it, so an evaluating IT team may run the comparison
itself. What the licence does not permit is redistributing or modifying
the result — you may check the claim, not ship your own build.

```bash
git checkout v2.0.0                      # the tag the release created
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)
npm run package
sha256sum dist/locke-extension-2.0.0-chromium.zip
```

`SOURCE_DATE_EPOCH` is what pins the archive timestamps to the release
commit. Unset, the writer falls back to a fixed constant (315532800,
the ZIP epoch floor), which is still deterministic but will not match a
release build. Until a release exists there is no published `.sha256` to
compare that hash against — compare it against the artifact you
submitted, or against a colleague's independent rebuild of the same
commit.

## Finding the extension ID

Substitute `<EXTENSION_ID>` (and `<EDGE_EXTENSION_ID>`) in the
templates with the real value:

- **Chrome Web Store install**: the ID is in the listing URL,
  `chrome.google.com/webstore/detail/<name>/<EXTENSION_ID>`, and on
  `chrome://extensions` once installed.
- **Edge Add-ons install**: the ID is in the listing URL,
  `microsoftedge.microsoft.com/addons/detail/<name>/<EDGE_EXTENSION_ID>`.
  It differs from the Chrome ID for the same package.
- **Firefox**: not an ID you look up — it is fixed at
  `desktop-connector@sonomos.ai` (`manifest.json`,
  `browser_specific_settings.gecko.id`), and the managed-storage file
  must be named after it.
- **An unpacked developer load (Chromium)**: Chromium derives the ID
  from the absolute path the extension was loaded from, so every
  checkout gets a different one and it is shown on `chrome://extensions`.
  Such an ID is not in the native-messaging host's `allowed_origins`, so
  the browser refuses to start the host until the desktop app authorises
  it. That is a desktop-app-side step.

  `[corrected 2026-09-01]` This section used to tell you to add a `key`
  field to `manifest.json` and compute the ID from it. Do not: the
  packager rejects a manifest carrying `key` or `update_url`
  (`scripts/store-build.mjs`), and modifying the extension is outside
  what `LICENSE` permits.

## Incident response

- Security contact: see `SECURITY.md` (`security@sonomos.ai`).
- Vulnerability disclosure: GitHub private security advisory at
  <https://github.com/sonomoshq/Locke-Extension/security/advisories/new>.
- Privacy questions: <https://sonomos.ai/locke/privacy>.
- On a machine where AI traffic has started failing, the first question
  is whether the Locke desktop app is running: the extension fails closed,
  so "the desktop app is down" and "the request was refused by policy"
  both arrive as a blocked request. The popup separates them, and the
  audit ring buffer in `storage.local` keeps a shape-only trail (no
  bodies, no PII) for exactly this conversation.
