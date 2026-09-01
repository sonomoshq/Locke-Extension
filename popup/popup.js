// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { ext } from '../shared/browser.js';
import { MSG, SCREENING_KEY, STATE_KEY, STATUS } from '../shared/constants.js';
import { copyFor } from './copy.js';

const el = {
  statusBadge: document.getElementById('statusBadge'),
  screeningValue: document.getElementById('screeningValue'),
  statusDetail: document.getElementById('statusDetail'),
  screeningNote: document.getElementById('screeningNote')
};

// All wording lives in copy.js, which is pure and pinned by test — the popup
// is the one place where a wrong sentence is itself the defect. Two rows,
// because the two facts are genuinely separate: whether the desktop app is
// reachable, and whether anything is actually screening.
function render(state) {
  const copy = copyFor(state);
  el.statusBadge.dataset.status = copy.view;
  el.statusBadge.textContent = copy.badge;
  el.screeningValue.dataset.screening = copy.screening;
  el.screeningValue.textContent = copy.screeningLabel;
  el.statusDetail.textContent = copy.detail;
  el.screeningNote.textContent = copy.note ?? '';
  el.screeningNote.hidden = copy.note === null;
}

async function loadInitialState() {
  const got = await ext.storage.session.get(STATE_KEY);
  return got?.[STATE_KEY] ?? null;
}

async function requestCheck() {
  try {
    const resp = await ext.runtime.sendMessage({ type: MSG.REQUEST_CHECK });
    if (resp?.state) render(resp.state);
  } catch {
    /* background may be restarting */
  }
}

// ── Wire up ────────────────────────────────────────────────────

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes[STATE_KEY]?.newValue) {
    render(changes[STATE_KEY].newValue);
    return;
  }
  // Capture evidence moved while this popup was open — a send just failed, or
  // just succeeded. The rendered state is derived from that evidence but is
  // not itself rewritten by the capture path (the held request is waiting on
  // that reply; evidence-keeping never gets a millisecond of it), so without
  // this the popup would go on showing the answer it computed when it opened
  // while the page behind it was being told something else. Re-derive instead
  // of guessing: `requestCheck` is the one path that runs the live probe and
  // the stored evidence through `screeningFor` together.
  if (changes[SCREENING_KEY]) requestCheck();
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE_UPDATE && message.state) {
    render(message.state);
  }
});

// Capture any CSP violations on extension pages and route them into the
// audit log. In practice the popup's CSP is strict enough that this should
// never fire — if it does, an auditor sees it in the background audit trail.
document.addEventListener('securitypolicyviolation', (e) => {
  try {
    ext.runtime.sendMessage({
      type: MSG.TELEMETRY,
      event: {
        kind: 'csp-violation',
        directive: e.violatedDirective,
        blockedURI: (e.blockedURI || '').slice(0, 200),
        documentURI: (e.documentURI || '').slice(0, 200),
        lineNumber: e.lineNumber,
        sourceFile: (e.sourceFile || '').slice(0, 200)
      }
    }).catch(() => { /* SW asleep */ });
  } catch { /* context invalidated */ }
});

(async () => {
  const initial = await loadInitialState();
  render(initial ?? { status: STATUS.UNKNOWN });
  requestCheck();
})();
