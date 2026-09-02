# In-browser smoke harness

**Opt-in, developer-run, and deliberately not CI.** Nothing in
`.github/workflows/` runs this, nothing gates on it, and no badge reports it.
It exists because every other test here runs the extension's modules *outside*
a browser — `node:test`, plus a `vm` sandbox for `content/shim.js` — so none of
them can answer "does this still do anything when a real browser loads it".

The results it produces live in
[`docs/testing/BROWSER-SMOKE.md`](../../docs/testing/BROWSER-SMOKE.md), which
also explains what each assertion means and where the harness cannot see.

## Run it

```sh
cd tests/smoke && npm install     # once — installs Puppeteer + a Chrome build
cd ../.. && npm run smoke
```

To also cover Firefox (Puppeteer's `npm install` downloads only Chrome):

```sh
cd tests/smoke && npx puppeteer browsers install firefox
```

Without it, the Firefox row is a clearly-labelled **skip** carrying that exact
command. A missing browser, a missing driver, or no network is always a skip
and always exits 0 — a harness that goes red because a developer does not have
Firefox is a harness people learn to ignore.

> **Use `cd tests/smoke && npm install`, not `npm --prefix tests/smoke install`.**
> npm 11 rewrites this directory's `package.json` when it is installed through
> `--prefix` from the repo root, adding a `"locke-extension": "file:../.."`
> dependency on the extension itself. Harmless, but it dirties the diff and it
> is not what the manifest is meant to say.

### Flags

`npm run smoke -- <flag>`

| Flag | Effect |
|---|---|
| `--only=chromium` / `--only=firefox` | Run one browser |
| `--headed` | Launch headful (the checks pass either way; useful for watching) |
| `--no-build` | Skip `scripts/package.mjs`; use whatever is already in `dist/` |
| `--no-write` | Print the table, leave `docs/testing/BROWSER-SMOKE.md` alone |
| `--out=<path>` | Write the results block somewhere else |
| `--no-enforcement-probe` | Do not issue the one real in-scope request (see below) |

## What it does, and what it sends

1. Builds `dist/chromium` and `dist/firefox` by running the repo's own packager
   (`scripts/package.mjs`) — the same entry point a release uses, so this never
   tests a tree nobody ships.
2. Launches each browser and loads the matching `dist/` directory unpacked.
3. Visits **one** catalog host from `shared/ai-surfaces.json` → `web_hosts`
   (`https://chatgpt.com/`) and checks that `content/shim.js` replaced
   `window.fetch`.
4. Issues **one real in-scope request** — `POST /backend-api/conversation`,
   body `{"smoke":true}` — and asserts the shim **held and blocked it**. On the
   state this harness asserts (`NO_BRIDGE`), those bytes never leave the
   machine; the block *is* the observation, and it is the only way to see
   `NO_BRIDGE` on Firefox, which exposes neither its event page nor its popup
   to the driver. If the request is **not** blocked — a machine with a
   reachable, authorised desktop app — the row records a **skip**, because the
   premise did not hold. `--no-enforcement-probe` turns this off.
5. Opens the popup (Chromium only) and compares the rendered badge, screening
   label and detail against what `popup/copy.js` actually produces, imported
   live rather than transcribed.
6. Writes the table into `docs/testing/BROWSER-SMOKE.md` between two markers.
   Everything outside the markers is a human's prose and is never touched.

## `NO_BRIDGE` / "Setup" is the expected result

Chromium derives an unpacked extension's ID from its load path, and the Locke
desktop app's native-messaging manifest allows only the published store IDs —
so the browser refuses to start the host and the extension correctly reports
`NO_BRIDGE`, which `popup/copy.js` renders as the **Setup** view. Authorising
a development ID is a desktop-app-side step (README → Install, step 3) and is
out of scope for this repository. The assertion is that the extension is
*honest* about not being connected, not that it connects.

## Dependencies

This directory is the one place in the repository with a JS dependency, and it
is nested on purpose:

- The **root** `package.json` and `package-lock.json` stay at zero
  dependencies. `ci.yml::lint-js` has two tripwires that fail the build
  otherwise ("no JS deps in package.json", "package-lock declares no
  third-party packages"), and the README's zero-dependency badge means what it
  says.
- `tests/smoke/package.json` **is** committed, with one exact-pinned
  devDependency, so `npm install` here does the right thing without anyone
  copying a version out of a README.
- `tests/smoke/node_modules/` and `tests/smoke/package-lock.json` are
  **gitignored**. The lockfile especially: `dependency-review.yml` runs on
  every PR at `fail-on-severity: moderate`, and committing a lockfile would
  put Puppeteer's whole transitive closure into the dependency graph, where an
  unrelated advisory could redden a PR over code that never ships.
- Nothing here can reach a store zip. `scripts/store-build.mjs` stages only
  `background/`, `content/`, `popup/`, `shared/` and `icons/`;
  `quality.yml::package-smoke` and `scripts/audit-payload.mjs` check the
  staged payload, not the repository.

## Driver choice

**Puppeteer**, one dependency for both browsers:

- Chrome over CDP — `browser.installExtension()` wraps
  `Extensions.loadUnpacked`, which returns the extension ID, which is what
  makes the `chrome-extension://<id>/popup/popup.html` URL reachable.
- Firefox over WebDriver BiDi — the same call installs a temporary add-on,
  which keeps the fixed gecko ID the native manifest already allows.

Both give `page.on('console')` with the same semantics, so the two rows of the
results table mean the same thing. The alternative — Playwright for Chromium
plus `web-ext` for Firefox — needed two tools and would have made "console
errors" mean two different things in one table.

Verified working on Puppeteer 25.9.0. One thing that is *not* reliable there
and the runner works around: `puppeteer.executablePath({ browser: 'firefox' })`
resolves the path using the **Chrome** build id and names a directory that does
not exist. `launch()` resolves Firefox correctly, so the runner treats
`executablePath()` as a hint and lets a real launch failure — not a
path guess — be the evidence a browser is missing.
