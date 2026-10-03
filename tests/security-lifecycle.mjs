import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHarness, syntheticPdf, sha256 } from './helpers/worker-harness.mjs';
import { makePng } from './png-fixtures.mjs';

// Independent G3 reproductions. Actual Worker, isolated local SQLite/memory R2,
// synthetic documents and sandbox inbox only; no production or live email claims.
const checked = async (response, status = 200) => {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
};
const field = (type, y = .2) => ({ signer_index: 0, type, page: 0, x: .1, y, w: .3, h: .08 });

async function fixture(t, { bytes, fields = [field('signature', .4), field('text')], email = 'independent.sender@example.test' } = {}) {
  const h = await createHarness();
  t.after(() => h.close());
  const start = await h.request('/api/public/start', { method: 'POST', body: { name: 'INDEPENDENT SYNTHETIC TEST ONLY', email } });
  await checked(start.clone());
  const senderCookie = start.headers.get('set-cookie').split(';')[0];
  const request = (path, options = {}) => h.request(path, { cookie: senderCookie, ...options });
  const input = bytes || await syntheticPdf();
  const form = new FormData();
  form.set('title', 'BL SIGN INDEPENDENT TEST ONLY - NOT A CONTRACT');
  form.set('file', new File([input], 'TEST-ONLY.pdf', { type: 'application/pdf' }));
  const { id } = await checked(await request('/api/public/envelopes', { method: 'POST', form }));
  const setup = { signers: [{ name: 'INDEPENDENT RECIPIENT TEST ONLY', email: 'independent.signer@example.test' }], fields };
  await checked(await request(`/api/envelopes/${id}/setup`, { method: 'PUT', body: setup }));
  const read = () => request(`/api/envelopes/${id}`).then(checked);
  const send = (body = {}) => request(`/api/envelopes/${id}/send`, { method: 'POST', body });
  async function auth() {
    const state = await read();
    const signer = state.signers[0], path = `/api/session/${signer.token}`;
    await checked(await h.request(path + '/auth-request', { method: 'POST' }));
    const verified = await h.request(path + '/auth-verify', { method: 'POST', body: { code: h.inbox.latestCode(signer.email) } });
    await checked(verified.clone());
    const cookie = verified.headers.get('set-cookie').split(';')[0];
    return { signer, path, request: (suffix = '', options = {}) => h.request(path + suffix, { cookie, ...options }) };
  }
  const values = async () => Object.fromEntries((await read()).fields.map(f => [f.id,
    f.type === 'signature' ? { png: `data:image/png;base64,${makePng().toString('base64')}` } : { v: 'PLACEMENTMARKER' }]));
  async function complete(recipient) {
    await checked(await recipient.request('/consent', { method: 'POST' }));
    return recipient.request('/complete', { method: 'POST', body: { values: await values() } });
  }
  return { h, id, request, read, input, setup, send, auth, values, complete };
}

test('independent integrity: changed original bytes cannot be viewed or sealed under the accepted original hash', async t => {
  const f = await fixture(t); await checked(await f.send()); const a = await f.auth();
  const original = (await f.read()).envelope;
  const other = await PDFDocument.create(); other.addPage([500, 700]);
  const corrupted = await other.save();
  assert.notEqual(sha256(corrupted), original.original_sha256);
  await f.h.env.DOCS.put(original.original_key, corrupted, { customMetadata: { pages: '1' } });
  for (const response of [await f.request(`/api/envelopes/${f.id}/pdf`), await a.request('/pdf')])
    assert.ok(response.status >= 400, `Changed original leaked as PDF: HTTP ${response.status}`);
  assert.equal((await f.complete(a)).status, 409);
  const current = f.h.env.DB.sql.prepare('SELECT status,final_key,original_sha256,finalization_error FROM envelopes WHERE id=?').get(f.id);
  assert.notEqual(current.status, 'completed'); assert.equal(current.final_key, null);
  assert.equal(current.original_sha256, original.original_sha256);
  assert.equal(f.h.env.DB.sql.prepare('SELECT status FROM signers WHERE envelope_id=?').get(f.id).status, 'pending');
  assert.ok((await f.read()).fields.every(item => item.value === null));
});

