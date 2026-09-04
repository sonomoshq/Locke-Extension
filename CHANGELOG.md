# Changelog

All notable changes to the Locke Extension (formerly Sonomos Desktop
Connector) will be
documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this extension follows the Sonomos Desktop release cadence rather than
strict SemVer.

## [Unreleased]

### Added — `store-credentials-check` workflow

`release.yml` has no dry-run input on purpose, which left no way to confirm the
ten store secrets and the `EDGE_API_KEY_ISSUED` variable short of a real
publish. A new `workflow_dispatch`-only workflow runs the same preflight and
`scripts/publish.mjs --dry-run` under the `store-publish` environment with the
same secret mapping, and writes a per-store result to the run summary. Nothing
is uploaded. Documented in `docs/store/AUTOMATED-RELEASE.md`.

### Changed — `INFRASTRUCTURE_REASONS` is generated from the shared vocabulary, not declared here

`shared/constants.js` declared the six prose fragments that separate "screening
is down, retry" from "this request was held back". Rust declared them too, in
`sonomos_vocab::INFRASTRUCTURE_REASON_FRAGMENTS`, and the only thing holding the
two together was a test in a third repo — Extension-Bridge opened a
`constants.js` off the filesystem and regexed the array out of it.

- **The list is now vendored and generated.** Canonical lives in
  `Service-Mesh/sonomos-vocab/vocab.json`, pinned entry-for-entry and in order
  against the Rust. Locke's `scripts/sync-surfaces.sh` vendors it to
  `shared/vocab.json`; `scripts/generate-vocab.mjs` (`npm run generate`) compiles
  that into `shared/vocab.generated.js`; `shared/constants.js` re-exports it.
  This repo holds no literal of its own to drift.
- **The old pin could not survive a fresh clone.** No repo can declare, version
  or fetch `../<Neighbour>`, so it was green only on a machine with the whole
  fleet checked out side by side. No cargo dependency could replace it either —
  what it reached for was JavaScript.
- **It was also reading the wrong repo.** The path was
  `../Depreciated-Desktop-Extension/shared/constants.js`, this extension's home
  before the 2026-08-31 rename, after which only the native-messaging host
  stayed there. It had been comparing Rust against a copy in a repo that ships
  no browser extension: passing, and protecting nothing that runs.
- **Two tests replace it**, both in `tests/constants.test.js`: the export equals
  the vendored JSON (catches a hand-edit of the generated file, or a `generate`
  nobody re-ran), and the values are still the six we expect (catches canonical
  changing and arriving here unreviewed). Locke's `vendored-vocab` fleet pin
  fails a push if `shared/vocab.json` ever stops matching canonical.
- **`shared/vocab.json` is a build input, not payload** — excluded from store
  zips alongside `shared/ai-surfaces.json`. The generated file ships.
- **`content/shim.js` keeps its inlined copy.** A MAIN-world classic script
  cannot import an ES module, generated or not; it stays pinned to
  `INFRASTRUCTURE_REASONS`, so it is now transitively pinned to canonical.

None of this makes the set harder to delete, which `constants.js` still says is
the plan once every peer sends a real `blockCause`: it is one import, one
generated file, two tests and one Locke sync target, with no consumer to rewrite.

### Changed — publishing is a deliberate act again, not a side effect of merging (Sonomos #190)

- **`.github/workflows/release.yml` is `workflow_dispatch`-only.** It ran on
  every push to `main` and submitted to the Chrome Web Store, Edge Add-ons and
  AMO with no human step at all, which meant an ordinary merge with a version
  bump in it reached three public review queues unattended. Merging now ships
  nothing; a release is somebody opening Actions → Release → "Run workflow" on
  `main`. Every job and step name is unchanged — `RELEASE-POLICY.md`,
  `CONTROL-CATALOG.md` and `ASVS-MAPPING.md` cite them verbatim.

  **This is not an approval gate and the docs say so in those words.** The same
  person can review, merge and dispatch. What it buys is that shipping is a
  decision rather than a side effect, and that a mistake caught between merging
  and dispatching is still fixable.

- **The release gate now asks a question a dispatch can answer.**
  `scripts/release-gate.mjs` compared `manifest.json`'s version against the
  *parent commit's* — exactly right for a push trigger, and wrong for a
  dispatch, where the tip of `main` is routinely not the bump commit. That gate
  would have answered "unchanged, nothing to publish" on a perfectly good
  release, making `force: true` the way every release was cut. An override used
  every time is not an override; it is the normal path with a warning label on
  it, and it would have silently disabled the one check standing between a
  dispatch and three stores.

  It now asks whether this repository already has a `v<version>` release tag —
  a fact about the repository, true whenever it is asked. `release.yml` creates
  that tag as part of publishing, and the local tag-push route
  (`scripts/hooks/pre-push`) leaves the same mark, so the two publish paths
  compose instead of racing.

- **Fail-closed in four directions, all tested.** Already tagged; a **shallow**
  clone, where a missing tag proves nothing rather than proving "not released"
  (the `gate` job now checks out at `fetch-depth: 0` so this branch is not
  taken); git unavailable or the tag list unreadable; and a dispatch on **any
  ref but `main`**. The last is new with dispatch — unlike a push trigger, a
  dispatch lets the operator pick the branch, and a release built from an
  unreviewed one would be signed under a sigstore identity that does not match
  the verification recipe `RELEASE-POLICY.md` publishes. `--force` deliberately
  does **not** override that one: it is an override for the version question,
  never a licence to ship a branch.

- **`tests/release-gate.test.js` now asserts that no workflow in the repository
  pairs a `push`, `pull_request` or `schedule` trigger with a store publish.**
  Reinstating the old behaviour takes one line of YAML in a file nobody diffs
  closely, so it is asserted rather than remembered. Parsed with a
  purpose-built reader, because this repository ships zero dependencies.

- **Every document that described the old model was corrected**, not just the
  policy: `RELEASE-POLICY.md`, `AUTOMATED-RELEASE.md`, `RELEASE-PIPELINE.md`,
  `CREDENTIALS.md`, `ASVS-MAPPING.md`, `CONTROL-CATALOG.md`, `CII-CHECKLIST.md`,
  `RISK-REGISTER.md` (R-04 narrowed, R-15 explicitly **not** mitigated — one
  person can still merge and dispatch), `MANAGEMENT-REVIEW.md`, `README.md` and
  `HONEST.md`. "Merging is the release" appeared in eight places; leaving any of
  them would have made the claim true somewhere.

- **What dispatch-only does *not* fix, stated rather than smoothed over:** the
  gate does not read the status of the checks that ran on the commit it is
  building, so a red `main` can still be released from, and branch protection is
  still not configured.

### Added — `managed-schema.json`'s `allowedProviders` now does something

- **It was a policy knob that did nothing.** The key was declared in the schema,
  merged into settings by the service worker, shipped in every enterprise
  template and documented in `DEPLOYMENT.md` — and read by no runtime code. Its
  enum was worse than inert: `claude-ai`, `gemini`, `phind`, `openai-api`,
  `bedrock-us-east-1` and thirty more, none of which the catalog has ever used,
  so every value the schema suggested named a provider that does not exist. A
  knob that does nothing is worse than an absent one, because a deployment
  review counts it as a control.

- **Wired, because the wiring was cheap.** `content/shim.js` already generates a
  host → catalog-id map into the page world (`SONOMOS_WEB_PROVIDERS`) and
  already decides scope in one place (`isScreenedHost`, which the user's
  subtractive `disabledWebHosts` set runs through). `allowedProviders` joins
  `SHIM_SETTING_KEYS`, rides the same config push, and is applied at the same
  chokepoint. The enum is now the catalog's own provider ids, and
  `tests/shim.test.js` fails if the schema and `shared/ai-surfaces.json` ever
  disagree again.

- **Semantics, chosen deliberately.** Empty or unset means every catalog surface
  is screened — reading an empty allowlist as "screen nothing" would turn a
  cleared policy into a total, silent loss of coverage. A non-empty list is
  **subtractive**: nothing in it can screen a host the manifest does not already
  declare. Matching is case-insensitive and trimmed, because managed policy is
  hand-authored JSON pushed by an MDM. A host the catalog cannot attribute stays
  **in** scope — an allowlist may only exclude what it can name.

- **The cost is stated, in `HONEST.md` and in the schema.** A provider an admin
  leaves out is not screened at all, so prompts to it leave the machine
  unexamined — and no surface reports that. The popup has no notion of scope, so
  a policy that excluded everything looks exactly like a healthy one.

- **Two neighbouring keys are inert and are now documented as inert rather than
  wired or removed:** `telemetryEnabled` (nothing consults it — the service
  worker's `handleTelemetry` logs unconditionally) and `lockedSettings` (the
  popup has no settings UI, so there is nothing to lock).

### Fixed — the popup asserted the desktop app was down before it had asked

- **`STATUS.UNKNOWN` read as "Offline — The Locke desktop app isn't running…
  Open it to resume."** That status is the service worker's *initial* state and
  the literal value `popup/popup.js` renders when the worker cannot be reached
  at all, so every popup open passed through it — and on a machine where Locke
  is running and screening, the sentence is simply false, with a remedy
  attached. It also contradicted our own toolbar badge, which has always shown a
  grey `?` for the same moment, and replaced `popup.html`'s honest "Checking…"
  placeholder with a claim. It is a **`checking`** view now: it says nothing has
  answered yet, and blames nothing. Same defect as the `NO_BRIDGE` correction
  before it, one status over.

- **`offline` said "isn't running" where it had only observed "isn't
  answering".** That branch is reached from a host reporting `connected: false`
  *and* from a bridge timeout, and a timeout is silence — the app may be running
  and wedged, or merely slower than `bridgeTimeoutMs`.

