# Firefox and Edge data consent

Implemented for the next extension release. This document describes source behavior,
not confirmation that a new store package has been published or certified.

## Policy basis (checked 2026-10-05)

- Mozilla counts transfers to a local native application as data transmission.
  Firefox 140+ has built-in data permissions; supporting earlier versions requires
  a custom disclosure. New/upgrading users must see consent before transmission.
  [Mozilla policy](https://extensionworkshop.com/documentation/publish/add-on-policies/#data-collection-and-transmission-disclosure-and-control)
- The manifest uses Mozilla's categories. Technical/interaction permission is
  optional and its browser-level revocation must be respected.
  [Mozilla taxonomy and API guidance](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- Edge requires express consent before collecting, storing or transmitting highly
  sensitive information such as health or financial data.
  [Microsoft policy §1.5.6](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies#156-highly-sensitive-information)

This implements controls; it does not replace store review or legal review.

## Declarations and data mapping

Firefox required categories cover what a supported request can actually contain:

| Category | Local screening payload |
| --- | --- |
| personallyIdentifyingInfo | Names, contact details and other identifying content in prompts/uploads |
| healthInfo | Health information in prompts/uploads |
| financialAndPaymentInfo | Financial/payment information in prompts/uploads |
| authenticationInfo | Credentials in page-set headers or submitted content |
| personalCommunications | Chat messages and uploaded communications |
| locationInfo | Location information in submitted content |
| browsingActivity | Request destination, path/query |
| websiteContent | Request body, page-set headers and supported upload content |
| searchTerms | Search terms in supported request payloads |
| technicalAndInteraction (optional) | Presence browser/version, Edge registration ID and applied disabled-site acknowledgement |

`websiteActivity` is not declared: the extension does not transmit a separate
keystroke, click or scroll activity stream. `bookmarksInfo` is not declared: it
does not access bookmarks. Do not use `none` for local native messaging.

## Implementation and choices

- `shared/data-consent.js` owns the versioned local choice. Firefox and Edge
  require an explicit choice; existing settings/native-host approval do not
  count. Chrome retains its existing behavior, even though Chrome and Edge use
  the same Chromium artifact. Edge detection runs in the extension-owned context.
- The focused `popup/consent.html` tab opens on first install or on upgrade when
  the consent version is absent/outdated. Closing it grants nothing. A declined
  current-version choice is not repeatedly reopened on later updates.
- The single page discloses the data, local receiver/purpose, sensitive categories,
  what refusal does, retention limits, and the privacy-policy link. Optional
  connection metadata is independently selectable, off by default.
- Firefox 128–139 uses the local choices. Firefox 140+ additionally checks the
  optional browser permission, feature-detected via `permissions.getAll()`.
  Permission API failures fail closed rather than being mistaken for old Firefox.
- Request-body snapshots/serialization are stopped before consent in the page
  shim. Pre-consent upload classification reads only safe header-name markers.
  The isolated content relay and the native client independently enforce consent;
  a page-world message cannot authorize native transmission.
- Pausing cancels pending native ports and held requests. Consent generations
  prevent pause/regrant from resurrecting an old request still being serialized.
  No already-transmitted data can be recalled; no desktop retention is changed.
- Refusal pauses local transfers and holds only the requests Locke normally
  screens. The page clearly offers **Decline and uninstall**, or disabling Locke
  in extension settings and reloading affected tabs. It never silently releases
  an intercepted request as though screening had occurred.
- Local screening with optional metadata off still performs content-free native
  health probes and receives disabled-site settings. It sends no presence beacon,
  registration request or applied-settings acknowledgement. Edge users who need
  connector registration can do that in the desktop app.
- Before startup storage reads resolve, Firefox/Edge stay fail closed. A request
  started in that short interval may need retrying. Existing tabs orphaned by an
  extension update still require reload, as before.

No host permissions, API permissions, extension ID or minimum browser versions
were expanded. Runtime and root development dependencies remain empty.

## Automated verification

`npm test` includes real source execution with browser API fakes and page-world
VM tests. New coverage includes:

- Fresh install, existing-version upgrade, refusal, restart and unknown versions
- Direct native boundary, alarms and popup probes before consent
- Allowed captures and content-free probes with optional metadata declined
- Firefox built-in optional permission grant/refusal/revocation and old-browser fallback
- Edge runtime detection while retaining Chrome behavior
- In-flight native cancellation; late state/badge writes after revocation
- Before-consent body/header handling for fetch, XHR and cross-origin uploads
- Pause/regrant during asynchronous body serialization
- Single-page controls, synchronous user-gesture permission requests, pause,
  cancelled uninstall and storage errors
- Manifest declarations, no increased API/host permissions and packaged privacy links

Run the full suite plus packaging/static gates:

```sh
npm test
npm run validate
npm run package
node scripts/preflight.mjs --checks=version,manifest,headers,notes,tests
node scripts/audit-payload.mjs --dir=dist/firefox
node scripts/audit-payload.mjs --dir=dist/chromium
npm run generate
```

## Release verification still required

Temporary add-on installations silently grant install-time permissions; they do
not verify the signed install/upgrade prompt. Follow
[Mozilla's packaged permission tests](https://extensionworkshop.com/documentation/develop/test-permission-requests/)
on Firefox 128/139 and 140+, and actual Microsoft Edge, with a supported Locke
desktop app before release:

1. Install: focused disclosure appears; no capture/native/presence traffic precedes choice
2. Close/decline: no transfer, actionable held-request explanation and working uninstall/disable exit
3. Allow personal data only: supported text/upload screening works; no optional indicators/ack
4. Opt into optional metadata; on Firefox 140+ accept/decline the browser prompt separately
5. Revoke through the page and revoke optional data in Firefox settings; verify all affected transfers stop
6. Restart and upgrade from the currently published version; verify consent persistence or re-prompt as appropriate
7. Check already-open AI tabs across upgrade and show the reload remedy
8. Verify Chrome still runs its existing consent behavior and all packages pass store lint

Store metadata/privacy copy must match the actual version being distributed.
Do not describe this consent flow as live while the stores still distribute the
older binary. No store release, signing credential operation or merge is part of
this patch.

### Recorded browser verification (2026-10-05)

The opt-in Linux harness `tests/smoke/consent.mjs` loads the actual staged Firefox
package in a disposable profile and registers a temporary native-host fixture.
It intercepts the synthetic AI test page and test requests, so no prompt is sent
to an AI service. It verifies the focused consent page, default-off metadata,
native denial before consent, a real Allow click, native capture after consent,
Pause/revocation, a reopened page preserving refusal, and the full page → isolated
relay → native fixture → allowed/blocked fetch path. A same-version temporary
reinstall checks that an existing refusal is not re-prompted. It does not verify
signed installation/upgrade prompts or a production desktop installation.

```sh
# Opt-in dev dependency, isolated from the root zero-dependency package:
(cd tests/smoke && npm install)
npm run package
node tests/smoke/consent.mjs /absolute/path/to/firefox
```

The harness needs Python 3, Firefox 140+ with BiDi extension installation, and
exclusive access to loopback port 18795. It fails if that port is occupied instead
of talking to an existing service. All profile/native-host files are temporary.
Its screenshot is written to the system temporary directory as
`locke-consent-live.png`. Firefox BiDi may report an extension tab's URL as
`about:blank`; the harness identifies it by its actual DOM instead.
