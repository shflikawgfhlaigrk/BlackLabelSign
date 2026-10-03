import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRIVATE_EMAIL, PrivateEmailTransport, restPayload, reviewedTemplates } from '../scripts/private-email-transport.mjs';
import { preparePrivateReview, startPrivateEmailReview } from '../scripts/private-email-review.mjs';

// Every provider in this file is a fake REST function. No credentials, external
// inbox, real OTP, Cloudflare call or actual delivery are part of these checks.
const owner = 'owner@example.test', origin = 'http://localhost:18889';
const link = `${origin}/s/SYNTHETIC_PRIVATE_LINK_ONLY`;
const hash = value => createHash('sha256').update(value).digest('hex');
const importProbe = fileURLToPath(new URL('./fixtures/import-with-no-fetch.mjs', import.meta.url));
const importWithoutFetch = moduleUrl => JSON.parse(execFileSync(process.execPath, [importProbe, moduleUrl], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
function workerMail(kind, { code = '123456', documentLink = link, address = owner, privateOrigin = origin } = {}) {
  const prepared = reviewedTemplates(address, privateOrigin).templates[kind];
  const mail = { to: { email: address, name: PRIVATE_EMAIL.signerName }, from: { email: prepared.from, name: 'BL Sign' },
    replyTo: prepared.reply_to, subject: prepared.subject.slice(PRIVATE_EMAIL.subjectPrefix.length + 1),
    ...(prepared.text !== undefined ? { text: prepared.text } : {}), ...(prepared.html !== undefined ? { html: prepared.html } : {}) };
  for (const key of ['subject', 'text', 'html']) if (mail[key]) mail[key] = mail[key].replaceAll('123456', code).replaceAll(`${privateOrigin}/s/TEST_ONLY_RECIPIENT_LINK`, documentLink);
  return mail;
}
const prior = (count = 0) => ({ ownerEmail: owner, reviewed: true, attempts: Array.from({ length: count }, (_, i) => ({
  id: `synthetic-prior-${i}`, state: i === 0 ? 'rejected' : 'accepted',
  ...(i === 0 ? { providerCode: '10001' } : { messageId: `<synthetic-prior-${i}@example.test>` }),
  evidenceRef: `synthetic-checked-receipt-${i}`, inboxReceipt: i > 0,
})) });
const receipt = (id = 'fake-message-1') => new Response(JSON.stringify({ success: true, result: {
  message_id: `<${id}@example.test>`, delivered: [], queued: [owner], permanent_bounces: [], suppressed_recipients: [],
} }), { status: 200, headers: { 'content-type': 'application/json' } });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bl-sign-private-email-'));
  const calls = [], count = options.count || 0;
  const config = { ownerEmail: owner, reviewApproved: true, origin, ledgerPath: join(directory, 'ledger.json'),
    expectedPriorAttempts: count, priorReconciliation: prior(count), accountId: 'a'.repeat(32), apiToken: 'SYNTHETIC-FAKE-TOKEN-NEVER-A-CREDENTIAL',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return receipt(); }, ...options };
  delete config.count;
  const adapter = new PrivateEmailTransport(config); adapter.bindRecipient(link);
  t.after(() => { adapter.close(); rmSync(directory, { recursive: true, force: true }); });
  return { adapter, config, calls, directory, ledger: () => JSON.parse(readFileSync(config.ledgerPath, 'utf8')) };
}

