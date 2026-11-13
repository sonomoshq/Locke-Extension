// Copyright © 2026 Sonomos, Inc.
// All rights reserved.

// The landing page of a screened navigation (background/navigation-screen.js).
// The original URL rides in the fragment, which never leaves the browser. The
// service worker screens it and answers where to go; this page only follows.

import { ext } from '../shared/browser.js';
import { MSG } from '../shared/constants.js';

const status = document.getElementById('status');
// Not decoded: the fragment is the URL exactly as requested, query encoding
// and all.
const original = location.hash.slice(1);
// Keep the prompt out of this page's own history entry.
history.replaceState(null, '', location.pathname);

async function run() {
  if (!original) {
    status.textContent = 'Nothing to check.';
    return;
  }
  let reply = null;
  try {
    reply = await ext.runtime.sendMessage({ type: MSG.SCREEN_NAVIGATION, url: original });
  } catch {
    reply = null;
  }
  if (reply && typeof reply.go === 'string') {
    location.replace(reply.go);
    return;
  }
  if (reply && reply.block) {
    status.textContent = reply.block === 'decision-block'
      ? 'Locke blocked this search: it contains information your settings do not allow to be sent.'
      : 'Locke found personal information in this search but could not remove it, so it was not sent.';
    return;
  }
  // The service worker did not answer. Only it can let the URL past the
  // redirect rule, so going there would land right back here: say so instead.
  status.textContent = 'Locke could not check this search. Reload the page to try again.';
}

run();
