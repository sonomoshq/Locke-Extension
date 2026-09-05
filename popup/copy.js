// Copyright © 2026 Sonomos, Inc. All rights reserved.
// What the popup says, as pure functions of the background state.
//
// Separated from popup.js so it can be tested without a DOM: this is the one
// place in the extension where a wrong sentence is itself the defect. A popup
// that reads "Online — Locke is protecting your AI chats" while screening is
// down is a false assurance the user acts on — the same defect class as an
// on/off switch that does nothing — so the copy is pinned by test, not just
// reviewed.
//
// ## The two questions, kept apart
//
// **Status** — is the Locke desktop app reachable? Answered by the health
// check (the native host's `status` probe).
// **Screening** — is anything actually screening? A different question with
// different evidence; see shared/screening.js. A bare "connected" answers
// neither, so it must never be rendered as "protected" on its own.
//
// "Active" has exactly one source: a real verdict on real traffic, inside the
// freshness window (`shared/screening.js` — no connection state and no live
// reachability answer can produce it). So the Active sentence below names that
// evidence rather than floating free of it. Everything short of it says so
// plainly, including the awkward middle case where the app is up and no
// capture has proved anything yet.
//
// ## The two "Not yet confirmed"s are not the same sentence
//
// `state.lastCaptureFailure` (`{ code, at }` or null, produced by
// shared/screening.js `captureFailureToName`) is what separates them.
//
// Without it: nothing has been tried, so "screening is confirmed the first
// time you send" is the whole truth and a fine thing to read.
//
// With it: something WAS tried, and it failed, seconds ago. Telling that user
// "screening is confirmed the first time you send" is worse than unhelpful —
// they have just sent, watched the page refuse it, and are now reading a
// popup that appears not to know. So the failure gets named, and named as the
// SAME event they already saw rather than a second one. Two of our own
// surfaces describing one outage in words that don't line up is how a tester
// concludes the site is broken and Sonomos is fine.
//
// ## ...and the third one is the opposite event
//
// `code: 'sent-unscreened'` is not a failure at all: the screener answered, the
// request went out, and part of it went out unexamined under the user's own
// fail-open window (`shared/screening.js` `shippedUnscreened`). It reads as
// "Not yet confirmed" like the other two — nothing here proves a screen — but
// it must NOT borrow their sentence, which ends "so nothing was sent
// unscreened". That is the precise inverse of what happened, and a popup that
// says it is lying more specifically than the "Active" this whole state
// replaced. It gets its own line, and that line says the bytes left.

import { SCREENING, STATUS } from '../shared/constants.js';

