// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// content/content-script.js is the isolated-world half of the capture chain.
// It is three things, and all of them are boundaries:
//
//   1. the RELAY. The MAIN-world shim is holding the page's request while this
//      file talks to the service worker. Every way that call can fail must end
//      in a null verdict, because the shim reads null as "block". A branch that
//      answered nothing would leave the page hanging forever; one that answered
//      a truthy verdict on a failure would SEND an unscreened body.
//   2. the TRUST test. `event.source !== window` is what stops an embedded
//      frame posting captures in, or draining verdicts out.
//   3. the SETTINGS bridge. A MAIN-world script has no extension APIs, so the
//      shim's config is read here and posted across, admin policy winning.
//
// The dialect matters for all three. Firefox exposes BOTH `browser` (promises)
// and a Chrome-compat `chrome` whose `runtime.sendMessage` and promise-style
// `storage.*.get` return undefined. A relay that assumed a promise back from
// `chrome` never got one on Firefox, replied `null`, and the shim's fail-closed
// path blocked every in-scope AI request; a settings read through the same
// namespace silently yields defaults and drops the admin policy on the floor.
// Every case below therefore runs against both dialects, with Firefox's compat
// `chrome` present and useless — exactly as the browser presents it.
//
// It is a classic isolated-world script (no exports), so it is tested the way
// the browser runs it: the real source evaluated in a vm context standing in
// for the content-script world.

const CS_SRC = await readFile(new URL('../content/content-script.js', import.meta.url), 'utf8');

const VERDICT = { ok: true, receipt: { decision: 'allow', redactedCount: 0 } };
const PAYLOAD_B64 = Buffer.from('POST /x HTTP/1.1\r\n\r\nssn 123-45-6789').toString('base64');

const capture = (callId = 1) => ({ type: 'SONOMOS_CAPTURE', callId, requestB64: PAYLOAD_B64 });

// Let the relay's promise chain (and the config push) settle before asserting.
// A timer tick runs after every queued microtask, however long the chain.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Objects built inside the vm realm carry that realm's prototypes, so strict
// deep-equal never matches them. Compare structure, which is all that crosses
// postMessage anyway.
const plain = (v) => JSON.parse(JSON.stringify(v));

// `relay(message)` stands in for the service worker: return a promise, return
// something that is not thenable, or throw synchronously.
function makeWorld({ dialect = 'chromium', relay, local = {}, managed = null,
                    location = { origin: 'https://chat.openai.com', href: 'https://chat.openai.com/' },
                    documentOrigin = null } = {}) {
  const posted = [];       // everything the content script posted to the page
  const listeners = [];    // its window message listeners
  const relayed = [];      // everything it handed the service worker
  const logs = [];
  const answer = relay || (async () => VERDICT);

  const record = (level) => (...args) => { logs.push({ level, line: args.join(' ') }); };

  // The storage half, reached through whichever namespace the script picks.
  const storage = {
    local: { get: async () => local },
    // storage.managed throws when no policy is configured — the common case on
    // a personal install, and it must never change behaviour.
    managed: { get: async () => { if (managed === null) throw new Error('no managed schema'); return managed; } },
    onChanged: { addListener: () => {} }
  };

  // Chromium: callback-only messaging, failures surface through lastError, and
  // a torn-down context throws out of sendMessage itself.
  const chromeNs = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        relayed.push(message);
        const out = answer(message);   // may throw, as an invalidated context does
        Promise.resolve(out).then(
          (v) => { chromeNs.runtime.lastError = null; callback(v); },
          (e) => {
            chromeNs.runtime.lastError = { message: e?.message || String(e) };
            callback(undefined);
            chromeNs.runtime.lastError = null;
          }
        );
      }
    },
    storage
  };

  // Firefox: `browser` returns a promise and is strict about its signature —
  // the second parameter is the *options* object, so a callback passed there is
  // a type error, not a fallback.
  const browserNs = {
    runtime: {
      lastError: null,
      sendMessage(message, options) {
        if (options !== undefined) throw new TypeError('Incorrect argument types for runtime.sendMessage');
        relayed.push(message);
        return answer(message);
      }
    },
    storage
  };

  // Firefox's Chrome-compat namespace: present, and useless for both jobs.
  // Anything the script routes through here is a bug that reaches users.
  const geckoCompatChrome = {
    runtime: { lastError: null, sendMessage() { return undefined; } },
    storage: {
      local: { get: () => undefined },
      managed: { get: () => undefined },
      onChanged: { addListener: () => {} }
    }
  };

  const namespace = dialect === 'firefox'
    ? { browser: browserNs, chrome: geckoCompatChrome }
    : { chrome: chromeNs };

  // What the browser does with postMessage's second argument, which this
  // harness used to record and ignore. A targetOrigin that does not parse
  // THROWS (the string 'null', which is what `location.origin` reads in an
  // opaque-origin frame), and one that parses but names an origin the
  // receiving DOCUMENT does not have is silently dropped. Either way the shim
  // is left holding a request nobody will ever answer, so `posted` records
  // only what actually arrives.
  const docOrigin = documentOrigin ?? location.origin;
  const deliverable = (targetOrigin) => {
    if (targetOrigin === '*') return true;
    let named;
    try {
      named = new URL(String(targetOrigin)).origin;
    } catch {
      const err = new Error(`Failed to execute 'postMessage': Invalid target origin '${targetOrigin}'`);
      err.name = 'SyntaxError';
      throw err;
    }
    // An opaque document origin is same origin with nothing, itself included.
    return docOrigin !== 'null' && named === docOrigin;
  };

  const sandbox = {
    location,
    console: { log: record('log'), warn: record('warn'), debug: record('debug'), error: record('error') },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, targetOrigin) => {
      if (!deliverable(targetOrigin)) return;
      posted.push({ data, targetOrigin });
    },
    ...namespace
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const innerWindow = vm.runInContext('window', sandbox);
  vm.runInContext(CS_SRC, sandbox, { filename: 'content/content-script.js' });

  // Post a message INTO the isolated world the way the MAIN-world shim does.
  const fromPage = (data, source = innerWindow) => {
    for (const fn of listeners) fn({ source, data });
  };
  const verdicts = () => posted.filter((p) => p.data?.type === 'SONOMOS_VERDICT');
  const configs = () => posted.filter((p) => p.data?.type === 'SONOMOS_CONFIG');
  const warning = (reason) => logs.find((l) => l.line.includes(`reason=${reason}`));
  return { sandbox, posted, relayed, logs, fromPage, verdicts, configs, warning, innerWindow };
}

