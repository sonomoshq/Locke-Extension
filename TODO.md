# TODO — open follow-ups

Living document. Items here have been deliberately deferred from the
current scope (typically because they need calendar time, external
review, or coordinated multi-repo work). They are NOT bugs — they're
known gaps with a documented owner and trigger.

> ## ⚖️ LEGAL REVIEW REQUIRED
>
> **Every legal document in this repo is a draft pending revision and
> review by the legal reviewer.** Customers must not be shown an
> unreviewed version. The affected files are:
>
> - `docs/legal/DPA-template.md`
> - `docs/legal/DPIA-template.md`
> - `docs/legal/RETENTION.md`
> - `docs/legal/SUB-PROCESSORS.md`
> - `EXPORT_CONTROL_NOTICE.md`
> - The EULA hosted at <https://sonomos.ai/eula> (linked from popup —
>   confirm the live copy reflects current product behaviour)
> - Any indemnification, choice-of-law, or warranty language in the
>   above docs
>
> Mark each file with `[REVIEWED-BY-LEGAL: YYYY-MM-DD ZB]` at the top
> once Zachary has signed off. Until then they're marked DRAFT.

## Legal — pending legal review

- [ ] DPA template — revise indemnification language (currently a
      placeholder), choice-of-law (defers to MSA which doesn't yet
      exist in repo), and termination clause
- [ ] DPIA template — confirm Article 9 special-categories handling
      language is accurate; confirm "no DPO required" claim is correct
      for Sonomos's processing volume
- [ ] RETENTION.md — confirm the audit-log retention window (currently
      "until ring-buffer eviction, ~100 entries") is acceptable; confirm
      no statutory retention obligation forces longer
- [ ] SUB-PROCESSORS.md — confirm the "no sub-processors touch
      product PII" claim survives review; if any corporate-ops vendor
      (Stripe, Linear, Slack, etc.) sees customer-identifiable
      metadata, list them with role
- [ ] **EXPORT_CONTROL_NOTICE.md — take an ECCN classification.**
      `[reframed 2026-08-21]` This used to read "confirm ECCN
      classification (5D002 vs. ENC exception) is accurate", which
      presumed a determination existed to confirm. None is evidenced:
      no classification record, no filing receipt and no author for the
      5D002 assertion the notice used to carry could be found, so the
      notice now states no ECCN rather than repeating one. Counsel is
      being asked to make a first determination, not to check ours.
      Also unresolved and named in the notice: whether a TSU
      notification under 15 CFR § 742.15(b) is required, and whether
      one was ever filed for any Sonomos product.
- [ ] EULA at <https://sonomos.ai/eula> — confirm current live copy
      covers the extension's behaviours documented in
      `docs/security/PERMISSIONS.md` and `docs/architecture/DATA-FLOW.md`

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

- [ ] **SOC 2 Type II attestation.** Nothing here has begun
      `[clarified 2026-08-21]`: no auditor selected, no gap assessment,
      no observation window, no target date, no budget approved. It is
      a 12-18 month engagement if it is ever started. Until it is,
      nothing in this repository may describe SOC 2 as "in progress",
      "in process" or "pending" — see `HONEST.md` and
      `RISK-REGISTER.md` R-19 for the wording that is true today. Not
      in scope for the engineering team.
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
- [ ] **Trademark policy.** Defer until "Sonomos" is registered.

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