// Collapse the background worker's finer-grained status into the states the
// popup cares about. A hard bridge/worker error is "error";
// connected/warming (the app is up) is "online"; NO_BRIDGE is "setup";
// UNKNOWN — nobody has asked yet — is "checking"; everything else —
// disconnected, timeout — reads as "offline".
//
// ## Why UNKNOWN is not "offline"
//
// It used to be, and that was the same defect as the NO_BRIDGE one below,
// one status over. `STATUS.UNKNOWN` is the *initial* state
// (`background/service-worker.js` `initialState`) and the literal fallback the
// popup renders when the worker cannot be reached at all
// (`popup/popup.js`: `render(initial ?? { status: STATUS.UNKNOWN })`). It means
// "no health check has answered", which is not an observation about the
// desktop app — and every popup open passes through it before `requestCheck`
// returns.
//
// Rendering that as **Offline — "The Locke desktop app isn't running… Open it
// to resume"** asserted a fact nobody had established and prescribed a fix for
// it, on a machine where the app may well be running and screening. It also
// contradicted our own toolbar badge, which has always shown `?` in grey for
// UNKNOWN and `off` in red for DISCONNECTED — two Sonomos surfaces describing
// one moment in words that do not line up, which is the failure mode this file
// exists to prevent. And `popup.html` ships "Checking…" as its pre-render
// placeholder, so the first thing the copy did was replace an honest
// placeholder with a claim.
//
// "Checking" says what is true: we have not heard yet. It is a transient state
// in the healthy case and a durable one only when the service worker itself is
// unreachable — which is worth showing as its own thing rather than blaming
// the app for.
//
// ## Why NO_BRIDGE is not "offline"
//
// It is the only status that says nothing at all about the desktop app.
// NO_BRIDGE means the BROWSER could not start our native-messaging host: no
// manifest for us, a manifest that omits this extension's id, or a host that
// exited immediately (shared/health-client.js `NO_HOST_PATTERNS`). The browser
// launches that process itself, per message, from that manifest — the desktop
// app is not in the loop — so with no working registration there is no channel
// at all, and whether Locke is running is something we cannot see.
//
// "Offline… Open it to resume" asserted it anyway, in the one configuration
// where the app is very often already open. That is the tester report behind
// this branch: three surfaces telling someone to start an app that was
// running, while the actual fix was one install command nobody named.
//
// "Setup" is what we DO know: the browser half of the install is not working.
// The sentence names what we observed rather than guessing which of the three
// causes it was — they arrive as browser-authored strings we cannot tell apart
// with confidence — and it points at the one fix that now covers all three:
// the desktop app. The worker asks the app to repair the registration on its
// own (background/service-worker.js `requestHostRegistration`, riding the
// loopback listener), so a store install self-heals silently and an unpacked
// load costs one Allow click in the app's consent prompt — or, as the manual
// fallback, pasting this extension's ID under Settings → Locke Extension.
// This copy used to send people to run the native messaging host's installer
// script by hand; that instruction is gone from the user-facing surfaces,
// because asking a user to run an installer the app can drive itself was the
// whole defect — the tester never found the command.
export function viewFor(state) {
  const status = state?.status ?? STATUS.UNKNOWN;
  const error = state?.error;
  // An error outranks UNKNOWN: a health check that threw told us something,
  // even though it left the status where it was.
  if (error === 'bridge-error' || error === 'worker-error' || error === 'bridge-protocol-mismatch') return 'error';
  if (status === STATUS.CONNECTED || status === STATUS.WARMING) return 'online';
  if (status === STATUS.NO_BRIDGE) return 'setup';
  if (status === STATUS.UNKNOWN) return 'checking';
  return 'offline';
}

// "Checking…" is the same string `popup.html` ships as its placeholder, so the
// badge does not flicker through a different word on the way to an answer.
const STATUS_BADGE = {
  online: 'Online',
  offline: 'Offline',
  error: 'Error',
  setup: 'Setup',
  checking: 'Checking…'
};

const SCREENING_LABEL = {
  [SCREENING.AVAILABLE]: 'Active',
  [SCREENING.UNAVAILABLE]: 'Unavailable',
  [SCREENING.UNCONFIRMED]: 'Not yet confirmed'
};

// What actually governs interception: `content_scripts.matches`, generated
// from `shared/ai-surfaces.json` → `web_hosts` (content/shim.js `isAiHost`).
// That catalog is not just chat apps — it deliberately also names search
// engines whose results page can carry an AI-generated answer (the `search`
// provider entry, e.g. `www.google.com`, "Search queries routinely contain
// PII; the extension treats them like chat surfaces"). Calling the whole set
// "AI sites" invites exactly the report this phrase used to draw — "since
// when is Google an AI site?" — a real question, because a plain search does
// not read as one. Naming it as a coverage LIST ("the AI apps and search
// engines Locke screens") rather than a claimed CATEGORY ("AI sites") is the
// accurate version: it says what actually decides scope (catalog
// membership) instead of asserting a property of the site that a user can
// correctly dispute.
//
// Self-contained on purpose — it is dropped into sentences whose subject is a
// request, so a pronoun here ("the AI apps and search engines it covers")
// would attach to the wrong noun.
const COVERED_SITES = 'the AI apps and search engines Locke covers';

