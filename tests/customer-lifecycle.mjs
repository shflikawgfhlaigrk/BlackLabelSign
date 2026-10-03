import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { serveHarness, sandboxFetch, syntheticPdf, sha256 } from './helpers/worker-harness.mjs';
import { makePng } from './png-fixtures.mjs';

// These are real HTTP requests to the exact Worker in an isolated local harness.
// All email acceptance and receipt evidence below is LOCAL SANDBOX ONLY.
class Client {
  constructor(harness, ip = '192.0.2.10') { this.h = harness; this.ip = ip; this.cookie = ''; }
  async request(path, { method = 'GET', body, form, headers = {} } = {}) {
    const h = { 'cf-connecting-ip': this.ip, 'user-agent': 'BL Sign synthetic acceptance', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await sandboxFetch(this.h, path, { method, headers: h,
      ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (r.headers.has('set-cookie')) this.cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  }
}
const json = async (r, status = 200) => { const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data; };
async function fixture(t, { count = 1, email = 'sender@example.test' } = {}) {
  const h = await serveHarness(); t.after(() => h.close());
  const sender = new Client(h), outsider = new Client(h), pdf = await syntheticPdf();
  const start = (client = sender, address = email) => client.request('/api/public/start', { method: 'POST', body: { name: 'Synthetic Sender TEST ONLY', email: address } });
  await json(await start());
  const upload = async (client = sender, title = 'BL SIGN TEST ONLY — NOT A CONTRACT', options = {}) => {
    const form = new FormData(); form.set('title', title); form.set('file', new File([pdf], 'TEST-ONLY.pdf', { type: 'application/pdf' }));
    return client.request('/api/public/envelopes', { method: 'POST', form, ...options });
  };
  const { id } = await json(await upload());
  const setup = { signers: Array.from({ length: count }, (_, i) => ({ name: `Synthetic Signer ${i} TEST ONLY`, email: `signer${i}@example.test` })),
    fields: Array.from({ length: count }, (_, i) => [
      { signer_index: i, type: 'signature', page: 0, x: .08, y: .2 + i * .18, w: .28, h: .08 },
      { signer_index: i, type: 'text', page: 0, x: .5, y: .2 + i * .18, w: .28, h: .08 },
    ]).flat() };
  await json(await sender.request(`/api/envelopes/${id}/setup`, { method: 'PUT', body: setup }));
  const read = () => sender.request(`/api/envelopes/${id}`).then(r => json(r));
  const send = () => sender.request(`/api/envelopes/${id}/send`, { method: 'POST', body: { routing: 'sequential', expireDays: 7 } });
  const authenticate = async (i, client = new Client(h)) => {
    const { signers } = await read(), signer = signers[i], path = `/api/session/${signer.token}`;
    await json(await client.request(path + '/auth-request', { method: 'POST' }));
    const code = h.inbox.latestCode(signer.email);
    await json(await client.request(path + '/auth-verify', { method: 'POST', body: { code } }));
    return { client, signer, path, code };
  };
  const values = async i => { const { signers, fields } = await read(); return { values: Object.fromEntries(fields.filter(f => f.signer_id === signers[i].id)
    .map(f => [f.id, f.type === 'signature' ? { png: `data:image/png;base64,${makePng().toString('base64')}` } : { v: 'SYNTHETIC TEST ONLY' }])) }; };
  const consent = auth => auth.client.request(auth.path + '/consent', { method: 'POST' });
  const complete = async (auth, i) => auth.client.request(auth.path + '/complete', { method: 'POST', body: await values(i) });
  return { h, sender, outsider, pdf, id, start, upload, setup, read, send, authenticate, values, consent, complete };
}

test('local HTTP: fresh no-account sender and two sequential verified recipients receive immutable final PDF and certificate', async t => {
  const f = await fixture(t, { count: 2 });
  assert.equal((await f.outsider.request('/api/public/envelopes')).status, 401);
  const created = await f.read(); assert.equal(created.envelope.original_sha256, sha256(f.pdf));
  const sent = await json(await f.send()); assert.equal(sent.delivery.accepted, 1); assert.equal(sent.delivery.deferred, 1);
  assert.equal(f.h.inbox.messages('signer0@example.test').length, 1); assert.equal(f.h.inbox.messages('signer1@example.test').length, 0);
  assert.equal(new URL(sent.signers[0].link).origin, f.h.origin);
  const path0 = new URL(sent.signers[0].link).pathname.replace('/s/', '/api/session/');
  const gate = await json(await f.outsider.request(path0)); assert.equal(gate.authRequired, true); assert.equal(gate.title, undefined); assert.equal(gate.fields, undefined);
  assert.equal((await f.outsider.request(path0 + '/pdf')).status, 401);
  const a0 = await f.authenticate(0); const current = await json(await a0.client.request(a0.path));
  assert.equal(current.myTurn, true); assert.equal(current.signer.consented, false);
  assert.equal((await f.complete(a0, 0)).status, 400);
  await json(await f.consent(a0));
  const first = await json(await f.complete(a0, 0)); assert.equal(first.completed, false); assert.equal(first.nextDelivery.state, 'accepted');
  assert.equal((await a0.client.request(a0.path + '/download')).status, 409);
  assert.equal(f.h.inbox.messages('signer1@example.test').length, 1);
  const a1 = await f.authenticate(1); await json(await f.consent(a1)); const second = await json(await f.complete(a1, 1)); assert.equal(second.completed, true);
  const finished = await f.read(); assert.equal(finished.envelope.status, 'completed');
  const downloaded = await a1.client.request(a1.path + '/download'); assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.equal(sha256(bytes), finished.envelope.final_sha256);
  assert.notEqual(sha256(bytes), sha256(f.pdf)); assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
  const loading = getDocument({ data: Uint8Array.from(bytes), disableFontFace: true,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname });
  const document = await loading.promise;
  const certificate = (await (await document.getPage(2)).getTextContent()).items.map(x => x.str).join(' ');
  assert.match(certificate, /Certificate of Completion/i); assert.ok(certificate.includes(f.id));
  assert.ok(certificate.includes(sha256(f.pdf))); assert.match(certificate, /Synthetic Signer 0 TEST ONLY/); assert.match(certificate, /Synthetic Signer 1 TEST ONLY/);
  await loading.destroy();
  const eventTypes = finished.events.map(e => e.type);
  for (const type of ['created', 'sent', 'email-authenticated', 'consented', 'signed', 'completed']) assert.ok(eventTypes.includes(type), type);
  assert.equal(eventTypes.filter(x => x === 'signed').length, 2);
  assert.deepEqual(Buffer.from(await (await f.sender.request(`/api/envelopes/${f.id}/final`)).arrayBuffer()), bytes);
  const verification = await f.outsider.request(`/verify/${f.id}`); assert.equal(verification.status, 200);
  const html = await verification.text(); assert.ok(html.includes(finished.envelope.final_sha256));
  assert.doesNotMatch(html, /signer0@example\.test|signer1@example\.test|SYNTHETIC TEST ONLY/);
});

test('local HTTP: tenant ownership, signer document access and private caching are enforced', async t => {
  const f = await fixture(t); await json(await f.start(f.outsider, 'outsider@example.test'));
  const own = await json(await f.outsider.request('/api/public/envelopes')); assert.equal(own.envelopes.length, 0);
  for (const suffix of ['', '/pdf', '/final']) assert.equal((await f.outsider.request(`/api/envelopes/${f.id}${suffix}`)).status, 401);
  for (const [suffix, method, body] of [['/setup', 'PUT', f.setup], ['/send', 'POST', {}], ['/void', 'POST', {}], ['', 'DELETE', undefined]])
    assert.equal((await f.outsider.request(`/api/envelopes/${f.id}${suffix}`, { method, body })).status, 401);
  const response = await f.sender.request(`/api/envelopes/${f.id}`);
  assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  await json(await f.send()); const { signers } = await f.read();
  const bad = await f.outsider.request(`/api/session/${signers[0].token}/pdf`); assert.equal(bad.status, 401);
  assert.equal((await f.outsider.request('/api/session/not-a-valid-token')).status, 404);
});

test('local HTTP: concurrent uploads share the three-envelope daily quota across same-email sessions and deletion', async t => {
  const f = await fixture(t);
  const alias = new Client(f.h); await json(await f.start(alias, ' SENDER@EXAMPLE.TEST '));
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => f.upload(i % 2 ? alias : f.sender)));
  assert.equal(outcomes.filter(x => x.status === 200).length, 2); assert.equal(outcomes.filter(x => x.status === 429).length, 6);
  assert.equal(f.h.env.DB.sql.prepare('SELECT COUNT(*) n FROM envelopes').get().n, 3);
  await json(await f.sender.request(`/api/envelopes/${f.id}`, { method: 'DELETE' }));
  assert.equal((await f.upload()).status, 429);
  assert.equal(f.h.env.DB.sql.prepare("SELECT COUNT(*) n FROM abuse_usage WHERE kind='envelope'").get().n, 3);
});

test('local HTTP: duplicate send and complete requests have one accepted mutation and one final immutable PDF', async t => {
  const f = await fixture(t);
  const sends = await Promise.all(Array.from({ length: 8 }, f.send));
  assert.equal(sends.filter(x => x.status === 200).length, 1); assert.ok(sends.every(x => [200, 400, 409].includes(x.status)));
  assert.equal(f.h.inbox.accepted.length, 1);
  const a = await f.authenticate(0); await json(await f.consent(a)); const payload = await f.values(0);
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => a.client.request(a.path + '/complete', { method: 'POST', body: payload })));
  assert.equal(outcomes.filter(x => x.status === 200).length, 1); assert.ok(outcomes.every(x => [200, 400, 409].includes(x.status)));
  const accepted = await f.read(); assert.equal(accepted.events.filter(x => x.type === 'signed').length, 1); assert.equal(accepted.events.filter(x => x.type === 'completed').length, 1);
  const objects = [...f.h.env.DOCS.objects].map(([key, o]) => [key, sha256(o.bytes)]);
  assert.equal((await f.complete(a, 0)).status, 400); assert.deepEqual([...f.h.env.DOCS.objects].map(([key, o]) => [key, sha256(o.bytes)]), objects);
  assert.equal((await f.sender.request(`/api/envelopes/${f.id}/setup`, { method: 'PUT', body: f.setup })).status, 400);
});

