# In-browser smoke results

**These are developer-run results. They are not CI results.** No workflow in
[`.github/workflows/`](../../.github/workflows/) runs the harness that produced
them, nothing gates on them, and no badge reports them. They are here because
every other test in this repository runs the extension's modules *outside* a
browser — `node:test` plus a `vm` sandbox for `content/shim.js` — so none of
them can answer the one question a user cares about first: **when a real
browser loads this extension, does it still do anything at all?**

The table below is the answer, from the last time a developer ran
`npm run smoke` and committed the result. The harness, and how to run it
yourself, are documented in [`tests/smoke/README.md`](../../tests/smoke/README.md).

## What the harness asserts

| Signal | How it is observed | Why that observation is honest |
|---|---|---|
| The unpacked build loads | `browser.installExtension(dist/<target>)` returns an extension ID | Chrome installs it over CDP `Extensions.loadUnpacked`; Firefox as a temporary add-on over WebDriver BiDi |
| The MAIN-world shim installed its `fetch` hook | On one catalog host, `Function.prototype.toString.call(window.fetch)` does not contain `[native code]` | `content/shim.js` assigns a plain `async function` over `window.fetch` and does **not** spoof `toString` — there is no `toString` in that file at all, so this is a property of the shipped shim, not a convention |
| The extension reports `NO_BRIDGE` **cleanly** | Chromium: the service worker's own `chrome.storage.session` state reads `status: 'no-bridge'`. Both browsers: one in-scope request is held and blocked with `reason=connector-not-started`, which `content/shim.js` maps from the worker's `no-bridge` relay code | `NO_BRIDGE` is the **expected** state for an unpacked load and is asserted as a pass — see below |
| The popup renders that state in the words `popup/copy.js` produces | Chromium: read `#statusBadge`, `#screeningValue`, `#statusDetail` out of the popup DOM and compare against `copyFor({ status: STATUS.NO_BRIDGE, … })`, imported live from `popup/copy.js` | The expected strings are computed from the module the popup itself uses, so they cannot drift from what a user sees |
| No console errors attributable to the extension | `page.on('console')` filtered to level `error`, plus `pageerror`, then attributed to the extension | `console.warn` is **expected** — the shim names every block on the console on purpose — so warnings never fail a run |

### Why "Setup" is the expected popup state, not a failure

Chromium derives an unpacked extension's ID from the absolute path it was
loaded from, so every checkout — and every temporary profile this harness
creates — gets a different one. The Locke desktop app's native-messaging
manifest allows only the **published store IDs**, so the browser refuses to
start the host, the background worker records `NO_BRIDGE`, and
`popup/copy.js`'s `viewFor` maps that to the `setup` view with the badge
`Setup`.

Authorising a development ID is a **desktop-app-side** step (see the README's
Install section, step 3); this repository has no command for it and this
harness does not attempt one. So the assertion is not "the extension
connects". It is "the extension is honest about not being able to" — which is
the property this codebase actually claims.

### The enforcement probe, stated plainly

To observe `NO_BRIDGE` on Firefox there is nothing to read: Firefox exposes
neither the extension's event page as a WebDriver BiDi target nor its
`moz-extension://` popup to a content browsing context. So the harness makes
the extension *say* it, by issuing one real in-scope request
(`POST /backend-api/conversation` with the body `{"smoke":true}`) on the
catalog host.

In the state being asserted, **those bytes never leave the machine**: the shim
holds the request, the relay answers `no-bridge`, and the shim blocks. The
block is the observation. If the request is *not* blocked — a machine where
the desktop app is reachable and this load is authorised — the run records a
**skip** for that row rather than a pass, because the premise did not hold.
`npm run smoke -- --no-enforcement-probe` turns it off.

## Known limitations of the harness

These are recorded rather than worked around, and any row they affect reads
"not observable" rather than "pass":

- **Firefox popup DOM: not observable.** WebDriver BiDi refuses to navigate a
  content browsing context to a `moz-extension://` URL (`unsupported
  operation … is not allowed in this context`). Pinning the add-on's internal
  UUID with the `extensions.webextensions.uuids` preference makes the URL
  *predictable*, not *navigable*.
