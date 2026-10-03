import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const sourceUrl = new URL('../src/index.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8').replace(/from '([^']+)'/g, (_, spec) =>
  `from '${spec.startsWith('.') ? new URL(spec, sourceUrl).href : pathToFileURL(require.resolve(spec)).href}'`);
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  for (const file of readdirSync(new URL('../migrations', import.meta.url)).filter(name => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) { return { bind(...args) { return {
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = []; for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const store = new Map(), sent = [];
  const env = { DB, ESTATE_BRIDGE_TOKEN: 'fixture-bridge', SESSION_SECRET: 'fixture-session',
    EMAIL: { async send(message) { sent.push(message); return { messageId: `fixture-${sent.length}` }; } },
    DOCS: {
      async put(key, value) { store.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); },
      async get(key) { const value = store.get(key); return value ? {
        body: value, async json() { return JSON.parse(new TextDecoder().decode(value)); },
        async arrayBuffer() { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); },
      } : null; },
      async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key); },
    },
  };
  const call = (path, method = 'GET', body) => worker.route(new Request(`https://sign.blacklabeltec.com${path}`,
    { method, headers: { 'x-estate-bridge': env.ESTATE_BRIDGE_TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { sqlite, env, store, sent, call };
}

const terms = { deal_id: 'UT:123', property_address: '123 Main Street, Salt Lake City, UT 84101',
  parcel_id: '123', state: 'UT', legal_description: 'Lot 1, Block 2, Example Subdivision',
  seller_name: 'Example Seller', seller_email: 'seller@example.com', seller_signer_name: 'Example Seller',
  seller_signer_capacity: 'Self', contract_buyer_name: 'Example Buyer LLC', buyer_email: 'buyer@example.com',
  buyer_signer_name: 'Jane Manager', buyer_signer_capacity: 'Manager',
  assignee_name: 'Example Assignee LLC', assignee_email: 'assignee@example.com',
  assignee_signer_name: 'Alex Manager', assignee_signer_capacity: 'Manager',
  title_company: 'Example Title', escrow_holder: 'Example Title', contract_date: '2026-09-23',
  closing_date: '2026-10-23', possession_date: '2026-10-23', purchase_price: '250000',
  earnest_money: '2500', assignment_fee: '15000', inspection_days: 10, title_objection_days: 5,
  property_type: 'residential', financing_type: 'cash', closing_costs: 'each_own', assignment_rights: 'consent' };

test('packet signing has real signer fields, exact reviewed invitations and signed-file state', async () => {
  const f = fixture();
  const made = await f.call('/api/estate/wholesale', 'POST', terms);
  assert.equal(made.status, 200);
  const { id } = await made.json();
  const manifest = JSON.parse(new TextDecoder().decode(f.store.get(`estate-wholesale/${id}/manifest.json`)));
  const packet = await PDFDocument.load(f.store.get(`estate-wholesale/${id}/packet.pdf`));
  assert.equal(manifest.execution_fields.length, 6);
  assert.ok(manifest.execution_fields.every(field => field.page === packet.getPageCount() - 1));
  assert.equal((await f.call(`/api/estate/wholesale/${id}/signing`)).status, 200);
  const path = `/api/estate/wholesale/${id}/signing`;
  const preview = await f.call(path, 'POST', { action: 'preview', sender_email: 'owner@example.com' });
  assert.equal(preview.status, 200);
  const { review, review_hash } = await preview.json();
  assert.deepEqual(review.map(item => item.role), ['seller', 'buyer', 'assignee']);
  assert.ok(review.every(item => item.from === 'sign@blacklabelbots.com' && item.reply_to === 'owner@example.com'));
  assert.equal(f.sent.length, 0);
  const envelopeId = f.sqlite.prepare('SELECT envelope_id FROM estate_wholesale_signing WHERE packet_id=?').get(id).envelope_id;
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM fields WHERE envelope_id=?').get(envelopeId).n, 6);
  const repeat = await f.call(path, 'POST', { action: 'preview', sender_email: 'owner@example.com' });
  assert.equal((await repeat.json()).review_hash, review_hash);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM estate_wholesale_signing').get().n, 1);
  const rejected = await f.call(path, 'POST', { action: 'send', sender_email: 'owner@example.com', approved_hash: 'wrong' });
  assert.equal(rejected.status, 409);
  assert.equal(f.sent.length, 0);
  const started = await f.call(path, 'POST', { action: 'send', sender_email: 'owner@example.com', approved_hash: review_hash });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).delivery.state, 'accepted');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to.email, 'seller@example.com');
  assert.equal(f.sent[0].text, review[0].text);
  assert.equal((await f.call(path, 'POST', { action: 'send', sender_email: 'owner@example.com', approved_hash: review_hash })).status, 409);
  const status = await (await f.call(path)).json();
  assert.equal(status.status, 'sent');
  assert.equal(status.signers.length, 3);
  assert.equal(status.signed_pdf_ready, false);
  assert.equal((await f.call(`/api/estate/wholesale/${id}/signed`)).status, 409);
  f.store.set(`final/${envelopeId}.pdf`, f.store.get(`estate-wholesale/${id}/packet.pdf`));
  f.sqlite.prepare("UPDATE envelopes SET status='completed', final_key=? WHERE id=?").run(`final/${envelopeId}.pdf`, envelopeId);
  assert.equal((await f.call(`/api/estate/wholesale/${id}/signed`)).status, 200);
});

test('long legal names keep full text and place signatures on separate pages', async () => {
  const f = fixture();
  const longTerms = { ...terms,
    seller_name: `The ${'Northwestern '.repeat(12)} Family Holdings Trust`,
    contract_buyer_name: `The ${'Intermountain '.repeat(12)} Development Company`,
    assignee_name: `The ${'Regional '.repeat(18)} Investment Partnership`,
  };
  const made = await f.call('/api/estate/wholesale', 'POST', longTerms);
  assert.equal(made.status, 200);
  const { id } = await made.json();
  const manifest = JSON.parse(new TextDecoder().decode(f.store.get(`estate-wholesale/${id}/manifest.json`)));
  const packet = await PDFDocument.load(f.store.get(`estate-wholesale/${id}/packet.pdf`));
  assert.equal(new Set(manifest.execution_fields.filter(field => field.type === 'signature').map(field => field.page)).size, 3);
  assert.equal(manifest.execution_fields.at(-1).page, packet.getPageCount() - 1);
  assert.equal((await f.call(`/api/estate/wholesale/${id}/signing`, 'POST',
    { action: 'preview', sender_email: 'owner@example.com' })).status, 200);
});

test('a non-assignment sale requests only seller and buyer signatures', async () => {
  const f = fixture();
  const sale = { ...terms, assignment_rights: 'prohibited', assignee_name: '',
    assignee_email: '', assignee_signer_name: '', assignee_signer_capacity: '', assignment_fee: '' };
  const made = await f.call('/api/estate/wholesale', 'POST', sale);
  assert.equal(made.status, 200);
  const { id } = await made.json();
  const manifest = JSON.parse(new TextDecoder().decode(f.store.get(`estate-wholesale/${id}/manifest.json`)));
  assert.deepEqual(manifest.signers.map(signer => signer.role), ['seller', 'buyer']);
  assert.deepEqual(manifest.execution_fields.map(field => field.type),
    ['signature', 'date', 'signature', 'date']);
  assert.equal((await f.call(`/api/estate/wholesale/${id}/signing`, 'POST',
    { action: 'preview', sender_email: 'owner@example.com' })).status, 200);
});