test('private fake REST: preparation/import create zero calls; explicit allowlist and approval are required', async t => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => { calls++; throw new Error('No provider call permitted'); };
  try {
    const file = new URL('../scripts/private-email-review.mjs', import.meta.url).href;
    assert.deepEqual(importWithoutFetch(file), { imported: true, providerCalls: 0, marker: null });
    const f = fixture(t, { fetchImpl: globalThis.fetch });
    assert.equal(f.adapter.summary().enabled, false); assert.equal(f.adapter.summary().reservedAttempts, 0);
    await assert.rejects(f.adapter.send(workerMail('invitation')), /owner readiness/);
    assert.equal(calls, 0);
    assert.throws(() => new PrivateEmailTransport({ ...f.config, ownerEmail: undefined }), /OWNER_APPROVED_TEST_EMAIL/);
    assert.throws(() => new PrivateEmailTransport({ ...f.config, reviewApproved: false }), /reviewed/);
    const prepared = preparePrivateReview({ ownerEmail: owner, templatePath: join(f.directory, 'templates.json') });
    assert.equal(prepared.templates.title, PRIVATE_EMAIL.title); assert.equal(Object.keys(prepared.templates.templates).length, 4);
    assert.match(readFileSync(prepared.path, 'utf8'), /inert placeholders/); assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('private import probe keeps quotes, spaces and Unicode file paths as argv data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bl-sign-import-probe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["single'quote.mjs", 'double"quote.mjs', 'spaces and snowman-☃.mjs', 'backtick`dollar$.mjs']) {
    const file = join(directory, name);
    writeFileSync(file, 'export const marker = "test-owned import fixture";\n');
    assert.deepEqual(importWithoutFetch(pathToFileURL(file).href), {
      imported: true, providerCalls: 0, marker: 'test-owned import fixture',
    });
  }
});

test('private import probe detects an import-time provider fetch', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bl-sign-import-fetch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'attempt-fetch.mjs');
  writeFileSync(file, 'try { await fetch("https://provider.example.test"); } catch {}\n');
  assert.throws(() => importWithoutFetch(pathToFileURL(file).href), /Import attempted a provider fetch/);
});

test('private fake REST: named Worker fields map to string addresses and message_id becomes an acceptance receipt', async t => {
  const f = fixture(t, { count: 3 }); f.adapter.ownerReady();
  const mail = workerMail('invitation');
  const result = await f.adapter.send(mail); assert.deepEqual(result, { messageId: '<fake-message-1@example.test>' });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`);
  const payload = JSON.parse(call.init.body);
  assert.equal(payload.from, 'sign@blacklabelbots.com'); assert.deepEqual(payload.to, [owner]); assert.equal(payload.reply_to, owner);
  assert.equal(payload.subject, `${PRIVATE_EMAIL.subjectPrefix} ${mail.subject}`);
  assert.equal(payload.html, mail.html); assert.equal(payload.text, mail.text); assert.equal(payload.replyTo, undefined);
  assert.equal(f.ledger().attempts.length, 4); assert.equal(f.ledger().attempts[3].state, 'accepted');
  assert.equal(f.ledger().attempts[3].inboxReceipt, false);
  assert.deepEqual(await f.adapter.send(mail), result); assert.equal(f.calls.length, 1, 'duplicate accepted payload is not sent twice');
  assert.equal(f.adapter.summary().outcome, 'NOT DONE');
});

test('private fake REST: unknown address, extra recipients, changed body/title or foreign link consume no reservation', async t => {
  const f = fixture(t); f.adapter.ownerReady();
  const mail = workerMail('invitation');
  for (const invalid of [
    { ...mail, to: 'stranger@example.test' }, { ...mail, from: 'other@blacklabelbots.com' },
    { ...mail, replyTo: 'stranger@example.test' }, { ...mail, cc: [owner] },
    { ...mail, to: [owner] }, { ...mail, text: mail.text + '\nUnreviewed text' },
    { ...mail, subject: 'Signature requested: Other document' },
    workerMail('invitation', { documentLink: 'https://outside.example.test/s/SYNTHETIC' }),
    workerMail('invitation', { documentLink: `${origin}/s/ANOTHER_SYNTHETIC_RECIPIENT` }),
  ]) await assert.rejects(f.adapter.send(invalid));
  assert.equal(f.calls.length, 0); assert.equal(f.ledger().attempts.length, 0);
});

test('private fake REST: four exact templates consume four reservations; active codes and bodies are never in ledger', async t => {
  const f = fixture(t, { count: 3 }); f.adapter.ownerReady();
  for (const kind of ['invitation', 'verification', 'completion', 'recovery']) await f.adapter.send(workerMail(kind, { code: '654321' }));
  assert.equal(f.calls.length, 4); assert.equal(f.ledger().attempts.length, 7);
  assert.deepEqual(f.ledger().attempts.slice(3).map(row => row.kind), ['invitation', 'verification', 'completion', 'recovery']);
  const ledger = readFileSync(f.config.ledgerPath, 'utf8');
  assert.doesNotMatch(ledger, /654321|SYNTHETIC_PRIVATE_LINK_ONLY|SYNTHETIC-FAKE-TOKEN|<html|Open document|recovery code is/);
  await assert.rejects(f.adapter.send(workerMail('verification', { code: '999999' })), /already has a reserved attempt/);
  assert.equal(f.calls.length, 4);
});

