// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { ext } from '../shared/browser.js';
import { detectBrowser } from '../shared/browser-info.js';
import { checkHealth, classifyLastError } from '../shared/health-client.js';
import { WEB_HOSTS } from '../shared/web-surfaces.generated.js';
import {
  AUDIT_KEY,
  AUDIT_MAX_ENTRIES,
  BRIDGE_MSG,
  DEFAULTS,
  DISABLED_WEB_HOSTS_KEY,
  hostMatches,
  MANAGED_KEYS,
  MSG,
  NATIVE_HOST,
  PRESENCE_INTERVAL_SECONDS,
  PRESENCE_URL,
  REGISTRATION_MIN_INTERVAL_MS,
  REGISTRATION_URL,
  SCREENING,
  SCREENING_KEY,
  STATE_KEY,
  SETTINGS_KEY,
  STATUS
} from '../shared/constants.js';
import {
  captureFailureToName,
  evidenceFromReceipt,
  evidenceFromRelayFailure,
  screeningFor,
  tallyFromReceipt
} from '../shared/screening.js';

const ALARM_NAME = 'sonomos-desktop-heartbeat';
// A SECOND alarm, on purpose. `ALARM_NAME` carries the health probe and backs
// off when it fails; this one carries nothing but "I am installed" and never
// does. See PRESENCE_INTERVAL_SECONDS in shared/constants.js for why the two
// were split.
const PRESENCE_ALARM = 'sonomos-presence';
const IN_FLIGHT_KEY = 'inFlight';
const BACKOFF_KEY = 'backoff';
// Session-storage timestamp of the last self-registration POST, the client
// half of REGISTRATION_MIN_INTERVAL_MS.
const REGISTRATION_ATTEMPT_KEY = 'registrationLastAttempt';

const BADGE = {
  [STATUS.CONNECTED]:    { text: '',    color: '#16a34a' },
  [STATUS.WARMING]:      { text: '…',   color: '#f59e0b' },
  [STATUS.DISCONNECTED]: { text: 'off', color: '#dc2626' },
  [STATUS.NO_BRIDGE]:    { text: '!',   color: '#f59e0b' },
  [STATUS.UNKNOWN]:      { text: '?',   color: '#6b7280' }
};

function initialState() {
  return {
    status: STATUS.UNKNOWN,
    httpStatus: null,
    body: null,
    latencyMs: null,
    lastCheck: null,
    lastChange: Date.now(),
    error: null,
    consecutiveFailures: 0,
    // Screening availability is NOT the connection status — see
    // shared/screening.js. Unconfirmed until real traffic proves otherwise.
    screening: SCREENING.UNCONFIRMED,
    // `{ code, at }` for a capture that just failed, or null. See runCheck.
    lastCaptureFailure: null,
    uncheckedSends: 0,
    withheldItems: 0,
    redactedItems: 0
  };
}

async function getManagedSettings() {
  // chrome.storage.managed throws if no managed schema is configured for
  // this profile (the common case on a personal install). Treat any
  // failure as "no policy" — never fail-closed on policy lookup, since
  // that would brick the extension for every non-managed user.
  try {
    const got = await ext.storage.managed.get(MANAGED_KEYS);
    if (!got || typeof got !== 'object') return {};
    const out = {};
    for (const key of MANAGED_KEYS) {
      if (got[key] === undefined) continue;
      out[key] = got[key];
    }
    if (Object.keys(out).length > 0) {
      maybeAuditPolicyLoaded(Object.keys(out));
    }
    return out;
  } catch {
    return {};
  }
}

let policyLoadedAudited = false;
function maybeAuditPolicyLoaded(keys) {
  if (policyLoadedAudited) return;
  policyLoadedAudited = true;
  appendAudit('policy-loaded', { keys });
}

async function getSettings() {
  const got = await ext.storage.local.get(SETTINGS_KEY);
  const managed = await getManagedSettings();
  // Precedence: DEFAULTS < user-local < managed. Managed always wins.
  return { ...DEFAULTS, ...(got?.[SETTINGS_KEY] ?? {}), ...managed };
}

async function getState() {
  const got = await ext.storage.session.get(STATE_KEY);
  return got?.[STATE_KEY] ?? initialState();
}

async function setState(state) {
  await ext.storage.session.set({ [STATE_KEY]: state });
}

// ── Screening evidence ──────────────────────────────────────────────
//
// The health check answers "is the Locke desktop app reachable". It cannot
// answer "is anything actually screening", because the host's probe only
// establishes reachability and the screener behind it can be dead — so a popup
// that reads one as the other tells the user they are protected while nothing
// is. shared/screening.js holds the reasoning; this holds the storage.
//
// What accrues here is first-hand: every capture receipt is testimony from the
// screener itself. Alongside it we keep the fail-open tallies, because a
// sanctioned bypass that nobody can see is indistinguishable from a clean
// screen, which is the whole reason `unchecked` exists.