- **Firefox background state: not observable.** The event page is not a BiDi
  target, so there is no context in which to evaluate
  `browser.storage.session`.
- **Firefox console attribution is weaker than Chromium's.** A WebExtension's
  console frames arrive as `<anonymous code>` with no `moz-extension://` URL,
  so the only usable key is the shim's own `[sonomos]` prefix. That catches
  everything the shim says deliberately and would **miss an uncaught internal
  exception** — precisely what an error-level assertion most wants to catch.
  On Chromium every frame carries `chrome-extension://<id>/`, so attribution
  there is exact.
- **Service-worker console output is not collected** on either browser; only
  the catalog page and (on Chromium) the popup page are listened to.
- **One catalog host, not the catalog.** Which hosts are in scope is settled
  exhaustively by `tests/shim.test.js` against the real file. A browser adds
  only "did the injection happen at all", and one host answers that.
- **A page's own console errors are excluded and listed.** `chatgpt.com`
  serves an anti-automation challenge to a driven browser, which reliably
  produces page-origin errors (a `403`, sandboxed-iframe warnings). They are
  counted, named in the run notes, and not charged to the extension.

## Results

<!-- BEGIN SMOKE RESULTS — machine-written by tests/smoke/run.mjs; do not edit by hand -->

**Recorded:** 2026-09-02 03:55 UTC  
**Machine:** Windows_NT 10.0.26200 (x64), Node v24.11.0  
**Catalog host visited:** https://chatgpt.com/  
**Provenance:** developer-run (`npm run smoke`). **These are not CI results** — no
workflow in `.github/workflows/` runs this harness and nothing gates on it.

| Browser | Launched | Extension loaded from | Popup state observed | Fetch hook | NO_BRIDGE | Console errors | Result |
|---|---|---|---|---|---|---|---|
| Chrome 152.0.7977.54 | puppeteer.launch({ browser: 'chrome', headless: true }) | dist/chromium (unpacked, id plnebcpfnaeggpmjmeomfjnbflnjeedm) | PASS — view='setup', badge='Setup', screening='Unavailable' (matches popup/copy.js) | PASS — window.fetch is wrapped (no [native code]) | PASS — in-scope request held and blocked, reason=connector-not-started | PASS — 0 attributable (4 from the page itself, not counted) | pass |
| Firefox 154.0 | puppeteer.launch({ browser: 'firefox', headless: true }) | dist/firefox (unpacked, id desktop-connector@sonomos.ai) | not observable — Firefox/BiDi refuses to navigate a content browsing context to a moz-extension:// URL ("unsupported operation … is not allowed in this context") | PASS — window.fetch is wrapped (no [native code]) | PASS — in-scope request held and blocked, reason=connector-not-started | PASS — 0 attributable (0 from the page itself, not counted) | pass (partial) |

### Run notes

**Chrome**
- binary: ~\.cache\puppeteer\chrome\win64-152.0.7977.54\chrome-win64\chrome.exe
- background state: status=no-bridge, screening=unavailable
- enforcement probe: POST /backend-api/conversation was blocked by the shim — nothing left the machine.
- popup console: 0 message(s), 0 at level error
- 2 attributable console.warn (expected — the shim warns on every block)
- page-origin errors excluded (4): Failed to load resource: the server responded with a status of 403 () | Blocked script execution in 'about:blank' because the document's frame is sandboxed and th | Blocked script execution in 'about:blank' because the document's frame is sandboxed and th | Failed to load resource: the server responded with a status of 403 ()

**Firefox**
- binary: ~\.cache\puppeteer\firefox\win64-stable_154.0\core\firefox.exe
- background state: not observable — Firefox does not expose the extension event page as a WebDriver BiDi target, so there is no context to evaluate chrome.storage.session in.
- enforcement probe: POST /backend-api/conversation was blocked by the shim — nothing left the machine.
- 2 attributable console.warn (expected — the shim warns on every block)

<!-- END SMOKE RESULTS -->