test('private fake REST: cap includes prior attempts and concurrent calls cannot overspend', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { count: 7, fetchImpl: async () => { await blocked; return receipt(); } }); f.adapter.ownerReady();
  const first = f.adapter.send(workerMail('invitation'));
  const others = await Promise.allSettled(['verification', 'completion', 'recovery'].map(kind => f.adapter.send(workerMail(kind))));
  assert.ok(others.every(result => result.status === 'rejected')); assert.equal(f.ledger().attempts.length, 8);
  release(); await first;
  await assert.rejects(f.adapter.send(workerMail('recovery')), /eight-attempt/);
  assert.equal(f.ledger().attempts.length, 8);
});

test('private fake REST: definitive schema rejection consumes attempt and cannot trigger a blind resend', async t => {
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: 'invalid_schema' }] }), { status: 400 }); } });
  f.adapter.ownerReady(); await assert.rejects(f.adapter.send(workerMail('invitation')), error => error.code === 'E_VALIDATION_ERROR');
  assert.equal(f.ledger().attempts[0].state, 'rejected'); assert.equal(f.ledger().attempts[0].providerCode, '10001');
  await assert.rejects(f.adapter.send(workerMail('invitation')), /already has a reserved attempt/); assert.equal(calls, 1);
});

test('private fake REST: timeout, malformed receipt, missing message ID and server error remain uncertain without retry', async t => {
  const providers = [async () => { throw new Error('synthetic interrupted REST'); },
    async () => new Response('not-json', { status: 200 }),
    async () => new Response(JSON.stringify({ success: true, result: { queued: [owner] } }), { status: 200 }),
    async () => new Response(JSON.stringify({ success: false, errors: [{ code: 500 }] }), { status: 500 })];
  for (const provider of providers) {
    let calls = 0; const f = fixture(t, { fetchImpl: async (...args) => { calls++; return provider(...args); } }); f.adapter.ownerReady();
    await assert.rejects(f.adapter.send(workerMail('invitation')), error => error.code === 'E_OUTCOME_UNKNOWN');
    assert.equal(f.ledger().attempts[0].state, 'uncertain');
    await assert.rejects(f.adapter.send(workerMail('invitation')), /needs reconciliation/);
    await assert.rejects(f.adapter.send(workerMail('recovery')), /needs reconciliation/); assert.equal(calls, 1);
    f.adapter.close(); assert.throws(() => new PrivateEmailTransport(f.config), /blind restart/);
  }
});

test('private fake REST: reservation persistence failure prevents provider request; accepted receipt write failure keeps durable reservation', async t => {
  let writes = 0, calls = 0;
  const f = fixture(t, { saveImpl(path, data) { writes++; if (writes > 1) throw new Error('Synthetic disk failure'); writeFileSync(path, JSON.stringify(data)); },
    fetchImpl: async () => { calls++; return receipt(); } });
  f.adapter.ownerReady(); await assert.rejects(f.adapter.send(workerMail('invitation')), /Reservation persistence failed/); assert.equal(calls, 0);
  const g = fixture(t, { saveImpl(path, data) { if (data.attempts.some(row => row.state !== 'reserved')) throw new Error('Synthetic receipt write failure'); writeFileSync(path, JSON.stringify(data)); } });
  g.adapter.ownerReady(); await assert.rejects(g.adapter.send(workerMail('invitation')), error => error.code === 'E_OUTCOME_UNKNOWN');
  assert.equal(g.calls.length, 1); assert.equal(g.ledger().attempts[0].state, 'reserved');
  await assert.rejects(g.adapter.send(workerMail('invitation')), /needs reconciliation/); assert.equal(g.calls.length, 1);
  g.adapter.close(); assert.throws(() => new PrivateEmailTransport(g.config), /blind restart/);
});