function initialScreening() {
  return {
    // AVAILABLE | UNAVAILABLE | UNCONFIRMED ("a capture failed and we cannot
    // tell whose fault it was" — shared/screening.js) | null (nothing yet)
    state: null,
    fragment: null,     // which INFRASTRUCTURE_REASONS fragment matched, if any
    code: null,         // our own closed-set code for a capture that failed
    at: 0,              // when the evidence was observed
    uncheckedSends: 0,  // requests that left WITHOUT a full screen (fail-open)
    withheldItems: 0,   // items held back because they could not be examined
    redactedItems: 0,   // PII spans the screener actually found and removed
    lastUncheckedAt: null
  };
}

// Which of the served entries name a surface we actually screen.
//
// The same membership rule the desktop app applies to its own half: an entry
// has effect only if the
// catalog already matches it, and `hostMatches` is the one definition of that
// — so `openai.com` counts, because `chat.openai.com` is below it, while
// `login.bank.example` resolves to nothing here and is reported as ignored
// rather than stored. Shape validation alone could not tell those apart.
//
// The remainder is not dropped silently: it becomes `ignored_count` in the
// ack, which is how a setting that names nothing we screen gets *reported*
// instead of just quietly failing to do anything.
function applicableDisabledHosts(served) {
  return served.filter((entry) => WEB_HOSTS.some((host) => hostMatches(entry, host)));
}

// Persist the desktop app's disable set, and only when it actually changed —
// every write fires storage.onChanged in every content script on every open
// tab, which re-pushes config to each shim. The set moves when a user flips a
// toggle; the health probe runs on a heartbeat.
//
// Stores the applied set and the count it could not apply, because that pair
// IS the ack we owe the desktop app (reportedApplied below sends it back on
// the next probe). Keeping it in memory instead would lose it to the next
// worker eviction, which on MV3 is constantly.
async function storeDisabledWebHosts(served) {
  const applied = { hosts: applicableDisabledHosts(served), ignoredCount: 0 };
  applied.ignoredCount = served.length - applied.hosts.length;
  try {
    const stored = (await ext.storage.local.get(DISABLED_WEB_HOSTS_KEY))?.[DISABLED_WEB_HOSTS_KEY];
    const same = stored && typeof stored === 'object' &&
      Array.isArray(stored.hosts) && stored.ignoredCount === applied.ignoredCount &&
      stored.hosts.length === applied.hosts.length &&
      stored.hosts.every((host, i) => host === applied.hosts[i]);
    if (same) return applied;
    await ext.storage.local.set({ [DISABLED_WEB_HOSTS_KEY]: applied });
  } catch { /* storage unavailable — the previous set stands */ }
  return applied;
}

// What this extension is currently enforcing, for the ack. Read from storage
// rather than remembered, for the same eviction reason. `null` when we have
// nothing stored: the host must then write no ack at all rather than one
// claiming an empty set is in force.
async function reportedApplied() {
  try {
    const stored = (await ext.storage.local.get(DISABLED_WEB_HOSTS_KEY))?.[DISABLED_WEB_HOSTS_KEY];
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.hosts)) return null;
    return { hosts: stored.hosts, ignoredCount: Number.isSafeInteger(stored.ignoredCount) ? stored.ignoredCount : 0 };
  } catch {
    return null;
  }
}

async function getScreening() {
  try {
    const got = await ext.storage.session.get(SCREENING_KEY);
    const stored = got?.[SCREENING_KEY];
    return (stored && typeof stored === 'object') ? { ...initialScreening(), ...stored } : initialScreening();
  } catch {
    return initialScreening();
  }
}

// A capture happens per outbound AI request, so refreshing the timestamp on
// every one would mean a session-storage write per keystroke-ish send. Only
// write when something meaningful moved, or when the stored evidence is old
// enough that its freshness is what's being asserted.
const SCREENING_WRITE_MIN_INTERVAL_MS = 30_000;

// Captures run concurrently (a busy chat page has several in flight), and a
// read-modify-write on session storage would silently drop increments under a
// burst. "How many requests went out unscreened" is precisely the number that
// must not be quietly wrong, so the writes are serialized. They are tiny and
// already off the critical path, so the queue costs nothing perceptible.
let screeningWrites = Promise.resolve();

