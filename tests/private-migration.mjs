import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { LocalD1, MemoryR2, SandboxInbox, loadWorker, syntheticPdf, sha256, candidateIdentity } from './helpers/worker-harness.mjs';
import { makePng } from './png-fixtures.mjs';

// Synthetic upgrade rehearsal only. No production connection, customer rows,
// deployed R2 objects or external email are read or changed by this test.
const root = new URL('../', import.meta.url);
const migration = '0011-sender-recovery.sql';
const priorMigrations = readdirSync(new URL('migrations/', root))
  .filter(name => /^000[2-9]-|^0010-/.test(name) && name.endsWith('.sql')).sort();
const quote = name => `"${name.replaceAll('"', '""')}"`;
const proofs = [];
const id = {
  sender: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  envelope: '11111111111111111111111111111111',
  draft: '22222222222222222222222222222222',
  signer: '33333333333333333333333333333333',
  draftSigner: '44444444444444444444444444444444',
  template: '88888888888888888888888888888888',
  token: '5555555555555555555555555555555555555555555555555555555555555555',
};
const stamp = '2026-01-01T00:00:00.000Z';

const tables = sql => sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
const columns = (sql, table) => sql.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
const rows = (sql, table, names = columns(sql, table)) => sql.prepare(
  `SELECT ${names.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${names.map(quote).join(',')}`
).all();
const insert = (sql, table, row) => sql.prepare(
  `INSERT INTO ${quote(table)} (${Object.keys(row).map(quote).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`
).run(...Object.values(row));

async function fixture(t) {
  // Reuse the D1 API adapter without its constructor, which applies all migrations.
  const db = Object.create(LocalD1.prototype);
  db.sql = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.sql.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
  assert.equal(priorMigrations.length, 9, 'Unexpected historical migration range');
  for (const name of priorMigrations)
    db.sql.exec(readFileSync(new URL(`migrations/${name}`, root), 'utf8'));
  assert.ok(!tables(db.sql).includes('sender_recovery'));
  assert.ok(!tables(db.sql).includes('envelope_uploads'));
  assert.ok(!columns(db.sql, 'senders').includes('token_expires_at'));
  assert.ok(!columns(db.sql, 'signers').includes('auth_delivery_status'));
  assert.ok(!columns(db.sql, 'templates').includes('deletion_claim'));

  const docs = new MemoryR2(), pdf = await syntheticPdf(), ink = makePng();
  const keys = {
    original: `orig/${id.envelope}.pdf`, final: `final/${id.envelope}.pdf`,
    historical: `orig/${id.envelope}-retained-draft.pdf`, draft: `orig/${id.draft}.pdf`,
    signature: `sig/${id.signer}.png`, template: `tpl/${id.template}.pdf`,
  };
  for (const [kind, key] of Object.entries(keys)) await docs.put(key, kind === 'signature' ? ink : pdf);
  const pdfHash = sha256(pdf);
  insert(db.sql, 'senders', { id: id.sender, name: 'SYNTHETIC LEGACY OWNER TEST ONLY', email: 'legacy.owner@example.test', token: id.token, ip: '192.0.2.10', created_at: stamp });
  insert(db.sql, 'envelopes', { id: id.envelope, title: 'BL SIGN UPGRADE TEST ONLY - NOT A CONTRACT', status: 'completed', created_at: stamp, sent_at: stamp, completed_at: stamp,
    sender_id: id.sender, original_key: keys.original, original_sha256: pdfHash, final_key: keys.final, final_sha256: pdfHash,
    routing: 'sequential', docs_json: JSON.stringify([{ name: 'TEST ONLY original', sha256: pdfHash }]), revision: 2, mutation_id: null });
  insert(db.sql, 'envelopes', { id: id.draft, title: 'BL SIGN LEGACY DRAFT TEST ONLY', created_at: stamp, sender_id: id.sender,
    original_key: keys.draft, original_sha256: pdfHash, expires_at: '2099-01-01T00:00:00.000Z', revision: 1 });
  for (const [signerId, envelopeId, status] of [[id.signer, id.envelope, 'signed'], [id.draftSigner, id.draft, 'pending']])
    insert(db.sql, 'signers', { id: signerId, envelope_id: envelopeId, name: 'SYNTHETIC LEGACY SIGNER TEST ONLY', email: 'legacy.recipient@example.test',
      token: `test-only-${signerId}`, status, consent_at: status === 'signed' ? stamp : null, signed_at: status === 'signed' ? stamp : null,
      delivery_status: 'accepted', delivery_message_id: 'synthetic-provider-id', delivery_at: stamp, delivery_attempts: 1, auth_challenge_id: `synthetic-${signerId}` });
  insert(db.sql, 'fields', { id: 'field-1-test-only', envelope_id: id.envelope, signer_id: id.signer, type: 'signature', page: 0, x: .1, y: .2, w: .3, h: .08, value: 'SYNTHETIC ONLY', signature_key: keys.signature });
  insert(db.sql, 'fields', { id: 'field-2-test-only', envelope_id: id.draft, signer_id: id.draftSigner, type: 'text', page: 0, x: .1, y: .4, w: .3, h: .08 });
  for (const [eventId, envelopeId, type] of [['event-1-test-only', id.envelope, 'completed'], ['event-2-test-only', id.draft, 'created']])
    insert(db.sql, 'events', { id: eventId, envelope_id: envelopeId, type, ts: stamp, ip: '192.0.2.10', ua: 'SYNTHETIC MIGRATION TEST ONLY', detail: 'Synthetic audit history; no legal agreement.' });
  insert(db.sql, 'templates', { id: id.template, name: 'SYNTHETIC RETAINED LEGACY TEMPLATE', sender_id: id.sender, key: keys.template, sha256: pdfHash, pages: 1, roles_json: '["signer"]', fields_json: '[]', created_at: stamp });
  for (const key of [keys.original, keys.final, keys.historical, keys.signature, keys.draft])
    insert(db.sql, 'envelope_objects', { envelope_id: key === keys.draft ? id.draft : id.envelope, key, published: 1, created_at: stamp });
  insert(db.sql, 'abuse_usage', { id: 'usage-test-only', kind: 'envelope', purpose: 'upload', account_key: 'synthetic-hmac-account', network_key: 'synthetic-hmac-network', recipient_key: '', subject_key: '', used_at: 1767225600 });
  insert(db.sql, 'estate_wholesale_signing', { packet_id: 'synthetic-existing-packet', envelope_id: id.draft, sender_email: 'legacy.owner@example.test', created_at: stamp });
  const before = Object.fromEntries(tables(db.sql).map(table => [table, { columns: columns(db.sql, table), rows: rows(db.sql, table) }]));
  const beforeObjects = Object.fromEntries([...docs.objects].map(([key, object]) => [key, sha256(object.bytes)]));
  const oldIndexes = db.sql.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
  db.sql.exec(readFileSync(new URL(`migrations/${migration}`, root), 'utf8'));
  return { db, docs, before, beforeObjects, oldIndexes, keys, pdfHash };
}