test('private fake REST: restart requires receipt reconciliation, retains IDs/count and returns accepted duplicate without sending', async t => {
  const f = fixture(t, { count: 3 }); f.adapter.ownerReady(); await f.adapter.send(workerMail('invitation')); f.adapter.close();
  const bytes = readFileSync(f.config.ledgerPath, 'utf8'), data = JSON.parse(bytes);
  assert.throws(() => new PrivateEmailTransport(f.config), /blind restart/);
  const reconciliation = { reviewed: true, ledgerSha256: hash(bytes), attempts: data.attempts.map(row => ({ ...row, evidenceRef: 'Synthetic reviewed provider receipt' })) };
  assert.throws(() => new PrivateEmailTransport({ ...f.config, resumeReconciliation: { ...reconciliation, ledgerSha256: 'wrong' } }), /blind restart/);
  const reopened = new PrivateEmailTransport({ ...f.config, resumeReconciliation: reconciliation }); t.after(() => reopened.close());
  reopened.bindRecipient(link); reopened.ownerReady();
  assert.equal(reopened.summary().reservedAttempts, 4); assert.equal(reopened.summary().attempts[3].messageId, '<fake-message-1@example.test>');
  assert.deepEqual(await reopened.send(workerMail('invitation')), { messageId: '<fake-message-1@example.test>' }); assert.equal(f.calls.length, 1);
});

test('private fake REST: sanitized prior receipt export preserves three reservations, provider IDs and observed inbox evidence', async t => {
  const sanitized = { schemaVersion: 1, from: 'sign@blacklabelbots.com', to: owner, maximumTotalAttempts: 8,
    confirmedPriorReservedAttempts: 3, oldPrivateProcessClosed: true, attempts: [
      { index: 1, state: 'rejected', httpStatus: 400, errorCodes: [10001], subjectSha256: 'a'.repeat(64), bodySha256: 'b'.repeat(64) },
      ...[2, 3].map(index => ({ index, state: 'accepted', messageId: `<prior-${index}@example.test>`, reconciliation: { gmailId: `synthetic-${index}`, inboxObserved: true, spfPass: true, dkimPass: true, dmarcPass: true } })),
    ] };
  const f = fixture(t, { count: 3, priorReconciliation: sanitized });
  assert.equal(f.ledger().attempts.length, 3); assert.equal(f.ledger().attempts[0].providerCode, '10001');
  assert.equal(f.ledger().attempts[1].messageId, '<prior-2@example.test>'); assert.equal(f.ledger().attempts[2].inboxReceipt, true);
  assert.equal(f.ledger().attempts[1].reconciliation.dkimPass, true); assert.equal(f.calls.length, 0);
});

test('private fake REST: close drains in-flight outcomes, holds writer lock and permanently fences the old instance', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { count: 3, fetchImpl: async () => { await delayed; return receipt(); } });
  f.adapter.ownerReady(); const pending = f.adapter.send(workerMail('invitation'));
  const closing = f.adapter.close();
  assert.throws(() => f.adapter.ownerReady(), /Closed private transport/);
  assert.throws(() => f.adapter.bindRecipient(link), /Closed private transport/);
  await assert.rejects(f.adapter.send(workerMail('verification')), /Closed private transport/);
  const bytes = readFileSync(f.config.ledgerPath, 'utf8');
  const attempts = JSON.parse(bytes).attempts.map(row => ({ ...row, state: row.state === 'reserved' ? 'rejected' : row.state,
    providerCode: 'SYNTHETIC_NO_ACCEPTANCE', provenNotAccepted: true, evidenceRef: 'Synthetic reconciliation only' }));
  assert.throws(() => new PrivateEmailTransport({ ...f.config, resumeReconciliation: { reviewed: true, ledgerSha256: hash(bytes), attempts } }), /already has an owner/);
  release(); await pending; await closing;
  assert.equal(f.ledger().attempts.length, 4); assert.equal(f.ledger().attempts[3].state, 'accepted');
  assert.throws(() => f.adapter.ownerReady(), /Closed private transport/);
  await assert.rejects(f.adapter.send(workerMail('verification')), /Closed private transport/);
});

test('private fake REST: reviewed restart cannot omit immutable imported prior reservations', async t => {
  const f = fixture(t, { count: 3 }); await f.adapter.close();
  const truncated = f.ledger(); truncated.attempts = [];
  writeFileSync(f.config.ledgerPath, JSON.stringify(truncated));
  const bytes = readFileSync(f.config.ledgerPath, 'utf8');
  assert.throws(() => new PrivateEmailTransport({ ...f.config, resumeReconciliation: { reviewed: true, ledgerSha256: hash(bytes), attempts: [] } }), /does not match this private approval/);
});