function noteScreening(evidence, tally) {
  if (!evidence && !tally) return screeningWrites;
  screeningWrites = screeningWrites.then(() => applyScreening(evidence, tally)).catch(() => {});
  return screeningWrites;
}

async function applyScreening(evidence, tally) {
  try {
    const prev = await getScreening();
    const next = { ...prev };
    let changed = false;

    if (evidence) {
      const code = evidence.code ?? null;
      if (prev.state !== evidence.state || prev.fragment !== evidence.fragment ||
          (prev.code ?? null) !== code) {
        changed = true;
        // A screening outage and its recovery are exactly what an admin
        // reconstructing "what happened on this machine" needs, and the
        // fragment is from our own closed set — never a string echoed from
        // upstream. Shape-only, like every other audited event.
        //
        // "Restored" is asserted ONLY on a real positive. Leaving an outage
        // for UNCONFIRMED is not a recovery — it is losing sight of the thing
        // that was broken — and an audit trail that records the second as the
        // first is the same lie as a green popup, written down for an
        // incident responder to read later.
        if (evidence.state === SCREENING.UNAVAILABLE) {
          appendAudit('screening-unavailable', { fragment: evidence.fragment });
        } else if (evidence.state === SCREENING.AVAILABLE && prev.state === SCREENING.UNAVAILABLE) {
          appendAudit('screening-restored', {});
        }
      } else if (evidence.at - (prev.at ?? 0) > SCREENING_WRITE_MIN_INTERVAL_MS) {
        changed = true;
      }
      next.state = evidence.state;
      next.fragment = evidence.fragment;
      next.code = code;
      next.at = evidence.at;
    }

    if (tally && (tally.uncheckedSends > 0 || tally.withheldItems > 0 || tally.redactedItems > 0)) {
      next.uncheckedSends = (prev.uncheckedSends ?? 0) + tally.uncheckedSends;
      next.withheldItems = (prev.withheldItems ?? 0) + tally.withheldItems;
      next.redactedItems = (prev.redactedItems ?? 0) + (tally.redactedItems ?? 0);
      if (tally.uncheckedSends > 0) next.lastUncheckedAt = evidence?.at ?? Date.now();
      changed = true;
    }

    if (!changed) return;
    await ext.storage.session.set({ [SCREENING_KEY]: next });
    await refreshBadgeFromEvidence(next);
  } catch {
    /* evidence-keeping must never be the thing that breaks a capture */
  }
}

// Re-derive the toolbar badge from evidence a capture just produced.
//
// The badge used to move only in `runCheck`, on the heartbeat — so a screener
// that died between beats left the toolbar clean for up to 30 s while every
// in-scope request on the page was already being refused. The evidence for
// that outage was in hand at the instant of the first failed send; nothing but
// the wiring made the user wait for a timer to see it. Same for the leak mark:
// a fail-open send that ships unexamined bytes is over by the time the next
// heartbeat runs.
//
// Deliberately does NOT re-run the health probe or rewrite the stored state.
// The held request is waiting on the capture reply this rides behind, so this
// path may cost nothing measurable; and the connection status it reads is the
// last one a real probe established, which is the only status anyone here is
// entitled to assert. `screeningFor` with no live signal falls through to
// exactly the evidence just written — see shared/screening.js.
async function refreshBadgeFromEvidence(evidence) {
  try {
    const state = await getState();
    const now = Date.now();
    await applyBadge(
      state.status,
      screeningFor(state.status, evidence, now),
      captureFailureToName(evidence, now)?.code ?? null
    );
  } catch {
    /* the badge is a hint; never let it break the capture path */
  }
}

// ── Audit log ───────────────────────────────────────────────────────
//
// Persists important events to storage.local as a 100-entry ring buffer for
// IT incident response. Each entry is shape-only — no request bodies, no PII.
//
// Audited events. The `kind` strings below are this extension's own storage
// vocabulary and are kept as they are; the descriptions say what each means:
//   daemon-down            — the host could no longer reach the desktop app
//   daemon-recovered       — the host reached the desktop app again
//   bridge-missing         — the native-messaging host is not registered
//   policy-loaded          — managed-storage values present at startup
//   csp-violation          — CSP violation on an extension page
//   screening-unavailable  — a capture proved nothing could screen
//   screening-restored     — a capture proved something could again
const AUDITED_KINDS = new Set([
  'daemon-down',
  'daemon-recovered',
  'bridge-missing',
  'policy-loaded',
  'csp-violation',
  'screening-unavailable',
  'screening-restored'
]);

