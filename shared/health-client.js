// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { nativeRequest } from './native-client.js';
import { BRIDGE_MSG, DEFAULTS, MAX_DISABLED_WEB_HOSTS, SCREENING, STATUS } from './constants.js';

// Health is "can the native host reach the Locke desktop app?" The host
// answers a `status` message with `{ type:'status', connected: bool,
// screening }` after running a live reachability probe. There is no HTTP
// daemon and no readiness/warming states — the connection either clears or it
// doesn't.
//
// `connected` and `screening` answer two different questions and must stay
// apart here exactly as they do on the wire: `connected` is "is the Locke
// desktop app reachable"; `screening` is what the host's live probe can
// honestly say — 'unavailable' or 'unknown', and deliberately no positive.
//
// Only 'unavailable' is definite, and the asymmetry is the point: the probe
// establishes reachability, which proves a negative outright and cannot prove
// that anything behind it can screen. 'unknown' — which now includes an app
// that just accepted the probe's connection — falls through to the extension's
// other evidence (shared/screening.js), where "Active" is earned by real
// capture receipts and by nothing else.

// Native-messaging errors that mean "this browser has no usable registration
// for us" — as opposed to "the host ran and something went wrong". They all
// resolve to STATUS.NO_BRIDGE, which is the one status the popup answers with
// an install instruction rather than "start the app" (popup/copy.js `viewFor`).
//
// `access to the specified native messaging host is forbidden` is Chrome's
// message when the manifest EXISTS but this extension's id is not in its
// `allowed_origins` — the shape a tester hits after loading an unpacked build
// against a manifest written for the store id. It is a registration problem in
// every respect except that the file is present, so it belongs here and not in
// the generic bridge-error bucket, where it read as an outage.
//
// NOTE: matched on Chrome's literal wording, which is not something this repo
// can pin by test — the strings are the browser's. Misclassifying only ever
// changes which sentence the popup shows, never whether anything is screened.
const NO_HOST_PATTERNS = [
  /specified native messaging host not found/i,
  /no such native application/i,
  // Both spellings seen in the wild: Chrome's "Native host has exited." and
  // the bare "Native host exited…". The optional middle is what the service
  // worker's now-deleted second copy of this list got wrong in one direction
  // and this one got wrong in the other.
  /native host (.* )?(exited|disconnected)/i,
  /failed to (connect|start) native/i
];

// The two shapes where the registration EXISTS but names someone else: this
// extension's id is not in `allowed_origins` (the unpacked-load case), or an
// enterprise policy blocks it. Split from NO_HOST_PATTERNS so the service
// worker can tell "nothing registered" from "registered, not for me" — both
// still resolve to the same NO_BRIDGE status (and the same self-registration
// request; the desktop app, not this wording, decides what happens next), but
// the distinction is recorded in the connection state as `noBridgeKind` for
// diagnostics and any copy that wants it.
const FORBIDDEN_PATTERNS = [
  /access to the specified native messaging host is forbidden/i,
  /forbidden because of the system policy/i
];

// 'forbidden' | 'not-found' | 'other'. Matched on the browser's literal
// wording, which this repo cannot pin by test — misclassifying between the
// first two only changes a diagnostic label, never whether anything is
// screened or whether registration is requested.
export function classifyLastErrorDetail(message) {
  if (!message) return 'other';
  for (const p of FORBIDDEN_PATTERNS) {
    if (p.test(message)) return 'forbidden';
  }
  for (const p of NO_HOST_PATTERNS) {
    if (p.test(message)) return 'not-found';
  }
  return 'other';
}

export function classifyLastError(message) {
  return classifyLastErrorDetail(message) === 'other' ? 'bridge-error' : 'no-bridge';
}

// Non-sensitive shape echoed into the connection state for the popup. The host
// status reply carries no daemon body anymore; keep the helper so the state
// shape stays stable and future host fields have a home.
export function sanitizeBody(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  if (typeof payload.message === 'string' && payload.message.length < 256) {
    out.message = payload.message;
  }
  return Object.keys(out).length ? out : null;
}

export function classify(payload) {
  if (!payload || typeof payload !== 'object') return STATUS.DISCONNECTED;
  if (payload.type === 'status') {
    return payload.connected === true ? STATUS.CONNECTED : STATUS.DISCONNECTED;
  }
  // The host replies `error` only for malformed requests — treat as down.
  return STATUS.DISCONNECTED;
}