test('independent integrity: original changed after acceptance leaves a visible sealing failure and preserves signer evidence', async t => {
  const f = await fixture(t); await checked(await f.send()); const a = await f.auth();
  const original = (await f.read()).envelope;
  const other = await PDFDocument.create(); other.addPage([500, 700]); const corrupted = await other.save();
  let reads = 0;
  f.h.env.DOCS.beforeGet = async key => {
    if (key === original.original_key && ++reads === 2) await f.h.env.DOCS.put(key, corrupted);
  };
  const log = console.error; console.error = () => {};
  try { assert.equal((await checked(await f.complete(a))).completed, false); } finally { console.error = log; }
  const state = await f.read();
  assert.notEqual(state.envelope.status, 'completed'); assert.equal(state.envelope.final_key, null);
  assert.ok(state.envelope.finalization_error); assert.equal(state.signers[0].status, 'signed');
  assert.equal(state.events.filter(item => item.type === 'signed').length, 1);
  assert.ok((await checked(await a.request())).finalizationError);
});

test('independent integrity: every final download rejects stored bytes that differ from the sealed final hash', async t => {
  const f = await fixture(t); await checked(await f.send()); const a = await f.auth();
  assert.equal((await checked(await f.complete(a))).completed, true);
  const completed = (await f.read()).envelope;
  await f.h.env.DOCS.put(completed.final_key, f.input);
  assert.notEqual(sha256(f.input), completed.final_sha256);
  for (const response of [await f.request(`/api/envelopes/${f.id}/final`), await a.request('/pdf'), await a.request('/download')])
    assert.ok(response.status >= 400, `Changed final leaked as signed PDF: HTTP ${response.status}`);
  assert.equal(f.h.env.DB.sql.prepare('SELECT final_sha256 FROM envelopes WHERE id=?').get(f.id).final_sha256, completed.final_sha256);
});

test('independent public contract: unsupported CC, parallel routing, templates, decline and reminders cannot be activated by API', async t => {
  const f = await fixture(t);
  const unsupported = await f.request(`/api/envelopes/${f.id}/setup`, { method: 'PUT', body: { ...f.setup,
    signers: [...f.setup.signers, { name: 'TEST COPY ONLY', email: 'copy@example.test', role: 'cc' }] } });
  assert.ok(unsupported.status >= 400, 'Public CC setup was accepted');
  assert.equal((await f.read()).signers.length, 1);
  assert.ok((await f.send({ routing: 'parallel' })).status >= 400, 'Public parallel routing was accepted');
  assert.equal((await f.read()).envelope.status, 'draft');
  assert.ok((await f.request('/api/templates', { method: 'POST', body: { envelope_id: f.id } })).status >= 400, 'Public template creation was accepted');
  await checked(await f.send()); const a = await f.auth();
  assert.ok((await a.request('/decline', { method: 'POST', body: { reason: 'SYNTHETIC TEST ONLY' } })).status >= 400, 'Public decline was accepted');
  f.h.env.DB.sql.prepare("UPDATE signers SET delivery_at='2000-01-01T00:00:00.000Z' WHERE envelope_id=?").run(f.id);
  assert.ok((await f.request(`/api/envelopes/${f.id}/resend`, { method: 'POST', body: { signer_id: a.signer.id } })).status >= 400, 'Public reminder was accepted');
  assert.equal((await f.read()).envelope.status, 'sent');
});

