import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const html = readFileSync(new URL('../public/landing.html', import.meta.url), 'utf8');
const scriptParser = fileURLToPath(new URL('./fixtures/extract-inline-script.py', import.meta.url));
// Parse HTML tags and raw script text. This extracts the shipped test subject;
// it is never used as a production sanitizer or to execute supplied HTML.
function inlineScript(source) {
  const sources = JSON.parse(execFileSync('python3', [scriptParser], { input: source, encoding: 'utf8' }));
  assert.ok(sources.length, 'Expected a complete classic inline landing script.');
  return sources.at(-1);
}
const script = inlineScript(html);
const settle = () => new Promise(resolve => setImmediate(resolve));
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('landing script extraction handles uppercase, mixed case, attributes and raw script text', () => {
  const expected = 'const text = "<script> &amp; </not-script>";';
  for (const [open, close] of [
    ['<SCRIPT>', '</SCRIPT>'],
    ['<ScRiPt data-example="angle > bracket" TYPE="text/javascript">', '</sCrIpT >'],
    ['<script type="application/javascript" nonce="test-only">', '</script\n>'],
  ]) assert.equal(inlineScript(`<p>fixture</p>${open}${expected}${close}`), expected);
});
test('landing extraction skips external scripts, inert JSON and commented markup, and selects the last inline script', () => {
  assert.equal(inlineScript('<!-- <SCRIPT>commented</SCRIPT> --><script>first</script>' +
    '<SCRIPT SRC="/test-only.js">external fallback</SCRIPT><script>last</script>' +
    '<script type="application/ld+json">{"fixture":true}</script>'), 'last');
});
test('landing extraction fails when the expected complete script is absent', () => {
  for (const absent of ['<p>No script</p>', '<script src="/test-only.js"></script>', '<SCRIPT>unclosed'])
    assert.throws(() => inlineScript(absent), /Expected a complete classic inline landing script/);
});
test('landing extraction follows HTML closing-tag behavior inside a JavaScript string', () => {
  assert.equal(inlineScript('<script>const text = "</ScRiPt>";</script>'), 'const text = "');
});

