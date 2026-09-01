---
name: Bug report
about: Something in the Locke Extension does not work as documented
title: "bug: "
labels: ["bug", "needs-triage"]
assignees: []
---

<!-- ─────────────────────────────────────────────────────────────────
  STOP — IS THIS A SECURITY VULNERABILITY?

  If the answer is yes, or maybe, close this form. Do NOT file a public
  issue. See SECURITY.md:

    * Email security@sonomos.ai
    * Or open a private advisory:
      https://github.com/sonomoshq/Desktop-Extension/security/advisories/new

  We acknowledge within 48 hours and aim to ship fixes within 30 days for
  high-severity issues. Safe-harbour terms are in
  docs/security/BUG-BOUNTY.md.

  "Security vulnerability" includes anything touching: the native
  messaging host, PII leaving the device unmasked, the fail-closed path,
  or the release/signing pipeline.
───────────────────────────────────────────────────────────────────── -->

- [ ] I have confirmed this is **not** a security vulnerability. (If it
      is, see the notice above and do not submit this form.)

## What happened

<!-- What you observed. Be specific about the exact moment it went wrong. -->

## What you expected

<!-- What the docs, popup, or README led you to expect instead. -->

## Steps to reproduce

1.
2.
3.

## Environment

| | |
|---|---|
| Extension version (from `chrome://extensions` or `about:addons`) | |
| Browser and version | |
| Operating system and version | |
| Locke desktop app version | |
| Installed unpacked, or from a store? | |
| Managed policy in effect? (`chrome://policy`) | yes / no / unknown |

## Connection status

<!-- The toolbar badge is the fastest signal. Click the extension icon
     and copy what the popup reports. -->

- Badge colour:
- Popup status text:
- Did the badge ever turn green on this install? yes / no

## Which AI surface

<!-- Which site were you on when it went wrong? e.g. chatgpt.com,
     claude.ai, gemini.google.com. "All of them" is also an answer. -->

## Audit log excerpt (optional but very useful)

<!-- Popup -> "Audit log" exports the extension's 100-entry ring buffer.
     REDACT anything sensitive before pasting: entries can reference the
     page you were on. -->

```
paste here
```

## Console errors (optional)

<!-- Service worker: chrome://extensions -> Locke Extension -> "service
     worker" -> Console. Page-side: DevTools console on the affected tab.
     Redact URLs and page content you would not want public. -->

```
paste here
```

## Anything else

<!-- Workarounds you found, when it started, whether it is intermittent. -->
