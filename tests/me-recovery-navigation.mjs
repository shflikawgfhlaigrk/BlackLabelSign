import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the complete shipped recovery page with a recording DOM and transport.
// Every code and account is synthetic; fetch never leaves this process.
const source = readFileSync(new URL('../public/assets/me.js', import.meta.url), 'utf8');
const envelopeId = '0123456789abcdef'.repeat(2);
const editorPath = '/e/' + envelopeId;
const origin = 'https://sign.blacklabeltec.com';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise(resolve => setImmediate(resolve));

async function page({ returnValue = editorPath, search, verify = () => response({ ok: true }),
  recover = () => response({ challenge_id: 'c'.repeat(32) }, 202) } = {}) {
  const operations = [], calls = [], elements = {};
  let current = new URL('/me' + (search ?? '?return=' + encodeURIComponent(returnValue)) + '#private-test-fragment', origin);
  let authenticated = false;
  const location = {
    get href() { return current.href; },
    set href(value) { operations.push({ type: 'href', value }); current = new URL(value, current); },
    get search() { return current.search; },
    get pathname() { return current.pathname; },
    set pathname(value) { operations.push({ type: 'pathname', value }); current.pathname = value; },
    get hash() { return current.hash; },
    get origin() { return current.origin; },
  };
  const history = {
    replaceState(state, title, value) {
      const next = new URL(value, current);
      assert.equal(next.origin, current.origin, 'History must stay on the current origin');
      operations.push({ type: 'replaceState', state, title, value }); current = next;
    },
  };
  const document = {
    activeElement: null,
    querySelector(selector) {
      assert.ok(elements[selector], 'Unexpected DOM selector: ' + selector);
      return elements[selector];
    },
  };
  for (const id of ['page-message', 'recover-message', 'recover-send', 'recover-verify',
    'recover-change', 'recovery', 'who', 'envelopes', 'account-data', 'refresh',
    'tbl', 'empty', 'recover-form', 'recover-email', 'recover-code', 'verify-form', 'delete-account']) {
    const classes = new Set();
    elements['#' + id] = {
      id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, readOnly: false,
      attributes: {},
      classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { document.activeElement = this; },
      querySelectorAll() { return []; },
    };
  }
  elements['#tbl tbody'] = { innerHTML: '', querySelectorAll() { return []; } };
  runInNewContext(source, {
    document, location, history, URLSearchParams, AbortSignal,
    confirm() { throw new Error('Deletion is outside this synthetic recovery test'); },
    prompt() { throw new Error('Deletion is outside this synthetic recovery test'); },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body });
      if (url === '/api/public/envelopes') return authenticated
        ? response({ sender: { name: 'Synthetic Sender TEST ONLY', email: 'sender@example.test' }, envelopes: [] })
        : response({ error: 'unauthorized' }, 401);
      if (url === '/api/public/recover') return recover();
      if (url === '/api/public/recover/verify') {
        const result = await verify();
        if (result.ok) authenticated = true;
        return result;
      }
      throw new Error('Unexpected mocked request: ' + url);
    },
  });
  await settle();
  const submit = async selector => {
    let prevented = 0;
    await elements[selector].onsubmit({ preventDefault() { prevented++; } });
    assert.equal(prevented, 1);
  };
  const requestCode = async () => {
    elements['#recover-email'].value = 'sender@example.test';
    await submit('#recover-form');
  };
  const verifyCode = async (code = '123456') => {
    elements['#recover-code'].value = code;
    await submit('#verify-form');
  };
  return { elements, document, location, operations, calls, requestCode, verifyCode };
}

test('recovery navigation: verified valid editor ID uses pathname after clearing query and fragment', async () => {
  const p = await page({ search: '?return=' + encodeURIComponent(editorPath) + '&source=synthetic&next=https%3A%2F%2Fattacker.example' });
  assert.equal(p.elements['#recovery'].hidden, false);
  await p.requestCode();
  assert.equal(p.operations.length, 0, 'Requesting a code cannot navigate');
  await p.verifyCode();
  assert.deepEqual(p.operations, [
    { type: 'replaceState', state: null, title: '', value: '/me' },
    { type: 'pathname', value: editorPath },
  ]);
  assert.equal(p.location.href, origin + editorPath);
  assert.equal(p.location.origin, origin);
  assert.equal(p.location.search, '');
  assert.equal(p.location.hash, '');
  assert.deepEqual(p.calls.map(call => call.url), ['/api/public/envelopes', '/api/public/recover', '/api/public/recover/verify']);
  assert.deepEqual(JSON.parse(p.calls.at(-1).body), { challenge_id: 'c'.repeat(32), code: '123456' });
});

