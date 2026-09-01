# Coordinated vulnerability disclosure / bug-bounty program

The Sonomos Desktop Connector welcomes security research. This
document defines scope, rules of engagement, safe-harbour terms,
and reward expectations.

> **Status: kudos-only at launch.** Live monetary payouts pending
> a budget decision; see `TODO.md`. The policy below is binding
> regardless — researchers acting in good faith within this scope
> are protected.

## Scope

### In scope

- The Sonomos Desktop Connector browser extension at this
  repository (latest release tag).
- Its native messaging host — the companion binary installed by the
  Locke desktop app that relays each held request. Its source is not
  part of this repository; what is in scope here is its observable
  behaviour on the native-messaging channel.
- The wire protocol between the extension and that host
  (`shared/constants.js::BRIDGE_MSG` — `hello`, `status`, `capture` —
  the synthesized-request framing, and the audit-log shape). There is
  no HMAC handshake and no "mask request"; both belonged to a retired
  architecture.
- Documentation that affects security posture (manifest scope,
  managed-policy schema, threat model).

### Out of scope

- The Locke desktop app and everything behind it (detection,
  redaction, storage) — a different repository, a different scope.
  What is in scope here stops at the native-messaging host.
- The user's own LLM-provider account (we don't operate it).
- Findings against pre-release / `main` tip — only released tags.
- Self-XSS that requires the user to paste attacker-supplied
  JavaScript into devtools.
- Findings already known and named in
  [`SECURITY.md`](../../SECURITY.md) as unmitigated — currently A3
  (nothing re-verifies the native-messaging host manifest after
  install) and the A2 presence-beacon fingerprint. Corrected
  2026-08-21: this used to exclude "the A2 first-request residual
  leak", which described the retired daemon's loopback channel.
- Missing security headers on `sonomos.ai` marketing pages.
- Spam / phishing of `info@sonomos.ai`.

## Rules of engagement

- **No testing against other users' installs.** Only your own
  endpoint, your own desktop app, your own browser profile.
- **No social engineering** of Sonomos staff or contractors.
- **No physical attacks** on Sonomos infrastructure or staff.
- **No automated scanners** that generate sustained traffic
  against `sonomos.ai`. Report rate-limit findings by
  description, not by demonstration.
- **Do not access, modify, or destroy** data that is not your own.
- **If you accidentally find PII** (yours or anyone else's), stop
  immediately and report what happened. We will not punish good-
  faith mistakes.

## Safe harbour

Sonomos will not pursue legal action against researchers who:

1. Make a good-faith effort to comply with this policy.
2. Report through the channels in [SECURITY.md](../../SECURITY.md)
   rather than disclosing publicly first.
3. Give us reasonable time to fix before public disclosure
   (see "Coordinated disclosure" below).
4. Do not violate the privacy of users, destroy data, or impair
   service availability.

This safe harbour extends to actions reasonably necessary to
investigate the vulnerability — including, with care, accessing
*your own* desktop app's logs and storage to demonstrate impact.

The CFAA (US) / Computer Misuse Act (UK) / similar laws may have
ambiguous coverage for security research. We commit to actively
defending researchers acting in good faith against legal action
arising from research conducted within this policy.

## Reporting

Use the channels in [SECURITY.md](../../SECURITY.md):

- Email `security@sonomos.ai` (PGP at
  `https://sonomos.ai/.well-known/pgp-key.asc`)
- GitHub Security Advisory on
  [this repository](https://github.com/sonomoshq/Locke-Extension/security/advisories/new)

Please include:

- A description of the issue and its potential impact.
- Reproduction steps with the exact extension version, browser
  version, OS, and Locke desktop app version.
- Any proof-of-concept code (mark sensitive snippets clearly).
- Your preferred name for acknowledgement (or anonymous, your
  choice).
- Whether you'd like attribution credit (linked GitHub profile,
  X/Twitter handle, personal site).

## Response SLA

- **Acknowledgement**: within 48 hours of receipt.
- **Triage**: a severity rating and a target fix window within 7
  days.
- **High-severity fix**: target 30 days from triage.
- **Disclosure coordination**: 90 days from triage by default;
  shorter if we ship a fix sooner, longer by mutual agreement if
  the fix is complex.

## Reward / acknowledgement

Currently:

- **Public acknowledgement** (with your consent) on
  [`docs/security/DISCLOSURE-LOG.md`](DISCLOSURE-LOG.md).
- **Sonomos sticker pack** for any valid finding (worldwide
  shipping; ask).

Pending budget approval (see `TODO.md`):

- Monetary rewards for High and Critical severity findings,
  sized to the issue and the effort.
- Listing on a public bounty platform (huntr.com or HackerOne).

## What gets you the most appreciation

These are the issue classes we care most about, ranked:

1. **Anything that breaks the loopback-only invariant** (extension
   reaching a non-loopback host without manifest pinning).
2. **Anything that lets a port-squatter receive plaintext PII**
   beyond the documented A2 first-request residual.
3. **Defeat of the native-messaging channel's origin binding** —
   getting an extension ID not in `allowed_origins` to speak to the
   native host, or reaching the desktop app's socket as a different
   OS user.
   *(This replaces "bypass of the per-install HMAC handshake", removed
   2026-08-21: there is no handshake to bypass. It belonged to a
   retired architecture, as this document's own scope section
   already says at the top. The channel's actual protections are
   browser-enforced `allowed_origins` and socket mode `0600`.)*
4. **Privilege escalation via the native-messaging bridge**
   (arbitrary code execution as the user from a non-elevated
   web origin).
5. **Audit-log tampering** that destroys evidence of the above.
6. **CSP / shadow-DOM escapes** that let a hostile page inject
   into the popup or impersonate the extension's UI.
7. **Supply-chain findings**: an Action SHA we've pinned that's
   been compromised; a vulnerable dep we've missed; an SBOM
   omission.

We'll generally not consider these significant on their own:

- Self-XSS in pages we don't control.
- Theoretical issues with no demonstrated impact.
- Missing rate limits on sigstore signing (we don't operate it).
- "You should use HTTPS/authentication for the loopback connection" —
  see `SECURITY.md` A2 for why not: the only thing on that connection is
  a two-field liveness beacon whose response is never read. Captured
  request bodies do not use loopback at all.

## Hall of fame

See [`docs/security/DISCLOSURE-LOG.md`](DISCLOSURE-LOG.md).