- **Every outage line overstated what was being held back.** "Requests to the AI
  apps and search engines Locke screens are being held back" reads as all of
  them. Only bodied requests are ever screened, and a prompt arriving as a
  top-level navigation is not screened on any host — so a user reading that
  during an outage concluded nothing of theirs was leaving, while an address-bar
  search left anyway. The sentences now name the subset.

- **"Screening is confirmed the first time you send"** became "the first time
  you send something it screens": an out-of-scope send confirms nothing.

### Added — a developer-run, in-browser smoke matrix (Sonomos #205)

- **`npm run smoke`** builds `dist/`, loads the unpacked extension in Chrome and
  Firefox, visits one catalog host, and asserts that `content/shim.js` installed
  its `fetch` hook and that the extension reported `NO_BRIDGE` cleanly with no
  console errors. Results land in
  [`docs/testing/BROWSER-SMOKE.md`](docs/testing/BROWSER-SMOKE.md).

- **It is not a workflow and it gates nothing.** Nothing in
  `.github/workflows/` runs it, and `HONEST.md` says so where it used to say
  there were no in-browser tests at all.

- **Zero runtime dependencies stays zero, and so does the root manifest.** The
  harness lives in a nested, opt-in `tests/smoke/package.json` with one pinned
  devDependency; its install and its lockfile are gitignored, so
  `ci.yml::lint-js`'s two tripwires stay true and Puppeteer's transitive closure
  never enters the dependency graph `dependency-review.yml` diffs. Nothing there
  can reach a store zip.

- **A missing browser, a missing driver or no network is a SKIP, never a
  failure**, and the "Setup" state an unauthorised unpacked ID produces is
  asserted as the *expected* result — the claim being tested is that the
  extension is honest about not being connected, not that it connects.

- **What the harness cannot see is recorded as "not observable", not as a
  pass.** Firefox's popup DOM and background state are unreadable over WebDriver
  BiDi, and its console attribution is weaker than Chromium's; the results table
  says so on the row it affects.

### Fixed — the enterprise and contributor docs described a product from before 2.0.0

- **`docs/enterprise/DEPLOYMENT.md` documented two things that no longer
  exist**: "observe mode", and a `keystrokeGuardEnabled` managed key. Both were
  removed in 2.0.0. The deployment guide is what an IT team reads before a
  fleet rollout, so it described a passive-observation mode and a keystroke
  guard that an admin could believe they were turning on.

- **The managed-settings table now matches `MANAGED_KEYS` exactly**, and says
  which keys are *enforced* (`allowedProviders`, `heartbeatSeconds`,
  `debugLogging`, `enforceTimeoutMs`) and which are **accepted and inert**
  (`telemetryEnabled`, `lockedSettings`), with an instruction not to cite the
  inert ones in a deployment review or a compliance answer.
  `managed-schema.json`'s own descriptions for those two said they worked; they
  now say they do not, and why.

- **Every enterprise template was corrected.** They shipped fictional
  `allowedProviders` values, a dead `keystrokeGuardEnabled`, and
  `lockedSettings` — a key that copies cleanly, applies cleanly, and shows
  green in `chrome://policy` while doing nothing. The inert keys are removed
  from the templates rather than annotated, because a comment does not survive
  a copy-paste of the value; each template names them in its header as
  deliberately absent instead. `debugLogging` and `enforceTimeoutMs` were in no
  template at all and now are. The ADMX/ADML pair lost `KeystrokeGuardEnabled`
  and `TelemetryEnabled`, gained the two missing enforced keys, and picked up
  the `presentationTable` it never had — without which `heartbeatSeconds`'
  input box would not render in GPMC.

- **`DEPLOYMENT.md` also claimed the extension makes no outbound network
  request.** It makes one: the loopback presence beacon, plus the
  self-registration POST on the same origin.

- **`CONTRIBUTING.md` said nothing runs in CI.** Eight of the nine workflows
  now do; it enumerates them with verbatim job names, and keeps "running is not
  gating" attached, because branch protection is still not configured. It also
  still asserted the withdrawn two-person release rule, and a `preflight`
  `native-host` check that was removed when the host manifest left this
  repository.

### Added — the extension's source is now published

- **The extension source is published as a separate public repository,
  `sonomoshq/Locke-Extension`, under a view-only licence.** Readers may read
  the source; the licence grants no permission to use, build, modify or
  redistribute it. The native messaging host and the Locke desktop app are not
  part of that publication.

### Changed — the documentation no longer describes the backend it talks to

The docs drew the topology of the services behind the native host, named
them, and cited files in their repositories. They no longer do.

- **The integration notes moved off `docs/architecture/`.** Their subject was
  the other side of the seam rather than this extension, so they are no longer
  on the public path.
- **`docs/architecture/DATA-FLOW.md` was scrubbed, not deleted.** It is cited
  as evidence by `ASVS-MAPPING.md` (four rows), `CONTROL-CATALOG.md`,
  `CII-CHECKLIST.md`, `RISK-REGISTER.md` R-19, `SUB-PROCESSORS.md`,
  `DPIA-template.md`, `SECURITY.md`, `CONTRIBUTING.md`, `TODO.md` and the PR
  template; deleting it would break all of them. What went is the named
  service chain, the wire types and cross-repository source paths. What
  stayed is everything a user or an auditor needs: scope,
  the per-hop content table, the block classes and their reason tokens, and
  what never leaves the device.
- **README, SECURITY, HONEST and the compliance and legal docs** now describe
  the boundary the extension can actually see — it hands a held request to
  the Locke desktop app and applies the verdict — instead of the chain behind
  it. That is the vocabulary `popup/copy.js` already uses with users.
- **Reason tokens are untouched.** `no-bridge` and `bridge-unreachable` are
  strings shipped code prints to the page console; renaming them in prose
  would make the prose wrong.
- **Not done here:** the internal names that remain in code identifiers. Those
  need a code change, which this one is not.

### Removed — three README badges asserting ratings this project has not earned

- **The SLSA Level 3 badge is gone**, along with the OpenSSF Scorecard and
  CII Best Practices badges. All three published a third-party rating that
  does not exist, and a supply-chain badge is the first thing a security
  reviewer clicks:
  - **SLSA L3.** `release.yml` holds the cosign `Sign artifacts` and
    `SLSA build provenance attestation` steps and is `workflow_dispatch`-only.
    Checked against the Actions API: **zero runs, ever**, and the repo has no
    git tag and no GitHub release. Nothing shipped is signed by us or carries
    an attestation, at L3 or any level.
  - **OpenSSF Scorecard.** 13 runs through 2026-06-18, **all failed**;
    `publish_results` needs a public repo. There is no published score.
  - **CII Best Practices.** The badge URL carried a literal `/0` project ID;
    the checklist has never been submitted.

  `docs/security/ASVS-MAPPING.md` had already recommended the SLSA badge come
  down on 2026-08-12 and nobody acted on it; that row now records that it was.
  The README states the gap in prose rather than leaving a silent blank where
  a badge was, so the same question does not get re-asked in six months.

### Fixed — the security docs said "never run" about seven workflows that did run

- **Checked every "dispatch-only, never run" claim against the GitHub Actions
  run history instead of against the workflow files.** The 2026-08-12 audit
  read the `on:` blocks and concluded nothing had ever executed. The history
  says otherwise: 98 runs, and `ci.yml`, `sbom.yml`, `semgrep.yml`,
  `gitleaks.yml`, `codeql.yml`, `scorecard.yml` and `dependency-review.yml`
  all ran on `push`/`pull_request`/`schedule` from 2026-05-10 until commit
  `6caa2a0` commented their triggers out on 2026-06-18. Trivy and Semgrep
  passed on all 15 CI runs; `sbom.yml` uploaded CycloneDX and SPDX artifacts
  on all 13 of its; CodeQL (17) and dependency-review (4) failed every time
  for want of GitHub Advanced Security on a private repo.

  So the honest posture is **"clean at a 2026-06-18 baseline, unscanned
  since"** — not "never scanned", which understates what is known, and not
  "clean", which overstates it. **`release.yml` is the one workflow that has
  genuinely never run**, and that is the one the supply-chain claims rested
  on. Corrected across `README.md`, `SECURITY.md`, `HONEST.md`,
  `CONTRIBUTING.md`-adjacent docs, `docs/security/{ASVS-MAPPING,
  CONTROL-CATALOG,CII-CHECKLIST,MANAGEMENT-REVIEW,RISK-REGISTER,
  RELEASE-POLICY}.md`, `docs/store/RELEASE-PIPELINE.md` and
  `docs/legal/DPIA-template.md`.

- **`HONEST.md` supply-chain rating cut from 9 to 5.** The 9 was scored on
  "sigstore, SLSA L3, SBOM, SHA-pin, version-pin", two of which have never
  executed. The 5 reflects what is real without CI: zero JS dependencies, a
  SHA-pinned Actions graph, and a genuinely deterministic build. Supply chain
  was also removed from the list of areas the doc names as its strongest.

- **`RISK-REGISTER.md` R-04 re-rated.** It credited "Sigstore keyless signing
  + SLSA L3 provenance" as live mitigations for a poisoned release. They have
  never run. Likelihood stays 1 because CI does not publish releases at all —
  a human runs the local pre-push gate — not because signing is in place.

### Fixed — on Windows an unpacked load had no supported fix at all