for (const dialect of ['chromium', 'firefox']) {
  // ── the relay ────────────────────────────────────────────────────

  test(`content-script (${dialect}): a valid capture is relayed once and its verdict returned under the same callId`, async () => {
    const world = makeWorld({ dialect });

    world.fromPage(capture(7));
    await settle();

    // Exactly once: a dialect probe that retried would relay the same held
    // request twice.
    assert.equal(world.relayed.length, 1);
    assert.deepEqual(plain(world.relayed[0]), { type: 'capture', requestB64: PAYLOAD_B64 });

    const answers = world.verdicts();
    assert.equal(answers.length, 1);
    assert.equal(answers[0].data.callId, 7, 'a verdict for the wrong call is a verdict for nobody');
    assert.equal(answers[0].data.verdict, VERDICT);
  });

  test(`content-script (${dialect}): a rejected relay answers null and names the hop`, async () => {
    // "Extension context invalidated" after a reload, or "Could not establish
    // connection" while the worker restarts. Both must block the send.
    const world = makeWorld({ dialect, relay: async () => { throw new Error('Could not establish connection'); } });

    world.fromPage(capture(3));
    await settle();

    const answers = world.verdicts();
    assert.equal(answers.length, 1, 'a held request must never be left without an answer');
    assert.equal(answers[0].data.verdict, null);
    assert.equal(answers[0].data.callId, 3);
    const warn = world.warning('relay-rejected');
    assert.ok(warn, 'the failing hop must name itself');
    assert.equal(warn.level, 'warn');
    assert.match(warn.line, /via=content-script action=block/);
  });

  test(`content-script (${dialect}): an undefined verdict is normalised to null, never to a send`, async () => {
    // The service worker answering with nothing must fail closed, not fall
    // through to the shim's "no verdict object" path with an undefined.
    const world = makeWorld({ dialect, relay: async () => undefined });

    world.fromPage(capture());
    await settle();

    assert.equal(world.verdicts()[0].data.verdict, null);
  });

  test(`content-script (${dialect}): no diagnostic ever carries the payload`, async () => {
    const world = makeWorld({ dialect, relay: async () => { throw new Error('boom'); } });

    world.fromPage(capture());
    await settle();

    const all = world.logs.map((l) => l.line).join('\n');
    assert.ok(all.length > 0, 'there must be something to check');
    assert.doesNotMatch(all, /123-45-6789/, 'the request body must never reach the console');
    assert.doesNotMatch(all, new RegExp(PAYLOAD_B64.slice(0, 16)), 'nor the base64 of it');
  });

  // ── settings → the page world ────────────────────────────────────

  test(`content-script (${dialect}): only the shim settings cross into the page world`, async () => {
    const world = makeWorld({
      dialect,
      local: {
        settings: {
          debugLogging: true,
          enforceTimeoutMs: 9000,
          // Nothing else about the user's configuration may cross the seam.
          lockedSettings: ['heartbeatSeconds'],
          allowedProviders: ['openai'],
          heartbeatSeconds: 30
        }
      }
    });
    await settle();

    const pushed = world.configs();
    assert.ok(pushed.length >= 1, 'the shim is pushed its config at document_start');
    assert.deepEqual(
      Object.keys(pushed[0].data.config).sort(),
      ['allowedProviders', 'debugLogging', 'enforceTimeoutMs'],
      'SHIM_SETTING_KEYS and nothing else — lockedSettings and heartbeatSeconds stay this side of the seam'
    );
    assert.equal(pushed[0].data.config.enforceTimeoutMs, 9000);
    // The policy is one of the three now, and it crosses with the value an
    // admin (or the user) actually set, not a placeholder.
    assert.deepEqual(pushed[0].data.config.allowedProviders, ['openai']);
  });

  test(`content-script (${dialect}): an admin policy beats the local value`, async () => {
    const world = makeWorld({
      dialect,
      local: { settings: { enforceTimeoutMs: 9000, debugLogging: true } },
      managed: { enforceTimeoutMs: 20000 }
    });
    await settle();

    const config = world.configs()[0].data.config;
    assert.equal(config.enforceTimeoutMs, 20000, 'DEFAULTS < local < managed');
    assert.equal(config.debugLogging, true, 'and a policy silent on a key leaves it alone');
  });

  test(`content-script (${dialect}): no policy configured is not a failure`, async () => {
    // storage.managed throws on an unmanaged profile. A policy lookup must never
    // be the thing that changes behaviour.
    const world = makeWorld({ dialect, local: {}, managed: null });
    await settle();

    const config = world.configs()[0].data.config;
    assert.equal(config.enforceTimeoutMs, 45000, 'the shim default holds');
    assert.equal(config.debugLogging, false);
  });
}