// What is actually being held back during an outage, and it is NOT "everything
// you send to those sites".
//
// Every "held back" sentence below used to say "requests to ${COVERED_SITES}",
// which reads as all of them. Only requests with a BODY are ever screened, and
// on the `search` catalog entries — `www.google.com`, `www.bing.com` and the
// rest, declared `web_screening: "none"` — a prompt that arrives as a top-level
// navigation (the address bar, the default search engine, a `?q=` link, a
// `<form>` submit) is not screened on ANY host and is therefore not held back
// by an outage either. `HONEST.md` states that plainly; the popup was quietly
// claiming otherwise.
//
// It matters most in exactly the state these sentences describe. A user
// reading "requests to the search engines Locke screens are being held back"
// during an outage concludes nothing of theirs is leaving. A search typed into
// the address bar left anyway. Naming the subset is the difference between a
// true sentence and a comfortable one.
// Written out rather than composed from COVERED_SITES: the leading "Locke" is
// what lets the trailing "it" be read correctly, and composing the two would
// either repeat the name twice in one clause or strand the pronoun.
const SCREENED_REQUESTS = 'the requests Locke screens on the AI apps and search engines it covers';
const SCREENED_REQUESTS_CAP =
  SCREENED_REQUESTS.charAt(0).toUpperCase() + SCREENED_REQUESTS.slice(1);

// The recent capture event this popup may describe, or null. A plain shape
// check — the freshness judgement itself belongs to the producer
// (`shared/screening.js` `captureFailureToName`), which is the half that owns
// the clock. A malformed value is ignored rather than guessed at.
function recentCaptureEvent(state) {
  const failure = state?.lastCaptureFailure;
  if (!failure || typeof failure !== 'object' || typeof failure.at !== 'number') return null;
  return failure;
}

