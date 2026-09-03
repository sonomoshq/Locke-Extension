## Engineering — coordinated work

- [ ] **Streaming large receipts.** Chrome caps a native-messaging
      host→browser reply at 1 MB, so a `redact` verdict whose rebuilt request
      exceeds the cap fails closed (blocked) today. A persistent
      `connectNative` port with chunked replies would let large rebuilt
      requests round-trip instead of blocking.
- [ ] **CSP `report-to` collector.** MV3 CSP doesn't easily report to
      a remote endpoint, but the service worker can collect violations
      via `securitypolicyviolation` events on extension pages. Adds
      audit-log entries when the popup CSP is hit. Low priority.

## Operations — calendar time

- [ ] **Chrome Web Store / Edge Add-ons / AMO listing.** Held until
      the product is more built out (per maintainer decision). When
      ready, `docs/security/PERMISSIONS.md` is the per-permission
      justification doc the stores require.
- [ ] **Live bug-bounty listing.** `docs/security/BUG-BOUNTY.md` defines
      scope and rules of engagement. Submit to <https://huntr.com> or
      similar once `security@sonomos.ai` is monitored 24/5.
- [x] **CII Best Practices badge — not pursued.** `[closed 2026-08-31]`
      The badge is for open-source projects and this repository is
      published under PolyForm Strict 1.0.0, which is not an OSI-approved
      open-source licence, so it is not eligible. The
      README badge was removed and is not coming back.
      `docs/security/CII-CHECKLIST.md` stays as an internal
      self-assessment; nothing is submitted.

## Documentation — minor

- [x] LICENSE added — PolyForm Strict License 1.0.0.
      Resolved in the opposite direction to what this entry assumed: the
      previously removed `LICENSE-MIT` / `LICENSE-APACHE` are not coming
      back, and the repository is source-available rather than open
      source. No `NOTICE` file is needed, since Apache-2.0 §4(d) no
      longer applies.
- [ ] Have counsel review `LICENSE`. It was drafted in-house and has not
      been through the same review as the documents in `docs/legal/`.

## Process — ISMS maturity

- [ ] **Two-person release in practice.** Policy is documented at
      `docs/security/RELEASE-POLICY.md`; CODEOWNERS enforces review.
      Confirm the second reviewer is staffed before the next signed
      release.
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
