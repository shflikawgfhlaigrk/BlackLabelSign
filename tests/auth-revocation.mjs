import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, syntheticPdf, sha256 } from './helpers/worker-harness.mjs';

// Actual Worker in local SQLite/memory R2 with synthetic documents and sandbox
// email only. No deployed resources, customer records, or live email are used.
const checked = async (response, status = 200) => {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
};

async function fixture(t) {
  const h = await createHarness();
  t.after(() => h.close());
  const email = 'revocation.owner@example.test';
  const start = await h.request('/api/public/start', { method: 'POST', body: {
    name: 'SYNTHETIC REVOCATION OWNER', email,
  } });
  await checked(start.clone());
  const oldCookie = start.headers.get('set-cookie').split(';')[0];
  const owner = (path, options = {}) => h.request(path, { cookie: oldCookie, ...options });
  const input = await syntheticPdf();
  const form = new FormData();
  form.set('title', 'BL SIGN REVOCATION TEST ONLY - NOT A CONTRACT');
  form.set('file', new File([input], 'TEST-ONLY.pdf', { type: 'application/pdf' }));
  const { id } = await checked(await owner('/api/public/envelopes', { method: 'POST', form }));
  const setup = {
    signers: [{ name: 'SYNTHETIC RECIPIENT', email: 'revocation.recipient@example.test' }],
    fields: [{ signer_index: 0, type: 'signature', page: 0, x: .1, y: .2, w: .3, h: .08 }],
  };
  await checked(await owner(`/api/envelopes/${id}/setup`, { method: 'PUT', body: setup }));
  const snapshot = () => ({
    envelope: h.env.DB.sql.prepare('SELECT * FROM envelopes WHERE id=?').get(id),
    signers: h.env.DB.sql.prepare('SELECT * FROM signers WHERE envelope_id=? ORDER BY id').all(id),
    fields: h.env.DB.sql.prepare('SELECT * FROM fields WHERE envelope_id=? ORDER BY id').all(id),
  });
  const before = snapshot();
  const issuance = await checked(await h.request('/api/public/recover', { method: 'POST', body: { email } }), 202);
  const code = h.inbox.latestCode(email);
  let newCookie, recovered = false;
  const prepare = h.env.DB.prepare.bind(h.env.DB);
  // Pause immediately after the stale request's successful sender lookup, before
  // any envelope operation. Recovery then rotates that token before it resumes.
  h.env.DB.prepare = query => {
    const statement = prepare(query), first = statement.first;
    statement.first = async function () {
      const row = await first.call(this);
      if (!recovered && query.startsWith('SELECT * FROM senders WHERE token=')) {
        recovered = true;
        const response = await h.request('/api/public/recover/verify', { method: 'POST', body: {
          challenge_id: issuance.challenge_id, code,
        } });
        await checked(response.clone());
        newCookie = response.headers.get('set-cookie').split(';')[0];
      }
      return row;
    };
    return statement;
  };
  const assertPreserved = async response => {
    assert.equal(recovered, true, 'Recovery race did not run');
    const body = await response.text();
    assert.ok(response.status >= 400, `Revoked request committed: HTTP ${response.status} ${body}`);
    assert.deepEqual(snapshot(), before, 'Revoked request changed envelope, recipients, or fields');
    const fresh = await h.request(`/api/envelopes/${id}`, { cookie: newCookie });
    await checked(fresh);
    assert.equal((await h.request('/api/public/envelopes', { cookie: oldCookie })).status, 401);
    assert.equal(h.env.DB.sql.prepare('SELECT COUNT(*) c FROM senders').get().c, 1);
    const document = h.env.DOCS.objects.get(before.envelope.original_key);
    assert.ok(document, 'Revoked request deleted the original PDF');
    assert.equal(sha256(document.bytes), sha256(input));
    assert.equal(h.inbox.accepted.length, 1, 'Revoked request sent a recipient email');
  };
  return { h, owner, id, setup, assertPreserved };
}

test('recovery revokes a setup request already authenticated in another browser', async t => {
  const f = await fixture(t);
  await f.assertPreserved(await f.owner(`/api/envelopes/${f.id}/setup`, { method: 'PUT', body: {
    ...f.setup, signers: [{ name: 'STALE REQUEST MUST NOT PERSIST', email: 'stale.recipient@example.test' }],
  } }));
});

test('recovery revokes a send request already authenticated in another browser', async t => {
  const f = await fixture(t);
  await f.assertPreserved(await f.owner(`/api/envelopes/${f.id}/send`, { method: 'POST', body: {} }));
});