async function appendAudit(kind, details = {}) {
  if (!AUDITED_KINDS.has(kind)) return;
  try {
    const got = await ext.storage.local.get(AUDIT_KEY);
    const log = Array.isArray(got?.[AUDIT_KEY]) ? got[AUDIT_KEY] : [];
    log.push({ ts: Date.now(), kind, details });
    if (log.length > AUDIT_MAX_ENTRIES) {
      log.splice(0, log.length - AUDIT_MAX_ENTRIES);
    }
    await ext.storage.local.set({ [AUDIT_KEY]: log });
  } catch {
    /* storage failure is non-fatal — never throw from audit path */
  }
}

// The toolbar badge, from the connection status AND the screening state.
//
// Connected shows no badge at all, which reads as "nothing to report". That is
// the right mark for a connected extension that is screening, and the wrong
// one for a connected extension whose screener is down — in that state every
// in-scope request is being held back and the toolbar is saying nothing about
// it, which is the same unearned reassurance the popup used to give. So a
// connected-but-not-screening extension gets the amber `!` that STATUS.NO_BRIDGE
// already uses for "up, but something needs you".
//
// UNCONFIRMED keeps the blank badge for the state it was named after — "no
// capture has proved anything yet", typically a fresh browser start. An absent
// mark is the absence of a claim, not a green one, and "we cannot tell yet"
// does not warrant pulling the user's eye to the toolbar on every startup.
//
// ONE EVENT INSIDE UNCONFIRMED IS MARKED, and the split is deliberate.
// `code: 'sent-unscreened'` is not "we cannot tell": it is a fact we know —
// under the user's own fail-open window a request went out carrying bytes
// nobody examined (shared/screening.js `shippedUnscreened`). Left blank, the
// one state where content provably left unprotected was the one state the
// toolbar said nothing about, while a screening outage — where nothing leaked,
// because everything was held back — wore the amber `!`. That ordering is
// backwards: the outage is the safe failure and the leak is the costly one.
//
// It is the SAME amber `!`, not a new glyph. The mark means "up, but something
// needs you" in both cases and the popup one click away carries the sentence
// that distinguishes them (`popup/copy.js` gives `sent-unscreened` its own
// line, saying plainly that the bytes left). A second glyph would ask the user
// to learn a legend to find out what the popup will tell them in words.
//
// It clears itself. `lastCaptureFailure` is null outside
// SCREENING_CONTRADICTION_WINDOW_MS and one clean receipt restores AVAILABLE,
// so this marks a recent event, never a standing penalty for a setting the
// user is entitled to have on.
async function applyBadge(status, screening = null, captureCode = null) {
  const base = BADGE[status] ?? BADGE[STATUS.UNKNOWN];
  const needsAttention = status === STATUS.CONNECTED &&
    (screening === SCREENING.UNAVAILABLE || captureCode === 'sent-unscreened');
  const { text, color } = needsAttention ? BADGE[STATUS.NO_BRIDGE] : base;
  try {
    await ext.action.setBadgeBackgroundColor({ color });
    await ext.action.setBadgeText({ text });
  } catch {
    /* action API occasionally unavailable during transitions */
  }
}

async function acquireLock() {
  const got = await ext.storage.session.get(IN_FLIGHT_KEY);
  const now = Date.now();
  const existing = got?.[IN_FLIGHT_KEY];
  if (existing && now - existing < 15_000) return false;
  await ext.storage.session.set({ [IN_FLIGHT_KEY]: now });
  return true;
}

async function releaseLock() {
  await ext.storage.session.remove(IN_FLIGHT_KEY);
}