for (const [name, returnValue] of [
  ['external HTTPS', 'https://attacker.example' + editorPath],
  ['JavaScript scheme', 'javascript:alert(1)'],
  ['scheme-relative authority', '//attacker.example' + editorPath],
  ['backslash authority', '/\\attacker.example' + editorPath],
  ['path traversal', '/e/../' + envelopeId],
  ['encoded path traversal', '/e/%2e%2e/' + envelopeId],
  ['query string', editorPath + '?next=https://attacker.example'],
  ['fragment', editorPath + '#javascript:alert(1)'],
  ['newline', editorPath + '\n'],
  ['carriage return', editorPath + '\r'],
  ['tab', '/e/\t' + envelopeId],
  ['NUL', editorPath + '\u0000'],
  ['DEL', editorPath + '\u007f'],
  ['Unicode line separator', editorPath + '\u2028'],
  ['Unicode paragraph separator', editorPath + '\u2029'],
  ['31 hex characters', '/e/' + 'a'.repeat(31)],
  ['33 hex characters', '/e/' + 'a'.repeat(33)],
  ['uppercase hex', '/e/' + envelopeId.toUpperCase()],
  ['double-encoded path', '%2Fe%2F' + envelopeId],
  ['encoded scheme-relative authority', '%2F%2Fattacker.example' + editorPath],
  ['empty return', ''],
]) test('recovery navigation: verified ' + name + ' return stays on My envelopes', async () => {
  const p = await page({ returnValue });
  const originalUrl = p.location.href;
  await p.requestCode(); await p.verifyCode();
  assert.deepEqual(p.operations, []);
  assert.equal(p.location.href, originalUrl);
  assert.equal(p.elements['#envelopes'].hidden, false);
  assert.equal(p.elements['#recovery'].hidden, true);
  assert.equal(p.calls.at(-1).url, '/api/public/envelopes');
});

test('recovery navigation: successful verification without a return parameter opens My envelopes', async () => {
  const p = await page({ search: '?source=synthetic' });
  await p.requestCode(); await p.verifyCode();
  assert.deepEqual(p.operations, []);
  assert.equal(p.elements['#envelopes'].hidden, false);
});

for (const [name, verify] of [
  ['invalid or expired code', () => response({ error: 'invalid, expired, or already used' }, 401)],
  ['server error despite ok body', () => response({ ok: true }, 503)],
  ['missing acceptance field', () => response({})],
  ['explicit negative acceptance', () => response({ ok: false })],
  ['malformed JSON', () => new Response('not JSON', { status: 200 })],
  ['interrupted response', () => { throw new TypeError('Synthetic offline response'); }],
]) test('recovery navigation: ' + name + ' never redirects a valid editor return', async () => {
  const p = await page({ verify });
  const originalUrl = p.location.href;
  await p.requestCode(); await p.verifyCode();
  assert.deepEqual(p.operations, []);
  assert.equal(p.location.href, originalUrl);
  assert.equal(p.elements['#recovery'].hidden, false);
  assert.equal(p.elements['#recover-verify'].disabled, false);
  assert.equal(p.document.activeElement?.id === 'recover-code' || name === 'interrupted response', true);
  assert.equal(p.calls.at(-1).url, '/api/public/recover/verify');
});

test('recovery navigation: submitting a code without a challenge never sends verification or navigates', async () => {
  const p = await page(); await p.verifyCode();
  assert.deepEqual(p.operations, []);
  assert.deepEqual(p.calls.map(call => call.url), ['/api/public/envelopes']);
  assert.match(p.elements['#recover-message'].textContent, /six-digit code/);
});

test('recovery navigation: missing challenge in the recovery response cannot authorize a redirect', async () => {
  const p = await page({ recover: () => response({}) });
  await p.requestCode(); await p.verifyCode();
  assert.deepEqual(p.operations, []);
  assert.ok(p.calls.every(call => call.url !== '/api/public/recover/verify'));
});

test('recovery navigation: malformed code never sends verification or redirects', async () => {
  const p = await page(); await p.requestCode(); await p.verifyCode('12345');
  assert.deepEqual(p.operations, []);
  assert.ok(p.calls.every(call => call.url !== '/api/public/recover/verify'));
});