test('recovery revokes a void request already authenticated in another browser', async t => {
  const f = await fixture(t);
  await f.assertPreserved(await f.owner(`/api/envelopes/${f.id}/void`, { method: 'POST' }));
});

test('recovery revokes an add-document request already authenticated in another browser', async t => {
  const f = await fixture(t), form = new FormData();
  form.set('file', new File([await syntheticPdf()], 'EXTRA-TEST-ONLY.pdf', { type: 'application/pdf' }));
  form.set('name', 'STALE SYNTHETIC ADDITION');
  await f.assertPreserved(await f.owner(`/api/envelopes/${f.id}/adddoc`, { method: 'POST', form }));
});

test('recovery revokes an envelope deletion already authenticated in another browser', async t => {
  const f = await fixture(t);
  await f.assertPreserved(await f.owner(`/api/envelopes/${f.id}`, { method: 'DELETE' }));
});

test('recovery revokes account deletion already authenticated in another browser', async t => {
  const f = await fixture(t);
  await f.assertPreserved(await f.owner('/api/public/account', { method: 'DELETE' }));
});

async function legacyTemplateFixture(t) {
  const h = await createHarness();
  t.after(() => h.close());
  const email = 'revocation.legacy.owner@example.test';
  const start = await h.request('/api/public/start', { method: 'POST', body: {
    name: 'SYNTHETIC LEGACY TEMPLATE OWNER', email,
  } });
  await checked(start.clone());
  const oldCookie = start.headers.get('set-cookie').split(';')[0];
  const sender = h.env.DB.sql.prepare('SELECT id FROM senders').get();
  const id = '0123456789abcdef0123456789abcdef', key = `tpl/${id}.pdf`;
  const input = await syntheticPdf();
  await h.env.DOCS.put(key, input);
  // Public template creation stays unsupported. This synthetic legacy record
  // exercises deletion and recovery of data retained by the additive migration.
  h.env.DB.sql.prepare(`INSERT INTO templates
    (id,name,sender_id,key,sha256,pages,roles_json,fields_json,created_at)
    VALUES (?,?,?,?,?,1,?,?,?)`).run(id, 'SYNTHETIC LEGACY TEST ONLY', sender.id,
    key, sha256(input), '[]', '[]', new Date().toISOString());
  const before = h.env.DB.sql.prepare('SELECT * FROM templates WHERE id=?').get(id);
  const issuance = await checked(await h.request('/api/public/recover', { method: 'POST', body: { email } }), 202);
  const code = h.inbox.latestCode(email);
  let recovered = false, newCookie;
  const prepare = h.env.DB.prepare.bind(h.env.DB);
  h.env.DB.prepare = query => {
    const statement = prepare(query), first = statement.first;
    statement.first = async function () {
      const row = await first.call(this);
      if (!recovered && query.startsWith('SELECT * FROM senders WHERE token=')) {
        recovered = true;
        const response = await h.request('/api/public/recover/verify', { method: 'POST', body: {
          challenge_id: issuance.challenge_id, code,
        } });
        await checked(response.clone());
        newCookie = response.headers.get('set-cookie').split(';')[0];
      }
      return row;
    };
    return statement;
  };
  const assertPreserved = async response => {
    assert.equal(recovered, true, 'Recovery race did not run');
    const body = await response.text();
    assert.ok(response.status >= 400, `Revoked deletion reported success: HTTP ${response.status} ${body}`);
    assert.deepEqual(h.env.DB.sql.prepare('SELECT * FROM templates WHERE id=?').get(id), before);
    const object = await h.env.DOCS.get(key);
    assert.ok(object, 'Revoked deletion removed a retained template PDF');
    assert.equal(sha256(new Uint8Array(await object.arrayBuffer())), sha256(input));
    await checked(await h.request('/api/public/envelopes', { cookie: newCookie }));
    assert.equal((await h.request('/api/public/envelopes', { cookie: oldCookie })).status, 401);
    assert.equal(h.env.DB.sql.prepare('SELECT COUNT(*) c FROM senders').get().c, 1);
  };
  return { h, id, oldCookie, assertPreserved };
}

test('recovery protects legacy template rows and PDFs from a stale template deletion', async t => {
  const f = await legacyTemplateFixture(t);
  await f.assertPreserved(await f.h.request(`/api/templates/${f.id}`, { method: 'DELETE', cookie: f.oldCookie }));
});

test('recovery protects legacy template PDFs from stale account deletion when no envelopes exist', async t => {
  const f = await legacyTemplateFixture(t);
  await f.assertPreserved(await f.h.request('/api/public/account', { method: 'DELETE', cookie: f.oldCookie }));
});