test('independent public contract: scheduler never adds an unrequested public reminder', async t => {
  const f = await fixture(t); await checked(await f.send());
  f.h.env.DB.sql.prepare("UPDATE envelopes SET sent_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.id);
  f.h.env.DB.sql.prepare("UPDATE signers SET delivery_at='2000-01-01T00:00:00.000Z' WHERE envelope_id=?").run(f.id);
  const accepted = f.h.inbox.accepted.length, jobs = [];
  await f.h.worker.scheduled({}, f.h.env, { waitUntil: promise => jobs.push(promise) });
  await Promise.all(jobs);
  assert.equal(f.h.inbox.accepted.length, accepted);
  assert.equal(f.h.env.DB.sql.prepare('SELECT reminder_count FROM signers WHERE envelope_id=?').get(f.id).reminder_count, 0);
});

test('independent closed links: voided requests stop code, consent, document and final access consistently', async t => {
  const f = await fixture(t); await checked(await f.send()); const a = await f.auth();
  await checked(await f.request(`/api/envelopes/${f.id}/void`, { method: 'POST' }));
  for (const [suffix, method] of [['', 'GET'], ['/pdf', 'GET'], ['/download', 'GET'], ['/auth-request', 'POST'], ['/auth-verify', 'POST'], ['/consent', 'POST'], ['/complete', 'POST']])
    assert.equal((await a.request(suffix, { method, ...(method === 'POST' ? { body: { code: '000000', values: {} } } : {}) })).status, 410, suffix);
});

test('independent cleanup: account deletion during delayed upload cannot recreate documents and reaps late object bytes', async t => {
  const f = await fixture(t);
  let resume, reached;
  const released = new Promise(resolve => { resume = resolve; }), arrival = new Promise(resolve => { reached = resolve; });
  f.h.env.DOCS.beforePut = async key => { if (key.startsWith('orig/')) { reached(); await released; } };
  const form = new FormData(); form.set('title', 'DELAYED SYNTHETIC TEST ONLY'); form.set('file', new File([f.input], 'TEST-ONLY.pdf'));
  const upload = f.request('/api/public/envelopes', { method: 'POST', form });
  await arrival;
  await checked(await f.request('/api/public/account', { method: 'DELETE' }));
  resume(); assert.equal((await upload).status, 409);
  assert.equal(f.h.env.DB.sql.prepare('SELECT COUNT(*) n FROM envelopes').get().n, 0);
  assert.equal(f.h.env.DB.sql.prepare('SELECT COUNT(*) n FROM senders').get().n, 0);
  const jobs = []; await f.h.worker.scheduled({}, f.h.env, { waitUntil: promise => jobs.push(promise) }); await Promise.all(jobs);
  assert.equal(f.h.env.DOCS.objects.size, 0);
});

test('independent signature input: a fully transparent image cannot count as a completed signature', async t => {
  const f = await fixture(t); await checked(await f.send()); const a = await f.auth();
  await checked(await a.request('/consent', { method: 'POST' }));
  const values = await f.values();
  const signature = (await f.read()).fields.find(item => item.type === 'signature');
  values[signature.id] = { png: `data:image/png;base64,${makePng({ pixels: [0, 0, 0, 0] }).toString('base64')}` };
  const objectCount = f.h.env.DOCS.objects.size;
  const response = await a.request('/complete', { method: 'POST', body: { values } });
  assert.equal(response.status, 400, 'An invisible signature image was accepted');
  const state = await f.read(); assert.equal(state.signers[0].status, 'pending');
  assert.equal(f.h.env.DOCS.objects.size, objectCount); assert.ok(state.fields.every(item => item.value === null));
});

test('independent PDF geometry: a text field cannot paint over document content outside its assigned box', async t => {
  const f = await fixture(t, { fields: [field('signature', .4), { ...field('text'), w: .02 }] });
  await checked(await f.send()); const a = await f.auth();
  const response = await f.complete(a);
  if (response.status >= 400) {
    const state = await f.read(); assert.equal(state.signers[0].status, 'pending'); return;
  }
  assert.equal((await checked(response)).completed, true);
  const task = getDocument({ data: new Uint8Array(await (await f.request(`/api/envelopes/${f.id}/final`)).arrayBuffer()), disableFontFace: true });
  try {
    const pdf = await task.promise, page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1 });
    const marker = (await page.getTextContent()).items.find(item => item.str === 'PLACEMENTMARKER');
    assert.ok(marker, 'Accepted text must remain represented in the final document');
    assert.ok(marker.width <= .02 * viewport.width + 2,
      `Text extends ${marker.width}pt across a ${.02 * viewport.width}pt field`);
  } finally { await task.destroy(); }
});

