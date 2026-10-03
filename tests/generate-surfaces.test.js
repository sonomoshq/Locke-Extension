// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

import {
  capturePathsFor,
  explicitAllowlists,
  unscreenedWebHosts,
  webScreeningOf
} from '../scripts/lib/capture-paths.mjs';

// The reduction scripts/generate-surfaces.mjs performs on the vendored
// catalog to produce SONOMOS_CAPTURE_PATHS — pinned against the live catalog
// AND against synthetic ones, because the live file happens to exercise only
// some of the branches and a rule that only holds for today's data is not a
// rule.
//
// The bug these exist for: the `search` entry has said `web_screening: "none"`
// since 2026-08-18 and the generator never read it, so the shim held every
// bodied request on www.google.com — and BLOCKED them all whenever the desktop
// app was not running. tests/honest-capture-paths.test.js checks the generated
// file against this reduction; this file checks the reduction itself.

const surfaces = JSON.parse(
  await readFile(new URL('../shared/ai-surfaces.json', import.meta.url), 'utf8')
);

const byId = Object.fromEntries(surfaces.providers.map((p) => [p.id, p]));

// ── against the live catalog ──────────────────────────────────────────────

test('generator: every web_screening:none host is narrowed to nothing or kept for a stated reason', () => {
  const none = surfaces.providers.filter((p) => webScreeningOf(p) === 'none');
  assert.ok(none.length > 0, 'the catalog is expected to declare at least the `search` entry unscreened');

  const { narrowed, kept } = unscreenedWebHosts(surfaces);
  const table = capturePathsFor(surfaces);
  for (const p of none) {
    for (const host of p.web_hosts.map((h) => h.toLowerCase())) {
      const k = kept.find((x) => x.host === host);
      if (k) {
        assert.ok(!narrowed.includes(host), `${host} cannot be both kept and narrowed`);
        assert.ok(['explicit', 'shadows'].includes(k.reason), `${host}: unknown keep reason ${k.reason}`);
        if (k.reason === 'shadows') assert.equal(table[host], undefined, `${host} must stay capture-everything`);
        if (k.reason === 'explicit') assert.ok(table[host].length > 0, `${host} keeps its explicit list`);
      } else {
        assert.ok(narrowed.includes(host), `${host} is declared unscreened and must be narrowed to nothing`);
        assert.deepEqual(table[host], [], `${host} gets an EMPTY allow-list`);
      }
    }
  }
});

test('generator: the search hosts users actually hit are narrowed to nothing', () => {
  // The specific outage: Google Maps / Flights / account XHR POSTs blocked
  // with the desktop app absent. Spelled out rather than derived, so a catalog
  // edit that quietly moved www.google.com out of `none` fails here by name.
  const table = capturePathsFor(surfaces);
  for (const host of ['www.google.com', 'www.bing.com', 'search.brave.com', 'you.com', 'duckduckgo.com']) {
    assert.deepEqual(table[host], [], `${host} must be narrowed to nothing`);
  }
});

test('generator: kagi.com is NOT narrowed, because assistant.kagi.com sits under it', () => {
  // The shim's allow-list lookup is longest-suffix: assistant.kagi.com has no
  // entry of its own, so an empty list on kagi.com would be the list it
  // inherited — and Kagi Assistant is a bodied chat the catalog says is
  // screened (sonomos-vocab `the_chat_surfaces_split_out_of_the_search_entry_are_screened`).
  assert.equal((byId.kagi?.web_hosts ?? []).some((host) => host === 'assistant.kagi.com'), true, 'premise: the catalog still files Kagi Assistant there');
  const table = capturePathsFor(surfaces);
  assert.equal(table['kagi.com'], undefined, 'kagi.com keeps capture-everything');
  const { kept } = unscreenedWebHosts(surfaces);
  assert.deepEqual(
    kept.find((k) => k.host === 'kagi.com'),
    { host: 'kagi.com', provider: 'search', reason: 'shadows', screened: 'assistant.kagi.com' }
  );
});

test('generator: screened providers\' explicit allow-lists come through unchanged', () => {
  const table = capturePathsFor(surfaces);
  const explicit = explicitAllowlists(surfaces);
  assert.ok(Object.keys(explicit).length >= 3, 'chatgpt.com, claude.ai and www.perplexity.ai declare lists today');
  for (const [host, paths] of Object.entries(explicit)) {
    assert.deepEqual(table[host], paths, `${host}'s allow-list must be emitted verbatim`);
    assert.ok(paths.length > 0);
  }
});

test('generator: a body-screened host with no allow-list gets no entry at all', () => {
  // Absence is capture-everything in the shim, and must stay absent — an
  // empty list there would be the opposite of what "not narrowed" means.
  const table = capturePathsFor(surfaces);
  const explicit = explicitAllowlists(surfaces);
  for (const p of surfaces.providers) {
    if (webScreeningOf(p) !== 'body') continue;
    for (const host of (p.web_hosts || []).map((h) => h.toLowerCase())) {
      if (explicit[host]) continue;
      assert.equal(table[host], undefined, `${host} is body-screened and unnarrowed — it must have no entry`);
    }
  }
});