async function runCheck(_reason = 'alarm') {
  if (!(await acquireLock())) return await getState();
  try {
    const settings = await getSettings();
    const prev = await getState();
    // Sent with the probe so the native host can write the extension's half
    // of the surface-override ack. It reports the
    // PREVIOUS round's applied set — the browser cannot confirm a set it has
    // not stored yet — so the ack trails the file by one heartbeat. That lag
    // is the honest content: it is the gap between written and enforced.
    const result = await checkHealth({ settings, applied: await reportedApplied() });

    const statusChanged = result.status !== prev.status;
    const isFailure = result.status === STATUS.DISCONNECTED || result.status === STATUS.NO_BRIDGE;
    const consecutiveFailures = isFailure ? (prev.consecutiveFailures ?? 0) + 1 : 0;

    if (statusChanged) {
      if (result.status === STATUS.DISCONNECTED) {
        appendAudit('daemon-down', { from: prev.status, error: result.error });
      } else if (result.status === STATUS.NO_BRIDGE) {
        appendAudit('bridge-missing', { from: prev.status, kind: result.noBridgeKind ?? null });
      } else if (result.status === STATUS.CONNECTED &&
                 (prev.status === STATUS.DISCONNECTED || prev.status === STATUS.NO_BRIDGE)) {
        appendAudit('daemon-recovered', { from: prev.status, latencyMs: result.latencyMs });
      }
    }

    // The host refused or is missing — ask the desktop app to fix the
    // registration. Fire-and-forget beside the health path, throttled
    // internally; see requestHostRegistration.
    if (result.status === STATUS.NO_BRIDGE) {
      void requestHostRegistration();
    }

    // The connection status says the desktop app is reachable. Whether
    // anything is SCREENING is a separate question with separate evidence, and
    // collapsing the two is how a popup ends up claiming protection that
    // isn't there.
    const screening = await getScreening();

    // The surfaces the user switched off in the desktop app. Stored, not held
    // in memory: this worker is evicted constantly, and content scripts read
    // the stored copy directly (content-script.js pushes it to the shim).
    // `null` means the host said nothing this round — an older host, or no
    // reply at all — and leaves the stored set exactly as it was.
    if (result.disabledWebHosts) {
      await storeDisabledWebHosts(result.disabledWebHosts);
    }

    const next = {
      status: result.status,
      httpStatus: result.httpStatus,
      body: result.body,
      latencyMs: result.latencyMs,
      lastCheck: result.timestamp,
      lastChange: statusChanged ? result.timestamp : prev.lastChange,
      error: result.error,
      consecutiveFailures,
      // `result.screening` is the host's own live probe answer for THIS check
      // (shared/health-client.js::screeningFromStatus) — 'unavailable', or
      // null. There is deliberately no positive: the probe establishes
      // reachability, not that anything behind it screens. So it can take the
      // answer DOWN instantly when screening dies, and never up; "Active" is
      // earned from capture receipts alone. See shared/screening.js.
      screening: screeningFor(result.status, screening, result.timestamp, result.screening),
      // The capture failure the popup is allowed to name, or null. Non-null
      // only while it is recent enough to be the same event the user is
      // looking at on the page. It reads the same stored evidence
      // `screeningFor` does, so it can never sit next to an "Active" row.
      lastCaptureFailure: captureFailureToName(screening, result.timestamp),
      uncheckedSends: screening.uncheckedSends ?? 0,
      withheldItems: screening.withheldItems ?? 0,
      redactedItems: screening.redactedItems ?? 0
    };

    await setState(next);
    await applyBadge(next.status, next.screening, next.lastCaptureFailure?.code ?? null);
    await scheduleNextAlarm(next);
    broadcast(next);
    return next;
  } catch {
    const prev = await getState();
    const next = {
      ...prev,
      status: STATUS.DISCONNECTED,
      error: 'worker-error',
      lastCheck: Date.now(),
      consecutiveFailures: (prev.consecutiveFailures ?? 0) + 1,
      // Disconnected means no path to the desktop app, so screening is certainly
      // unavailable — never carry a stale "available" through a failure.
      screening: SCREENING.UNAVAILABLE,
      lastCaptureFailure: null
    };
    await setState(next);
    await applyBadge(next.status, next.screening);
    broadcast(next);
    return next;
  } finally {
    await releaseLock();
  }
}

// The HEALTH alarm only. It backs off — deliberately: `checkHealth` is a
// native-messaging round trip that can launch a host process and probe the
// desktop app behind it, and a desktop app that is down should not be hammered with
// that every 30 s indefinitely. Nothing here touches PRESENCE_ALARM, and
// nothing here may: the whole defect this shape fixes was a cheap, always-true
// fact being rationed at the expensive question's rate.
async function scheduleNextAlarm(state) {
  const settings = await getSettings();
  const base = settings.heartbeatSeconds;
  const max = settings.backoffMaxSeconds;
  const fails = state.consecutiveFailures ?? 0;
  const seconds = fails <= 0
    ? base
    : Math.min(base * Math.pow(2, Math.min(fails, 8)), max);

  await ext.storage.session.set({ [BACKOFF_KEY]: seconds });
  await ext.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(seconds / 60, 0.5)
  });
}

// ── Desktop presence beacon ─────────────────────────────────────────
//
// Announces this extension to the Locke desktop app's loopback presence
// listener (PRESENCE_URL) so the app can show "extension connected" per
// browser. Fire-and-forget: never awaited by the health path, never affects
// badge/status logic, and every failure is swallowed — the desktop app not
// running is the normal case, so silence is correct. Payload is only
// { browser, version }; no page data ever rides this channel.
//
// WHAT THIS DOES AND DOES NOT CLAIM. It says one thing: this extension is
// installed and its worker is running. It is not evidence that anything was
// screened, that screening is reachable, or that the desktop app is
// connected — those have their own evidence (shared/screening.js) and their
// own surfaces, and none of them is derived from this. That is also why the
// beacon is deliberately absent from the capture path: tying it to real
// traffic would quietly turn "installed" into "screening", which is the
// conflation this codebase keeps having to unwind — and it would spend a
// held request's latency on bookkeeping.
function sendPresenceBeacon() {
  try {
    fetch(PRESENCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        browser: detectBrowser(navigator.userAgent, navigator),
        version: ext.runtime.getManifest().version
      })
    }).catch(() => {});
  } catch {
    /* fetch unavailable or throwing synchronously — presence is best-effort */
  }
}