test('local HTTP: malformed, wrong, expired and replayed OTPs fail; an interrupted device resumes only after new verification', async t => {
  const f = await fixture(t); await json(await f.send()); const { signers } = await f.read(); const s = signers[0], path = `/api/session/${s.token}`;
  const recipient = new Client(f.h); await json(await recipient.request(path + '/auth-request', { method: 'POST' })); const code = f.h.inbox.latestCode(s.email);
  assert.equal((await recipient.request(path + '/auth-verify', { method: 'POST', body: { code: 'abc' } })).status, 400);
  assert.equal((await recipient.request(path + '/auth-verify', { method: 'POST', body: { code: code === '000000' ? '111111' : '000000' } })).status, 401);
  const parallel = await Promise.all(Array.from({ length: 6 }, () => new Client(f.h).request(path + '/auth-verify', { method: 'POST', body: { code } })));
  assert.equal(parallel.filter(r => r.status === 200).length, 1); assert.equal(parallel.filter(r => r.headers.has('set-cookie')).length, 1);
  recipient.cookie = parallel.find(r => r.status === 200).headers.get('set-cookie').split(';')[0];
  assert.equal((await recipient.request(path + '/auth-verify', { method: 'POST', body: { code } })).status, 410);
  await json(await recipient.request(path + '/consent', { method: 'POST' }));
  const reloaded = await json(await recipient.request(path)); assert.equal(reloaded.signer.consented, true);
  const newDevice = new Client(f.h); assert.equal((await json(await newDevice.request(path))).authRequired, true); assert.equal((await newDevice.request(path + '/pdf')).status, 401);
  f.h.env.DB.sql.prepare("UPDATE signers SET auth_code_sent_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(s.id);
  await json(await newDevice.request(path + '/auth-request', { method: 'POST' })); const nextCode = f.h.inbox.latestCode(s.email);
  f.h.env.DB.sql.prepare("UPDATE signers SET auth_code_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(s.id);
  assert.equal((await newDevice.request(path + '/auth-verify', { method: 'POST', body: { code: nextCode } })).status, 410);
  recipient.cookie = recipient.cookie.replace(/=\d+\./, '=1.'); assert.equal((await json(await recipient.request(path))).authRequired, true);
});

test('local HTTP: provider rejection clears the code; provider acceptance without sandbox receipt remains distinct from receipt proof', async t => {
  const f = await fixture(t); f.h.inbox.mode = 'reject'; const sent = await json(await f.send()); assert.equal(sent.delivery.failed, 1);
  const { signers } = await f.read(); const s = signers[0], path = `/api/session/${s.token}`;
  assert.equal(s.delivery_status, 'failed'); assert.match(s.delivery_error, /E_RECIPIENT_NOT_ALLOWED/);
  const recipient = new Client(f.h); assert.equal((await recipient.request(path + '/auth-request', { method: 'POST' })).status, 502);
  const failed = f.h.env.DB.sql.prepare('SELECT * FROM signers WHERE id=?').get(s.id); assert.equal(failed.auth_code_hash, null);
  f.h.inbox.mode = 'accept-without-receipt';
  await json(await recipient.request(path + '/auth-request', { method: 'POST' }));
  assert.equal(f.h.inbox.accepted.length, 1); assert.equal(f.h.inbox.received.length, 0);
  assert.equal((await recipient.request(path + '/pdf')).status, 401);
  f.h.env.DB.sql.prepare("UPDATE signers SET auth_code_sent_at='2000-01-01T00:00:00.000Z',delivery_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(s.id);
  f.h.inbox.mode = 'collect';
  assert.equal((await f.sender.request(`/api/envelopes/${f.id}/resend`, { method: 'POST', body: { signer_id: s.id } })).status, 400);
  await json(await f.sender.request(`/api/envelopes/${f.id}/resend`, { method: 'POST', body: { signer_id: s.id }, headers: { authorization: `Bearer ${f.h.env.ADMIN_TOKEN}` } }));
  await json(await recipient.request(path + '/auth-request', { method: 'POST' }));
  const code = f.h.inbox.latestCode(s.email); await json(await recipient.request(path + '/auth-verify', { method: 'POST', body: { code } }));
  assert.equal(f.h.inbox.received.length, 2); assert.equal(f.h.inbox.accepted.length, 3);
});

test('local HTTP: rejected PDF and missing required fields leave original document, signer and storage unchanged', async t => {
  const f = await fixture(t); const form = new FormData(); form.set('title', 'TEST ONLY bad PDF'); form.set('file', new File(['not a PDF'], 'bad.pdf'));
  assert.equal((await f.sender.request('/api/public/envelopes', { method: 'POST', form })).status, 400);
  assert.equal(f.h.env.DB.sql.prepare('SELECT COUNT(*) n FROM envelopes').get().n, 1);
  await json(await f.send()); const a = await f.authenticate(0); await json(await f.consent(a));
  const before = await f.read(), objectCount = f.h.env.DOCS.objects.size;
  assert.equal((await a.client.request(a.path + '/complete', { method: 'POST', body: { values: {} } })).status, 400);
  const after = await f.read(); assert.equal(after.signers[0].status, 'pending'); assert.equal(after.envelope.original_sha256, before.envelope.original_sha256);
  assert.equal(f.h.env.DOCS.objects.size, objectCount); assert.ok(after.fields.every(f => f.value === null));
});

test('local HTTP: transient final storage failure preserves recorded signature and retries sealing on read', async t => {
  const f = await fixture(t); await json(await f.send()); const a = await f.authenticate(0); await json(await f.consent(a));
  let failures = 0; f.h.env.DOCS.beforePut = async key => { if (key.startsWith('final/') && failures++ === 0) throw new Error('Synthetic final storage interruption'); };
  const originalError = console.error; console.error = () => {};
  let result; try { result = await json(await f.complete(a, 0)); } finally { console.error = originalError; }
  assert.equal(result.completed, false); assert.equal(result.sealing, true);
  assert.equal(f.h.env.DB.sql.prepare('SELECT status FROM signers').get().status, 'signed');
  const recovered = await f.read(); assert.equal(recovered.envelope.status, 'completed'); assert.ok(recovered.envelope.final_sha256);
  assert.equal(recovered.events.filter(e => e.type === 'signed').length, 1); assert.equal(recovered.events.filter(e => e.type === 'completed').length, 1);
  assert.equal((await a.client.request(a.path + '/download')).status, 200);
});

test('local HTTP: future sequential recipient cannot consent or complete before the prior signer', async t => {
  const f = await fixture(t, { count: 2 }); await json(await f.send()); const future = await f.authenticate(1);
  const state = await json(await future.client.request(future.path)); assert.equal(state.myTurn, false); assert.match(state.waitingOn, /Signer 0/);
  assert.equal((await f.consent(future)).status, 400); assert.equal((await f.complete(future, 1)).status, 400);
  assert.ok((await f.read()).signers.every(s => s.status === 'pending'));
});

test('local HTTP: invalid, voided and expired recipient links cannot sign or yield final downloads', async t => {
  const f = await fixture(t); await json(await f.send()); const a = await f.authenticate(0);
  await json(await f.sender.request(`/api/envelopes/${f.id}/void`, { method: 'POST' }));
  assert.equal((await a.client.request(a.path)).status, 410); assert.equal((await a.client.request(a.path + '/pdf')).status, 410);
  assert.equal((await f.consent(a)).status, 410); assert.equal((await a.client.request(a.path + '/download')).status, 410);
  const prior = f.h.inbox.accepted.length;
  assert.equal((await new Client(f.h).request(a.path + '/auth-request', { method: 'POST' })).status, 410); assert.equal(f.h.inbox.accepted.length, prior);
  const second = await fixture(t); await json(await second.send()); const b = await second.authenticate(0);
  second.h.env.DB.sql.prepare("UPDATE envelopes SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(second.id);
  assert.equal((await b.client.request(b.path)).status, 410); assert.equal((await second.consent(b)).status, 410);
  assert.equal((await second.complete(b, 0)).status, 410);
  const prior2 = second.h.inbox.accepted.length;
  assert.equal((await new Client(second.h).request(b.path + '/auth-request', { method: 'POST' })).status, 410); assert.equal(second.h.inbox.accepted.length, prior2);
  assert.equal((await new Client(second.h).request('/api/session/invalid')).status, 404);
});

test('local HTTP: no-session sender recovery merges same-email documents, rotates old sessions, and atomically blocks replay', async t => {
  const f = await fixture(t), alias = new Client(f.h), recovered = new Client(f.h);
  await json(await f.start(alias, ' SENDER@EXAMPLE.TEST '));
  const uploadKey = 'synthetic-alias-upload-key';
  const second = await json(await f.upload(alias, undefined, { headers: { 'idempotency-key': uploadKey } }));
  const old1 = f.sender.cookie, old2 = alias.cookie;
  const unknown = await json(await recovered.request('/api/public/recover', { method: 'POST', body: { email: 'unknown@example.test' } }), 202);
  assert.equal(f.h.inbox.received.length, 0); assert.match(unknown.challenge_id, /^[a-f0-9]{32}$/);
  const known = await json(await recovered.request('/api/public/recover', { method: 'POST', body: { email: 'sender@example.test' } }), 202);
  assert.equal(unknown.message, known.message); assert.equal(unknown.expires_minutes, known.expires_minutes);
  const code = f.h.inbox.latestCode('sender@example.test');
  const candidates = Array.from({ length: 8 }, () => new Client(f.h));
  const responses = await Promise.all(candidates.map(c => c.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: known.challenge_id, code } })));
  assert.equal(responses.filter(r => r.status === 200).length, 1); assert.equal(responses.filter(r => r.headers.has('set-cookie')).length, 1);
  recovered.cookie = responses.find(r => r.status === 200).headers.get('set-cookie').split(';')[0];
  assert.notEqual(recovered.cookie, old1); assert.notEqual(recovered.cookie, old2);
  assert.equal((await f.sender.request('/api/public/envelopes')).status, 401); assert.equal((await alias.request('/api/public/envelopes')).status, 401);
  const all = await json(await recovered.request('/api/public/envelopes')); assert.deepEqual(all.envelopes.map(e => e.id).sort(), [f.id, second.id].sort());
  const retry = await json(await f.upload(recovered, undefined, { headers: { 'idempotency-key': uploadKey } })); assert.equal(retry.id, second.id);
  assert.equal(f.h.env.DB.sql.prepare("SELECT COUNT(*) n FROM abuse_usage WHERE kind='envelope'").get().n, 2);
  assert.equal((await recovered.request(`/api/envelopes/${f.id}/pdf`)).status, 200); assert.equal((await recovered.request(`/api/envelopes/${second.id}/pdf`)).status, 200);
  assert.equal((await recovered.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: known.challenge_id, code } })).status, 400);
  assert.equal((await recovered.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: unknown.challenge_id, code } })).status, 400);
});