- **An unpacked load can now be authorised on Windows.** A Chromium load whose
  ID is derived from its absolute load path — every unpacked checkout — matched
  no ID the Locke desktop app had registered for the native messaging host. The
  browser refused the host ("access to the specified native messaging host is
  forbidden"), the extension sat in Setup, and the remedy the extension itself
  printed pointed at a step that had no answer for the state the user was in.
  Windows now authorises and remembers extension IDs the way macOS and Linux
  already did, protecting the stored list with a user-only ACL, so the fix the
  extension names is one that exists.

### Fixed — an authorised extension ID did not survive the next re-install

- **The extension IDs you authorise are now remembered.** Authorising an
  unpacked load wrote its ID nowhere durable, so the next re-install of the
  native messaging host — what the setup docs, the Inspector's "install native
  host" button and every repair path invoke — silently dropped it. The browser
  refused the host again ("access to the specified native messaging host is
  forbidden"), the extension fell back to Setup, and the remedy every surface
  names reproduced the drop. Authorised IDs now survive a re-install, and the
  list is capped rather than growing on its own: each entry is an origin
  allowed to start the native host, so it is a trust surface.

### Fixed — the catalog claimed search surfaces were masked; nothing typed on them is

- **Re-synced `shared/ai-surfaces.json` from the canonical catalog** and
  regenerated the manifest and the two host globals from it. Eleven
  "web_hosts" were presented as protected while the extension screens nothing
  a user types on them.

  The mechanism, stated once because it is a property of the transport rather
  than of any site: the shim hooks `fetch`, `XMLHttpRequest`,
  `navigator.sendBeacon` and `fetchLater`, and screens request **bodies**. A
  prompt that arrives on a URL instead — typed in the **address bar**, sent to
  the browser's default search engine, followed as a `?q=` deep link, or
  submitted by a `<form>` (a navigation, and `method="post"` is unhooked
  exactly like `method="get"`) — is disclosed before any page-side code runs.
  This manifest holds no `webRequest` / `webNavigation` /
  `declarativeNetRequest` permission, so such a request cannot be observed at
  all. A query typed into the address bar never touches the page, so even
  page-side form interception would miss it. That is true on **every** host in
  the catalog, the `body` ones included — no list can express it, and none is
  attempted.

  **Screening navigation-borne prompts is deferred to 1.x**, for a
  product-design reason rather than a plumbing one: for chat, masking
  preserves utility because the model still answers the masked question, but
  for search the PII often *is* the query, and searching for
  `<PERSON_1> <ADDRESS_1>` returns nothing useful. Mask-and-forward does not
  transfer; it needs a different interaction model (warn-and-confirm, an
  override verdict path, "sent anyway" event semantics), with its own design
  doc. `HONEST.md` now states the hole plainly and the catalog carries the
  deferral, so it is not rediscovered as a bug.

- **The injection list changed in both directions, and the removals matter
  more than the additions.** Dropped `phind.com` and `www.phind.com` (Phind
  shut down 2026-01-16), `chat.lechat.fr` (no DNS record), `leo.brave.com`
  (no DNS; Brave Leo is a browser-native sidebar no content script can reach),
  `brave.com` (marketing site, whose `*.brave.com` pattern bought injection
  across Brave's entire web estate for zero screening) and `grok.x.ai`
  (301s to marketing). A dead hostname in a shipped MAIN-world injection list
  is worse than dead weight — whoever registers that name next inherits a
  content script on their pages, from us.

  Added, and these **increase** screening: `copilot.microsoft.com` (absent
  entirely, while `www.bing.com/chat` redirects to it — we covered Bing's
  unscreenable half and missed the screenable one), `grok.com`,
  `duck.ai` and `assistant.kagi.com`. `duckduckgo.com` and `kagi.com` stay
  listed and stay declared unscreened: their own search boxes are navigations,
  but those hostnames also carry the chat traffic of the two entries above,
  and the shim scopes on the request **target**, so removing either would
  silently delete real screening on a different page. 27 hosts → 24.

- **Pinned the drift direction nothing was watching.** `manifest.test.js`
  checked that every catalog host is injected on; nothing checked the reverse,
  so a host deleted from the catalog but left in the manifest kept being
  injected on indefinitely — which is how a shut-down service stayed in the
  shipped list for seven months. Two tests now fail if the manifest or either
  generated host list names a host the catalog does not, i.e. if someone syncs
  the catalog and forgets `npm run generate`. Both were confirmed to fail when
  deliberately broken.

- **Removed a stale comment in `scripts/generate-surfaces.mjs`** describing an
  `<all_urls>` "keystroke guard" that does not exist and never did. The
  manifest declares exactly two content scripts, both scoped to the catalog
  match patterns. A comment claiming a capability we do not have, sitting next
  to the code that decides where we inject, reads as a coverage claim.

  Nothing about fail-closed behaviour changed, and no request that was
  screened before is unscreened now.


### Fixed — the popup claimed confirmed screening off a probe that stops one hop short

- **"Active — Locke confirmed screening is active" no longer comes from a
  reachability probe.** The probe established only that the Locke desktop app
  accepted a connection. The native host promoted that to
  `screening: "available"`, `shared/screening.js` ranked it above stored
  capture evidence, and the popup rendered it as a confirmed green.

  Accepting a connection is not screening. The desktop app accepts the probe
  the same way whether or not it is in a state to screen anything, so the
  popup could report confirmed screening while every real capture was
  fail-closing with `engine unavailable`. The same "connected means protected"
  defect the probe was built to fix, displaced one step inward — and worst in
  precisely the state the fail-closed posture exists for.

  The probe is now read in one direction only, which is the only direction it
  can support:

  - The native messaging host answers a reachable guard with `unknown`, never
    `available`; it can no longer emit a positive at all. Its 5s
    staleness bound went with it — the bound existed to stop a stale `true`
    reading as "reachable now", and no `true` at any age asserts anything now.
  - `shared/health-client.js`'s `screeningFromStatus` forwards only
    `unavailable`, and explicitly demotes a legacy `available` from an older
    host — the host is installed natively while the extension updates through
    a store, so that skew outlives the fix.
  - `shared/screening.js`'s `screeningFor` has no branch a positive can reach.
    AVAILABLE now has exactly one source: a real capture receipt.
  - The popup's reassuring line names its evidence — "Locke screened a recent
    request, so screening is confirmed active" — because it now always has
    some.

  Nothing about which requests are screened changed, and nothing fails open:
  every state here is a report. A live `unavailable` still travels instantly,
  which is what catches a guard that died between sends. The 60-second
  contradiction window that used to stop a probe overruling a failed capture
  is retired as redundant — the guarantee is structural now, with no expiry —
  and the constant stays on for its other job, bounding which recent capture
  event the popup may name. One deliberate consequence: **recovery is
  signalled by traffic**, not by the probe, so after an outage receipt the
  popup stays "Unavailable" until something is actually screened.

### Fixed — the app told users to install an extension that was installed

- **The presence beacon no longer rides the health-check backoff.** It was
  fired from exactly three places — `onInstalled`, `onStartup` and the
  health alarm — and that alarm backs off to `backoffMaxSeconds` (5 min)
  while the desktop app is unreachable. So the beacon's real cadence was
  set by whether the *guard* could be reached, and the moment the backoff
  is widest is precisely the moment Locke comes up: the browser has been
  open with the extension installed while Locke was down, the user starts
  Locke, opens Controls to flip a per-site toggle, and is told **"Locke
  Extension required — Install the Locke Extension"** for up to five
  minutes while the extension is installed and screening every send on the
  page. The desktop listener calls a heartbeat stale at 45 s and starts
  each app run having never heard from any browser, so four and a half of
  those five minutes read as absent. It is a first-thirty-seconds-of-a-demo
  failure that points the user at a fix which is not the problem.

  The two signals answer different questions and now keep different
  cadences. "Am I installed?" is a fact this extension always knows, costs
  one loopback POST that is refused instantly when nothing is listening,
  and is never in doubt — it gets its own alarm (`sonomos-presence`) at a
  fixed 30 s that never backs off. "Can I reach the guard?" is a
  native-messaging round trip that may launch a host process and reach the
  desktop app behind it — it keeps the backoff it was given, unchanged,
  because an app that is down should not be hammered with that. The beacon
  also fires when the popup asks for a check, which is the cheapest
  possible moment to be seen by an app that started since the last tick.

  Presence still means **installed, and nothing more**. It is not evidence
  that anything was screened: it carries the same two fields it always did
  (`{ browser, version }`), it is deliberately absent from the capture path
  so real traffic can never quietly promote "installed" to "screening", and
  an extension whose guard is down still reports itself present — answering
  a screening outage with an install instruction is the wrong fix aimed at
  the wrong user. Nothing about which requests are screened, or about
  fail-closed behaviour, changed.

  Re-arming is idempotent by asking first (`alarms.get`), because
  `alarms.create` replaces by name and restarts the countdown — an
  unconditional re-create on a worker that wakes constantly would starve
  the tick it exists to protect. The worker re-arms on every evaluation, so
  any wake at all restores a presence alarm lost to an extension update.
  The beacon cadence and the desktop listener's staleness window are a
  contract between two processes that nothing else checked, and getting it
  wrong does not fail loudly — it just quietly reports absence.

### Fixed — the frames we widened injection into could not answer

- **The shim↔content-script channel is no longer dead in an opaque-origin
  frame.** All three posts of the `SONOMOS_*` protocol named
  `location.origin` as their `postMessage` target. That is the origin of
  the frame's *URL*, not of its *document*, and the two differ in exactly
  the frames `match_about_blank` / `match_origin_as_fallback` opt us into.
  In an `about:blank`, `about:srcdoc` or `data:` frame it reads the string
  `"null"` — truthy, so the `|| '*'` fallback never fired, and not a
  parseable URL, so `postMessage` threw: every bodied request in the frame
  was refused as `verdict-channel-failed`, whose copy asks for a page
  reload that could not help, because the origin is opaque by construction.
  In a *sandboxed* frame at a catalog URL it reads the real origin, which
  the frame's opaque document origin never matches, so the message was
  silently dropped and the request hung the full 45 s before being refused
  as `verdict-timeout` — advice to check a desktop app that was never
  asked. Both ends now post to the window without naming an origin, which
  is the only spelling that works in every frame and gives nothing away:
  the message never leaves this window, both listeners already reject any
  `event.source` that is not it, and `targetOrigin` filters by the
  receiving document's origin rather than by listener, so the page could
  read these posts whatever we passed. Fail-closed is untouched — every
  path here refused rather than sent — and nothing changed about which
  requests are screened. `tests/constants.test.js` pins the two copies of
  the rule together, and both test harnesses now enforce the browser's real
  `targetOrigin` semantics (throw on unparseable, silent drop on mismatch)
  instead of ignoring the argument.

- **`HONEST.md` overstated what a `data:` frame gets.** It claimed both the
  AI-host scope and the initiator-scoped upload path work in every frame the
  widening reached. A `data:` document does not inherit its creator's base
  URL (`document.baseURI` is the `data:` URL itself), so `PAGE_HOST` is
  empty there, the frame is not an AI surface, and the upload scope — which
  is defined on the initiator — cannot fire. The host scope still does. The
  claim is corrected and pinned by a test.

### Fixed — a refusal the user could not tell from the site breaking

- **Every XHR-path block now names Sonomos.** `blockXhr` aborted the request
  and dispatched a bare `ProgressEvent('error')` — byte-for-byte what a
  dropped connection looks like — so a guard outage, a policy block and a
  too-large attachment all reached the user as the SITE's own network-error
  copy, and our refusals were filed as ChatGPT bugs. A `fetch` block never had
  this problem: it rejects with a `TypeError` carrying the sentence. XHR has no
  such channel, so the reason now rides on the object — `sonomosBlocked`,
  `sonomosBlockReason`, `sonomosBlockKind`, `sonomosBlockMessage`, set before
  the event fires — and the human sentence is emitted on the page's console for
  EVERY transport (fetch, XHR, `sendBeacon`, `fetchLater`) from one place, at
  `warn`, unconditionally. Deliberately NOT done: an in-page banner (this
  extension writes nothing into the document, and a page can remove or forge
  what it does write) and a synthesized `status`/`responseText` (which would
  attribute our refusal to the site's own server). The residual — a site that
  swallows its own error still shows its own copy — is stated in `HONEST.md`.

- **Four relay-failure codes stopped telling users to start an app that was
  running.** `no-bridge`, `bridge-empty`, `bridge-unknown-response`,
  `capture-error` and `bad-request` all inherited the fallback sentence "the
  Locke desktop app could not be reached. Start it, then try again." Each now
  has copy that is true of it — `no-bridge` points at re-registering the
  native messaging host rather than at starting the app (the browser starts
  the host itself, from a manifest a running app does not write, so "start the
  app" cannot fix any shape of it),
  `capture-error` names the page reload (it is OUR service worker that threw,
  not the app). `bridge-error` keeps the original sentence, which is true
  there.

- **The capture path and the health check stopped disagreeing about one
  error.** `captureViaHost` carried a second copy of the health check's
  native-messaging pattern list, and the copies had drifted in both directions
  — the capture path missed Chrome's actual "Native host has exited." while
  the health check missed the bare "Native host exited". So one event produced
  two codes and two sentences: the page said "the desktop app could not be
  reached, start it" while the popup correctly said the connector had not
  started. The worker now calls `classifyLastError` (screening evidence is
  UNCONFIRMED under either code, so nothing about enforcement moves).

- **The popup answers `NO_BRIDGE` with the install step, not "open the app".**
  A new `setup` view: with no native-messaging manifest there is no channel, so
  whether Locke is running is something the extension cannot see — and
  "Offline… Open it to resume" asserted it anyway, in the configuration where
  the app is usually already open. Chrome's `allowed_origins` rejection now
  classifies as `NO_BRIDGE` too.

- **The toolbar badge no longer lags an outage by a heartbeat, and marks a
  fail-open send.** `applyScreening` never touched the badge, so a guard that
  died between beats left the toolbar clean for up to 30 s while the page was
  already being refused; the badge is now re-derived from the evidence each
  capture produces. And `UNCONFIRMED` no longer keeps a blank badge for
  `sent-unscreened`: a request that shipped unexamined bytes was the one state
  the toolbar said nothing about, while an outage — where nothing leaked —
  wore the amber `!`. It is the same `!`, it clears on the next clean receipt,
  and the popup carries the sentence that tells the two apart — the badge
  split an earlier change had left open.

- **A beacon to a surface the user switched off is no longer refused.** The
  `sendBeacon` and `fetchLater` hooks tested the catalog (`isAiHost`) instead
  of the catalog minus the user's own disable set (`isScreenedHost`), so a
  disabled host still had every beacon blocked — enforcement the user had
  explicitly turned off.

- **`receipt-too-large` names both real numbers.** The shim's 8 MiB capture cap
  is ten times the native-messaging reply cap a redacted request must come back
  through, so "send a smaller attachment" was unactionable advice. The message
  now states the request's actual size and the reply ceiling
  (`REDACT_REPLY_BODY_LIMIT`). Deliberately NOT done: refusing large bodies
  before the round trip — that cap only binds when the guard rewrites the
  request, so pre-refusing would block the clean 2 MB attachment that succeeds
  today.

- **The native host's stderr has somewhere to go.** It is now written to
  the native messaging host's log under `~/.sonomos/logs/` (appended, rotated at 1 MiB) — the path
  the desktop app's diagnostics card already tells support to ask for. stdout
  is untouched: it is the native-messaging channel.

### Fixed — the popup called a fail-open send "Screening: Active"

- **An `allow` or `redact` marked `unchecked` no longer reads as protected.**
  `shared/screening.js::evidenceFromReceipt` decided on `decision` alone and
  never read `receipt.unchecked` — the field the native host emits on every
  receipt precisely so the browser can tell the two identical-looking outcomes
  apart (`unchecked = false` + `unscreened[]` ⇒
  the bytes were withheld; `unchecked = true` ⇒ the unexamined bytes DID
  leave). So the single kind of send where unexamined content had just reached
  the AI provider rendered a confident green "Screening: Active". Every other
  surface already had this right — the shim warns `allow-unchecked` in the
  page console, `tallyFromReceipt` counts it in the session note — which made
  the popup the one surface contradicting the rest about the same request.

  The receipt now yields **UNCONFIRMED**, not UNAVAILABLE. The guard is
  demonstrably alive (it answered) and it honoured a window the user opened
  themselves, so "screening isn't answering" would blame the infrastructure
  for a user's choice, write a `screening-unavailable` audit entry on a
  healthy machine, and claim requests were "being held back" when the opposite
  had just happened. UNCONFIRMED is the state this repo already keeps for "a
  real capture happened and it does not entitle us to claim a screen", and it
  brings the two behaviours this case needs: a live reachability probe can no
  longer overwrite it inside the contradiction window (a hello with the guard
  does not un-send what already left), and one clean receipt restores "Active"
  immediately, so nothing is stuck penalised for a window since closed.

  The pairing rule now lives in one predicate, `shippedUnscreened`, read by
  both `evidenceFromReceipt` and `tallyFromReceipt` — the count the popup
  shows and the state it renders can no longer disagree about one receipt. An
  ABSENT `unchecked` key still reads `false`, matching the host's
  `#[serde(default)]`: absent means "a bridge too old to have the field", and
  reading it as `true` would report every request on such a bridge as a leak.
  A withheld `redact` (`unchecked: false` + `unscreened[]`) keeps reading
  Active, because holding bytes back IS screening working.

- **The popup says it was sent, not held back.** `sent-unscreened` rides along
  as the evidence code, and `popup/copy.js` gives it its own detail line. The
  generic unconfirmed-after-a-failure sentence ends "so nothing was sent
  unscreened" — the precise inverse of this case — and inheriting it would
  have swapped one false sentence for its mirror image.

### Merged — main's store-acceptance pass, over the top of this branch's relay work

`main`'s store pass (the entry below) and this branch's honesty pass both
rewrote the same eight lines of `content/content-script.js`, for different
reasons. `main` was fixing Firefox: `chrome.runtime.sendMessage(msg)` returns
`undefined` there rather than a promise, so the relay answered `null` and the
shim's fail-closed path blocked every in-scope request. This branch was making
that same relay *say* which hop failed (`relay-rejected`, `relay-no-promise`,
`relay-threw`) and carrying the shim's settings across the world boundary.

Both survive. `main`'s `askWorker()` dialect branch is the mechanism, and the
reason-coded warnings hang off its two failure paths. `relay-no-promise` keeps
its own reason code and its comment: `askWorker()` always hands back a promise
on the Chromium path, so that branch is now reachable only when the Gecko
namespace answers with something that is not thenable — which is precisely the
trap `main` documented. The settings read moved onto the same `api` namespace
pick, because a promise-style `chrome.storage.local.get()` on Firefox yields
`undefined` for exactly the reason `sendMessage` did: left alone, every Firefox
profile would have silently fallen back to `SHIM_DEFAULTS`, admin policy
included. The two `tests/content-script.test.js` files that arrived from both
sides are one file now, running every case against both dialects — 20 tests,
with Firefox's Chrome-compat namespace present and useless in the fixture so
the settings cases fail if either read wanders back to `chrome.*`.

This branch's own entries follow main's.

Store-acceptance pass over the 2.0.0 packaging: two submission blockers, one
Firefox functional bug, and a mechanical gate so none of them can come back.

### Fixed
- **Store uploads were rejected on Windows.** `scripts/package.mjs` shelled out
  to PowerShell `Compress-Archive`, which writes entry names with BACKSLASH
  separators — a violation of §4.4.17.1 of the ZIP spec. Chrome Web Store,
  Edge, and AMO either reject such an archive ("manifest file not found") or
  flatten its directories. Replaced with `scripts/zip.mjs`, a dependency-free
  deterministic ZIP writer: forward-slash names, fixed timestamps and entry
  order, so the same tree produces byte-identical artifacts on any OS (which
  also makes the AMO source review reproducible).
- **Firefox blocked every in-scope AI request.** `content/content-script.js`
  called `chrome.runtime.sendMessage(msg)` and expected a promise back.
  Firefox's Chrome-compat namespace is callback-only and returns `undefined`,
  so the relay answered `null`, which the shim correctly reads as fail-closed —
  the extension was unusable on Firefox. The relay now prefers `browser` and
  handles both dialects (`tests/content-script.test.js` pins both).

### Added
- **`data_collection_permissions: { required: ["none"] }`** under
  `browser_specific_settings.gecko`. AMO has required a data-collection
  declaration from every new add-on since 2025-11-03 and shows it in the
  install prompt; `none` is the accurate answer for a loopback-only extension.
  Reasoning in `docs/security/PERMISSIONS.md`.
- **`npm run validate`** (`scripts/store-build.mjs`, also gating
  `npm run package`) — checks the staged tree against the strictest rule of
  the three stores: field limits, version format and manifest/package.json
  agreement, icon files whose pixels match their declared size, every manifest
  reference actually shipping, auto-reject keys (`update_url`, `key`),
  remote-code smells (`eval`, `new Function`, remote `<script src>`), CSP
  hygiene, per-family key stripping, and the AMO gecko/data-collection rules.
  `npm run package` refuses to write a zip that fails it.
- `tests/store-build.test.js` and `tests/content-script.test.js` — 31 cases
  covering the staging transforms, each validation rule, zip round-trip and
  determinism, and both messaging dialects.
- **Automated store publishing.** `scripts/publish/{chrome,edge,firefox}.mjs`
  submit the built artifacts to the Chrome Web Store (API v2 — v1 stops
  working 2026-10-15), Edge Add-ons (API v1.1; the Azure AD auth it replaced
  was retired 2025-01-10) and AMO (API v5, JWT signed per request because a
  token may not outlive 300 seconds and validation polling routinely does).
  Each returns a per-store result rather than throwing, so one store being
  down cannot stop a release to the other two, and each distinguishes
  *skipped* from *failed*: an item already in review cannot accept an upload,
  and republishing during Edge certification restarts its seven-business-day
  clock. `scripts/publish.mjs` drives all three and writes
  `dist/publish-report.json`.
- **`npm run preflight`** — everything that must hold before a byte is
  uploaded: the release version agreeing across all five files that carry it,
  the store validation above, the native-messaging host name pinned in
  `shared/constants.js` and in the host's manifest templates, store credentials
  present, and listing assets accounted for.
- **`npm run bump`** — one command for a version bump, which otherwise means
  four hand edits (`manifest.json`, `package.json`, both sites in
  `package-lock.json`) plus a dated `CHANGELOG.md` heading. A store rejects
  a re-upload of an existing version, so a half-applied bump is a failed
  release.
- **A pre-push gate and the workflows to replace it.**
  `scripts/hooks/pre-push` (installed by `npm run install-hooks`, also npm's
  `prepare`) validates every push and, on a `v*` tag, publishes to all three
  stores. `.github/workflows/` carries CI, release, CodeQL, Semgrep,
  Gitleaks, dependency-review, SBOM and Scorecard — every one
  `workflow_dispatch`-only with its real triggers commented out, because
  Actions minutes on a private repo are billable. `release.yml` calls the
  same `scripts/publish.mjs` the hook does, so opening the repo changes
  triggers rather than logic.
- `docs/store/RELEASE-PIPELINE.md` and `docs/store/CREDENTIALS.md`.

### Changed
- **Privacy policy URL is now `https://sonomos.ai/locke/privacy`** — the
  extension-specific policy. The company-wide policy at `sonomos.ai/privacy`
  does not cover the extension, so linking it from the popup misstated what
  users were consenting to. Updated in `popup/popup.html`,
  `docs/store/LISTING.md`, `docs/security/CONTROL-CATALOG.md`,
  `docs/enterprise/DEPLOYMENT.md`, and the DPA's privacy pointer; the two
  corporate-operations references (DPA sub-processor list,
  `docs/legal/RETENTION.md`) still point at the company policy, which is
  correct for those. `npm run validate` now fails the build if a shipped page
  links the company policy or links no policy at all.
- Store zips now carry PNG icons only (the `icons/*.svg` design masters were
  shipping unreferenced) and drop `shared/ai-surfaces.json`, a build input with
  no runtime consumer that put unrelated API-host entries in front of a
  reviewer.
- The firefox zip additionally drops the Chrome-only `storage.managed_schema`
  pointer and `managed-schema.json`; Firefox delivers managed storage through a
  native manifest, so both only earned an addons-linter warning.
- Corrected README's "no host permissions" claim — 2.0.0 added the loopback
  `http://127.0.0.1/*` entry for the presence beacon.
- **The security documentation asserted a CI pipeline that did not exist.**
  `docs/security/MANAGEMENT-REVIEW.md` recorded seven workflows as green and
  `ASVS-MAPPING.md` marked five controls Met citing workflow jobs, at a time
  when `.github/` was not in the repository at all. Each is corrected to
  state what actually runs today: a local pre-push hook plus workflows that
  are committed but have never executed. Nothing shipped so far is signed or
  attested.
- `scripts/zip.mjs` honours `SOURCE_DATE_EPOCH` when it is set, so an
  auditor can check out a tag, rebuild, and compare against the published
  bytes — the reproducibility `docs/security/RELEASE-POLICY.md` promises.
  Unset, it keeps the fixed timestamp, so a local build is still
  deterministic without anyone exporting anything.
- `scripts/store-build.mjs::validate` also enforces the two invariants the
  compliance documents cite by name but no store reviewer checks:
  loopback-only `host_permissions`, and no wildcard content-script host in
  any of its spellings. They are checked against the staged trees, so the
  claim holds for the artifact that ships rather than for the source tree.
  Staging no longer follows symlinks, which could otherwise embed a file
  from outside the repo into a store zip under an innocuous name.

### Fixed — a failure-UX audit: three of five confirmed findings closed, two documented as blocked

A twelve-lens audit produced 73 findings across the stack; five landed in this
repo. Two were already closed by prior work on this branch (the
policy/infrastructure block split, and the two-row Status/Screening split that
keeps "connected" from ever rendering as "protected") — re-verified rather
than re-fixed. Three were real and are fixed here:

- **A reachable desktop app was told apart from a reachable one that answered
  "I can't reach my own screening service."** `content/shim.js`'s `decide()`
  collapsed every non-timeout relay failure — a native-messaging host that
  never launched (`no-bridge`) *and* one that launched, answered the browser,
  and only then failed to reach its screening service (`bridge-unreachable`) —
  into the same `native-call-failed` reason and the same sentence: *"the Locke
  desktop app could not be reached. Start it, then try again."* That is
  correct for the first case and wrong for the second, and it is the literal
  mechanism behind the audit's own complaint: *"Sonomos blocks my 1 MB
  attachment saying 'the Locke desktop app could not be reached' — but Locke
  IS running and the popup says Online / Active at the same time."*
  `bridge-unreachable`
  now gets its own reason and its own sentence — *"the Locke desktop app
  answered, but it could not reach its screening service... try again
  shortly; if it keeps happening, restart Locke"* — that stops giving advice
  ("start it") which is wrong when the app just answered, and stops
  contradicting a Status row fed by that same reachable native host.
  Mutation-tested: `tests/shim.test.js`.
- **"AI sites" claimed a category a plain search page visibly does not belong
  to.** The popup's four "held back" sentences all said requests were held
  back for "AI sites" — but `shared/ai-surfaces.json`'s `search` provider
  deliberately covers search engines with AI-generated answers too
  (`www.google.com` among them, "Search queries routinely contain PII; the
  extension treats them like chat surfaces"). "AI site" asserts a property of
  the page a user can correctly dispute (*"Locke is blocking requests on
  google.com — since when is Google an AI site?"*); naming it as the coverage
  list that actually governs interception — "the AI apps and search engines
  Locke screens" — says what decides scope instead of asserting something
  about the site. Mutation-tested: `tests/screening.test.js`.
- **A redacted send and a clean send looked identical everywhere, including
  the popup** — *"There is no way to tell whether Locke actually redacted
  anything."* The evidence already reached the popup on every receipt
  (`redactedCount`, the guard's own count of PII spans it removed) —
  it was read for connection/screening evidence and fail-open tallies and
  then discarded. `shared/screening.js`'s `tallyFromReceipt` now also tracks
  it; `background/service-worker.js` accumulates it in session storage the
  same way it already does for the fail-open counts; `popup/copy.js`'s note
  now leads with *"N item(s) of personal information were redacted from what
  you sent this session"* when it is nonzero. No new plumbing crossed a repo
  boundary — every input was already on the wire. Mutation-tested:
  `tests/screening.test.js`.

Two more are written down rather than built, because closing them needs a
change this repo cannot make on its own or is a materially larger feature than
a copy fix: the desktop app's own "couldn't screen" refusals (a request too
large or too complex to screen, or unparseable) currently degrade to the
*policy* wording rather than an outage wording, by a **deliberate, tested**
design; and the popup has no way to point to a specific blocked send, only
aggregate session state.

### Added — screening can now say "Active" on live evidence, not just a past send

The Locke desktop app shipped the reachability probe this repo's own docs
asked for: a probe request that rides the existing host connection — not a
capture, never queued for screening, never counted — answered with a live
reachability result. An older build on either side still decodes the frame it
understands.

The native messaging host gains the call, and its `status` reply gains a
real `"available"` value for its `screening` field, earned only when the probe
just confirmed the guard is up — bounded by a new, explicit staleness check
(5 s) on top of the answer's own "always live, never cached" guarantee, so a
reply that somehow sat queued cannot be read as "reachable now". A reachable
desktop app reporting the guard down now earns its own distinct
`"unavailable"` too — previously indistinguishable from "reachable,
unconfirmed". `shared/screening.js` takes the live answer as a third kind of
evidence, ranked above stored capture evidence when it is definite: a live
`unavailable` overrides a recent `available` receipt (the guard just went
down), and a live `available` overrides a recent `unavailable` receipt (the
guard just recovered) — closing the "a guard that dies between requests goes
unnoticed until the next send is blocked" gap named when this split first
shipped.

The popup's "Active" sentence no longer claims a specific request was
screened (`popup/copy.js`) — it can now be earned by the live probe alone,
before any request exists to point to, so the old wording would have been a
lie on that path. Every branch this whole split exists to protect is
unchanged: a bridge too old to understand the probe, a truncated reply, or a
stale timestamp all still read `"unknown"`, and `"unknown"` still asserts
nothing on its own — the host keeps its own test pinning exactly that, the
direct descendant of the test this repo pinned specifically so this upgrade
could not happen by accident.

### Fixed — four holes at the edge of the capture boundary

Everything in `content/shim.js` only runs where `content_scripts` puts it, so
the last two rounds of care inside the shim were bounded by a manifest nobody
had audited. Four findings, each with the direction it now fails in:

**A frame with no url of its own got a pristine `fetch`.** `all_frames` injects
into every frame whose *own* url matches — not every frame of a matching tab.
So an `about:blank`, `srcdoc` or `blob:` iframe got no hooks, and three lines of
page script reached an unhooked `fetch` in the page's own origin. `HONEST.md`
asserted the opposite, which was the worse half. The manifest now declares
`match_origin_as_fallback` (Chrome 99+, Firefox 128+ — both under the minimums
we already require) and `match_about_blank`, and the shim resolves its own
identity and its request base against the base such a frame inherited from its
creator, so both scopes work there instead of degrading to a
`scope-unresolvable` block. No host permission, no catalog entry. Fails toward
holding a request in a frame our own covered page created.

**The catalog said a subdomain is the same host; `matches` did not.** The
canonical catalog treats an entry and every subdomain of it as one host, and
`isAiHost` has always enforced that — but `matches` listed exact spellings
only, so on `www.perplexity.ai` the shim was never injected and enforced
nothing. Not partial coverage: none. The generator now emits that rule in
match-pattern syntax and `tests/manifest.test.js` checks every catalog
spelling against the real catalog file. `isAiHost` also strips trailing dots
now, closing the absolute-FQDN evasion. This widens *where we inject* and
nothing else — the scope test already applied the subdomain rule — and the
negative direction is pinned too.

**`fetchLater()` was the `sendBeacon` hole one API later.** A deferred fetch
answers synchronously and the browser sends on its own schedule, so no verdict
can be applied. In-scope with a body, it is now refused with a `TypeError` —
the failure signal that API's callers already handle — rather than leaving
unscreened. Unlike a beacon it can be a `PUT` and carry object-write headers,
so the initiator-scoped upload path applies to it as well. The rest of the
outbound sweep is now stated in `HONEST.md`: WebTransport is the WebSocket
class; **Background Fetch is deliberately not hooked** and fails toward "we did
not look", on the record.

**The two files at the ends of the relay had no tests.** `content-script.js`
and `background/service-worker.js` now have them, aimed at the branches whose
failure direction is *send* or *trust*: `isTrustedSender` rejecting other
extensions, an empty native answer never reading as a verdict, a missing host
told apart from a broken one, every relay failure ending in a null verdict the
shim reads as block, only the two shim settings crossing into the page world,
and no diagnostic on either side carrying the payload.

### Fixed — the attachment that never went to the AI host went unscreened

Scope was the request's **destination**, so the densest PII on the page walked
out of the only gap left in the browser path. An AI web app that attaches a
file often does not post the bytes to its own origin: it mints a pre-signed URL
and `PUT`s the file straight to object storage on an unrelated host. That host
is not in the surface catalog, so the shim never saw the request as AI traffic,
and a CV or a customer list left the machine while the popup said screening was
Active.

The obvious fix was the dangerous one. The surface catalog is shared and
nothing user-supplied may ever add to it, so putting `s3.amazonaws.com` there
to catch one AI web app reaches well beyond this extension — every bucket
every application on this machine talks to. The catalog is untouched, and the
earlier request to add it is withdrawn with the reasoning recorded so it is
not reopened.

Scope is now the **initiator** as well as the destination, which is a thing
only the extension can do. The shim runs inside the page, so a request's
initiator is not inferred from a packet — it is the document we were injected
into, and `content_scripts.matches` is generated from the same catalog. A
cross-origin object write from a catalog surface is therefore held and screened
with the blast radius bounded by the pages we already covered, and **no host
permission was added** (a MAIN-world hook on the page's own `fetch` needs
none). A `PUT` from any other page is untouched; `PAGE_IS_AI_SURFACE` makes
that structural in the code rather than a property of the manifest.

Recognition is conjunctive and deliberately narrow, because the failure to
avoid on this side is holding traffic we had no business holding: `https`, plus
a body, plus either the method `PUT` — a cross-origin PUT from a web page is
very nearly only ever a write to storage, while analytics, error reporting,
auth and payments are all POSTs — or a `POST` whose own headers declare an
object write (`x-goog-upload-*`, which is how Gemini's attachment path works,
`x-ms-blob-*`, the S3 object-write headers, `x-bz-file-name`). Header *names*
only. `x-amz-date` and `authorization` are deliberately absent: SigV4 signs
every AWS call including analytics ones, so they say "signed", not "object
write". Sentry, Stripe, Segment and a Kinesis `PutRecords` are pinned by test
as traffic that must pass through untouched.

Two refusals exist only on this path, and both are strictly more closed than
the branch they replace:

- **`upload-withheld`.** Withholding swaps an unexaminable attachment for an
  inert 1×1 placeholder so the rest of a chat prompt still ships — the right
  trade in a multipart POST. Here the attachment *is* the whole body, so
  withholding would `PUT` a 69-byte image into the bucket, the site would
  record a successful upload of the user's file, and the model would be shown a
  blank square with nobody told. Nothing left the machine either way; this way
  we can say so.
- **`upload-integrity-locked`.** If the request commits to its exact bytes
  (`Content-MD5`, a real `x-amz-content-sha256`, `x-goog-hash`), a redacted
  body cannot be re-signed, and shipping it earns the storage provider's own
  error, which reads to a user as "the site is broken". `UNSIGNED-PAYLOAD`
  commits to nothing and is not treated as a commitment. A clean `allow` always
  ships the original bytes, checksum intact.

A pre-signed URL's query string **is** a credential, so on this path the
synthesized raw request carries the path only — the signature never crosses
into the desktop app, and the query is stripped before a path is examined
anyway. The object key is very often the user's filename, so it is kept off
the console too: an upload diagnostic names
the host and `scope=upload` and nothing else. Enforcement is unaffected — a
release or a re-issue always goes out on the page's own original URL.

Costs, stated rather than buried, and all now in [`HONEST.md`](HONEST.md): a
POST-shaped upload declaring nothing we recognise is still unscreened; each
chunk of a chunked upload is screened independently, so a value straddling a
boundary is missed; and a file over the shim's 8 MiB cap is now **blocked**
where it previously always succeeded. `Capture scoping` in the coverage table
goes 7 → 8.

### Fixed — the popup could say "protected" while nothing was screening

The native host's reachability probe proves the Locke desktop app is running;
it proves nothing about whether it can screen. The popup read that one signal
as "Locke is protecting your AI chats in the background" — a false assurance
the user acts on, in exactly the state where the fail-closed posture is doing
the most work and they can see it the least.

Connection and screening are now two separate rows, with separate evidence:

- The host's `status` reply carries a `screening` field that has **no
  `available` value at all**. A reachable desktop app yields `unknown`; an
  unreachable one yields `unavailable` — no path to the app is no path to
  screening, and that is the one negative the extension can assert on its own.
- The only thing that earns "Active" is first-hand evidence from real traffic.
  Every capture receipt is testimony from the guard itself: a verdict that
  could only follow a real screen (`allow`, `redact`, or a `block` for a policy
  reason) proves it answered; a `block` carrying an infrastructure reason
  proves it did not. Evidence is timestamped and expires after 10 minutes,
  because a verdict from an hour ago is not a claim about now.
- With the app up and nothing observed yet, the popup says **"Not yet
  confirmed"** and "Screening is confirmed the first time you send to an AI
  site" — the honest sentence rather than the comfortable one.

A real screening-reachability probe is the proper fix and needs a change on
the desktop side. The host's refusal to say "available" until then is pinned
by test.

### Added — the native host owns a deadline, and expiry is a block

The native messaging host waited on the desktop app forever, so the browser's
own patience ran out first: an MV3 service worker is terminated after 30 s
idle, and when it dies mid-flight the user is told "the Locke extension
restarted while this request was waiting" — true about the symptom, useless
about the
cause. The posture was already closed; what was missing was the explanation.

The host now gives up at **25 s** (`CAPTURE_DEADLINE`) and answers
`screening-timeout`, which the shim maps to a block with an outage message and
retry advice — never to "start the desktop app", since the app is what just
answered. 25 s sits below the browser's 30 s window (leaving the reply frame
5 s to land), well above the slowest real screen, and under the desktop app's
own read timeout, so the host is always the layer that speaks first. The probe
gets a 3 s deadline on the same principle — under the extension's 4 s
`bridgeTimeoutMs`. The shim's 45 s ceiling is unchanged and is now the last
resort behind both.

### Added — an outage is no longer reported as a refusal of your content

Because everything here fails closed, "the guard was down" and "your content
was refused" both arrive as `decision: block`; only the guard's `reason`
separates them. The shim showed both with the policy wording, so a user whose
guard had died was told "screening stopped this request" and went looking for
PII they never sent.

The shim now classifies the reason before showing it, against a closed set of
fragments matching the text the desktop app emits (`guard unreachable —
blocked (fail-closed)` among them). An infrastructure reason blocks as
`screening-unavailable` (class `unavailable`, retry advice); anything
unmatched keeps the policy wording and still blocks — degradation is
one-way, so drift costs a worse message, never an unscreened send. The set
lives in `shared/constants.js`, is inlined in `content/shim.js` (a MAIN-world
classic script cannot import a module), and a test fails if the two drift.

### Added — fail-open sends are counted where a human can see them

`unchecked` / `unscreened` reached the console and stopped there. A sanctioned
bypass nobody can see is indistinguishable from a clean screen, which is the
whole reason the flag exists. The service worker now tallies them and the popup
reports "N requests went out this session without a full screen, under your
fail-open setting" — factual rather than alarmed, because it is a state the
user opted into. Withheld attachments are counted and worded separately
("stayed on this machine", never "went out"), since they are the opposite
outcome and the pairing is the only thing that separates them. Screening
outages and recoveries also enter the audit ring-buffer, with a fragment from
our own closed set — never a string echoed back from upstream.

### Fixed — the remaining ways a send could go out unscreened

An audit of the whole interception path, against a July gap-register claim that
the extension "fails open on file uploads and on large scans". That claim was
**true when written and is no longer true**: the fail-open enforce path was
closed on 2026-07-03 (#22), exact-byte body capture landed on 2026-08-09 (#28),
and the 45 s ceiling was restored on 2026-08-10. Uploads, oversized bodies and
timeouts all block today, and there are tests pinning each. What the audit did
find:

- **`navigator.sendBeacon` was an unscreened hole.** A beacon cannot be held —
  it answers synchronously and the browser sends on its own schedule — so an
  in-scope beacon carrying data is now **refused** (`sendBeacon` returns
  `false`, reason `uncapturable-beacon`). Same reasoning as a synchronous XHR:
  in scope, unholdable, therefore unscreenable. Bodiless and out-of-scope
  beacons are delegated untouched.
- **A bodied request whose target would not resolve was passed through.** The
  shim runs on AI surfaces and nowhere else, so that is a "couldn't check"
  state on a surface we are responsible for. Now blocked in `fetch`, `XHR` and
  `sendBeacon` alike, reason `scope-unresolvable`. Bodiless ones still pass
  through — the hard rule about out-of-scope traffic is unchanged.
- **A withheld attachment was indistinguishable from a fail-open send.** The
  guard marks a verdict `unchecked` when the user's time-boxed fail-open window
  let something ship unexamined, and leaves it `false` when it *withheld* an
  attachment instead (bytes replaced with an inert placeholder, nothing
  unexamined leaving the machine). The native messaging host relayed
  `unscreened` but **dropped `unchecked`**, so the extension could not tell the
  two apart. It is now mirrored, emitted to the browser always (including when
  false), and surfaced as `allow-unchecked` / `redact-unchecked` versus
  `redact-withheld` — all at `console.warn`, unconditionally. Because a
  withhold always rebuilds the request, unscreened items on an `allow` are read
  as *shipped* whatever the flag says, which keeps the reading honest against a
  bridge too old to send it.
- **A blocked XHR left the page waiting forever.** `abort()` fires no events at
  all when the send was never forwarded, so the site spun with the explanation
  only on a console nobody had open. The shim now dispatches `error` +
  `loadend` itself.

### Changed — a blocked send says which KIND of block it is

"We refused your content" and "our screener is down" are different sentences,
and telling a user the first when the second is true sends them hunting for PII
they never sent. Every block is now classed `policy` / `unavailable` /
`too-large` / `unsupported` — the same distinction HTTP makes with
403 / 503 / 413 — and both the class and the reason ride on the **thrown
error** as well as the console line, so a site that surfaces the message shows
something actionable. All four classes are fail-closed; the class describes the
cause, never whether the content left. The oversize message names the real byte
counts and says in words that it is a size limit, not a sensitive-data block.

### Documented — two coverage gaps that are not fail-open branches

Both now in [`HONEST.md`](HONEST.md), with the fixes recorded as pending
because they cannot be made here:

- **Scope is the request's host**, so an AI web app that `PUT`s attachment
  bytes to pre-signed object storage on an unrelated host uploads them
  unscreened. Same-origin `multipart/form-data` uploads are captured, screened
  and withheld-where-unexaminable exactly as intended. Closing this means
  adding the upload hosts to the canonical catalog; the copy here is vendored.
- **Only bodied requests are screened**, so a prompt carried entirely in a
  query string is not. The search surfaces in the catalog are described as
  treated "like chat surfaces" and today are not — a search is a bodyless GET,
  usually a top-level navigation the shim does not hook. `Capture scoping` in
  the coverage table drops 9 → 7 to say so.

### Fixed — the capture path now explains itself
- **Every fail-closed branch reports its own reason.** `content/shim.js` had no
  console output at all and `background/service-worker.js` had one line, so a
  blocked send was indistinguishable from a working one: the user saw only the
  AI site's generic "Something went wrong", and there was no way to tell "we
  caught PII" from "the desktop app never answered". Each branch now emits a
  stable, greppable `[sonomos] reason=<branch> … action=block` line —
  `console.warn` for anything that blocks or would ship unscreened,
  `console.debug` for the healthy path. Reasons: `not-in-scope`, `no-body`,
  `uncapturable-stream`, `uncapturable-document`, `uncapturable-oversize`,
  `uncapturable-unreadable`,
  `uncapturable-request-clone`, `uncapturable-sync-xhr`, `verdict-timeout`,
  `verdict-missing`, `verdict-malformed`, `verdict-channel-failed`,
  `native-call-failed`, `decision-block`, `decision-missing`,
  `decision-unknown`, `redact-missing-request`, `redact-undecodable`,
  `redact-malformed`, `redact-ct-conflict`, `redact-ct-set-failed`,
  `internal-error`, `internal-error-out-of-scope`, `config-applied`, plus the
  content script's `relay-rejected` / `relay-threw` / `relay-no-promise`
  and `bridge-empty` / `bridge-error` /
  `bridge-unknown-response` / `no-bridge` / `capture-error` from the worker.
- **Diagnostics are shape-only, by construction.** Host, path (never
  `url.search` — a query string can carry the prompt), method, byte counts,
  media type (parameters stripped), decision, elapsed ms. Request bodies and
  header values never appear, and a test asserts that across the block, allow
  and redact paths.
- **The enforce ceiling went back to 45 s** (`ENFORCE_TIMEOUT_MS` → the
  `enforceTimeoutMs` setting, default `45_000`). The v3 raw-relay rewrite had
  silently dropped it from the deliberate `45 * 1000` — chosen "so a
  slow-but-valid scan isn't false-blocked" — to `5000`. A real screen of a
  large agent-shaped request routinely takes longer than that, so 5 s sat
  *under* the floor and a perfectly healthy setup blocked browser sends purely
  because the shim gave up first. A timeout now reports
  `blockedBecause=no-verdict-arrived-not-pii`.
- **Verbosity is configurable**: `debugLogging` and `enforceTimeoutMs` are new
  settings (defaults, `storage.local`, and `storage.managed` — see
  `managed-schema.json`). The MAIN-world shim cannot read storage, so
  `content/content-script.js` reads them with the worker's precedence and pushes
  them over the new `PAGE_MSG.CONFIG` channel, re-pushing on change. Typing
  `SONOMOS_DEBUG = true` in the page console works too. Pushed values are
  clamped, since a hostile page can post on that channel as well.
- Tests: `tests/shim.test.js` 38 → 57, asserting each reason string against its
  own branch, that the timeout path reports the timeout (not a generic block),
  and that no diagnostic leaks body, query-string, or header content.

## [2.0.0] — 2026-08-10

Renamed the extension to **Locke Extension** and prepped it for store
submission (Chrome Web Store, Edge Add-ons, Firefox AMO). The Firefox
`gecko.id` stays `desktop-connector@sonomos.ai` — changing it would orphan
existing installs, and the id is invisible to users.

### Added
- **Desktop presence beacon.** On every heartbeat tick the service worker
  fires a fire-and-forget `POST http://127.0.0.1:18795/heartbeat` to the
  Locke desktop app's loopback presence listener with `{ browser, version }`
  (browser classified by the new `shared/browser-info.js`). Failures are
  silent — the app not running is the normal case. Requires the new
  `host_permissions` entry `http://127.0.0.1/*` (portless because Firefox
  ignores match patterns with an explicit port) and a matching CSP
  `connect-src`; no page data ever rides this channel.
- **Per-browser store packaging** (`scripts/package.mjs`, `npm run package`):
  stages runtime files only and emits
  `dist/locke-extension-<version>-chromium.zip` (Chrome Web Store + Edge
  Add-ons; strips `background.scripts` and `browser_specific_settings`) and
  `dist/locke-extension-<version>-firefox.zip` (AMO; strips
  `background.service_worker` and `minimum_chrome_version`).
- `docs/store/LISTING.md` — submission copy for all three stores.

### Changed
- **Renamed to Locke Extension** — manifest `name`/`short_name`/
  `description`/`action.default_title`, popup header and status copy,
  `package.json` name, README, and the native messaging host manifest
  templates' human-readable descriptions. The native-messaging host name
  `ai.sonomos.desktop` and all extension ids are unchanged.
- `docs/security/PERMISSIONS.md` rewritten to match the real manifest
  (it documented the retired daemon/keystroke-guard architecture).

Moved the capture chain to the **v3 "raw relay" wire** (the parse-and-reconstruct
redesign) and made the shim **hold-and-enforce, fail-closed**: an in-scope
bodied request leaves the browser only after an `allow` or `redact` verdict;
anything short of that blocks it.

### Changed (v3 raw relay)
- `content/shim.js` captures the **exact body bytes** (strings as UTF-8;
  Blob/ArrayBuffer/TypedArray/URLSearchParams/FormData serialized once via
  `new Response(body)`, keeping the generated multipart boundary and its matching
  Content-Type), synthesizes a raw HTTP/1.1 request (request line + `Host` + the
  page-set headers + body), and ships it base64 through the message chain. On
  `redact` it splits the receipt's whole rebuilt request at the first CRLFCRLF and
  re-issues the held fetch/XHR with the rebuilt body **as bytes** and the rebuilt
  Content-Type; everything else about the call stays as the page issued it.
- Message shapes along the chain: `{ requestB64 }` outward;
  `{ decision, reason, redactedCount, requestB64? }` back (decision absent ⇒
  block). `content/content-script.js` and `background/service-worker.js` relay
  those; the v2 record-building (provider map, `query_kind`, `messages[]`
  placeholders, `raw_body`) is gone — the extension parses nothing. The vendored
  web-hosts scoping stays.
- The native messaging host speaks envelope version 3: `ExtensionRecord` =
  `{"request": <base64 raw request>}` out, the guard's `Receipt` back, both
  forwarded verbatim (the host never decodes the request). Its receipt mirror
  fails closed on a missing decision, and an over-1 MB rebuilt request still
  yields the compact `receipt-too-large` error (→ block).
- Bodies that can't be captured faithfully — ReadableStream, synchronous XHR,
  over the 8 MiB cap, unreadable — now **block** instead of passing unscreened
  as metadata-only records.
- Tests: `tests/shim.test.js` runs the real shim in a vm sandbox — raw-request
  synthesis (string / FormData boundary / binary), receipt handling
  (allow/redact/block), and the fail-closed paths.

---

Previous unreleased train: simplified the extension to an
**observe-and-forward capture feed**. It now
observes AI web-app requests and reports a *copy* to the Locke desktop app for
downstream scanning; it no longer holds, blocks, redacts, or alters any request.
All redaction happens in the desktop app, never in the extension. This is a
behaviour-narrowing change and a candidate for a major version bump when it
ships.

### Removed
- **ENFORCE mode / page-side masking.** No hold → verdict → substitute/block
  round-trip. The shim reports a copy and the original request always proceeds
  untouched. Removed `shared/enforce-policy.js` and the `enforce` storage flag,
  the popup "Mask on websites" toggle, and the acted-upon verdict path.
- **Layer-1b `scan_paths` scoping** (`shared/content-scoping.js`). The shim no
  longer computes or sends `scan_paths`; per-provider structured parsing is left
  entirely to the downstream engine.
- **Keystroke-guard subsystem** (`content/keystroke-guard/`, tracker-domain lists,
  the anti-keylogging feature) and the `keystrokeGuardEnabled` managed setting.
  Removed the corresponding key from the enterprise policy templates and
  `managed-schema.json`.
- **HPKE request-body encryption.** Design and client scaffolding removed;
  `docs/architecture/HPKE-DESIGN.md` deleted.
- **`WebSocket` / `navigator.sendBeacon` / `EventSource` capture hooks.** The shim
  now observes `fetch` and `XMLHttpRequest` only.
- Deleted docs describing removed subsystems: `docs/architecture/HPKE-DESIGN.md`,
  `docs/architecture/page-side-masking.md`, `docs/architecture/web-masking-followups.md`,
  `docs/security/KEYSTROKE-GUARD-AUDIT.md`.

### Changed
- `content/shim.js` reduced to pure observation of `fetch` + `XHR` on AI web
  surfaces (`shared/ai-surfaces.json` → `web_hosts`, baked into
  `content/web-surfaces.generated.js` as `SONOMOS_WEB_HOSTS`). On a host match it
  builds an `ExtensionRecord` and posts a copy to the content script; otherwise it
  does nothing.
- `content/content-script.js` is now a fire-and-forget relay to the service worker;
  it does not await or act on any reply.
- The bridge `Receipt` is treated as a landing acknowledgement only — the extension
  never acts on any verdict it may carry.
- Rewrote `README.md`, `HONEST.md` and `docs/architecture/DATA-FLOW.md` to the
  observe-only model.

## [1.0.0] — 2026-05

### Added
- Per-install HMAC handshake for local authentication
  (`background/service-worker.js`, `content/content-script.js`, and the native
  messaging host). See [SECURITY.md](SECURITY.md) for the full threat model.
- CI workflows: `.github/workflows/ci.yml` (JS + Python lint, manifest
  validation, host-permissions tripwire, native-messaging host name pin),
  `gitleaks.yml` (secret detection), `semgrep.yml` (SAST: `p/javascript`,
  `p/browser`, `p/secrets`), `sbom.yml` (CycloneDX + SPDX), `release.yml`
  (sigstore-signed release artifacts on tag push).
- `README.md`, `SECURITY.md`, `CHANGELOG.md`.
- Enterprise hardening:
  - MAIN-world content scripts scoped to a fixed AI-provider host list
    (no longer `<all_urls>`); CI tripwire keeps manifest matches in
    sync with `shim.js`'s `ADAPTER_REGISTRY`.
  - `managed-schema.json` + `storage.managed` integration so admins can
    push policy via Chrome `ExtensionSettings` / Firefox managed-storage
    (`daemonUrl`, `allowedProviders`, `failMode`, `keystrokeGuardEnabled`,
    `telemetryEnabled`, `heartbeatSeconds`, `lockedSettings`). Managed
    `daemonUrl` is rejected at runtime if not loopback.
  - In-page toast UI moved into a closed shadow DOM so a hostile page
    can't restyle, observe, or DOM-inspect it.
  - Deployment templates under `docs/enterprise/templates/` for Chrome
    (JSON, plist, ADMX/ADML), Edge (JSON), and Firefox (policies +
    managed-storage).
  - `docs/enterprise/DEPLOYMENT.md`, `docs/architecture/DATA-FLOW.md`,
    `docs/legal/DPA-template.md`.
  - Privacy link in popup footer.
- All third-party GitHub Actions pinned by SHA; gitleaks and semgrep
  pinned to specific releases instead of `latest`.
- Site-list alignment with the desktop app's canonical site list:
  - `shim.js` `ADAPTER_REGISTRY` rewritten so gateway adapters mirror
    the desktop app's canonical API-host list (35 entries) and internal
    adapters mirror its browser-surface list (17 entries — AI chat
    surfaces + 11 search engines).
  - `manifest.json` `content_scripts.matches` is the unified browser-
    domain list (17 entries). API-only hosts (api.openai.com etc.) are
    no longer in matches — they were never page-load locations.
  - Search engines now in scope: google.com, bing.com, duckduckgo.com,
    duck.ai, kagi.com, you.com, search.brave.com, brave.com,
    leo.brave.com, phind.com, www.phind.com. Body-based interception
    works on the AI-chat endpoints these sites expose; full query-
    string masking on GET search submissions is a follow-up.
  - Adapters dropped (not in desktop's canonical list): Copilot, Poe,
    Mistral chat, DeepSeek chat, HuggingFace chat, Qwen, Meta AI, the
    OpenAI/Anthropic/Google playground UIs.
  - New CI tripwire fails the build if `manifest.json` drifts from the
    desktop's browser-surface list (when both are checked
    out side-by-side; skipped silently on hosted CI).
- Round-2 IT-friendliness pass:
  - OpenSSF Scorecard workflow + README badge — automated 0–10 posture
    rating, published to GitHub Security tab and the OpenSSF public
    dataset where vendor risk-rating tools pick it up.
  - CodeQL workflow (`security-extended` query suite, JS + Python).
    Complements Semgrep with cross-file taint analysis.
  - `dependency-review-action` on every PR — fails on moderate+
    severity vulns and enforces a permissive-license allowlist.
  - `release.yml` now emits SLSA Level 3 build provenance attestations
    via `actions/attest-build-provenance`. Verifiable with
    `gh attestation verify`.
  - Release zip built reproducibly (`SOURCE_DATE_EPOCH`-pinned mtimes,
    sorted entry list). Independent rebuilds of a tag produce
    byte-identical hashes.
  - `docs/security/security.txt` (RFC 9116) for deployment to
    `sonomos.ai/.well-known/`.
  - `docs/security/PERMISSIONS.md` — per-permission justification doc,
    reusable for store-listing submissions.
  - `docs/security/ASVS-MAPPING.md` — OWASP ASVS L1/L2 met/N/A/roadmap
    table; pre-answers most vendor questionnaires.
  - `docs/security/CII-CHECKLIST.md` — Linux Foundation Best Practices
    badge form pre-filled for submission.
  - `docs/architecture/HPKE-DESIGN.md` — design doc for the X25519/ECDH
    layer that closes the SECURITY.md A2 first-request residual risk.
    Coordinated daemon + extension change; not yet implemented.
  - `SECURITY.md` threat model expanded: A4 (compromised dependency),
    A5 (compromised CI), A6 (insider with local user privileges).
  - Cached HMAC token now expires after 1 hour (was browser-process
    lifetime). Limits blast radius if the token leaks.
  - Audit-log ring buffer (100 entries, `chrome.storage.local`)
    capturing `daemon-down`, `daemon-recovered`, `bridge-missing`,
    `policy-loaded`, `policy-rejected`, `hmac-proof-failed`,
    `coverage-gap`. Exportable as JSON via the popup's "Audit log"
    link for IT incident response. Shape-only — no PII, no bodies,
    no auth tokens.
  - `minimum_chrome_version` bumped 116 → 120 for cleaner managed-
    storage semantics.
  - All new GitHub Actions pinned by SHA.
- Gateway coverage widened from 5 providers to 35: the extension's
  gateway adapters can now reach every public-hostname provider the
  Locke desktop app supports, not just OpenAI / Anthropic / OpenRouter /
  Google / xAI.

### Changed
- Mask requests now carry a token and a nonce header, and mask responses are
  validated against a proof header. Any verification failure → fail-closed
  (existing user-prompted "send unmasked / cancel" UI fires).
- Version bumped from `0.2.0` → `1.0.0` to reflect production readiness
  for enterprise pilots.

## [0.2.0] — 2026-04

### Changed
- Mask path moved from the native-messaging chain to a direct content-script
  HTTP call to the local mask endpoint. Removed the byte/char-offset hazards
  of the old Python slicing path.

## [0.1.0] — Initial

- MV3 manifest, native-messaging bridge, page-world fetch/XHR/WebSocket
  interception, ARIA DOM observer for streaming chat UIs, keystroke-guard,
  per-tab attack-surface badge.