// The detail line. Keyed on the pair, because the interesting cases are
// exactly the ones where the two disagree.
function detailFor(view, screening, recentFailure) {
  if (view === 'checking') {
    // Says only what we know: nothing has answered yet. It deliberately makes
    // no claim about the desktop app, and no claim about protection either
    // way — screening does not run through this popup, so its silence is not
    // evidence about anything.
    return 'Checking with the Locke desktop app. Nothing has answered yet, so this popup can’t tell you whether screening is running — that answer is a moment away. Screening itself doesn’t depend on this window: an in-scope request is held for a verdict and blocked if none comes back.';
  }
  if (view === 'error') {
    return `Locke hit a problem, so ${SCREENED_REQUESTS} are being held back. Open the Locke desktop app for details.`;
  }
  if (view === 'setup') {
    // Names the missing step, and only the missing step. "Open the app" used
    // to be the one instruction that provably could not help here — the
    // browser launches Locke's connector from a manifest, not the app. The
    // app is in the loop now: the worker has already asked it to repair the
    // registration (requestHostRegistration), so opening it is where the
    // consent prompt — the actual fix — is waiting. content/shim.js gives the
    // same advice for the same condition (`connector-not-started`); one
    // problem, one fix, on both surfaces.
    return `Locke’s browser connector didn’t start, so ${SCREENED_REQUESTS} are being held back. Open the Locke desktop app and click Allow when it asks to connect this extension — or add this extension’s ID under Settings → Locke Extension — then retry.`;
  }
  if (view === 'offline') {
    // "isn't answering", not "isn't running". This branch is reached from a
    // host that replied `connected: false` AND from a bridge timeout, and a
    // timeout is silence rather than an observation: the app may be running
    // and wedged, or simply slower than `bridgeTimeoutMs`. Saying what we
    // observed — no answer — costs nothing and stays true in both, and the
    // remedy is the same either way.
    return `The Locke desktop app isn’t answering, so ${SCREENED_REQUESTS} are being held back. Open it to resume — or restart it, if it is already open.`;
  }
  if (screening === SCREENING.UNAVAILABLE) {
    // The state this whole split exists for: app up, nothing screening.
    return `The desktop app is reachable, but screening isn’t answering. ${SCREENED_REQUESTS_CAP} are being held back until it recovers.`;
  }
  if (screening === SCREENING.AVAILABLE) {
    // This state now has exactly one source: a real verdict on real traffic
    // (`shared/screening.js` — AVAILABLE is earned from a capture receipt and
    // from nothing else). So the sentence names its evidence instead of
    // floating free of it.
    //
    // It used to be reachable from a live reachability probe too, which is why
    // it was worded vaguely — and why it was wrong: the probe establishes that
    // the app is reachable, not that anything behind it can screen, so "Locke
    // confirmed screening is active" appeared while the screener was still
    // starting up and every request was being held back. Vague wording did not
    // make that honest; it only made it harder to notice.
    //
    // "Recent" is the 10-minute SCREENING_EVIDENCE_TTL_MS, so the claim stays
    // true for as long as it is shown. A policy `block` counts as a screen
    // here, correctly: the screener looked and refused.
    return 'Locke screened a recent request, so screening is confirmed active. Open the Locke desktop app to watch it work.';
  }
  if (recentFailure?.code === 'sent-unscreened') {
    // Unconfirmed because a real capture just went out UNEXAMINED. The one
    // case in this function where "held back" would be the wrong direction:
    // say plainly that it was sent, and name the setting that allowed it, so
    // the fix is somewhere the user can actually reach.
    return `A recent request to one of ${COVERED_SITES} was sent before it could be fully screened, under your fail-open setting. Part of it went out unexamined. If the page warned you just now, this is that same event, not a second problem.`;
  }
  if (recentFailure) {
    // Unconfirmed BECAUSE a real capture just failed. Say which way round it
    // is — the request was held back, nothing leaked — and say plainly that
    // the block on the page and this line are one event, so nobody spends
    // their afternoon triaging the website.
    return `A recent request to one of ${COVERED_SITES} was held back — Locke couldn’t confirm it had been screened, so nothing was sent unscreened. If the page showed you a Sonomos block just now, this is that same event, not a second problem.`;
  }
  // Connected, but nothing has proved anything behind the app is screening.
  // Say that, rather than the comfortable thing.
  return `Connected to the Locke desktop app. Screening is confirmed the first time you send something it screens, on one of ${COVERED_SITES}.`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const wasWere = (n) => (n === 1 ? 'was' : 'were');

// The session note, or null when there is nothing to report.
//
// Three counts, all sourced from real capture receipts
// (shared/screening.js `tallyFromReceipt`) and all rendered as plain fact —
// no warning glyph, no "leak", no second person accusation:
//
//   redactedItems — the screener's own `redactedCount`: personal information it
//     actually found and removed before your message left. This is the
//     answer to a question the popup used to have no answer for at all: a
//     redacted send and a clean send look identical in the browser, the
//     console, and (until this line existed) the popup too. The evidence was
//     already here — every capture receipt carries it — it just was not
//     shown.
//   uncheckedSends / withheldItems — `unchecked` / `unscreened` reaching a
//     human. They mark content that went out under the user's own explicit,
//     time-boxed fail-open window, a state they opted into deliberately. The
//     two are deliberately different sentences, because they are opposite
//     outcomes and the pairing is the only thing separating them: unchecked
//     content LEFT the machine; withheld content did not.
//
// All three can be non-zero from the very same session (even the very same
// request: some of it redacted, one attachment withheld) — they are
// independent facts, not alternatives, so every clause that applies is shown.
export function noteFor(state) {
  const redacted = Number(state?.redactedItems) || 0;
  const unchecked = Number(state?.uncheckedSends) || 0;
  const withheld = Number(state?.withheldItems) || 0;
  const parts = [];
  if (redacted > 0) {
    parts.push(
      `${plural(redacted, 'item', 'items')} of personal information ${wasWere(redacted)} redacted from what you sent this session.`
    );
  }
  if (unchecked > 0) {
    parts.push(
      `${plural(unchecked, 'request', 'requests')} went out this session without a full screen, under your fail-open setting.`
    );
  }
  if (withheld > 0) {
    parts.push(
      `${plural(withheld, 'attachment', 'attachments')} couldn’t be examined and stayed on this machine.`
    );
  }
  return parts.length ? parts.join(' ') : null;
}

// Everything the popup renders, from one state object.
export function copyFor(state) {
  const view = viewFor(state);
  const screening = SCREENING_LABEL[state?.screening] ? state.screening : SCREENING.UNCONFIRMED;
  return {
    view,
    badge: STATUS_BADGE[view],
    screening,
    screeningLabel: SCREENING_LABEL[screening],
    detail: state?.error === 'worker-error'
      ? `The browser extension did not answer, so ${SCREENED_REQUESTS} are being held back. Close and reopen this popup. If it still cannot connect, reload the extension in your browser’s extensions settings, then reload the affected page and retry.`
      : state?.error === 'bridge-protocol-mismatch'
        ? `The installed Locke components use incompatible versions, so ${SCREENED_REQUESTS} are being held back. Update or repair the Locke desktop app, restart it, then reopen this popup and retry.`
        : detailFor(view, screening, recentCaptureEvent(state)),
    note: noteFor(state)
  };
}