test('private fake REST: credential echoes in provider metadata are never persisted or exposed', async t => {
  const token = 'SYNTHETIC-SECRET-CREDENTIAL-ECHO';
  const f = fixture(t, { apiToken: token, fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ code: token, message: token }] }), { status: 400 }) });
  f.adapter.ownerReady(); await assert.rejects(f.adapter.send(workerMail('verification')));
  assert.equal(f.ledger().attempts[0].providerCode, 'HTTP_400');
  assert.ok(!readFileSync(f.config.ledgerPath, 'utf8').includes(token)); assert.ok(!JSON.stringify(f.adapter.summary()).includes(token));
  const g = fixture(t, { apiToken: token, fetchImpl: async () => receipt(token) });
  g.adapter.ownerReady(); await assert.rejects(g.adapter.send(workerMail('verification')), error => error.code === 'E_OUTCOME_UNKNOWN');
  assert.ok(!readFileSync(g.config.ledgerPath, 'utf8').includes(token)); assert.ok(!JSON.stringify(g.adapter.summary()).includes(token));
});

test('private fake REST: HTTP review binds actual Worker state, starts paused with no sends, rotates recipient link and hides codes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bl-sign-private-loopback-'));
  // Dedicated ephemeral HTTP port to avoid the founder's fixed18889 listener.
  const { createServer } = await import('node:net');
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const templatePath = join(directory, 'templates.json'); preparePrivateReview({ ownerEmail: owner, templatePath, port });
  let calls = 0;
  const review = await startPrivateEmailReview({ ownerEmail: owner, reviewApproved: true, port, templatePath, ledgerPath: join(directory, 'ledger.json'),
    priorReconciliation: prior(3), expectedPriorAttempts: 3, accountId: 'a'.repeat(32), apiToken: 'SYNTHETIC-FAKE-TOKEN',
    fetchImpl: async () => { calls++; return receipt(); } }); t.after(async () => { await review.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.match(review.origin, /^http:\/\/localhost:/); assert.equal(calls, 0);
  const page = await fetch(review.reviewUrl); assert.equal(page.status, 200); assert.match(await page.text(), /Email adapter is paused/);
  const inbox = await fetch(review.origin + '/__sandbox/inbox'); assert.equal(inbox.status, 410); assert.match(await inbox.text(), /never available/);
  const forbidden = await fetch(review.origin + '/__private/owner-ready', { method: 'POST', headers: { origin: 'https://other.example.test' } }); assert.equal(forbidden.status, 403);
  const start = await fetch(review.origin + '/__private/start', { redirect: 'manual' }); assert.equal(start.status, 303);
  const editor = start.headers.get('location'), cookie = start.headers.get('set-cookie').split(';')[0];
  const id = editor.split('/').pop();
  const request = (path, method = 'GET', body) => fetch(review.origin + path, { method, headers: { cookie, origin: review.origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const before = await (await request(`/api/envelopes/${id}`)).json(); assert.equal(before.envelope.status, 'draft');
  const paused = await request(`/api/envelopes/${id}/send`, 'POST', { routing: 'sequential', expireDays: 0 }); assert.equal(paused.status, 503);
  assert.equal(calls, 0); assert.equal((await (await request(`/api/envelopes/${id}`)).json()).envelope.status, 'draft');
  const ready = await fetch(review.origin + '/__private/owner-ready', { method: 'POST', headers: { origin: review.origin }, redirect: 'manual' }); assert.equal(ready.status, 303);
  const sent = await (await request(`/api/envelopes/${id}/send`, 'POST', { routing: 'sequential', expireDays: 0 })).json();
  assert.equal(sent.delivery.accepted, 1); assert.equal(calls, 1); assert.notEqual(sent.signers[0].token, before.signers[0].token);
  assert.equal(new URL(sent.signers[0].link).origin, review.origin);
  const authPath = new URL(sent.signers[0].link).pathname.replace('/s/', '/api/session/');
  const auth = await (await request(authPath + '/auth-request', 'POST')).json(); assert.equal(auth.codeSent, true); assert.equal(calls, 2);
  const status = await (await fetch(review.origin + '/__private/status')).json(); assert.equal(status.reservedAttempts, 5);
  assert.doesNotMatch(JSON.stringify(status), /verification code:|recovery code is|TEST_ONLY_RECIPIENT_LINK|Bearer|SYNTHETIC-FAKE-TOKEN/);
  assert.equal(review.harness.inbox.received.length, 0, 'real transport does not collect an OTP in the sandbox inbox');
});
