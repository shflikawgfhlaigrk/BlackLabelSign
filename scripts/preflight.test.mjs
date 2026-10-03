import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assessPrivateConfig, summarizeCache, liveMetadata, codeFingerprints, matchesSignRoutePattern } from './preflight.mjs';

const template = JSON.parse(await readFile(new URL('../config/templates/wrangler.private.example.json', import.meta.url), 'utf8'));

test('private template admits only loopback and simulated data/mail', () => {
  assert.equal(assessPrivateConfig(template).state, 'LOCAL_ONLY');
  for (const change of [
    config => { config.routes = [{ pattern: 'sign.blacklabeltec.com', custom_domain: true }]; },
    config => { config.workers_dev = true; },
    config => { config.preview_urls = true; },
    config => { config.d1_databases[0].database_id = 'f173ebb5-55f4-459a-83e9-e4b8b52b6704'; },
    config => { config.r2_buckets[0].bucket_name = 'bl-sign-docs-day1-20260913'; },
    config => { config.send_email[0].remote = true; },
    config => { config.send_email[0].allowed_destination_addresses = ['unapproved@example.com']; },
    config => { config.vars.PUBLIC_ORIGIN = 'https://sign.blacklabeltec.com'; },
    config => { config.vars.PUBLIC_ORIGIN = 'http://127.0.0.1@unapproved.example'; },
    config => { config.dev.ip = '0.0.0.0'; },
    config => { config.triggers = { crons: ['* * * * *'] }; },
    config => { config.services = [{ binding: 'OTHER', service: 'production' }]; },
  ]) {
    const config = structuredClone(template);
    change(config);
    assert.equal(assessPrivateConfig(config).state, 'INVALID');
  }
});

test('unavailable or stale cache never establishes functional live state', () => {
  assert.equal(summarizeCache(null).state, 'UNKNOWN');
  const stale = summarizeCache({ stale: true, data: { workers: [{ id: 'bl-sign' }] } });
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.liveBindingAndSecretState, 'UNKNOWN');
  assert.equal(stale.wrapperPreservationRequired, true);
});

test('cached Sign route patterns require the exact hostname with supported schemes and path wildcards', () => {
  const accepted = ['sign.blacklabeltec.com', 'sign.blacklabeltec.com/*', 'sign.blacklabeltec.com/api/*',
    'sign.blacklabeltec.com/e/*', 'http://sign.blacklabeltec.com/*', 'https://sign.blacklabeltec.com/me',
    'https://SIGN.BLACKLABELTEC.COM/e/*'];
  const rejected = ['sign.blacklabeltec.com.attacker.example/*', 'sign.blacklabeltec.comevil/*',
    'sign.blacklabeltec.com@attacker.example/*', 'user:password@sign.blacklabeltec.com/*',
    'sub.sign.blacklabeltec.com/*', '*.sign.blacklabeltec.com/*', 'sign.blacklabeltec.com:443/*',
    'sign.blacklabeltec.com./*', 'ftp://sign.blacklabeltec.com/*', 'javascript:sign.blacklabeltec.com',
    '//sign.blacklabeltec.com/*', 'https:/sign.blacklabeltec.com/*', 'sign.blacklabeltec.com\\@attacker.example/*',
    'sign.blacklabeltec.com/*?other=1', 'sign.blacklabeltec.com/*#fragment', 'sign.blacklabeltec.com\n/*', '', null];
  for (const pattern of accepted) assert.equal(matchesSignRoutePattern(pattern), true, String(pattern));
  for (const pattern of rejected) assert.equal(matchesSignRoutePattern(pattern), false, String(pattern));
  const result = summarizeCache({ data: { routes: [
    ...accepted.map(pattern => ({ pattern, worker: 'bl-sign' })),
    ...rejected.map(pattern => ({ pattern, worker: 'counterfeit-route' })),
  ] } });
  assert.deepEqual(result.routeWorkers, ['bl-sign']);
});

test('missing explicit metadata credentials makes no network request', async () => {
  let calls = 0;
  const result = await liveMetadata({}, async () => { calls++; });
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(calls, 0);
});

test('metadata uses GET only and strips plaintext values, secret values and code', async () => {
  const secret = 'synthetic_sensitive_fixture_must_never_be_reported';
  const requests = [];
  const result = await liveMetadata({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: secret }, async (url, options) => {
    requests.push({ url, method: options.method });
    if (url.endsWith('/scripts/bl-sign')) return new Response(`export default { fixture: '${secret}' }`, { headers: { 'content-type': 'application/javascript' } });
    const response = url.endsWith('/settings')
      ? { compatibility_date: '2026-07-30', bindings: [{ name: 'SESSION_SECRET', type: 'secret_text', text: secret }, { name: 'DB', type: 'd1', id: 'fixture-id' }] }
      : url.endsWith('/secrets') ? [{ name: 'SESSION_SECRET', type: 'secret_text', value: secret }]
      : [{ id: 'deployment-fixture', created_on: '2026-10-03T00:00:00Z', versions: [{ version_id: 'version-fixture', percentage: 100 }], metadata: secret }];
    return new Response(JSON.stringify({ success: true, result: response }));
  });
  assert.equal(requests.length, 4);
  assert(requests.every(request => request.method === 'GET' && request.url.startsWith('https://api.cloudflare.com/client/v4/')));
  assert(!JSON.stringify(result).includes(secret));
  assert.deepEqual(result.secrets.names, ['SESSION_SECRET']);
  assert.equal(result.journey.state, 'UNKNOWN');
  assert.equal(result.testInbox.state, 'UNKNOWN');
});

test('network and authorization errors preserve unknown production state', async () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture' };
  for (const fetcher of [async () => { throw new Error('private token fixture'); }, async () => new Response('private fixture', { status: 401 })]) {
    const result = await liveMetadata(env, fetcher);
    assert.equal(result.settings.state, 'UNKNOWN');
    assert.equal(result.secrets.state, 'UNKNOWN');
    assert(!JSON.stringify(result).includes('private'));
  }
});

test('multipart module fingerprints preserve exact UTF-8 and binary bytes', () => {
  const moduleBytes = Buffer.from('export default { name: "caf\u00e9" };\n');
  const multipart = Buffer.concat([
    Buffer.from('--fixture\r\nContent-Disposition: form-data; name="main"; filename="index.js"\r\nContent-Type: application/javascript\r\n\r\n'),
    moduleBytes,
    Buffer.from('\r\n--fixture--\r\n'),
  ]);
  assert.deepEqual(codeFingerprints(multipart, 'multipart/form-data; boundary="fixture"'), [{
    name: 'index.js', bytes: moduleBytes.length,
    sha256: createHash('sha256').update(moduleBytes).digest('hex'),
  }]);
});