// ── Native-host self-registration ───────────────────────────────────
//
// When the native host refuses us (NO_BRIDGE), ask the Locke desktop app to
// authorise this extension's id — the request that replaces "go run
// install.sh --extension-id" with one Allow click in the app. POSTs
// { id, browser, version } to REGISTRATION_URL on the same loopback origin
// as the presence beacon; the app takes the id primarily from the request's
// Origin header (browser-attested) and uses this body as the fallback and
// cross-check.
//
// Deliberately fired on EVERY no-bridge shape, not just "forbidden": the app,
// not the browser's unpinnable error wording, decides what a request means.
// An id that is already authorised (every store install) answers `approved`
// with no UI at all; `not-found` with the app running means registration is
// missing or damaged, and this request is exactly the repair channel.
//
// Chromium-only by construction: a Firefox id is `desktop-connector@
// sonomos.ai`, fixed in the manifest and never path-derived, so there is
// nothing to register — the id-shape gate below keeps Firefox from ever
// POSTing. Same fire-and-forget discipline as the beacon: never awaited by
// the health path, every failure swallowed (the app not running is normal).
//
// The one thing it does on success: an `approved` reply re-arms the health
// alarm at its floor, so recovery costs one heartbeat instead of waiting out
// a 300 s backoff that was earned while the host was refusing us.
async function requestHostRegistration() {
  try {
    const id = ext.runtime.id;
    if (!/^[a-p]{32}$/.test(id)) return;

    const now = Date.now();
    const stored = await ext.storage.session.get(REGISTRATION_ATTEMPT_KEY);
    const last = stored?.[REGISTRATION_ATTEMPT_KEY] ?? 0;
    if (now - last < REGISTRATION_MIN_INTERVAL_MS) return;
    await ext.storage.session.set({ [REGISTRATION_ATTEMPT_KEY]: now });

    const response = await fetch(REGISTRATION_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        browser: detectBrowser(navigator.userAgent, navigator),
        version: ext.runtime.getManifest().version
      })
    });

    let status = null;
    try {
      status = (await response.json())?.status ?? null;
    } catch {
      /* non-JSON reply (old app: a 404) — nothing to act on */
    }
    if (status === 'approved') {
      // The manifest just gained (or already had) this id — probe at the
      // floor instead of the current backoff. runCheck's own
      // scheduleNextAlarm takes over from the next beat.
      await ext.alarms.create(ALARM_NAME, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    }
  } catch {
    /* app not running, fetch unavailable, storage failure — all normal */
  }
}

// Arm the presence tick if it is not already armed.
//
// IDEMPOTENT ON PURPOSE. `alarms.create` REPLACES an alarm of the same name
// and restarts its countdown, so an unconditional create on a worker that
// wakes often would keep pushing the tick into the future and starve the very
// signal it exists to produce. Asking first is what makes it safe to call
// this from the module's top level, which is where it earns its keep: the MV3
// worker re-evaluates on every wake, so any wake at all — a capture, a health
// beat, a popup — re-arms a presence alarm lost to an update or a crash.
//
// It never runs the health probe and never reads the connection state; there
// is no state in which the extension declines to say it is installed.
async function ensurePresenceAlarm() {
  try {
    if (await ext.alarms.get(PRESENCE_ALARM)) return false;
  } catch {
    // A browser that cannot be asked what is armed gets the create anyway.
    // Re-creating costs one restarted countdown; not creating costs presence.
  }
  try {
    await ext.alarms.create(PRESENCE_ALARM, { periodInMinutes: PRESENCE_INTERVAL_SECONDS / 60 });
    return true;
  } catch {
    return false;
  }
}

function broadcast(state) {
  try {
    ext.runtime.sendMessage({ type: MSG.STATE_UPDATE, state }).catch(() => {});
  } catch {
    /* no listeners — fine */
  }
}

function isTrustedSender(sender) {
  return sender && sender.id === ext.runtime.id;
}

function sendNativeMessagePromise(payload) {
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = ext.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
        const err = ext.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(response);
      });
      // Firefox returns a Promise and ignores the callback.
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