test('0011 preserves every synthetic legacy row, audit value and document reference', async t => {
  const f = await fixture(t);
  for (const [table, snapshot] of Object.entries(f.before))
    assert.deepEqual(rows(f.db.sql, table, snapshot.columns), snapshot.rows, `${table} changed historical data`);
  for (const index of f.oldIndexes)
    assert.deepEqual(f.db.sql.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name), index);
  assert.deepEqual(Object.fromEntries([...f.docs.objects].map(([key, object]) => [key, sha256(object.bytes)])), f.beforeObjects);
  for (const row of f.db.sql.prepare('SELECT original_key,final_key FROM envelopes').all()) {
    assert.ok(f.docs.objects.has(row.original_key));
    if (row.final_key) assert.ok(f.docs.objects.has(row.final_key));
  }
  for (const { key } of f.db.sql.prepare('SELECT key FROM envelope_objects UNION SELECT key FROM templates').all()) assert.ok(f.docs.objects.has(key));
  assert.equal(f.db.sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  proofs.push({ name: 'preserved_legacy_data', priorTableCount: Object.keys(f.before).length,
    rowCounts: Object.fromEntries(Object.entries(f.before).map(([table, snapshot]) => [table, snapshot.rows.length])), retainedObjectCount: Object.keys(f.beforeObjects).length });
});

test('0011 leaves the old nullable-expiry token valid in the actual Worker and preserves PDF retrieval', async t => {
  const f = await fixture(t), worker = await loadWorker(), inbox = new SandboxInbox();
  const env = { DB: f.db, DOCS: f.docs, EMAIL: inbox, PUBLIC_ORIGIN: 'https://localhost', SESSION_SECRET: 'SYNTHETIC LOCAL MIGRATION TEST ONLY' };
  const request = path => worker.fetch(new Request(`https://localhost${path}`, { headers: { cookie: `blsender=${id.token}` } }), env);
  assert.equal(f.db.sql.prepare('SELECT token_expires_at FROM senders WHERE id=?').get(id.sender).token_expires_at, null);
  const listing = await request('/api/public/envelopes');
  assert.equal(listing.status, 200);
  const listingBody = await listing.json();
  assert.equal(listingBody.envelopes.length, 2);
  for (const path of [`/api/envelopes/${id.envelope}/pdf`, `/api/envelopes/${id.envelope}/final`]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), f.pdfHash);
  }
  assert.equal((await worker.fetch(new Request('https://localhost/api/public/envelopes', { headers: { cookie: 'blsender=invalid-test-only' } }), env)).status, 401);
  f.db.sql.prepare('UPDATE senders SET token_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', id.sender);
  assert.equal((await request('/api/public/envelopes')).status, 401, 'Expired upgraded token remained valid');
  f.db.sql.prepare('UPDATE senders SET token_expires_at=NULL WHERE id=?').run(id.sender);
  assert.equal((await request('/api/public/envelopes')).status, 200);
  assert.deepEqual(rows(f.db.sql, 'senders', f.before.senders.columns), f.before.senders.rows);
  assert.equal(inbox.accepted.length, 0);
  proofs.push({ name: 'legacy_token_and_pdf_readback', originalAndFinalSha256: f.pdfHash, oldNullableTokenAccepted: true, invalidAndExpiredTokenRejected: true, sandboxEmailAttempts: 0 });
});

