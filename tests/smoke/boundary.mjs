// Copyright © 2026 Sonomos, Inc. All rights reserved.
// Real-browser request-boundary proof: local origin, local upstream, isolated profile.

import { strict as assert } from 'node:assert';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALLOW = { ok: true, receipt: { decision: 'allow', redactedCount: 0 } };
const BLOCK = { ok: true, receipt: { decision: 'block', reason: 'boundary probe', blockCause: 'policy' } };
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(read, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(10);
  }
}

function splitCapture(message) {
  const raw = Buffer.from(message.requestB64, 'base64');
  const split = raw.indexOf('\r\n\r\n');
  assert.ok(split >= 0, 'captured request has a header/body split');
  return { head: raw.subarray(0, split).toString('utf8'), body: raw.subarray(split + 4) };
}

function contentType(head) {
  const match = /^content-type:\s*(.+)$/im.exec(head);
  return match ? match[1].trim() : null;
}

async function main() {
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch {
    throw new Error('Puppeteer is missing. Run: cd tests/smoke && npm install');
  }

  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if (request.url === '/' && request.method === 'GET') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.setHeader('set-cookie', 'boundary-cookie=approved; SameSite=Lax');
        response.end('<!doctype html><title>Locke boundary proof</title><main>local upstream</main>');
        return;
      }
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.setHeader('content-type', 'text/plain');
      response.end('ok');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'locke-boundary-'));
  let browser;

  try {
    browser = await puppeteer.launch({ browser: 'chrome', headless: true, userDataDir: profile });
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(String(error)));

    const pending = [];
    await page.exposeFunction('__lockeBoundaryCapture', message => (
      new Promise(resolve => pending.push({ message, resolve }))
    ));
    const shim = await readFile(new URL('../../content/shim.js', import.meta.url), 'utf8');
    const bootstrap = `
      globalThis.SONOMOS_WEB_HOSTS = ['127.0.0.1'];
      globalThis.SONOMOS_WEB_PROVIDERS = { '127.0.0.1': 'local-boundary' };
      globalThis.SONOMOS_CAPTURE_PATHS = {};
      globalThis.SONOMOS_SKIP_PATH_SEGMENTS = [];
      addEventListener('message', event => {
        if (event.source !== window || event.data?.type !== 'SONOMOS_CAPTURE') return;
        Promise.resolve(globalThis.__lockeBoundaryCapture(event.data)).then(verdict => {
          postMessage({ type: 'SONOMOS_VERDICT', callId: event.data.callId, verdict }, location.origin);
        });
      });
    `;
    await page.evaluateOnNewDocument(bootstrap + '\n' + shim + `
      postMessage({ type: 'SONOMOS_CONFIG', config: {} }, location.origin);
    `);
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.title(), 'Locke boundary proof');
    assert.equal(
      await page.evaluate(() => Function.prototype.toString.call(fetch).includes('[native code]')),
      false,
      'the shipped shim wrapped fetch in the real browser'
    );

    const nextCapture = (label) => waitFor(() => pending.shift(), label);
    const upstream = (path) => waitFor(() => received.find(item => item.url === path), `upstream ${path}`);

    await page.evaluate(() => {
      const body = new URLSearchParams({ prompt: 'approved' });
      const init = { method: 'POST', headers: { 'x-boundary': 'approved' }, body, credentials: 'include' };
      const target = { href: '/fetch-stable' };
      const input = { toString: () => target.href };
      globalThis.__fetchMutable = { body, init, target };
      globalThis.__fetchDone = fetch(input, init).then(response => response.text());
    });
    const fetchCapture = await nextCapture('mutable fetch capture');
    await page.evaluate(() => {
      __fetchMutable.body.set('prompt', 'unscreened');
      __fetchMutable.init.method = 'PUT';
      __fetchMutable.init.headers['x-boundary'] = 'changed';
      __fetchMutable.init.credentials = 'omit';
      __fetchMutable.target.href = '/fetch-unscreened';
    });
    fetchCapture.resolve(ALLOW);
    assert.equal(await page.evaluate(() => __fetchDone), 'ok');
    const fetchWire = await upstream('/fetch-stable');
    const fetchScreened = splitCapture(fetchCapture.message);
    assert.equal(fetchWire.method, 'POST');
    assert.equal(fetchWire.body.toString(), 'prompt=approved');
    assert.deepEqual(fetchWire.body, fetchScreened.body);
    assert.equal(fetchWire.headers['x-boundary'], 'approved');
    assert.match(fetchWire.headers.cookie || '', /boundary-cookie=approved/);
    assert.equal(received.some(item => item.url === '/fetch-unscreened'), false);

    await page.evaluate(() => {
      const form = new FormData();
      form.append('prompt', 'approved');
      form.append('file', new Blob([new Uint8Array([0, 255, 13, 10])]), 'boundary.bin');
      globalThis.__form = form;
      globalThis.__formDone = fetch('/form-stable', { method: 'POST', body: form }).then(r => r.text());
    });
    const formCapture = await nextCapture('FormData capture');
    await page.evaluate(() => __form.set('prompt', 'unscreened'));
    formCapture.resolve(ALLOW);
    assert.equal(await page.evaluate(() => __formDone), 'ok');
    const formWire = await upstream('/form-stable');
    const formScreened = splitCapture(formCapture.message);
    assert.deepEqual(formWire.body, formScreened.body);
    assert.equal(formWire.headers['content-type'], contentType(formScreened.head));
    assert.ok(formWire.body.includes(Buffer.from([0, 255, 13, 10])));

    await page.evaluate(() => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      globalThis.__bytes = bytes;
      globalThis.__bytesDone = fetch('/bytes-stable', { method: 'POST', body: bytes }).then(r => r.text());
    });
    const bytesCapture = await nextCapture('buffer capture');
    await page.evaluate(() => __bytes.fill(9));
    bytesCapture.resolve(ALLOW);
    assert.equal(await page.evaluate(() => __bytesDone), 'ok');
    const bytesWire = await upstream('/bytes-stable');
    assert.deepEqual(bytesWire.body, Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(bytesWire.body, splitCapture(bytesCapture.message).body);

    const requestWasConsumed = await page.evaluate(() => {
      const request = new Request('/request-stable', {
        method: 'POST',
        headers: { 'x-request': 'approved' },
        body: 'approved'
      });
      globalThis.__request = request;
      globalThis.__requestDone = fetch(request).then(r => r.text());
      return request.bodyUsed;
    });
    assert.equal(requestWasConsumed, true);
    const requestCapture = await nextCapture('Request capture');
    await page.evaluate(() => __request.headers.set('x-request', 'changed'));
    requestCapture.resolve(ALLOW);
    assert.equal(await page.evaluate(() => __requestDone), 'ok');
    const requestWire = await upstream('/request-stable');
    assert.equal(requestWire.headers['x-request'], 'approved');
    assert.equal(requestWire.body.toString(), 'approved');
    assert.deepEqual(requestWire.body, splitCapture(requestCapture.message).body);

    async function proveReopen(name, staleVerdict) {
      const oldPath = `/xhr-${name}-old`;
      const successorPath = `/xhr-${name}-successor`;
      await page.evaluate(({ oldPath }) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', oldPath);
        xhr.send('old');
        globalThis.__generationXhr = xhr;
      }, { oldPath });
      const oldCapture = await nextCapture(`${name} old capture`);
      await page.evaluate(({ successorPath }) => {
        __generationXhr.open('POST', successorPath);
        __generationXhr.send('new');
      }, { successorPath });
      const successorCapture = await nextCapture(`${name} successor capture`);
      oldCapture.resolve(staleVerdict);
      await wait(75);
      assert.equal(received.some(item => item.url === oldPath || item.url === successorPath), false);
      const untouched = await page.evaluate(() => ({
        blocked: __generationXhr.sonomosBlocked,
        reason: __generationXhr.sonomosBlockReason
      }));
      assert.equal(untouched.blocked, undefined);
      assert.equal(untouched.reason, undefined);
      successorCapture.resolve(ALLOW);
      const successor = await upstream(successorPath);
      assert.equal(successor.body.toString(), 'new');
      assert.equal(received.some(item => item.url === oldPath), false);
    }

    await proveReopen('stale-allow', ALLOW);
    await proveReopen('stale-block', BLOCK);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      const events = [];
      for (const type of ['readystatechange', 'abort', 'loadend']) {
        xhr.addEventListener(type, () => events.push(type));
      }
      xhr.open('POST', '/xhr-aborted');
      xhr.send('cancelled');
      globalThis.__abortedXhr = xhr;
      globalThis.__abortEvents = events;
    });
    const abortCapture = await nextCapture('aborted XHR capture');
    await page.evaluate(() => __abortedXhr.abort());
    abortCapture.resolve(ALLOW);
    await wait(75);
    assert.equal(received.some(item => item.url === '/xhr-aborted'), false);
    const aborted = await page.evaluate(() => ({
      events: __abortEvents,
      blocked: __abortedXhr.sonomosBlocked
    }));
    assert.deepEqual(aborted.events.slice(-3), ['readystatechange', 'abort', 'loadend']);
    assert.equal(aborted.blocked, undefined);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    console.log('PASS real Chromium/local-upstream boundary: 4 fetch snapshots, 2 XHR reopen generations, 1 held abort');
    console.log(`PASS isolated profile: ${profile}`);
    console.log(`PASS upstream requests observed: ${received.length}; stale/aborted requests observed: 0`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