// ── Capture relay ───────────────────────────────────────────────────
//
// One held AI request from a content script — the shim's synthesized raw HTTP
// request, base64 — goes through the native messaging host to the Locke
// desktop app, which returns a Receipt carrying the verdict:
// { decision, reason, redactedCount, requestB64? } where `requestB64`
// (redact only) is the whole rebuilt request. We hand that straight back to
// the content script, which relays it to the shim to enforce. The raw request
// and the rebuilt one (both sensitive) cross native messaging to the same-user
// host; we never log them here — only the receipt metadata.

// Diagnostics for the relay hop, in the same `[sonomos] reason=…` logfmt the
// shim uses so both halves of the chain grep alike. Shape-only: how many bytes
// of base64 crossed, how long it took, which decision came back — never the
// payload. Warnings are unconditional (a failed relay is always a blocked
// send); the healthy line is debug and gated behind the debugLogging setting.
function relayWarn(reason, fields) {
  try { console.warn(`[sonomos] reason=${reason} via=service-worker${logfmt(fields)}`); } catch { /* no console */ }
}

function relayDebug(reason, fields) {
  if (!debugLogging) return;
  try { console.debug(`[sonomos] reason=${reason} via=service-worker${logfmt(fields)}`); } catch { /* no console */ }
}

function logfmt(fields) {
  let out = '';
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    const s = String(value);
    out += ` ${key}=${/[\s"=]/.test(s) ? JSON.stringify(s) : s}`;
  }
  return out;
}