test('0011 creates usable recovery/upload records and nullable signer/template columns without changing old rows', async t => {
  const f = await fixture(t);
  assert.equal(f.db.sql.prepare('SELECT COUNT(*) c FROM sender_recovery').get().c, 0);
  assert.equal(f.db.sql.prepare('SELECT COUNT(*) c FROM envelope_uploads').get().c, 0);
  assert.equal(f.db.sql.prepare('SELECT auth_delivery_status FROM signers WHERE id=?').get(id.signer).auth_delivery_status, null);
  assert.equal(f.db.sql.prepare('SELECT deletion_claim FROM templates WHERE id=?').get(id.template).deletion_claim, null);
  assert.ok(f.db.sql.prepare("SELECT name FROM sqlite_master WHERE name='idx_sender_recovery_expiry'").get());
  f.db.sql.exec('BEGIN');
  try {
    insert(f.db.sql, 'sender_recovery', { id: 'synthetic-recovery', email: 'legacy.owner@example.test', expires_at: '2099-01-01T00:00:00.000Z' });
    assert.deepEqual({ ...f.db.sql.prepare('SELECT accepted,attempts,consumed_at,consumed_token FROM sender_recovery').get() }, { accepted: 0, attempts: 0, consumed_at: null, consumed_token: null });
    insert(f.db.sql, 'envelope_uploads', { sender_id: id.sender, request_key: 'synthetic-request-key', fingerprint: 'synthetic-fingerprint', envelope_id: id.draft });
    assert.throws(() => insert(f.db.sql, 'envelope_uploads', { sender_id: id.sender, request_key: 'synthetic-request-key', fingerprint: 'different-test-fingerprint', envelope_id: id.envelope }), /UNIQUE constraint failed/);
    f.db.sql.prepare('UPDATE signers SET auth_delivery_status=? WHERE id=?').run('accepted', id.signer);
    f.db.sql.prepare('UPDATE templates SET deletion_claim=? WHERE id=?').run('synthetic-claim', id.template);
    assert.equal(f.db.sql.prepare('SELECT auth_delivery_status FROM signers WHERE id=?').get(id.signer).auth_delivery_status, 'accepted');
    assert.equal(f.db.sql.prepare('SELECT deletion_claim FROM templates WHERE id=?').get(id.template).deletion_claim, 'synthetic-claim');
  } finally { f.db.sql.exec('ROLLBACK'); }
  for (const [table, snapshot] of Object.entries(f.before)) assert.deepEqual(rows(f.db.sql, table, snapshot.columns), snapshot.rows);
  proofs.push({ name: 'new_schema_usable', recoveryDefaultsVerified: true, uploadCompositeKeyRejectsDuplicate: true, signerAndTemplateColumnsWritable: true });
});

after(() => {
  const folder = new URL('output/private/', root);
  mkdirSync(folder, { recursive: true });
  writeFileSync(new URL('migration-0011-upgrade-evidence.json', folder), JSON.stringify({
    scope: 'LOCAL_SQLITE_SYNTHETIC_UPGRADE_ONLY', outcome: proofs.length === 3 ? 'DONE' : 'NOT DONE',
    generatedAt: new Date().toISOString(), candidate: candidateIdentity(),
    migration: { file: `migrations/${migration}`, sha256: sha256(readFileSync(new URL(`migrations/${migration}`, root))) },
    baseline: { file: 'schema.sql', sha256: sha256(readFileSync(new URL('schema.sql', root))),
      priorMigrations: priorMigrations.map(file => ({ file: `migrations/${file}`, sha256: sha256(readFileSync(new URL(`migrations/${file}`, root))) })) },
    checks: proofs, productionRowsRead: 0, productionWrites: 0, remoteR2Operations: 0, externalEmailsSent: 0,
    limits: 'This rehearsal proves additive preservation in local SQLite and actual source readback. It is not a production D1 migration execution or proof of remote platform bindings.',
  }, null, 2) + '\n');
});