test('local HTTP: invalid, exhausted, expired and failed-delivery recovery challenges fail closed', async t => {
  const f = await fixture(t), client = new Client(f.h);
  assert.equal((await client.request('/api/public/recover', { method: 'POST', body: { email: 'bad' } })).status, 400);
  const issue = () => client.request('/api/public/recover', { method: 'POST', body: { email: 'sender@example.test' } });
  const first = await json(await issue(), 202), code = f.h.inbox.latestCode('sender@example.test');
  const wrong = code === '000000' ? '111111' : '000000';
  const guesses = await Promise.all(Array.from({ length: 12 }, () => client.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: first.challenge_id, code: wrong } })));
  assert.equal(guesses.filter(r => r.status === 400).length, 5); assert.equal(guesses.filter(r => r.status === 429).length, 7);
  assert.equal((await client.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: first.challenge_id, code } })).status, 429);
  const expired = await json(await issue(), 202); f.h.env.DB.sql.prepare("UPDATE sender_recovery SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.challenge_id);
  assert.equal((await client.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: expired.challenge_id, code: f.h.inbox.latestCode('sender@example.test') } })).status, 400);
  f.h.inbox.mode = 'reject'; const failed = await json(await issue(), 202);
  assert.equal(f.h.env.DB.sql.prepare('SELECT code_hash FROM sender_recovery WHERE id=?').get(failed.challenge_id).code_hash, null);
  assert.equal((await client.request('/api/public/recover/verify', { method: 'POST', body: { challenge_id: failed.challenge_id, code } })).status, 400);
  await json(await issue(), 202); await json(await issue(), 202); assert.equal((await issue()).status, 429);
});