// Error text from the native-messaging layer names hosts and shapes, never
// request content — but clip it anyway so nothing upstream can turn one line
// into a dump.
function clip(s, max = 120) {
  if (typeof s !== 'string') return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Cached so the capture path never blocks on a storage read. Only the debug
// lines consult it; warnings are always emitted.
let debugLogging = DEFAULTS.debugLogging;

async function refreshDebugFlag() {
  try {
    const settings = await getSettings();
    debugLogging = settings.debugLogging === true;
  } catch { /* keep the last known value */ }
}

// `provider` is the catalog id the shim attributed this capture to, relayed
// verbatim — this worker holds no catalog of its own and must not coin one.
// Omitted from the frame entirely when there is none, so an unattributed
// capture is byte-identical to the frame older builds sent.
async function captureViaHost(requestB64, provider) {
  const startedAt = Date.now();
  // Base64 length, not the payload: enough to tell "a 4 MB upload timed out"
  // from "a 2 KB prompt was rejected".
  const b64Bytes = requestB64.length;
  try {
    const response = await sendNativeMessagePromise({
      type: BRIDGE_MSG.CAPTURE,
      requestB64,
      ...(provider ? { provider } : {})
    });
    const ms = Date.now() - startedAt;
    if (!response || typeof response !== 'object') {
      relayWarn('bridge-empty', { ms, b64Bytes });
      // Every failure below blocks a real request in the page, so each one is
      // recorded. It proves nothing about the screener — hence UNCONFIRMED, not
      // UNAVAILABLE — but it does prove the popup may not go on claiming a
      // screen it cannot see happening. shared/screening.js draws that line.
      noteScreening(evidenceFromRelayFailure('bridge-empty'), null);
      return { ok: false, code: 'bridge-empty' };
    }
    if (response.type === 'receipt') {
      const receipt = response.receipt ?? null;
      relayDebug('receipt', {
        ms,
        b64Bytes,
        decision: clip(receipt?.decision) ?? 'missing',
        blockCause: clip(receipt?.blockCause) ?? 'missing',
        redactedCount: receipt?.redactedCount ?? null,
        rebuilt: typeof receipt?.requestB64 === 'string'
      });
      // Not awaited: the held request is waiting on this reply, and evidence
      // is never worth a millisecond of a user's send.
      noteScreening(evidenceFromReceipt(receipt), tallyFromReceipt(receipt));
      return { ok: true, receipt };
    }
    if (response.type === 'error') {
      relayWarn('bridge-error', {
        ms,
        b64Bytes,
        code: clip(response.code) || 'bridge-error',
        detail: clip(response.message)
      });
      noteScreening(evidenceFromRelayFailure(response.code), null);
      return { ok: false, code: response.code || 'bridge-error', message: response.message || '' };
    }
    relayWarn('bridge-unknown-response', { ms, b64Bytes, responseType: clip(String(response.type)) });
    noteScreening(evidenceFromRelayFailure('bridge-unknown-response'), null);
    return { ok: false, code: 'bridge-unknown-response' };
  } catch (e) {
    const ms = Date.now() - startedAt;
    // This is `runtime.lastError.message` — see sendNativeMessagePromise.
    const detail = e?.message || String(e);
    // The SAME classifier the health check uses, deliberately, instead of the
    // second copy of the pattern list that used to live here. The copies had
    // already drifted: this one tested `native host exited` while Chrome's
    // actual string is "Native host has exited.", so a crashed host was
    // reported to the page as "the desktop app could not be reached. Start
    // it" while the popup — running the other list — was correctly saying the
    // connector had not started. Two surfaces, two stories, one event, which
    // is the exact defect class this round of fixes exists to remove.
    if (classifyLastError(detail) === 'no-bridge') {
      relayWarn('no-bridge', { ms, b64Bytes, detail: clip(detail) });
      noteScreening(evidenceFromRelayFailure('no-bridge'), null);
      // A held request just hit the missing/refusing host — same repair
      // request the health path fires; the internal throttle makes this a
      // no-op when one went out recently.
      void requestHostRegistration();
      return { ok: false, code: 'no-bridge', message: e.message };
    }
    relayWarn('native-call-failed', { ms, b64Bytes, detail: clip(detail) });
    noteScreening(evidenceFromRelayFailure('bridge-error'), null);
    return { ok: false, code: 'bridge-error', message: detail };
  }
}

// Keep the cached verbosity flag in step with settings/policy changes, so
// flipping debugLogging takes effect without reloading the extension.
try {
  ext.storage.onChanged.addListener(() => { refreshDebugFlag(); });
} catch { /* storage events unavailable — the startup read still applies */ }
refreshDebugFlag();

// Re-arm the presence tick on every worker evaluation. Cheap (one
// `alarms.get`), silent, and the only thing standing between a presence alarm
// lost to an extension update and a desktop app that says "not installed"
// until the browser restarts.
ensurePresenceAlarm();

ext.runtime.onInstalled.addListener(async () => {
  await setState(initialState());
  await applyBadge(STATUS.UNKNOWN);
  await ext.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  await ensurePresenceAlarm();
  sendPresenceBeacon();
  runCheck('install');
});

ext.runtime.onStartup.addListener(async () => {
  await ext.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  await ensurePresenceAlarm();
  sendPresenceBeacon();
  runCheck('startup');
});

ext.alarms.onAlarm.addListener((alarm) => {
  // The presence tick. No health probe rides it: that is the entire point of
  // the split — a probe that keeps failing must not take the "I am installed"
  // answer down with it.
  if (alarm.name === PRESENCE_ALARM) {
    sendPresenceBeacon();
    return;
  }
  // The health beat, and only the health check. The beacon used to fire here
  // too; that is exactly what tied "I am installed" to the backoff below it,
  // so it is gone from this branch rather than kept as a redundant second
  // producer with a five-minute worst case. The top-level `ensurePresenceAlarm`
  // is the real safety net — this wake re-runs it.
  if (alarm.name === ALARM_NAME) {
    runCheck('alarm');
  }
});

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;
  // One held AI request (raw, base64) to relay to the desktop app.
  if (message?.type === MSG.CAPTURE && typeof message.requestB64 === 'string') {
    captureViaHost(
      message.requestB64,
      typeof message.provider === 'string' && message.provider ? message.provider : null
    )
      .then(sendResponse)
      .catch((e) => {
        relayWarn('capture-error', { detail: clip(e?.message) });
        noteScreening(evidenceFromRelayFailure('capture-error'), null);
        sendResponse({ ok: false, code: 'capture-error' });
      });
    return true;
  }
  if (message?.type === MSG.REQUEST_CHECK) {
    // The popup is open, so the worker is awake and the user is looking at
    // the connection right now — the cheapest possible moment to be seen by
    // a desktop app that may have started since the last tick. Fired ahead of
    // the probe and never awaited: presence does not wait on health, and a
    // beacon that fails changes nothing about the answer below.
    sendPresenceBeacon();
    runCheck('popup').then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.type === MSG.TELEMETRY && message.event) {
    handleTelemetry(message.event, sender);
    return false;
  }
  return false;
});

// Fire-and-forget diagnostic signals. Shape-only — bodies never appear here.
function handleTelemetry(event, sender) {
  try {
    const tabId = sender?.tab?.id ?? null;
    const url = sender?.tab?.url ? sender.tab.url.slice(0, 200) : null;
    console.debug('[Sonomos] telemetry', event.kind || '?', { tabId, url, event });
    if (event?.kind === 'csp-violation') {
      appendAudit('csp-violation', {
        directive: event.directive,
        blockedURI: event.blockedURI,
        documentURI: event.documentURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber
      });
    }
  } catch { /* never throw from telemetry path */ }
}
