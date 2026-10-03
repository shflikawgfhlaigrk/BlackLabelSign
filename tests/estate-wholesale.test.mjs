import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { validateWholesaleTerms, buildWholesaleDrafts, WHOLESALE_DOCUMENT_KINDS } from '../src/estate-wholesale.mjs';

const require = createRequire(import.meta.url);
const sourceUrl = new URL('../src/index.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8').replace(/from '([^']+)'/g, (_, spec) =>
  `from '${spec.startsWith('.') ? new URL(spec, sourceUrl).href : pathToFileURL(require.resolve(spec)).href}'`);
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const terms = {
  deal_id: 'UT:123', property_address: '123 Main Street, Salt Lake City, UT 84101',
  parcel_id: '123', state: 'UT', legal_description: 'Lot 1, Block 2, Example Subdivision',
  seller_name: 'Example Seller', seller_email: 'seller@example.com', contract_buyer_name: 'Example Buyer LLC',
  seller_signer_name: 'Example Seller', seller_signer_capacity: 'Self',
  buyer_signer_name: 'Jane Manager', buyer_signer_capacity: 'Manager',
  buyer_email: 'buyer@example.com', assignee_name: 'Example Assignee LLC', assignee_email: 'assignee@example.com',
  assignee_signer_name: 'Alex Manager', assignee_signer_capacity: 'Manager',
  title_company: 'Example Title', escrow_holder: 'Example Title',
  contract_date: '2026-09-23', closing_date: '2026-10-23', possession_date: '2026-10-23',
  purchase_price: '250000', earnest_money: '2500', assignment_fee: '15000', inspection_days: 10,
  title_objection_days: 5, property_type: 'residential', financing_type: 'cash', closing_costs: 'each_own', assignment_rights: 'allowed',
};
const store = new Map();
const sent = [];
const env = { ESTATE_BRIDGE_TOKEN: 'local-fixture-only', SESSION_SECRET: 'synthetic-session-secret',
  DB: { prepare() { return { bind() { return this; } }; }, async batch() { return [{ meta: { changes: 1 } }]; } },
  EMAIL: { async send(message) { sent.push(message); return { messageId: 'test-message-1' }; } },
  DOCS: {
  async put(key, value) { store.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)); },
  async get(key) { const value = store.get(key); return value ? { body: value,
    async json() { return JSON.parse(new TextDecoder().decode(value)); },
    async arrayBuffer() { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } } : null; },
  async delete(keys) { for (const key of keys) store.delete(key); },
} };
const request = (path, method = 'GET', body, token = env.ESTATE_BRIDGE_TOKEN) =>
  new Request(`https://sign.blacklabeltec.com${path}`, {
    method, headers: { 'x-estate-bridge': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('wholesale terms require explicit names, legal description, dates, and money', () => {
  assert.equal(validateWholesaleTerms({ ...terms, seller_name: '' }).ok, false);
  assert.equal(validateWholesaleTerms({ ...terms, closing_date: '2026-09-01' }).ok, false);
  assert.equal(validateWholesaleTerms({ ...terms, purchase_price: '0' }).ok, false);
  assert.equal(validateWholesaleTerms(terms).ok, true);
  assert.equal(validateWholesaleTerms({ ...terms, earnest_money: '0', assignment_fee: '0', possession_date: '2026-10-01' }).ok, true);
  assert.equal(validateWholesaleTerms({ ...terms, financing_type: 'conventional', loan_amount: '200000', financing_deadline: '2026-11-01' }).ok, false);
});

test('every generated draft is a distinct parseable PDF', async () => {
  const drafts = await buildWholesaleDrafts(validateWholesaleTerms(terms).terms);
  assert.notDeepEqual(drafts.purchase, drafts.assignment);
  assert.deepEqual(Object.keys(drafts), WHOLESALE_DOCUMENT_KINDS.filter(kind => kind !== 'packet'));
  for (const kind of Object.keys(drafts)) {
    assert.equal(new TextDecoder().decode(drafts[kind].slice(0, 5)), '%PDF-');
    assert.ok((await PDFDocument.load(drafts[kind])).getPageCount() >= 1);
  }
});

test('property riders cover each type and a prohibited assignment omits the assignment draft', async () => {
  for (const property_type of ['residential', 'land', 'commercial', 'new_construction', 'other']) {
    const checked = validateWholesaleTerms({ ...terms, property_type, assignment_rights: 'prohibited',
      assignee_name: '', assignee_email: '', assignment_fee: '' });
    assert.equal(checked.ok, true, property_type);
    const drafts = await buildWholesaleDrafts(checked.terms);
    assert.equal('assignment' in drafts, false);
    assert.ok((await PDFDocument.load(drafts.rider)).getPageCount() >= 1);
  }
});

test('estate bridge keeps all drafts private and serves them through opaque packet id', async () => {
  let response = await worker.route(request('/api/estate/wholesale', 'POST', terms, 'wrong'), env);
  assert.equal(response.status, 401);
  response = await worker.route(request('/api/estate/wholesale', 'POST', { ...terms, assignee_name: '' }), env);
  assert.equal(response.status, 400);
  response = await worker.route(request('/api/estate/wholesale', 'POST', terms), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(result.documents, WHOLESALE_DOCUMENT_KINDS);
  for (const kind of result.documents) {
    const path = `/api/estate/wholesale/${result.id}/${kind}`;
    assert.equal((await worker.route(request(path, 'GET', null, 'wrong'), env)).status, 401);
    const pdf = await worker.route(request(path), env);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.match(pdf.headers.get('content-disposition'), /attachment/);
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.ok((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount() >= 1);
  }
});

test('email preview displays exact message and send requires matching review hash', async () => {
  const created = await worker.route(request('/api/estate/wholesale', 'POST', terms), env);
  const { id } = await created.json();
  const path = `/api/estate/wholesale/${id}/email`;
  const delivery = { action: 'preview', recipient_name: 'Example Seller', recipient_email: 'seller@example.com',
    sender_email: 'buyer@example.com', note: 'Please review the attached drafts.' };
  const preview = await worker.route(request(path, 'POST', delivery), env);
  assert.equal(preview.status, 200);
  const review = await preview.json();
  assert.equal(review.review.from, 'sign@blacklabelbots.com');
  assert.match(review.review.text, /Please review the attached drafts/);
  const denied = await worker.route(request(path, 'POST', { ...delivery, action: 'send', approved_hash: 'wrong' }), env);
  assert.equal(denied.status, 409);
  assert.equal(sent.length, 0);
  const accepted = await worker.route(request(path, 'POST', { ...delivery, action: 'send', approved_hash: review.review_hash }), env);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).message_id, 'test-message-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments[0].type, 'application/pdf');
  assert.ok((await PDFDocument.load(sent[0].attachments[0].content)).getPageCount() >= 7);
});
