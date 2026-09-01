# Export Control and Cryptography Notice

> **DRAFT — pending revision and review by the legal reviewer.** See
> `TODO.md` for the legal review checklist.

> ## Status: UNCLASSIFIED — pending counsel
>
> **Sonomos has not determined an ECCN for this software, and no
> Sonomos product has an export classification anyone here can
> evidence.** No classification record, no filing receipt and no
> self-classification report has been located. Nothing below assigns,
> confirms or denies an ECCN — that is a determination for counsel,
> and counsel has not yet made one.
>
> What this notice does instead is state, accurately, what
> cryptography the code contains. That inventory is engineering fact
> and is verifiable by reading the source. The classification that
> follows from it is not, and is left open.

> **Corrected 2026-08-21.** This notice used to inventory an
> HMAC-SHA-256 handshake, SHA-256 body hashing and nonce generation in
> `content/content-script.js`, plus a planned X25519 / HKDF /
> AES-256-GCM layer described in `docs/architecture/HPKE-DESIGN.md`.
> None of it is in the product: those functions implemented the retired
> loopback handshake and were removed in the 2026-06 mesh rewrite, and
> the cited design document has never existed in this repository. An inventory that overstates what a
> product carries is the wrong error to make in an export-control
> filing, so it is corrected here rather than left standing.

## Cryptographic functionality

**The extension implements and invokes no cryptography.** There is no
`crypto.subtle` call, no key, no nonce, and no secret held anywhere in
`background/`, `content/`, `popup/` or `shared/`.

Its two channels are protected by operating-system facilities rather
than by ciphers:

* **Captured page data** leaves the browser over OS native messaging
  (stdio) to a same-user helper, which relays it to the Locke desktop
  app over a Unix domain socket at mode `0600`. Confidentiality here is
  file and process permissions, not encryption.
* **The presence beacon** is plaintext loopback HTTP carrying
  `{ browser, version }` and nothing else.

The native messaging host that carries those bytes is installed by the
Locke desktop app and is **not part of this repository**. Nothing about
its contents is inventoried here, and no statement above should be read
as covering it.

Users' TLS connections to their chosen LLM provider are made by the
browser, unmodified and not interposed by this extension.

**One item for completeness, so the inventory cannot be called
incomplete:** `scripts/publish/firefox.mjs` imports `node:crypto` and
computes an HMAC-SHA-256 to sign a JWT for Mozilla's addons.mozilla.org
publish API (`:25`, `:68`, `:77`). It is release tooling that runs on a
maintainer's machine, it authenticates *us* to a store, and it is not
staged into the distributed package — `scripts/` is excluded by
`scripts/package.mjs`. It is named here rather than omitted.

## Scope: this notice covers the browser extension only

The statements above are about the code in **this repository**, which
contains the browser extension and the tooling that builds, validates
and publishes it — and nothing else. They are not true of Sonomos
software generally, and must not be quoted as if they were.

The desktop product is a different component with genuinely different
cryptographic content: real TLS implementations, certificate handling,
cryptographic hashing, and OS-keychain-backed token storage. It also
supplies the native messaging host this extension talks to. None of
that is published in this repository and none of it is inventoried
here.

**None of that is classified here either.** It is named so that a
reader who needs an export analysis of the desktop product knows to
ask for one, rather than inferring "no cryptography" from a document
that only ever described the extension.

## ECCN classification

**No ECCN has been determined for this software.**

An earlier version of this notice stated a provisional classification
of 5D002. That assertion is withdrawn `[2026-08-21]`: no record of who
made it, when, or on what basis has been found, and it was in any case
made against the crypto inventory that this notice has since corrected
as wrong. An unevidenced classification is worse than none, so it is
removed rather than restated more softly.

Counsel is asked to make a **first determination**, not to confirm
ours. The inventory above is the input; the questions are:

- What ECCN, if any, applies to the extension given that it implements
  and invokes no cryptography.
- What ECCN applies to the desktop product, which does contain
  cryptographic implementations of its own. This is a separate
  analysis and is not covered by this notice.
- Whether a TSU notification under 15 CFR § 742.15(b) is required for
  either, and — see below — whether one has ever been filed for
  anything.
- Whether `LICENSE EXCEPTION ENC` per §740.17 covers the distribution
  model, if it is reached at all.

### Prior filings: none can be evidenced

This notice used to state that the parent desktop product
"filed a TSU notification on 2026-03-13." **That claim is withdrawn as
unverified.** No filing receipt, no BIS confirmation, no submission
record and no correspondence supporting it exists on disk or in any
repository, and no one at Sonomos can confirm the filing was made. It
may have been made
and gone unrecorded, or it may never have happened — we do not know,
and a date asserted about a regulatory filing is precisely the kind of
claim that must not rest on nobody's recollection.

**Treat Sonomos as having no evidenced export filings of any kind**
until counsel establishes otherwise.

### The gap this leaves, named rather than papered over

Withdrawing the classification does not create the exposure; it
reveals it. Stated plainly:

- Software is being distributed with **no export classification of
  record**. If any Sonomos component is in fact 5D002 — the desktop
  product, not the extension, is the candidate — then the annual
  self-classification report under §742.15(b), and possibly a §740.17
  notification, may already be overdue. We do not know whether they are.
- Nothing in the release process gates on export status. No check
  asks "is this classified?" before an artifact ships.
- The obligation, if one exists, attaches to distribution, which is
  already happening. It is not deferred by this document.

This is a legal question with a deadline attached, and it needs
counsel's time rather than an engineer's best guess.

## Disclaimer

*This notice is provided for informational purposes only and does
not constitute legal advice. Users are responsible for determining
whether their use, distribution, or re-export of this software
complies with applicable export-control laws in their jurisdiction.*