test('generator: the table is sorted by host, so the generated file is stable', () => {
  const keys = Object.keys(capturePathsFor(surfaces));
  assert.deepEqual(keys, [...keys].sort());
});

// ── against synthetic catalogs ────────────────────────────────────────────

const catalog = (...providers) => ({ providers });

test('generator: an absent web_screening means body — nothing is narrowed', () => {
  const table = capturePathsFor(catalog({ id: 'a', web_hosts: ['chat.example.com'] }));
  assert.deepEqual(table, {});
});

test('generator: an unrecognised web_screening stops the build rather than guessing', () => {
  assert.throws(
    () => capturePathsFor(catalog({ id: 'a', web_hosts: ['x.example.com'], web_screening: 'partly' })),
    /provider "a" declares web_screening "partly"/
  );
  // The build-time guard, so a mode the catalog adds later cannot be read as
  // either "hold everything" or "hold nothing" by accident.
  assert.throws(() => webScreeningOf({ id: 'b', web_screening: null }), /web_screening null/);
});

test('generator: an explicit allow-list on an unscreened host wins over the empty list', () => {
  // This is how the catalog can say "duckduckgo.com's own pages screen one
  // path and nothing else": the explicit list is the more specific statement.
  const table = capturePathsFor(catalog(
    { id: 'search', web_hosts: ['duckduckgo.com', 'www.google.com'], web_screening: 'none' },
    {
      id: 'duckduckgo', web_hosts: ['duck.ai'],
      capture_path_allowlist: { hosts: { 'duckduckgo.com': ['/duckchat/v1/chat'] } }
    }
  ));
  assert.deepEqual(table, { 'duckduckgo.com': ['/duckchat/v1/chat'], 'www.google.com': [] });
  const { kept } = unscreenedWebHosts(catalog(
    { id: 'search', web_hosts: ['duckduckgo.com'], web_screening: 'none' },
    { id: 'duckduckgo', capture_path_allowlist: { hosts: { 'duckduckgo.com': ['/duckchat/v1/chat'] } } }
  ));
  assert.deepEqual(kept, [{ host: 'duckduckgo.com', provider: 'search', reason: 'explicit' }]);
});

test('generator: an empty explicit list reads as absent, exactly as before', () => {
  // A half-written entry on a SCREENED host must not switch screening off;
  // the same half-written entry on an unscreened host does not stop the
  // mode-derived narrowing either.
  const table = capturePathsFor(catalog(
    { id: 'a', web_hosts: ['chat.example.com'], capture_path_allowlist: { hosts: { 'chat.example.com': [] } } },
    { id: 'search', web_hosts: ['www.example.com'], web_screening: 'none',
      capture_path_allowlist: { hosts: { 'www.example.com': [] } } }
  ));
  assert.deepEqual(table, { 'www.example.com': [] });
});

test('generator: an apex is kept when a screened subdomain would inherit its empty list', () => {
  // Order-independent: the broad entry first, then the specific one, and the
  // other way round, must agree.
  const broad = { id: 'search', web_hosts: ['kagi.example'], web_screening: 'none' };
  const specific = { id: 'kagi', web_hosts: ['assistant.kagi.example'] };
  for (const providers of [[broad, specific], [specific, broad]]) {
    const table = capturePathsFor(catalog(...providers));
    assert.deepEqual(table, {}, 'kagi.example must have no entry');
    assert.deepEqual(unscreenedWebHosts(catalog(...providers)).kept, [
      { host: 'kagi.example', provider: 'search', reason: 'shadows', screened: 'assistant.kagi.example' }
    ]);
  }
});

test('generator: the apex IS narrowed once the screened subdomain has a list of its own', () => {
  // The catalog's way of lifting the keep above: give the screened subdomain
  // an allow-list, and longest-suffix lookup lands there, not on the apex.
  const table = capturePathsFor(catalog(
    { id: 'search', web_hosts: ['kagi.example'], web_screening: 'none' },
    {
      id: 'kagi', web_hosts: ['assistant.kagi.example'],
      capture_path_allowlist: { hosts: { 'assistant.kagi.example': ['/assistant/prompt'] } }
    }
  ));
  assert.deepEqual(table, {
    'assistant.kagi.example': ['/assistant/prompt'],
    'kagi.example': []
  });
});

test('generator: a screened host that is NOT under the unscreened one does not keep it', () => {
  // duck.ai is not a subdomain of duckduckgo.com. The shim handles that
  // cross-host case at request time (the empty list counts only on the
  // unscreened surface's own pages); the generator must still narrow.
  const table = capturePathsFor(catalog(
    { id: 'search', web_hosts: ['duckduckgo.com'], web_screening: 'none' },
    { id: 'duckduckgo', web_hosts: ['duck.ai'] }
  ));
  assert.deepEqual(table, { 'duckduckgo.com': [] });
});

test('generator: hosts are lower-cased and trailing dots stripped, like every other host rule', () => {
  const table = capturePathsFor(catalog({ id: 'search', web_hosts: ['WWW.Google.com.'], web_screening: 'none' }));
  assert.deepEqual(table, { 'www.google.com': [] });
});