test('local HTTP: cross-origin mutations fail before state changes and administrator attempts have a persisted throttle', async t => {
  const f = await fixture(t); const before = await f.read();
  for (const headers of [{ origin: 'https://attacker.example.test' }, { 'sec-fetch-site': 'cross-site' }])
    assert.equal((await f.sender.request(`/api/envelopes/${f.id}/void`, { method: 'POST', headers })).status, 403);
  assert.equal((await f.read()).envelope.status, before.envelope.status);
  for (let i = 0; i < 10; i++) assert.equal((await f.outsider.request('/api/login', { method: 'POST', body: { token: 'wrong' } })).status, 403);
  assert.equal((await f.outsider.request('/api/login', { method: 'POST', body: { token: 'wrong' } })).status, 429);
  assert.equal(f.h.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE envelope_id='auth' AND type='login-failed'").get().n, 10);
});

test('local HTTP: ambiguous provider outcomes and lost receipt persistence block automatic resend and scheduler duplication', async t => {
  for (const mode of ['uncertain', 'lost-persistence']) {
    const f = await fixture(t);
    let attempts = 0; f.h.inbox.beforeSend = async () => { attempts++; };
    if (mode === 'uncertain') f.h.inbox.mode = 'uncertain';
    else f.h.env.DB.beforeRun = async s => { if (s.query.includes("delivery_status='accepted'")) throw new Error('Synthetic receipt write outage'); };
    const sent = await json(await f.send()); assert.equal(sent.delivery.uncertain, 1);
    const { signers } = await f.read(); assert.ok(['sending', 'uncertain'].includes(signers[0].delivery_status));
    f.h.env.DB.sql.prepare("UPDATE signers SET delivery_at='2000-01-01T00:00:00.000Z'").run();
    const retry = await f.sender.request(`/api/envelopes/${f.id}/resend`, { method: 'POST', body: { signer_id: signers[0].id }, headers: { authorization: `Bearer ${f.h.env.ADMIN_TOKEN}` } }); assert.ok([409, 429].includes(retry.status));
    const jobs = []; await f.h.worker.scheduled({}, f.h.env, { waitUntil: p => jobs.push(p) }); await Promise.all(jobs);
    assert.equal(attempts, 1);
    if (mode === 'lost-persistence') assert.equal(f.h.inbox.accepted.length, 1);
  }
});

test('local HTTP: same-key upload retries reserve one quota slot, reject changed bodies, recover R2 interruption and retain deletion tombstones', async t => {
  const f = await fixture(t), key = 'synthetic-request-key-0001';
  const upload = async (title = 'TEST ONLY idempotency', requestKey = key) => {
    const form = new FormData(); form.set('title', title); form.set('file', new File([f.pdf], 'TEST-ONLY.pdf', { type: 'application/pdf' }));
    return f.sender.request('/api/public/envelopes', { method: 'POST', form, headers: { 'idempotency-key': requestKey } });
  };
  const parallel = await Promise.all(Array.from({ length: 8 }, () => upload()));
  const ids = await Promise.all(parallel.filter(r => r.status === 200).map(r => r.json()));
  assert.ok(ids.length); assert.equal(new Set(ids.map(x => x.id)).size, 1); const id = ids[0].id;
  assert.ok(parallel.every(r => [200, 409].includes(r.status)));
  assert.equal((await json(await upload())).id, id);
  assert.equal(f.h.env.DB.sql.prepare("SELECT COUNT(*) n FROM abuse_usage WHERE kind='envelope'").get().n, 2);
  assert.equal((await upload('TEST ONLY altered title')).status, 409);
  let failed = false; f.h.env.DOCS.beforePut = async k => { if (!failed && k.startsWith('orig/')) { failed = true; throw new Error('Synthetic original R2 interruption'); } };
  const oldError = console.error; console.error = () => {}; let interrupted;
  try { interrupted = await upload('TEST ONLY resume storage', 'synthetic-request-key-0002'); } finally { console.error = oldError; }
  assert.ok([409, 500, 502].includes(interrupted.status)); f.h.env.DOCS.beforePut = null;
  const resumed = await json(await upload('TEST ONLY resume storage', 'synthetic-request-key-0002'));
  const saved = await json(await f.sender.request(`/api/envelopes/${resumed.id}`)); assert.equal(saved.envelope.original_sha256, sha256(f.pdf));
  assert.equal(f.h.env.DB.sql.prepare("SELECT COUNT(*) n FROM abuse_usage WHERE kind='envelope'").get().n, 3);
  await json(await f.sender.request(`/api/envelopes/${id}`, { method: 'DELETE' })); assert.equal((await upload()).status, 409);
});