for (const rotation of [90, 180, 270]) test(`independent PDF geometry: signature and text retain viewed placement on a ${rotation}-degree page`, async t => {
  const pdf = await PDFDocument.load(await syntheticPdf()); pdf.getPage(0).setRotation(degrees(rotation));
  const f = await fixture(t, { bytes: await pdf.save() }); await checked(await f.send()); const a = await f.auth();
  assert.equal((await checked(await f.complete(a))).completed, true);
  await assertMarkerPlacement(f);
});

test('independent PDF geometry: cropped page placement follows the visible CropBox', async t => {
  const pdf = await PDFDocument.load(await syntheticPdf()); pdf.getPage(0).setCropBox(70, 110, 460, 580);
  const f = await fixture(t, { bytes: await pdf.save() }); await checked(await f.send()); const a = await f.auth();
  assert.equal((await checked(await f.complete(a))).completed, true);
  await assertMarkerPlacement(f);
});

async function assertMarkerPlacement(f) {
  const originalTask = getDocument({ data: new Uint8Array(await (await f.request(`/api/envelopes/${f.id}/pdf`)).arrayBuffer()), disableFontFace: true });
  const finalTask = getDocument({ data: new Uint8Array(await (await f.request(`/api/envelopes/${f.id}/final`)).arrayBuffer()), disableFontFace: true });
  try {
    const original = await originalTask.promise, final = await finalTask.promise;
    const before = (await original.getPage(1)).getViewport({ scale: 1 });
    const page = await final.getPage(1), viewport = page.getViewport({ scale: 1 });
    assert.equal(viewport.width, before.width); assert.equal(viewport.height, before.height);
    const marker = (await page.getTextContent()).items.find(item => item.str === 'PLACEMENTMARKER');
    assert.ok(marker, 'Completed PDF lost the accepted text field');
    const [x, y] = viewport.convertToViewportPoint(marker.transform[4], marker.transform[5]);
    assert.ok(x >= .1 * viewport.width - 2 && x <= .4 * viewport.width + 2 && y >= .2 * viewport.height - 2 && y <= .28 * viewport.height + 2,
      `Text moved away from its viewed field: normalized x=${x / viewport.width}, y=${y / viewport.height}`);
    const imageCenters = [], stack = []; let matrix = [1, 0, 0, 1, 0, 0];
    const operators = await page.getOperatorList();
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i], args = operators.argsArray[i];
      if (op === OPS.save) stack.push([...matrix]);
      else if (op === OPS.restore) matrix = stack.pop();
      else if (op === OPS.transform) matrix = multiply(matrix, args);
      else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject)
        imageCenters.push(viewport.convertToViewportPoint(matrix[0] / 2 + matrix[2] / 2 + matrix[4], matrix[1] / 2 + matrix[3] / 2 + matrix[5]));
    }
    assert.equal(imageCenters.length, 1, 'Completed PDF must contain the accepted signature image');
    const [sx, sy] = imageCenters[0];
    assert.ok(sx >= .1 * viewport.width - 2 && sx <= .4 * viewport.width + 2 && sy >= .4 * viewport.height - 2 && sy <= .48 * viewport.height + 2,
      `Signature moved away from its viewed field: normalized x=${sx / viewport.width}, y=${sy / viewport.height}`);
  } finally { await Promise.all([originalTask.destroy(), finalTask.destroy()]); }
}

const multiply = ([a,b,c,d,e,f], [g,h,i,j,k,l]) => [a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f];