// ── the trust test ─────────────────────────────────────────────────

test('content-script: a message from anything but this window is ignored', async () => {
  const world = makeWorld();
  // An embedded frame posting into the top document. If this were relayed, a
  // frame we do not cover could push captures through our chain; if the
  // verdict came back, it could observe them.
  world.fromPage(capture(), { notThisWindow: true });
  await settle();

  assert.deepEqual(world.relayed, [], 'nothing may reach the service worker');
  assert.deepEqual(world.verdicts(), [], 'and nothing may be answered');
});

test('content-script: a malformed capture is ignored, not answered', async () => {
  const world = makeWorld();
  for (const bad of [
    null,
    { type: 'SOMETHING_ELSE', callId: 1, requestB64: 'x' },
    { type: 'SONOMOS_CAPTURE', callId: '1', requestB64: 'x' },   // callId must be a number
    { type: 'SONOMOS_CAPTURE', callId: 1 },                      // no payload
    { type: 'SONOMOS_CAPTURE', callId: 1, requestB64: 42 }
  ]) {
    world.fromPage(bad);
  }
  await settle();

  assert.deepEqual(world.relayed, []);
  assert.deepEqual(world.verdicts(), []);
});

test('content-script: the verdict and the config reach an opaque-origin frame', async () => {
  // Both posts used to name `location.origin`, which in an `about:blank`,
  // `about:srcdoc`, `data:` or sandboxed frame — every frame the manifest's
  // `match_about_blank` / `match_origin_as_fallback` keys opt us into — is the
  // string 'null': truthy, so the `|| '*'` fallback never fired, and not a
  // parseable URL, so postMessage threw. The verdict never left this world and
  // the shim blocked the page's request as `verdict-channel-failed`, telling
  // the user to reload a frame whose origin is opaque by construction.
  //
  // Naming no origin is the fix and it gives nothing away: the target is this
  // very window, the listener already rejects any `event.source` that is not
  // it, and targetOrigin filters by the receiving document's origin — never by
  // listener — so the page could read both posts whatever we passed.
  const world = makeWorld({
    location: { origin: 'null', href: 'about:srcdoc' },
    documentOrigin: 'null'
  });

  world.fromPage(capture());
  await settle();

  assert.equal(world.verdicts().length, 1, 'the held request gets its answer');
  assert.deepEqual(plain(world.verdicts()[0].data.verdict), VERDICT);
  assert.equal(world.configs().length, 1, 'and the shim still gets its settings');
});

// ── the two failures only the promise dialect can produce ──────────
//
// On Chromium the relay is callback-driven, so it always hands back a promise
// and both of these land in `relay-rejected` instead. On Firefox the namespace
// answers directly, and either way the send must still be blocked.

test('content-script (firefox): a relay that hands back no promise answers null', async () => {
  // MV3 and browser.* both document sendMessage as promise-returning. If it is
  // not, we treat the channel as unreachable rather than guessing what came
  // back — the trap the Chrome-compat namespace sets on Firefox.
  const world = makeWorld({ dialect: 'firefox', relay: () => ({ ok: true, receipt: { decision: 'allow' } }) });

  world.fromPage(capture());
  await settle();

  assert.equal(world.verdicts()[0].data.verdict, null,
    'a non-promise reply must not be mistaken for a verdict');
  assert.equal(world.warning('relay-no-promise')?.level, 'warn');
});

