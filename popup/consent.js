// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { ext } from '../shared/browser.js';
import { consentIsCurrent, onDataConsentChanged, readDataConsent, saveDataConsent, TECHNICAL_DATA } from '../shared/data-consent.js';

const allow = document.getElementById('allowConsent');
const pause = document.getElementById('pauseConsent');
const decline = document.getElementById('declineConsent');
const technical = document.getElementById('technicalConsent');
const status = document.getElementById('consentStatus');
const controls = [allow, pause, decline, technical];
let busy = false;
let current = null;
let refreshSequence = 0;
function lock(value) {
  if (value) refreshSequence++;
  busy = value;
  for (const control of controls) control.disabled = value;
  if (current?.unavailable) allow.disabled = true;
}

const PAUSED = 'Data sharing is paused. Requests Locke normally screens are held back. To browse without Locke, uninstall or disable it in your browser’s extension settings, then reload affected tabs.';
async function refresh() {
  const sequence = ++refreshSequence;
  let consent;
  do {
    consent = await readDataConsent();
    // An older read must never repaint a newer operation or refresh.
    if (sequence !== refreshSequence) return;
    // A storage write can resolve before its change event is delivered. The
    // transfer boundary correctly fails closed when that event invalidates a
    // read; the UI must instead re-read before claiming the save failed or
    // showing unchecked controls for a choice that was actually committed.
  } while (!consentIsCurrent(consent));
  current = consent;
  technical.checked = consent.technical;
  allow.textContent = consent.granted ? 'Save choices' : 'Allow local screening';
  if (!busy) {
    lock(false);
    allow.disabled = consent.unavailable === true;
    status.textContent = consent.unavailable ? 'Locke could not read your saved choice. Reopen this page or disable Locke in your browser’s extension settings.' : consent.granted ? 'Local screening is enabled. You can change these choices at any time.' : PAUSED;
  }
}

allow.addEventListener('click', async () => {
  if (busy || !current) return;
  // permissions.request MUST run directly in this user event, before awaiting
  // storage or other browser APIs. Refusal of the optional permission never
  // prevents enabling core screening.
  lock(true);
  try {
    const optional = current.builtin && technical.checked
      ? ext.permissions.request({ data_collection: [TECHNICAL_DATA] })
      : Promise.resolve(technical.checked);
    const permitted = await optional;
    await saveDataConsent(true, permitted);
    if (current.builtin && !permitted) await ext.permissions.remove({ data_collection: [TECHNICAL_DATA] });
    await refresh();
    if (!current.granted) throw new Error('consent-not-confirmed');
    status.textContent = 'Local screening is enabled. You can close this page. Retry held requests. If the extension was just updated, reload affected tabs first.';
  } catch {
    status.textContent = 'Locke could not save your choice. Reopen Data sharing and try again; do not assume screening is enabled.';
  } finally { lock(false); }
});

async function stopSharing() {
  // Revoke locally BEFORE any optional browser prompt or uninstall operation.
  // Even a cancelled uninstall leaves the native boundary shut.
  await saveDataConsent(false);
  if (current?.builtin) await ext.permissions.remove({ data_collection: [TECHNICAL_DATA] });
  await refresh();
}
pause.addEventListener('click', async () => {
  if (busy) return;
  lock(true);
  try { await stopSharing(); status.textContent = PAUSED; }
  catch { status.textContent = 'Locke could not save the pause. Disable Locke in your browser’s extension settings and reload affected tabs to stop using it.'; }
  finally { lock(false); }
});
decline.addEventListener('click', async () => {
  if (busy) return;
  lock(true);
  try {
    await stopSharing();
    status.textContent = PAUSED;
    // uninstallSelf does not require the broad management permission.
    await ext.management.uninstallSelf({ showConfirmDialog: true });
  } catch {
    status.textContent = 'The uninstall was cancelled or Locke could not uninstall itself. Disable or remove Locke in your browser’s extension settings, then reload affected tabs. Check Data sharing before assuming your choice was saved.';
  } finally { lock(false); }
});
onDataConsentChanged(() => { if (!busy) void refresh(); });
void refresh();
