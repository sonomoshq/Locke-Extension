# Store credentials

Every environment variable the release pipeline reads, where in each store's
console it comes from, and the ways each one expires.  The contract itself
lives in `scripts/lib/creds.mjs` — this file is the operator-facing gloss on
it, not a second source of truth.

No real credential value appears anywhere in this repository, and none ever
should.  The examples below are shaped like the real thing and are not the
real thing.

## These credentials publish from CI, not from a workstation

`[added 2026-08-31; restated 2026-09-01]` Dispatching `release.yml` on `main`
publishes to the Chrome Web Store, Edge Add-ons and AMO with **no human
approval step** (`docs/security/RELEASE-POLICY.md`).  The values below
therefore live in repository secrets rather than on one operator's machine.
Since 2026-09-01 a release starts with somebody clicking Run workflow, so
there is at least a person who knows a publish is happening — but they are
watching a run summary, not a console, and nothing about the credentials'
expiry is any less silent for it.

Two of them expire on a fixed clock, and both are load-bearing:

| Credential | Lifetime | Consequence for an unattended pipeline |
|---|---|---|
| `CWS_REFRESH_TOKEN` | **7 days** while the OAuth consent screen is in "Testing" | **Chrome publishing breaks weekly.**  Not "may break" — the token's life is shorter than most release intervals, so an unattended pipeline will find it dead more often than alive.  Publishing the consent screen is what stops the clock |
| `EDGE_API_KEY` | **72 days**, with no server-side warning | Edge publishing breaks with a 401 mid-run.  The key carries no readable expiry and the API never warns; `EDGE_API_KEY_ISSUED` is the only tracking there is, and only if somebody updates it with the key |

**Neither has an owner.**  No rotation procedure is documented here,
because none exists that can be verified from this repository — and
inventing one would put a name on a page rather than a person on a
rota.  The constraint is the finding: *both credentials expire on their
own, unattended publishing will hit both, and somebody has to be
accountable for renewing them.*  The per-store detail below says where
each value comes from and what the failure looks like.

## Where the values come from

Resolution order, first hit wins per variable:

1. `process.env` — an exported shell variable, or a CI secret once the repo
   is public.
2. `$LOCKE_RELEASE_ENV` — an explicit path to a `KEY=VALUE` file, for when
   the default location is wrong (a second publisher account, a shared
   release box).
3. `~/.config/sonomos/release.env` — the local-publish default.

The real environment always wins over the file: `loadEnv()` merges the file
first and spreads `process.env` over it, so a one-off
`EDGE_API_KEY=… npm run publish-stores` overrides the file without editing
it.

The file lives **outside the repository on purpose**.  `.gitignore` already
covers `.env`, but "the secret was never in the working tree" is a stronger
guarantee than "the secret was ignored" — a `git add -f`, a stray editor
backup file, an IDE workspace index, or a tarball of the checkout cannot leak
what was never there.  Do not move it into the repo and do not add a
`.env.example` that people will fill in place.

The parser accepts `#` comments, `export KEY=value`, and single- or
double-quoted values.  It does not do interpolation.

## Chrome Web Store (API v2)

| Variable | Where to get it | Secret |
|---|---|---|
| `CWS_PUBLISHER_ID` | Developer Dashboard → Publisher → Settings | no |
| `CWS_EXTENSION_ID` | The 32-character item ID in the dashboard URL | no |
| `CWS_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs, **Web application** type | no |
| `CWS_CLIENT_SECRET` | The same OAuth client | yes |
| `CWS_REFRESH_TOKEN` | Minted against that client (the OAuth playground is the usual route), scope `https://www.googleapis.com/auth/chromewebstore` | yes |

Setup, once: enable the Chrome Web Store API in a Google Cloud project,
create the OAuth client, then exchange an authorization code for a refresh
token.  The publisher must have accepted the API terms in the Developer
Dashboard, or every call comes back with an authorization error that says
nothing about terms.