test('content-script (firefox): a relay that throws synchronously answers null', async () => {
  const world = makeWorld({ dialect: 'firefox', relay: () => { throw new Error('context invalidated'); } });

  world.fromPage(capture());
  await settle();

  assert.equal(world.verdicts()[0].data.verdict, null);
  assert.equal(world.warning('relay-threw')?.level, 'warn');
});

test('content-script (chromium): a sendMessage that throws is a rejected relay, not an unanswered one', async () => {
  // chrome.runtime.sendMessage throws outright on a torn-down context. The
  // callback never runs, so the wrapper's own try/catch is what keeps the held
  // request from hanging forever.
  const world = makeWorld({ dialect: 'chromium', relay: () => { throw new Error('Extension context invalidated'); } });

  world.fromPage(capture(9));
  await settle();

  const answers = world.verdicts();
  assert.equal(answers.length, 1);
  assert.equal(answers[0].data.verdict, null);
  assert.equal(answers[0].data.callId, 9);
  assert.ok(world.warning('relay-rejected'), 'the block must still name its hop');
});

// ── the desktop app's disable set ──────────────────────────────────
//
// Not a setting: the service worker writes it from the native host's status
// reply and nothing here may edit it, so it is read from storage.local
// directly rather than merged through the DEFAULTS < local < managed
// precedence the shim's own knobs use.

for (const dialect of ['chromium', 'firefox']) {
  test(`content-script (${dialect}): the stored disable set is pushed to the shim`, async () => {
    // Stored shape is `{ hosts, ignoredCount }` — the worker keeps the count
    // alongside for the ack; only the hosts reach the shim.
    const world = makeWorld({ dialect, local: { disabledWebHosts: { hosts: ['chatgpt.com', 'perplexity.ai'], ignoredCount: 1 } } });
    await settle();

    const config = world.configs().at(-1)?.data?.config;
    assert.deepEqual(plain(config?.disabledWebHosts), ['chatgpt.com', 'perplexity.ai']);
    assert.equal('ignoredCount' in plain(config), false, 'the ack count is not the shim\'s business');
  });

  test(`content-script (${dialect}): nothing stored pushes no key, rather than an empty set`, async () => {
    const world = makeWorld({ dialect, local: {} });
    await settle();

    const config = world.configs().at(-1)?.data?.config;
    assert.equal('disabledWebHosts' in plain(config), false,
      'an absent key leaves the shim on its applied set; an empty one would re-scope a disabled surface');
  });

  test(`content-script (${dialect}): an admin policy cannot forge a disable set`, async () => {
    // storage.managed drives the shim's knobs, but not this: it is the desktop
    // app's state, and a policy that could switch screening off for a host
    // would be an admin-writable hole in what the extension screens.
    const world = makeWorld({ dialect, local: {}, managed: { disabledWebHosts: { hosts: ['chatgpt.com'], ignoredCount: 0 } } });
    await settle();

    const config = world.configs().at(-1)?.data?.config;
    assert.equal('disabledWebHosts' in plain(config), false);
  });
}

// ── the captured surface's identity ─────────────────────────────────────
//
// The shim resolves the catalog id and this hop only carries it. Without it
// the desktop app cannot say WHERE PII was caught, and every browser capture
// renders as "unknown".

test('content-script: the shim\'s provider claim is relayed to the worker', async () => {
  const world = makeWorld({});

  world.fromPage({ ...capture(11), provider: 'google' });
  await settle();

  assert.equal(world.relayed.length, 1);
  assert.deepEqual(plain(world.relayed[0]), {
    type: 'capture',
    requestB64: PAYLOAD_B64,
    provider: 'google'
  });
});

// Omitted rather than nulled: an unattributed capture is the exact message
// this hop sent before the field existed.
test('content-script: a capture with no provider relays no provider key', async () => {
  const world = makeWorld({});

  world.fromPage(capture(12));
  await settle();

  assert.deepEqual(plain(world.relayed[0]), { type: 'capture', requestB64: PAYLOAD_B64 });
});

// A page can post anything into this listener. A non-string claim is dropped
// rather than forwarded — the shape that reaches the worker stays the shim's.
test('content-script: a malformed provider claim is dropped, not relayed', async () => {
  const world = makeWorld({});

  for (const junk of [{ evil: true }, 42, '', null]) {
    world.relayed.length = 0;
    world.fromPage({ ...capture(13), provider: junk });
    await settle();
    assert.deepEqual(
      plain(world.relayed[0]),
      { type: 'capture', requestB64: PAYLOAD_B64 },
      `provider ${JSON.stringify(junk)} must not reach the worker`
    );
  }
});