// The host's own live probe evidence, or null when it asserts nothing.
//
// **'unavailable' is the only answer this returns.** Everything else — a
// missing field, 'unknown', a value from a future host this build doesn't
// recognise, and deliberately also a legacy 'available' — reads as "no live
// signal", and screeningFor (shared/screening.js) falls back to receipt
// evidence exactly as if no probe had been asked.
//
// The asymmetry is not caution, it is what the probe can actually establish.
// It measures reachability. That proves a negative outright (no path to the
// desktop app ⇒ nothing can be screened) and cannot prove the positive: the
// screener behind it can be down, crashed, or still starting up while the
// connection is accepted exactly as a healthy one would be — the routine state
// of the first minutes after the app launches.
//
// A current host no longer sends 'available' at all; it answers a reachable
// app with 'unknown'. The explicit demotion here is for
// the skew that outlives this change: the host is installed natively and the
// extension updates through a store, so an older host paired with this build
// would otherwise keep earning the green it was never entitled to. Reading it
// as no-signal costs a user with an old host nothing but a wait for their
// first real send, which is precisely when the claim becomes true.
export function screeningFromStatus(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'status') return null;
  return payload.screening === SCREENING.UNAVAILABLE ? SCREENING.UNAVAILABLE : null;
}

// The surfaces the user switched off in the desktop app, as this host read
// them out of ~/.sonomos/surfaces.local.json. Returns null — "the host said
// nothing about this" — rather than [] for a reply that omits the field, so an
// older host that predates it cannot read as "the user disabled nothing" and
// wipe a set that is still in force. Only an explicit array clears it.
//
// Present on connected AND disconnected status replies: whether the desktop
// app is reachable and which surfaces the user excluded are independent facts.
export function disabledWebHostsFromStatus(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'status') return null;
  if (!Array.isArray(payload.disabledWebHosts)) return null;
  return payload.disabledWebHosts
    .filter((host) => typeof host === 'string' && host.length > 0 && host.length <= 253)
    .slice(0, MAX_DISABLED_WEB_HOSTS)
    .map((host) => host.replace(/\.+$/, '').toLowerCase());
}

// `applied` is what the extension is currently enforcing, sent so the host can
// write the extension's half of the surface-override ack. Omitted entirely
// when we have nothing to report — the host then
// writes no ack, rather than one asserting an empty set is in force. An older
// host ignores the field.
export async function checkHealth({ settings, applied } = {}) {
  const timeoutMs = settings?.bridgeTimeoutMs ?? DEFAULTS.bridgeTimeoutMs;
  const start = performance.now();
  try {
    const request = { type: BRIDGE_MSG.STATUS };
    if (applied) request.applied = applied;
    const response = await nativeRequest(request, timeoutMs, 'bridge-timeout');
    return {
      status: classify(response),
      httpStatus: null,
      body: response?.type === 'status' ? sanitizeBody(response) : null,
      screening: screeningFromStatus(response),
      disabledWebHosts: disabledWebHostsFromStatus(response),
      latencyMs: Math.round(performance.now() - start),
      timestamp: Date.now(),
      error: response?.code === 'bridge-protocol-mismatch'
        ? 'bridge-protocol-mismatch'
        : response?.type === 'error' ? (response.code || 'bridge-error') : null
    };
  } catch (err) {
    const kind = err?.message === 'bridge-timeout' ? 'timeout' : classifyLastError(err?.message);
    const noBridge = kind === 'no-bridge';
    return {
      status: noBridge ? STATUS.NO_BRIDGE : STATUS.DISCONNECTED,
      // Which no-bridge shape: 'forbidden' (registered, not for this id) vs
      // 'not-found' (nothing registered). Diagnostic only — the service
      // worker's registration request fires on either.
      noBridgeKind: noBridge ? classifyLastErrorDetail(err?.message) : null,
      httpStatus: null,
      body: null,
      // No reply at all ⇒ no live probe evidence either — never guessed.
      screening: null,
      latencyMs: Math.round(performance.now() - start),
      timestamp: Date.now(),
      // No reply at all ⇒ nothing said about the user's surfaces either. The
      // stored set stands; see DISABLED_WEB_HOSTS_KEY for why a silent host
      // must not re-enable screening the user declined.
      disabledWebHosts: null,
      error: kind
    };
  }
}
