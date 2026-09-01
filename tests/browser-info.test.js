// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectBrowser } from '../shared/browser-info.js';

// Real-world UA strings (trimmed to the tokens that matter). The traps are
// the Chromium family: Edge, Opera, and Vivaldi all carry `Chrome/` in their
// UAs, and Brave ships a stock Chrome UA — only `navigator.brave` gives it
// away. detectBrowser must check the specific tokens before the generic one.

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
  vivaldi: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Vivaldi/6.8.3381.48',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
};

test('browser-info: plain Chrome UA → chrome', () => {
  assert.equal(detectBrowser(UA.chrome, {}), 'chrome');
});

test('browser-info: Edge UA contains Chrome/ but Edg/ wins', () => {
  assert.equal(detectBrowser(UA.edge, {}), 'edge');
});

test('browser-info: Firefox UA → firefox', () => {
  assert.equal(detectBrowser(UA.firefox, {}), 'firefox');
});

test('browser-info: Opera UA contains Chrome/ but OPR/ wins', () => {
  assert.equal(detectBrowser(UA.opera, {}), 'opera');
});

test('browser-info: Vivaldi UA contains Chrome/ but Vivaldi/ wins', () => {
  assert.equal(detectBrowser(UA.vivaldi, {}), 'vivaldi');
});

test('browser-info: Brave has a stock Chrome UA — navigator.brave decides', () => {
  assert.equal(detectBrowser(UA.chrome, { brave: {} }), 'brave');
  // Without the brave object the same UA is just Chrome.
  assert.equal(detectBrowser(UA.chrome, { brave: undefined }), 'chrome');
});

test('browser-info: unrecognised UA → other', () => {
  assert.equal(detectBrowser(UA.safari, {}), 'other');
  assert.equal(detectBrowser('', {}), 'other');
  assert.equal(detectBrowser(undefined, undefined), 'other');
});

test('browser-info: specific tokens beat navigator.brave', () => {
  // A brave-like nav object never overrides an explicit vendor token.
  assert.equal(detectBrowser(UA.firefox, { brave: {} }), 'firefox');
  assert.equal(detectBrowser(UA.edge, { brave: {} }), 'edge');
});