// Exercise the shipped script with DOM controls and a recording transport.
// There are no production accounts, uploads, email sends, or network requests.
async function page({ handler = async () => reply({}), sender } = {}) {
  const calls = [], elements = {}, location = { href: '/' };
  const document = { activeElement: null, querySelector: selector => elements[selector.slice(1)] };
  for (const id of ['name', 'email', 'title', 'file', 'start', 'create', 'startcard', 'upcard',
    'err', 'err2', 'hello', 'name-error', 'email-error', 'title-error', 'file-error', 'start-free']) {
    elements[id] = { id, value: '', files: [], textContent: id, disabled: false, style: {}, attributes: {}, listeners: {},
      focus() { document.activeElement = this; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
    };
  }
  elements.upcard.style.display = 'none';
  runInNewContext(script, { document, location, FormData, AbortSignal, TypeError, console, crypto,
    matchMedia: () => ({ matches: true }), window: { scrollTo() {} },
    fetch: async (url, options = {}) => {
      if (!options.method) return sender ? reply({ sender, envelopes: [] }) : reply({ error: 'unauthorized' }, 401);
      calls.push({ url, ...options });
      return handler(url, options);
    },
  });
  await settle();
  const submit = id => elements[id].onsubmit({ preventDefault() {} });
  const identity = () => { elements.name.value = '  Test Buyer  '; elements.email.value = ' buyer@example.com '; };
  const pdf = (size = 30, type = 'application/pdf', name = 'sample.pdf') => {
    elements.title.value = '  Synthetic document  ';
    elements.file.files = [new File([new Uint8Array(size)], name, { type })];
  };
  return { elements, document, calls, location, submit, identity, pdf };
}

test('missing identity names both fields, focuses the first, and sends no request', async () => {
  const p = await page(); await p.submit('startcard');
  assert.equal(p.calls.length, 0); assert.equal(p.elements.start.disabled, false);
  assert.equal(p.document.activeElement.id, 'name');
  assert.equal(p.elements['name-error'].textContent, 'Enter your name.');
  assert.equal(p.elements.email.attributes['aria-invalid'], 'true');
  p.elements.name.listeners.input();
  assert.equal(p.elements.name.attributes['aria-invalid'], 'false');
});
test('invalid email stays in the form without a network request', async () => {
  const p = await page(); p.identity(); p.elements.email.value = 'wrong@'; await p.submit('startcard');
  assert.equal(p.calls.length, 0); assert.equal(p.document.activeElement.id, 'email');
  assert.equal(p.elements['email-error'].textContent, 'Enter a valid email address.');
});
test('successful identity opens upload with preserved API shape and keyboard focus', async () => {
  const p = await page({ handler: async () => reply({ name: 'Test Buyer' }) });
  p.identity(); await p.submit('startcard');
  assert.deepEqual(JSON.parse(p.calls[0].body), { name: 'Test Buyer', email: 'buyer@example.com' });
  assert.equal(p.elements.startcard.style.display, 'none');
  assert.equal(p.elements.upcard.style.display, ''); assert.equal(p.document.activeElement.id, 'title');
  assert.equal(p.elements.start.disabled, false);
});
for (const [name, handler, message] of [
  ['offline', async () => { throw new TypeError('offline'); }, /Connection interrupted/],
  ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }, /Connection interrupted/],
  ['server validation', async () => reply({ error: 'daily limit reached' }, 429), /daily limit reached/],
  ['HTML server error', async () => new Response('<html>Unavailable</html>', { status: 503 }), /could not complete/],
  ['malformed JSON', async () => new Response('not json'), /Connection interrupted/],
  ['missing session identity', async () => reply({ ok: true }), /session could not be confirmed/],
]) test(`start recovers from ${name} without losing entries or showing upload`, async () => {
  const p = await page({ handler }); p.identity(); await p.submit('startcard');
  assert.equal(p.elements.start.disabled, false); assert.equal(p.elements.start.textContent, 'start');
  assert.equal(p.elements.start.attributes['aria-busy'], undefined);
  assert.match(p.elements.err.textContent, message); assert.equal(p.elements.upcard.style.display, 'none');
  assert.equal(p.elements.name.value, '  Test Buyer  ');
});
test('repeated submit while a request is pending sends only once', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const p = await page({ handler: () => pending }); p.identity();
  const first = p.submit('startcard'); await p.submit('startcard');
  assert.equal(p.calls.length, 1); assert.equal(p.elements.start.disabled, true);
  resolve(reply({ name: 'Test Buyer' })); await first;
  assert.equal(p.elements.start.disabled, false);
});
test('returning sender Start free focuses the visible upload field', async () => {
  const p = await page({ sender: { name: 'Returning Buyer' } });
  assert.equal(p.document.activeElement, null); p.elements['start-free'].onclick();
  assert.equal(p.document.activeElement.id, 'title'); assert.equal(p.calls.length, 0);
});
test('upload requires a title and file before sending', async () => {
  const p = await page(); await p.submit('upcard');
  assert.equal(p.calls.length, 0); assert.equal(p.document.activeElement.id, 'title');
  assert.equal(p.elements['title-error'].textContent, 'Enter a document title.');
  assert.equal(p.elements['file-error'].textContent, 'Choose a PDF document.');
});
for (const [name, size, type, fileName, message] of [
  ['empty', 0, 'application/pdf', 'sample.pdf', /empty/],
  ['too large', 15 * 1024 * 1024 + 1, 'application/pdf', 'sample.pdf', /15 MB/],
  ['non-PDF', 20, 'image/png', 'image.png', /Choose a PDF/],
]) test(`${name} upload has field feedback without a network request`, async () => {
  const p = await page(); p.pdf(size, type, fileName); await p.submit('upcard');
  assert.equal(p.calls.length, 0); assert.match(p.elements['file-error'].textContent, message);
  assert.equal(p.document.activeElement.id, 'file');
});
test('valid PDF goes to the returned editor only once, with title and file intact', async () => {
  const id = 'a'.repeat(32); const p = await page({ handler: async () => reply({ id }) });
  p.pdf(30, '', 'sample.pdf'); await p.submit('upcard');
  assert.equal(p.calls[0].url, '/api/public/envelopes');
  assert.equal(p.calls[0].body.get('title'), 'Synthetic document');
  assert.equal(p.calls[0].body.get('file').size, 30); assert.equal(p.location.href, '/e/' + id);
});
test('lost upload response restores control and tells buyer to reconcile envelopes', async () => {
  const p = await page({ handler: async () => { throw new TypeError('offline'); } });
  p.pdf(); await p.submit('upcard');
  assert.equal(p.elements.create.disabled, false); assert.equal(p.elements.file.files.length, 1);
  assert.match(p.elements.err2.textContent, /Check My envelopes before uploading again/);
  assert.equal(p.calls.length, 1); assert.equal(p.location.href, '/');
});
test('malformed success does not navigate to a bogus editor', async () => {
  const p = await page({ handler: async () => reply({ id: 'unexpected' }) });
  p.pdf(); await p.submit('upcard'); assert.equal(p.location.href, '/');
  assert.match(p.elements.err2.textContent, /Check My envelopes/); assert.equal(p.elements.create.disabled, false);
});
test('upload retries after an interrupted response retain the same idempotency key', async () => {
  const p = await page({ handler: async () => { throw new TypeError('synthetic lost response'); } }); p.pdf();
  await p.submit('upcard'); await p.submit('upcard');
  const keys = p.calls.map(c => new Headers(c.headers).get('idempotency-key'));
  assert.match(keys[0], /^[a-f0-9-]{36}$/); assert.equal(keys[0], keys[1]); assert.equal(p.calls.length, 2);
});
for (const change of ['title', 'file']) test(`changed upload ${change} gets a distinct request key`, async () => {
  const p = await page({ handler: async () => { throw new TypeError('synthetic lost response'); } }); p.pdf(); await p.submit('upcard');
  if (change === 'title') p.elements.title.value = 'A different synthetic document'; else p.pdf();
  await p.submit('upcard'); assert.notEqual(new Headers(p.calls[0].headers).get('idempotency-key'), new Headers(p.calls[1].headers).get('idempotency-key'));
});
test('parallel upload clicks send one request and an acknowledged upload resets its request key', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const p = await page({ handler: () => pending }); p.pdf();
  const first = p.submit('upcard'); await p.submit('upcard'); assert.equal(p.calls.length, 1);
  resolve(reply({ id: 'a'.repeat(32) })); await first; await p.submit('upcard');
  assert.equal(p.calls.length, 2); assert.notEqual(new Headers(p.calls[0].headers).get('idempotency-key'), new Headers(p.calls[1].headers).get('idempotency-key'));
});
