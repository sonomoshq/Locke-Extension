## Engineering — coordinated work

- [ ] **Streaming large receipts.** Chrome caps a native-messaging
      host→browser reply at 1 MB, so a `redact` verdict whose rebuilt request
      exceeds the cap fails closed (blocked) today. A persistent
      `connectNative` port with chunked replies would let large rebuilt
      requests round-trip instead of blocking.

## Operations — calendar time

- [ ] **Live bug-bounty listing.** `docs/security/BUG-BOUNTY.md` defines
      scope and rules of engagement. Submit to <https://huntr.com> or
      similar once `security@sonomos.ai` is monitored 24/5.

## Documentation — minor

- [ ] Have counsel review `LICENSE`. It was drafted in-house and has not
      been through the same review as the documents in `docs/legal/`.

## Process — ISMS maturity

- [ ] **Release approval gate.** The two-person release rule is
      withdrawn (`docs/security/RELEASE-POLICY.md`), and the repository
      has no CODEOWNERS file. Pull requests to `main` need one approving
      review. Decide whether a signed release also needs a second
      person's approval (`docs/security/RISK-REGISTER.md` R-15).
- [ ] **Quarterly management review.** First scheduled review per
      `docs/security/MANAGEMENT-REVIEW.md` is the next quarter
      boundary after this commit.
- [ ] **Risk register quarterly update.** `docs/security/RISK-REGISTER.md`
      ratings need refresh each quarter — flag any risk that's
      changed level since last review.

---

## How to use this doc

- New deferred work: add an entry under the right section.
- Closed item: delete it; record the closure in CHANGELOG.md if it
  was non-trivial.
- Items needing legal sign-off: explicitly route to the legal reviewer;
  do not close based on engineering review alone.
