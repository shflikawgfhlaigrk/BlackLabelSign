import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveHarness, sandboxFetch } from './worker-harness.mjs';

test('private fixture certificate validates localhost and both loopback IP SANs', () => {
  const certificate = new X509Certificate(readFileSync(new URL('../fixtures/localhost-TEST-ONLY.crt', import.meta.url)));
  assert.equal(certificate.checkHost('localhost'), 'localhost');
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(certificate.checkIP('::1'), '::1');
  assert.equal(certificate.checkHost('localhost.attacker.example'), undefined);
  assert.equal(certificate.checkIP('192.0.2.1'), undefined);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.ok(Date.parse(certificate.validFrom) <= Date.now());
  assert.ok(Date.parse(certificate.validTo) > Date.now());
});

test('sandbox HTTPS uses explicit fixture trust and normal hostname/IP validation', async t => {
  const harness = await serveHarness(); t.after(() => harness.close());
  for (const origin of [harness.origin, harness.origin.replace('localhost', '127.0.0.1')]) {
    const response = await sandboxFetch({ origin }, '/me');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /My envelopes/);
  }
  const response = await sandboxFetch(harness, '/me?return=%2Fe%2F' + 'a'.repeat(32));
  assert.equal(response.status, 200);
});

test('sandbox HTTPS rejects an unknown localhost certificate before an HTTP request', async t => {
  // A separate ephemeral synthetic key ensures this is not the trusted fixture.
  // No key is printed, committed, registered or installed in system trust.
  const folder = mkdtempSync(join(tmpdir(), 'bl-sign-unknown-tls-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const key = join(folder, 'unknown-TEST-ONLY.key'), cert = join(folder, 'unknown-TEST-ONLY.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  let requests = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => { requests++; res.end('untrusted'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(sandboxFetch({ origin: `https://localhost:${server.address().port}` }, '/'), error =>
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code));
  assert.equal(requests, 0);
});

test('sandbox fetch rejects external, credentialed and malformed origins before networking', async () => {
  const origins = ['https://attacker.example:8443', 'https://localhost.attacker.example:8443',
    'https://localhost:8443@attacker.example:8443', 'https://user:pass@localhost:8443',
    'http://localhost:8443', 'https://localhost', 'https://localhost:8443/path',
    'https://localhost:8443?query=1', 'https://localhost:8443#fragment',
    'https://127.0.0.1.attacker.example:8443', 'https://[::ffff:127.0.0.1]:8443'];
  for (const origin of origins) await assert.rejects(sandboxFetch({ origin }, '/'), /sandboxFetch requires/);
});

test('sandbox fetch rejects absolute, authority, traversal and encoded-control paths before requests', async t => {
  let requests = 0;
  const harness = await serveHarness({ requestHook: () => { requests++; return null; } });
  t.after(() => harness.close());
  const paths = ['https://attacker.example/', harness.origin + '/me', '//attacker.example/',
    '/\\attacker.example/', '../me', '/../me', '/%2e%2e/me', '/%2f%2e%2e/me',
    '/me#fragment', '/me\nheader', '/me%0a', '/%zz', '/api/%5c'];
  for (const path of paths) await assert.rejects(sandboxFetch(harness, path), /sandboxFetch/);
  assert.equal(requests, 0);
});

test('sandbox fetch rejects a mismatched Host header before requests', async t => {
  let requests = 0;
  const harness = await serveHarness({ requestHook: () => { requests++; return null; } });
  t.after(() => harness.close());
  for (const host of ['attacker.example', 'localhost.attacker.example', 'user@localhost'])
    await assert.rejects(sandboxFetch(harness, '/me', { headers: { host } }), /different Host authority/);
  assert.equal(requests, 0);
  assert.equal((await sandboxFetch(harness, '/me', { headers: { host: new URL(harness.origin).host } })).status, 200);
});