**The refresh token expires after 7 days while the OAuth consent screen is
in "Testing" status.**  This is the single most common way a Chrome release
fails at 2am, and the symptom is an opaque `invalid_grant` from the token
endpoint that reads like a typo.  Two fixes: publish the consent screen (move
it out of Testing) so refresh tokens stop expiring, or accept that the token
must be re-minted within a week of every release.  `scripts/publish/chrome.mjs`
warns about it unconditionally in preflight, precisely because the eventual
error message will not.

Note that a Chrome `--dry-run` *does* spend a token round trip: it mints an
access token and calls `:fetchStatus`.  That is a feature — it is how a dry
run tells you the credential is dead before the release window opens — but it
means a dry run is not free while the consent screen is in Testing.

**One service account per Chrome Web Store publisher.**  The OAuth client is
bound to the publisher that authorised it; a second publisher account needs
its own client, its own refresh token, and its own `release.env` (point
`$LOCKE_RELEASE_ENV` at it).  Sharing one credential across publishers does
not work and produces permission errors that look like item-ID mistakes.

## Edge Add-ons (API v1.1)

| Variable | Where to get it | Secret |
|---|---|---|
| `EDGE_PRODUCT_ID` | Partner Center → Extension overview → Product ID (a GUID) | no |
| `EDGE_CLIENT_ID` | Partner Center → Publish API | no |
| `EDGE_API_KEY` | Partner Center → Publish API | yes |

"v1.1" names the *credential generation*, not a URL segment — every request
path is `/v1/…`.  The pre-2025 flow (Azure AD / Entra client credentials
exchanged for a Bearer token) was retired on 2025-01-10 and now fails auth
outright; if you find documentation telling you to mint a token, it is out of
date.

**The Edge API key expires every 72 days.**  The key is an opaque string that
carries no readable expiry, the API never warns, and the first symptom is a
401 in the middle of a release.  The only defence is calendar discipline, so
the pipeline adds a variable purely for bookkeeping:

| Variable | Purpose |
|---|---|
| `EDGE_API_KEY_ISSUED` | ISO date (`YYYY-MM-DD`) you minted the current `EDGE_API_KEY`.  Not a credential, not sent anywhere. |

`scripts/preflight.mjs` warns when it is unset (a 72-day fuse nobody is
watching), warns from day 58 with a countdown, and **fails the release** at
day 72 rather than letting the upload discover it.  `scripts/publish/edge.mjs`
additionally warns on every single run, green or not.  Update the date in the
same edit as the key — a stale `EDGE_API_KEY_ISSUED` is worse than an absent
one, because it buys false confidence.

The first publish of a product cannot be done through this API at all
(`CreateNotAllowed`): create the extension by hand in Partner Center, then
put its GUID in `EDGE_PRODUCT_ID`.

## Firefox AMO (API v5)

| Variable | Where to get it | Secret |
|---|---|---|
| `AMO_JWT_ISSUER` | addons.mozilla.org → Manage API Keys → JWT issuer, shaped `user:123456:78` | no |
| `AMO_JWT_SECRET` | The same page → JWT secret | yes |

The add-on's GUID is deliberately **not** an environment variable.  It is
read from `manifest.json::browser_specific_settings.gecko.id`, which is the
only place it may ever be defined: an env-supplied GUID can point a release
at the wrong add-on, and changing it orphans every existing install.

AMO does not issue a long-lived token.  `scripts/publish/firefox.mjs` signs a
fresh HS256 JWT **per request** — the "secret" from Manage API Keys is the
HMAC key itself; there is no keypair anywhere in this flow.  Two constraints
drive that:

- **AMO rejects any JWT whose `exp` is more than 300 seconds past `iat`.**
  The publisher uses 240 seconds, leaving a minute of headroom for clock
  skew; a token that is valid locally and expired server-side comes back as
  an opaque 401 with no useful body.  A machine with a badly wrong clock
  cannot publish to AMO at all.
- **AMO treats a replayed `jti` as a replay attack**, so every signed token
  carries a fresh nonce.  Validation polling routinely outlives a token's
  240-second life, which is why the code passes a token *factory* around
  rather than a token.

## Non-credential variables

| Variable | Read by | Purpose |
|---|---|---|
| `LOCKE_RELEASE_ENV` | `scripts/lib/creds.mjs` | Override the path to the env file |
| `EDGE_API_KEY_ISSUED` | `scripts/preflight.mjs`, `scripts/publish/edge.mjs` | 72-day expiry bookkeeping (see above) |
| `EDGE_EXTENSION_ID` | *(nothing, as of 2026-08-31)* | Formerly read by `scripts/preflight.mjs` to check the published Edge extension ID against the native-messaging host's `allowed_origins`.  The host's manifest templates are not part of this repository, so the check cannot be made here and has been removed; `scripts/preflight.mjs` carries a comment where it used to live.  The variable is documented here only so a `release.env` that still sets it is not mistaken for a live input |
| `SOURCE_DATE_EPOCH` | `scripts/zip.mjs` | Optional. The writer uses a fixed timestamp when it is unset, so builds are deterministic either way; set it to the tag commit's committer time to reproduce a release's exact bytes |

`CWS_EXTENSION_ID` is a Chrome credential only.  *(Corrected 2026-08-31: it
used to do double duty as the value preflight checked against the host's
`allowed_origins`.  That check is gone from this repository along with the
host's manifest templates.)*

The operational fact behind that check has **not** gone away, and nothing
here warns about it any more: until both published extension IDs are listed
in the native-messaging host's `allowed_origins`, native messaging is broken
for every store install even though the extension itself installs fine.  That
is now verified where the host is built, not here — and a store install of a
version published by an unattended pipeline is exactly the case where nobody
notices.

## Example `release.env`

`~/.config/sonomos/release.env`, mode `0600`.  Every value below is a
placeholder — replace all of them, and never commit this file anywhere.

```sh
# Locke Extension release credentials.  NOT in the repo, deliberately.
# chmod 600 this file.

# ── Chrome Web Store (API v2) ──────────────────────────────────────
CWS_PUBLISHER_ID=00000000-0000-0000-0000-000000000000
CWS_EXTENSION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CWS_CLIENT_ID=REDACTED.apps.googleusercontent.com
CWS_CLIENT_SECRET=REDACTED
CWS_REFRESH_TOKEN=REDACTED       # 7-day life while consent screen = Testing

# ── Edge Add-ons (API v1.1) ────────────────────────────────────────
EDGE_PRODUCT_ID=00000000-0000-0000-0000-000000000000
EDGE_CLIENT_ID=REDACTED
EDGE_API_KEY=REDACTED
EDGE_API_KEY_ISSUED=2026-08-12   # 72-day fuse — update WITH the key above
EDGE_EXTENSION_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# ── Firefox AMO (API v5) ───────────────────────────────────────────
AMO_JWT_ISSUER=user:000000:00
AMO_JWT_SECRET=REDACTED
```

Check what resolved without printing anything sensitive:

```sh
npm run preflight -- --checks=credentials
```

It reports each missing variable by name *and* by where to get it, for every
store in one pass, rather than failing on the first gap.

## Redaction

`scripts/lib/creds.mjs::redact` replaces every known secret value (8
characters or longer) with `«redacted»` in everything the publishers print,
and additionally strips any `Bearer`, `JWT` or `ApiKey` token of 16+
characters that it did not put there — a minted Chrome access token, for
instance, or a credential echoed back inside a store's error body.  It is
applied to `dist/publish-report.json` as well as to the console.

This matters because store APIs are chatty on failure: Google echoes request
context into `google.rpc.Status` details, and an access token in a terminal
scrollback — or in a CI log, once this repo is public — is a live credential
until it expires.

Redaction is a backstop, not a licence.  If a secret does reach a log or a
screen share, rotate it: a Chrome refresh token from the OAuth flow, an Edge
key from Partner Center → Publish API (and update `EDGE_API_KEY_ISSUED`), an
AMO secret from Manage API Keys.
