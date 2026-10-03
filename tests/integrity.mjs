import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { makePng, chunk, rgbaPixels } from './png-fixtures.mjs';

// Load the exact Worker source as ESM; only module URLs change for Node.
const require = createRequire(import.meta.url);
const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  .replace(/from '([^']+)'/g, (_, spec) => `from '${spec.startsWith('.')
    ? new URL(spec, new URL('../src/index.js', import.meta.url)).href
    : pathToFileURL(require.resolve(spec)).href}'`);
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = makePng();
const imageValue = bytes => ({ png: `data:image/png;base64,${bytes.toString('base64')}` });
const gate = () => {
  let entered, release;
  const reached = new Promise(r => { entered = r; });
  const resume = new Promise(r => { release = r; });
  return { reached, release, wait: async () => { entered(); await resume; } };
};

class D1 {
  constructor() {
    this.sql = new DatabaseSync(':memory:');
    this.sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort())
      this.sql.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  prepare(query) {
    const db = this;
    return { args: [], query,
      bind(...args) { this.args = args; return this; },
      async first() { return db.sql.prepare(query).get(...this.args) || null; },
      async all() { return { results: db.sql.prepare(query).all(...this.args) }; },
      async run() {
        if(db.beforeRun)await db.beforeRun(this);
        return { meta: { changes: Number(db.sql.prepare(query).run(...this.args).changes) } };
      },
    };
  }
  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch(statements);
    // No await between BEGIN and COMMIT: matches D1's serial, atomic batch contract.
    this.sql.exec('BEGIN');
    try {
      const result = statements.map(s => ({ meta: { changes: Number(this.sql.prepare(s.query).run(...s.args).changes) } }));
      this.sql.exec('COMMIT'); return result;
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
}
class R2 {
  objects = new Map();
  async put(key, data, options = {}) {
    if (this.beforePut) await this.beforePut(key);
    this.objects.set(key, { bytes: Buffer.from(data), ...options });
  }
  async head(key) { return this.objects.get(key) || null; }
  async get(key) {
    if (this.beforeGet) await this.beforeGet(key);
    const o = this.objects.get(key);
    if (!o) return null;
    return { ...o, body: Uint8Array.from(o.bytes), arrayBuffer: async () => Uint8Array.from(o.bytes).buffer };
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
}
async function fixture({ count = 1, routing = 'sequential' } = {}) {
  const env = { DB: new D1(), DOCS: new R2(), ADMIN_TOKEN: 'synthetic-admin', SESSION_SECRET: 'synthetic-session',
    emails: [], EMAIL: { async send(mail) { env.emails.push(mail); return { messageId: `mock-${env.emails.length}` }; } } };
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]); const bytes = await pdf.save();
  const id = 'a'.repeat(32), key = `orig/${id}.pdf`;
  await env.DOCS.put(key, bytes, { customMetadata: { pages: '1' } });
  env.DB.sql.prepare('INSERT INTO envelopes (id,title,created_at,original_key,original_sha256,routing) VALUES (?,?,?,?,?,?)')
    .run(id, 'Synthetic agreement', new Date().toISOString(), key, hash(bytes), routing);
  const headers = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
  const request = (path, { method = 'GET', body, auth = headers, held, form } = {}) => {
    const req = new Request(`https://sign.example${path}`, { method, headers: auth });
    if (body !== undefined) req.json = async () => { if (held) await held.wait(); return body; };
    if (form) req.formData = async () => { if (held) await held.wait(); return form; };
    return worker.fetch(req, env);
  };
  const setupBody = { signers: Array.from({ length: count }, (_, i) => ({ name: `Signer ${i}`, email: `signer${i}@example.com` })),
    fields: Array.from({ length: count }, (_, i) => [
      { signer_index: i, type: 'signature', page: 0, x: .1, y: .1 + i * .2, w: .3, h: .1 },
      { signer_index: i, type: 'text', page: 0, x: .5, y: .1 + i * .2, w: .2, h: .1 },
    ]).flat() };
  const setup = body => request(`/api/envelopes/${id}/setup`, { method: 'PUT', body: body || setupBody });
  assert.equal((await setup()).status, 200);
  const envelope = () => env.DB.sql.prepare('SELECT * FROM envelopes WHERE id=?').get(id);
  const signers = () => env.DB.sql.prepare('SELECT * FROM signers WHERE envelope_id=? ORDER BY order_index').all(id);
  const fields = () => env.DB.sql.prepare('SELECT * FROM fields WHERE envelope_id=? ORDER BY id').all(id);
  const send = (held, body = { routing }) => request(`/api/envelopes/${id}/send`, { method: 'POST', body, held });
  const session = (i, sub, options = {}) => {
    const s = signers()[i], expiry = Date.now() + 3600_000;
    const signature = createHmac('sha256', env.SESSION_SECRET).update(`${s.id}:${s.token}:${expiry}`).digest('hex');
    return request(`/api/session/${s.token}${sub}`, { ...options,
      auth: { cookie: `blsa_${s.id.slice(0, 24)}=${expiry}.${signature}` } });
  };
  const values = (i, label = 'accepted', image = png) => ({ values: Object.fromEntries(fields()
    .filter(f => f.signer_id === signers()[i].id).map(f => [f.id, f.type === 'signature' ? imageValue(image) : { v: label }])) });
  const consent = i => session(i, '/consent', { method: 'POST' });
  const complete = (i, held, label, image) => session(i, '/complete', { method: 'POST', body: values(i, label, image), held });
  const voidEnvelope = () => request(`/api/envelopes/${id}/void`, { method: 'POST' });
  const addForm = new FormData(); addForm.set('file', new File([bytes], 'append.pdf', { type: 'application/pdf' }));
  const snapshot = () => ({ envelope: envelope(), signers: signers().map(({ delivery_at, ...s }) => s), fields: fields(),
    objects: [...env.DOCS.objects].map(([k,v]) => [k,hash(v.bytes)]).sort() });
  return { env, id, request, setup, setupBody, send, session, consent, complete, values, voidEnvelope,
    envelope, signers, fields, snapshot, addForm };
}
const checked = async response => { const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };

test('F063: invalid PNG changes no accepted state or storage', async () => {
  const f=await fixture({count:2});await checked(await f.send());await checked(await f.consent(0));
  const before=f.snapshot(),events=f.env.DB.sql.prepare('SELECT * FROM events').all();
  assert.equal((await f.complete(0,undefined,'rejected',png.subarray(0,-3))).status,400);
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.env.DB.sql.prepare('SELECT * FROM events').all(),events);
  assert.equal((await checked(await f.complete(0))).completed,false);
});
test('F063: truncated terminal metadata is rejected before parser or signer commit',async()=>{
  const f=await fixture();await checked(await f.send());await checked(await f.consent(0));
  const input=makePng({extra:[chunk('tEXt',Buffer.alloc(2048,65))]}).subarray(0,-12);
  const before=f.snapshot();assert.equal((await f.complete(0,undefined,'rejected',input)).status,400);assert.deepEqual(f.snapshot(),before);
});
for(const type of ['tEXt','iTXt'])test(`F063: unterminated ${type} cannot stall signing or public verification`,async()=>{
  const f=await fixture();await checked(await f.send());await checked(await f.consent(0));
  const input=makePng({extra:[chunk(type,Buffer.alloc(2048,65))]});
  assert.equal((await checked(await f.complete(0,undefined,'accepted',input))).completed,true);
  const field=f.fields().find(x=>x.type==='signature'),stored=f.env.DOCS.objects.get(field.signature_key).bytes;
  assert.equal(stored.includes(Buffer.from(type)),false);assert.deepEqual([...rgbaPixels(stored)],[0,40,50,60,255]);
  const accepted=f.snapshot();for(let i=0;i<3;i++){const r=await f.request(`/verify/${f.id}`);assert.equal(r.status,200);assert.match(await r.text(),new RegExp(f.envelope().final_sha256));}
  assert.deepEqual(f.snapshot(),accepted);
});
test('F063: corrupt legacy signature stops read retries and preserves evidence',async()=>{
  const f=await fixture();await checked(await f.send());await checked(await f.consent(0));
  f.env.DB.sql.prepare("UPDATE signers SET status='signed',signed_at=?").run(new Date().toISOString());
  const field=f.fields().find(x=>x.type==='signature'),key=`sig/${field.id}.png`,corrupt=png.subarray(0,-3);
  f.env.DB.sql.prepare("UPDATE fields SET value='png' WHERE id=?").run(field.id);await f.env.DOCS.put(key,corrupt);
  const fields=f.fields(),signers=f.signers(),originalHash=f.envelope().original_sha256;let imageReads=0;
  f.env.DOCS.beforeGet=async k=>{if(k===key)imageReads++;};
  const r=await f.request(`/verify/${f.id}`);assert.equal(r.status,200);assert.match(await r.text(),/Completion paused/);
  assert.equal(f.envelope().finalization_error,'invalid_signature_image');assert.equal(f.envelope().final_key,null);
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='sealing-failed'").get().n,1);
  const reads=imageReads;for(let i=0;i<4;i++)await f.request(`/verify/${f.id}`);await f.request(`/api/envelopes/${f.id}`);
  assert.equal(imageReads,reads);assert.deepEqual(f.fields(),fields);assert.deepEqual(f.signers(),signers);
  assert.equal(f.envelope().original_sha256,originalHash);assert.deepEqual(f.env.DOCS.objects.get(key).bytes,corrupt);
  await checked(await f.voidEnvelope());assert.equal(f.envelope().status,'voided');
});
test('F063: concurrent invalid-asset reads persist one failure event',async()=>{
  const f=await fixture();await checked(await f.send());await checked(await f.consent(0));
  const field=f.fields().find(x=>x.type==='signature');f.env.DB.sql.prepare("UPDATE signers SET status='signed'").run();
  f.env.DB.sql.prepare("UPDATE fields SET value='png' WHERE id=?").run(field.id);await f.env.DOCS.put(`sig/${field.id}.png`,png.subarray(0,-3));
  const results=await Promise.all(Array.from({length:5},()=>f.request(`/verify/${f.id}`)));
  assert.ok(results.every(r=>r.status===200));assert.equal(f.envelope().finalization_error,'invalid_signature_image');
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='sealing-failed'").get().n,1);
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='completed'").get().n,0);
});

// Authentication uses ordinary unauthenticated signer requests and synthetic
// challenges, never the fixture's pre-authenticated session helper.
async function authFixture() {
  const f = await fixture(); await checked(await f.send());
  const sid = f.signers()[0].id, token = f.signers()[0].token;
  const verify = (code, held) => f.request(`/api/session/${token}/auth-verify`, { method: 'POST', body: { code }, held, auth: {} });
  const issue = () => f.request(`/api/session/${token}/auth-request`, { method: 'POST', auth: {} });
  const seed = (code = '123456', failures = 0, expired = false) => {
    const h = hash(Buffer.from(`${f.env.SESSION_SECRET}:${sid}:${token}:${code}`));
    f.env.DB.sql.prepare('UPDATE signers SET auth_code_hash=?,auth_code_expires_at=?,auth_code_sent_at=?,auth_failures=? WHERE id=?')
      .run(h, new Date(Date.now() + (expired ? -60000 : 600000)).toISOString(), new Date(Date.now()-120000).toISOString(), failures, sid);
    const columns=f.env.DB.sql.prepare('PRAGMA table_info(signers)').all();
    if(columns.some(c=>c.name==='auth_challenge_id'))f.env.DB.sql.prepare('UPDATE signers SET auth_challenge_id=? WHERE id=?').run(crypto.randomUUID(),sid);
  };
  seed();return { ...f, sid, token, verify, issue, seed };
}

test('F070: twenty parallel incorrect codes reserve only five attempts', async () => {
  const f=await authFixture(), holds=Array.from({length:20},gate);
  const requests=holds.map((g,i)=>f.verify(String(200000+i),g));await Promise.all(holds.map(g=>g.reached));holds.forEach(g=>g.release());
  const responses=await Promise.all(requests);assert.equal(responses.filter(r=>r.status===401).length,5);assert.equal(responses.filter(r=>r.status===429).length,15);
  assert.equal(f.signers()[0].auth_failures,5);assert.ok(responses.every(r=>!r.headers.get('set-cookie')));
});
test('F070: a correct guess held until the budget is exhausted is rejected', async () => {
  const f=await authFixture(),hold=gate(),pending=f.verify('123456',hold);await hold.reached;
  for(let i=0;i<5;i++)assert.equal((await f.verify('000000')).status,401);
  hold.release();const r=await pending;assert.equal(r.status,429);assert.equal(r.headers.get('set-cookie'),null);
});
test('F070: parallel correct submissions issue only one cookie and audit event', async () => {
  const f=await authFixture(),holds=Array.from({length:8},gate);const pending=holds.map(g=>f.verify('123456',g));await Promise.all(holds.map(g=>g.reached));holds.forEach(g=>g.release());
  const responses=await Promise.all(pending);assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.headers.has('set-cookie')).length,1);
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='email-authenticated'").get().n,1);
});
for(const correct of [false,true])test(`F070: stale ${correct?'correct':'incorrect'} request cannot act on replacement challenge`,async()=>{
  const f=await authFixture(),hold=gate(),pending=f.verify(correct?'123456':'000000',hold);await hold.reached;
  f.seed('654321');const before=f.signers()[0];hold.release();const r=await pending;assert.ok([409,410].includes(r.status));assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual(f.signers()[0],before);
});
test('F070: expiry during a delayed verification is enforced at commit',async()=>{
  const f=await authFixture(),hold=gate(),pending=f.verify('123456',hold);await hold.reached;
  f.env.DB.sql.prepare("UPDATE signers SET auth_code_expires_at='2000-01-01T00:00:00.000Z'").run();hold.release();const r=await pending;assert.ok([409,410].includes(r.status));assert.equal(r.headers.get('set-cookie'),null);
});
test('F070: correct fifth attempt authenticates; replay and malformed input fail',async()=>{
  const f=await authFixture();for(const code of ['12345','abcdef','１２３４５６'])assert.equal((await f.verify(code)).status,400);
  assert.equal(f.signers()[0].auth_failures,0);for(let i=0;i<4;i++)assert.equal((await f.verify('000000')).status,401);
  const r=await f.verify('123456');assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');assert.ok(cookie);assert.equal((await f.verify('123456')).status,410);
  const session=await f.request(`/api/session/${f.token}`,{auth:{cookie:cookie.split(';')[0]}});assert.equal(session.status,200);assert.equal((await session.json()).authRequired,undefined);
});
test('F070: resend replaces exhausted challenge; only current code authenticates',async()=>{
  const f=await authFixture();f.seed('123456',5);await checked(await f.issue());const mail=f.env.emails.at(-1);const code=mail.subject.match(/\d{6}/)[0];assert.equal(f.signers()[0].auth_failures,0);
  assert.equal((await f.issue()).status,429);assert.equal((await f.verify(code)).status,200);
});
for(const change of ['replacement','expiry'])test(`F070: ${change} after reservation prevents cookie issuance`,async()=>{
  const f=await authFixture(),hold=gate();let held=false;
  f.env.DB.beforeRun=async s=>{if(!held&&s.query.includes('last_authenticated_at=?')){held=true;await hold.wait();}};
  const pending=f.verify('123456');await hold.reached;
  if(change==='replacement')f.seed('654321');else f.env.DB.sql.prepare("UPDATE signers SET auth_code_expires_at='2000-01-01T00:00:00.000Z'").run();
  const before=f.signers()[0];hold.release();const r=await pending;assert.equal(r.status,410);assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual(f.signers()[0],before);
});
test('F070: delayed challenge publisher cannot replace a newer generation',async()=>{
  const f=await authFixture(),hold=gate();let held=false;
  f.env.DB.beforeRun=async s=>{if(!held&&s.query.includes('SET auth_challenge_id=?')){held=true;await hold.wait();}};
  const pending=f.issue();await hold.reached;f.seed('654321');const before=f.signers()[0];hold.release();assert.equal((await pending).status,429);assert.deepEqual(f.signers()[0],before);
});
test('F070: older email failure cannot clear a newer challenge',async()=>{
  const f=await authFixture(),hold=gate();f.env.EMAIL.send=async()=>{await hold.wait();throw new Error('synthetic provider failure');};
  const pending=f.issue();await hold.reached;f.seed('654321');const before=f.signers()[0];hold.release();assert.equal((await pending).status,502);assert.deepEqual(f.signers()[0],before);
});

for (const operation of ['setup', 'send', 'adddoc']) test(`delayed ${operation} cannot mutate a completed envelope`, { timeout: 5000 }, async () => {
  const f = await fixture(); const hold = gate();
  const pending = f.request(`/api/envelopes/${f.id}/${operation}`, { method: operation === 'setup' ? 'PUT' : 'POST', held: hold,
    ...(operation === 'adddoc' ? { form: f.addForm } : { body: operation === 'setup' ? { signers: [], fields: [] } : {} }) });
  await hold.reached; await checked(await f.send()); await checked(await f.consent(0)); await checked(await f.complete(0));
  const before = f.snapshot(); hold.release(); const loser = await pending;
  assert.ok(loser.status >= 400 && loser.status < 500, `delayed write returned ${loser.status}`);
  assert.deepEqual(f.snapshot(), before);
});

test('empty required-signer roster never creates a completion certificate', async () => {
  const f = await fixture({ count: 0 });
  f.env.DB.sql.prepare("UPDATE envelopes SET status='sent'").run();
  await f.request(`/api/envelopes/${f.id}`);
  assert.equal(f.envelope().status, 'sent'); assert.equal(f.envelope().final_key, null);
});

test('duplicate completion preserves winning PNG, text, final hash and signed event', async () => {
  const f = await fixture({ count: 2 }); await checked(await f.send()); await checked(await f.consent(0));
  const hold = gate(); const pending = f.complete(0, hold, 'rejected', makePng({pixels:[90,80,70,255]}));
  await hold.reached; await checked(await f.complete(0)); const before = f.snapshot();
  hold.release(); assert.equal((await pending).status, 409); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='signed'").get().n, 1);
  await checked(await f.consent(1)); assert.equal((await checked(await f.complete(1))).completed, true);
  const accepted = f.envelope(); assert.equal(hash(f.env.DOCS.objects.get(accepted.final_key).bytes), accepted.final_sha256);
});

for (const terminal of ['void', 'decline', 'expiry']) test(`delayed completion cannot beat ${terminal}`, async () => {
  const f = await fixture({ count: 2, routing: 'parallel' }); await checked(await f.send()); await checked(await f.consent(0));
  const hold = gate(); const pending = f.complete(0, hold); await hold.reached;
  if (terminal === 'void') await checked(await f.voidEnvelope());
  if (terminal === 'decline') await checked(await f.session(1, '/decline', { method: 'POST', body: { reason: 'No' } }));
  if (terminal === 'expiry') f.env.DB.sql.prepare("UPDATE envelopes SET expires_at='2000-01-01T00:00:00.000Z'").run();
  const before = f.snapshot(); hold.release(); const r = await pending;
  assert.ok(r.status >= 400 && r.status < 500); assert.deepEqual(f.snapshot(), before);
});

test('staged final PDF cannot resurrect a voided envelope', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  const hold = gate(); let held = false;
  f.env.DOCS.beforePut = async key => { if (key.startsWith('final/') && !held) { held = true; await hold.wait(); } };
  const pending = f.complete(0); await hold.reached;
  // Another already-authorized void request reaches its SQL update during finalization.
  f.env.DB.sql.prepare("UPDATE envelopes SET status='voided'").run();
  hold.release(); const result = await checked(await pending);
  assert.equal(f.envelope().status, 'voided'); assert.equal(f.envelope().final_key, null);
  assert.notEqual(result.completed, true);
  assert.equal([...f.env.DOCS.objects.keys()].filter(k => k.startsWith('final/')).length, 0);
});

test('ordinary add-document, setup, parallel signing, CC, download and verification', async () => {
  const f = await fixture({ count: 2, routing: 'parallel' });
  await checked(await f.request(`/api/envelopes/${f.id}/adddoc`, { method: 'POST', form: f.addForm }));
  f.setupBody.signers.push({ name: 'Copy', email: 'copy@example.com', role: 'cc' }); await checked(await f.setup());
  await checked(await f.send()); await Promise.all([f.consent(0), f.consent(1)]);
  await checked(await f.complete(1)); await checked(await f.complete(0));
  assert.equal(f.envelope().status, 'completed'); assert.equal(f.signers()[2].status, 'pending');
  const download = await f.session(2, '/download'); assert.equal(download.status, 200);
  assert.equal(hash(Buffer.from(await download.arrayBuffer())), f.envelope().final_sha256);
  const verify = await f.request(`/verify/${f.id}`); assert.match(await verify.text(), new RegExp(f.envelope().final_sha256));
  assert.ok(f.env.emails.some(m => m.subject.startsWith('Completed:')));
});

test('unauthorized, out-of-turn and missing consent attempts leave evidence untouched', async () => {
  const f = await fixture({ count: 2 }); await checked(await f.send()); const before = f.snapshot();
  assert.equal((await f.request(`/api/session/${f.signers()[0].token}/complete`, { method: 'POST', body: f.values(0), auth: {} })).status, 401);
  assert.equal((await f.complete(1)).status, 400); assert.equal((await f.complete(0)).status, 400);
  assert.deepEqual(f.snapshot(), before);
});

test('invalid later field cannot leave staged signature artifacts', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0)); const before = f.snapshot();
  const body = f.values(0); for (const v of Object.values(body.values)) if ('v' in v) v.v = '';
  assert.equal((await f.session(0, '/complete', { method: 'POST', body })).status, 400);
  assert.deepEqual(f.snapshot(), before);
});

for (const op of ['setup', 'send', 'adddoc']) test(`a newer draft revision defeats stale ${op}`, async () => {
  const f = await fixture(); const hold = gate();
  const pending = f.request(`/api/envelopes/${f.id}/${op}`, { method: op === 'setup' ? 'PUT' : 'POST', held: hold,
    ...(op === 'adddoc' ? { form: f.addForm } : { body: op === 'setup' ? { signers: [], fields: [] } : {} }) });
  await hold.reached; await checked(await f.setup()); const before = f.snapshot(); hold.release();
  assert.equal((await pending).status, 409); assert.deepEqual(f.snapshot(), before);
});

test('simultaneous parallel signers both commit; completion publishes once', async () => {
  const f = await fixture({ count: 2, routing: 'parallel' }); await checked(await f.send());
  await Promise.all([f.consent(0), f.consent(1)]);
  for (const r of await Promise.all([f.complete(0), f.complete(1)])) await checked(r);
  assert.equal(f.signers().filter(s => s.status === 'signed').length, 2);
  assert.equal(f.envelope().status, 'completed');
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='completed'").get().n, 1);
  assert.equal([...f.env.DOCS.objects.keys()].filter(k => k.startsWith('final/')).length, 1);
});

test('delayed void cannot overwrite completion', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  const hold = gate(); let held = false;
  f.env.DB.beforeBatch = async statements => {
    if (!held && statements[0].query.includes("status='voided'")) { held = true; await hold.wait(); }
  };
  const pending = f.voidEnvelope(); await hold.reached; await checked(await f.complete(0));
  const before = f.snapshot(); hold.release(); assert.equal((await pending).status, 409); assert.deepEqual(f.snapshot(), before);
});

for (const sub of ['consent', 'decline']) test(`delayed ${sub} cannot change a voided envelope`, async () => {
  const f = await fixture(); await checked(await f.send()); const hold = gate(); let held = false;
  f.env.DB.beforeBatch = async statements => {
    if (!held && statements.some(s => sub === 'consent' ? s.query.includes('SET consent_at=') : s.query.includes("SET status='declined'"))) {
      held = true; await hold.wait();
    }
  };
  const pending = f.session(0, `/${sub}`, { method: 'POST', body: {} }); await hold.reached;
  await checked(await f.voidEnvelope()); const before = f.snapshot(); hold.release();
  assert.equal((await pending).status, 409); assert.deepEqual(f.snapshot(), before);
});

test('failed sealing retries once on read without replacing accepted evidence', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  f.env.DOCS.beforePut = async key => { if (key.startsWith('final/')) throw new Error('synthetic R2 outage'); };
  const originalError = console.error; console.error = () => {};
  let result; try { result = await checked(await f.complete(0)); } finally { console.error = originalError; }
  assert.equal(result.sealing, true); assert.equal(f.signers()[0].status, 'signed');
  const fields = f.fields(); f.env.DOCS.beforePut = null;
  await Promise.all([f.request(`/verify/${f.id}`), f.request(`/api/envelopes/${f.id}`)]);
  assert.equal(f.envelope().status, 'completed'); assert.deepEqual(f.fields(), fields);
  assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM events WHERE type='completed'").get().n, 1);
});

test('D1 batch failure rolls back signer, fields, event and object references', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0)); const before = f.snapshot();
  f.env.DB.sql.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON events WHEN NEW.type='signed' BEGIN SELECT RAISE(ABORT,'synthetic DB failure'); END");
  const originalError = console.error; console.error = () => {};
  try { assert.equal((await f.complete(0)).status, 500); } finally { console.error = originalError; }
  assert.deepEqual(f.snapshot(), before);
});

test('envelope deletion removes all immutable originals, signatures and final objects', async () => {
  const f = await fixture(); await checked(await f.request(`/api/envelopes/${f.id}/adddoc`, { method: 'POST', form: f.addForm }));
  await checked(await f.send()); await checked(await f.consent(0)); await checked(await f.complete(0));
  assert.ok(f.env.DOCS.objects.size >= 4);
  await checked(await f.request(`/api/envelopes/${f.id}`, { method: 'DELETE' }));
  assert.equal(f.env.DOCS.objects.size, 0);
  for (const table of ['envelopes', 'signers', 'fields', 'events', 'envelope_objects'])
    assert.equal(f.env.DB.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('signature staged during deletion loses publication and is removed', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  const hold = gate(); f.env.DOCS.beforePut = key => key.startsWith('sig/') ? hold.wait() : undefined;
  const pending = f.complete(0); await hold.reached;
  await checked(await f.request(`/api/envelopes/${f.id}`, { method: 'DELETE' })); hold.release();
  assert.equal((await pending).status, 409); assert.equal(f.env.DOCS.objects.size, 0);
  assert.equal(f.env.DB.sql.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
});

test('legacy signature keys still seal and delete', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  f.env.DB.sql.prepare("UPDATE signers SET status='signed',signed_at=?").run(new Date().toISOString());
  for (const field of f.fields()) {
    f.env.DB.sql.prepare('UPDATE fields SET value=? WHERE id=?').run(field.type === 'signature' ? 'png' : 'legacy', field.id);
    if (field.type === 'signature') await f.env.DOCS.put(`sig/${field.id}.png`, png);
  }
  await f.request(`/verify/${f.id}`); assert.equal(f.envelope().status, 'completed');
  await checked(await f.request(`/api/envelopes/${f.id}`, { method: 'DELETE' })); assert.equal(f.env.DOCS.objects.size, 0);
});

test('template reuse creates an independent editable envelope', async () => {
  const f = await fixture(); const template = await checked(await f.request('/api/templates', { method: 'POST', body: { envelope_id: f.id, name: 'Fixture' } }));
  const used = await checked(await f.request(`/api/templates/${template.id}/use`, { method: 'POST', body: {} }));
  assert.notEqual(used.id, f.id);
  const copy = await checked(await f.request(`/api/envelopes/${used.id}`)); assert.equal(copy.signers.length, 1);
  assert.notEqual(copy.envelope.original_key, f.envelope().original_key);
  await checked(await f.request(`/api/envelopes/${used.id}/send`, { method: 'POST', body: {} }));
  assert.equal(f.envelope().status, 'draft');
});

test('DB outage after staging retains a cleanup reference through retry and deletion', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  const prepare = f.env.DB.prepare.bind(f.env.DB); let unavailable = false;
  f.env.DB.prepare = query => {
    const statement = prepare(query), first = statement.first;
    statement.first = async function () { if (unavailable) throw new Error('synthetic DB unavailable'); return first.call(this); };
    return statement;
  };
  f.env.DB.beforeBatch = async statements => {
    if (statements.some(s => s.query.includes("SET status='signed'"))) {
      unavailable = true; throw new Error('synthetic publication failure');
    }
  };
  const error = console.error; console.error = () => {};
  try { assert.equal((await f.complete(0)).status, 500); } finally { console.error = error; }
  assert.equal(f.env.DB.sql.prepare('SELECT COUNT(*) n FROM envelope_objects WHERE published=0').get().n, 1);
  unavailable = false; f.env.DB.beforeBatch = null;
  await checked(await f.complete(0)); await checked(await f.request(`/api/envelopes/${f.id}`, { method: 'DELETE' }));
  assert.equal(f.env.DOCS.objects.size, 0);
  // The opaque cancellation marker remains recoverable if a crashed upload arrives late.
  assert.equal(f.env.DB.sql.prepare('SELECT COUNT(*) n FROM envelope_objects WHERE published=-1').get().n, 1);
});

test('sweep cancellation rejects a late staged upload and reaps its bytes', async () => {
  const f = await fixture(); await checked(await f.send()); await checked(await f.consent(0));
  const hold = gate(); f.env.DOCS.beforePut = key => key.startsWith('sig/') ? hold.wait() : undefined;
  const pending = f.complete(0); await hold.reached;
  f.env.DB.sql.prepare("UPDATE envelope_objects SET created_at='2000-01-01T00:00:00.000Z' WHERE published=0").run();
  const jobs = []; await worker.scheduled({}, f.env, { waitUntil: p => jobs.push(p) }); await Promise.all(jobs);
  hold.release(); assert.equal((await pending).status, 409);
  assert.equal(f.signers()[0].status, 'pending');
  assert.equal([...f.env.DOCS.objects.keys()].filter(k => k.startsWith('sig/')).length, 0);
});

async function publicFixture() {
  const f = await fixture();
  const start = (email = 'owner@example.com', ip = '192.0.2.10', held) => f.request('/api/public/start', {
    method: 'POST', body: { name: 'Synthetic sender', email }, auth: { 'cf-connecting-ip': ip }, held,
  });
  const authFor = (r, ip = '192.0.2.10') => ({ cookie: r.headers.get('set-cookie').split(';')[0], 'cf-connecting-ip': ip });
  const upload = (auth, held) => {
    const form = new FormData(); form.set('title', 'Budget test'); form.set('file', f.addForm.get('file'));
    return f.request('/api/public/envelopes', { method: 'POST', form, auth, held });
  };
  const remove = (id, auth) => f.request(`/api/envelopes/${id}`, { method: 'DELETE', auth });
  const removeAccount = auth => f.request('/api/public/account', { method: 'DELETE', auth });
  return { ...f, start, authFor, upload, remove, removeAccount };
}
test('F062: deleting accounts does not reset network signup allowance', async () => {
  const f = await publicFixture();
  for (let i = 0; i < 10; i++) {
    const r = await f.start(`owner${i}@example.com`); assert.equal(r.status, 200);
    await checked(await f.removeAccount(f.authFor(r)));
  }
  assert.equal((await f.start('last@example.com')).status, 429);
});
test('F062: concurrent registrations share one atomic network allowance', async () => {
  const f = await publicFixture(), holds = Array.from({ length: 20 }, gate);
  const pending = holds.map((g, i) => f.start(`owner${i}@example.com`, '192.0.2.10', g));
  await Promise.all(holds.map(g => g.reached)); holds.forEach(g => g.release());
  const rs = await Promise.all(pending); assert.equal(rs.filter(r => r.status === 200).length, 10);
  assert.equal(rs.filter(r => r.status === 429).length, 10);
});
test('F062: envelope and account deletion preserve the same email daily allowance', async () => {
  const f = await publicFixture();
  for (let i = 0; i < 3; i++) {
    const r = await f.start('owner@example.com', `192.0.2.${i+1}`), auth = f.authFor(r);
    const e = await checked(await f.upload(auth)); await checked(await f.remove(e.id, auth));
    await checked(await f.removeAccount(auth));
  }
  const r = await f.start('OWNER@example.com', '192.0.2.200');
  assert.equal((await f.upload(f.authFor(r))).status, 429);
});
test('F062: concurrent uploads admit only three envelopes', async () => {
  const f = await publicFixture(), auth = f.authFor(await f.start()), holds = Array.from({ length: 8 }, gate);
  const pending = holds.map(g => f.upload(auth, g)); await Promise.all(holds.map(g => g.reached)); holds.forEach(g => g.release());
  const rs = await Promise.all(pending); assert.equal(rs.filter(r => r.status === 200).length, 3);
  assert.equal(rs.filter(r => r.status === 429).length, 5);
});
test('F062: unsupported public templates cannot bypass the persistent upload allowance', async () => {
  const f = await publicFixture(), auth = f.authFor(await f.start());
  const first = await checked(await f.upload(auth));
  assert.equal((await f.request('/api/templates', { method: 'POST', auth, body: { envelope_id: first.id, name: 'Synthetic template' } })).status,400);
  await checked(await f.remove(first.id, auth));
  for (let i=0;i<2;i++) await checked(await f.upload(auth));
  assert.equal((await f.upload(auth)).status,429);
});

function seedUsage(env, count, { kind = 'mail', purpose = 'request', ...identity } = {}, age = 0) {
  const key = scope => createHmac('sha256', env.SESSION_SECRET).update(`usage:${scope}:${String(identity[scope] || 'unrelated').trim().toLowerCase()}`).digest('hex');
  const stmt = env.DB.sql.prepare('INSERT INTO abuse_usage(id,kind,purpose,account_key,network_key,recipient_key,subject_key,used_at) VALUES (?,?,?,?,?,?,?,unixepoch()-?)');
  for (let i = 0; i < count; i++) stmt.run(crypto.randomUUID(), kind, purpose, ...['account','network','recipient','subject'].map(key), age);
}
for (const [scope, max, identity] of [
  ['account', 150, { account: 'admin' }], ['network', 300, { network: 'admin' }],
  ['recipient', 50, { recipient: 'signer0@example.com' }], ['global', 10000, {}],
]) test(`F062: ${scope} outbound budget gates verification before provider call`, async () => {
  const f = await authFixture(); seedUsage(f.env, max - 1, identity);
  const before = f.env.emails.length, usage = f.env.DB.sql.prepare('SELECT COUNT(*) n FROM abuse_usage').get().n;
  assert.equal((await f.issue()).status, 429); assert.equal(f.env.emails.length, before);
  assert.equal(f.env.DB.sql.prepare('SELECT COUNT(*) n FROM abuse_usage').get().n, usage);
});
test('F062: verification failures consume recipient allowance across replacement accounts', async () => {
  const f = await publicFixture(); let attempts = 0;
  f.env.EMAIL.send = async () => { attempts++; throw new Error('synthetic provider rejection'); };
  for (let i = 0; i < 6; i++) {
    const auth = f.authFor(await f.start(`owner${i}@example.com`));
    const owner = f.env.DB.sql.prepare('SELECT id FROM senders ORDER BY rowid DESC LIMIT 1').get();
    const id = crypto.randomUUID().replaceAll('-', ''), sid = crypto.randomUUID().replaceAll('-', ''), token = crypto.randomUUID().replaceAll('-', '');
    f.env.DB.sql.prepare("INSERT INTO envelopes(id,title,status,created_at,original_key,original_sha256,sender_id) VALUES (?,'Synthetic','sent',?,'unused','unused',?)").run(id, new Date().toISOString(), owner.id);
    f.env.DB.sql.prepare("INSERT INTO signers(id,envelope_id,name,email,token) VALUES (?,?,'Recipient','same@example.com',?)").run(sid, id, token);
    const r = await f.request(`/api/session/${token}/auth-request`, { method: 'POST', auth: {} });
    assert.equal(r.status, i < 5 ? 502 : 429);
    await checked(await f.removeAccount(auth));
  }
  assert.equal(attempts, 5); assert.equal(f.env.DB.sql.prepare("SELECT COUNT(*) n FROM abuse_usage WHERE kind='mail'").get().n, 5);
});
test('F062: concurrent codes for different challenges share one recipient hourly cap', async () => {
  const f = await fixture(), tokens = [];
  f.env.DB.sql.prepare("UPDATE envelopes SET status='sent'").run();
  for (let i = 0; i < 12; i++) {
    const sid = crypto.randomUUID().replaceAll('-', ''), token = crypto.randomUUID().replaceAll('-', ''); tokens.push(token);
    f.env.DB.sql.prepare("INSERT INTO signers(id,envelope_id,name,email,token) VALUES (?,?,'Recipient','same@example.com',?)").run(sid, f.id, token);
  }
  const rs = await Promise.all(tokens.map(t => f.request(`/api/session/${t}/auth-request`, { method: 'POST', auth: {} })));
  assert.equal(rs.filter(r => r.status === 200).length, 5); assert.equal(rs.filter(r => r.status === 429).length, 7);
  assert.equal(f.env.emails.length, 5);
});
test('F062: overlapping reminders reserve one attempt before provider call', async () => {
  const f = await authFixture(), hold = gate(); let attempts = 0;
  f.env.DB.sql.prepare("UPDATE signers SET delivery_at='2000-01-01T00:00:00.000Z',delivery_attempts=4").run();
  f.env.EMAIL.send = async () => { attempts++; await hold.wait(); return { messageId: 'mock' }; };
  const resend = () => f.request(`/api/envelopes/${f.id}/resend`, { method: 'POST', body: { signer_id: f.sid } });
  const first = resend(); await hold.reached;
  const rest = await Promise.all(Array.from({ length: 8 }, resend)); assert.ok(rest.every(r => r.status === 429));
  hold.release(); assert.equal((await first).status, 200); assert.equal(attempts, 1); assert.equal(f.signers()[0].delivery_attempts, 5);
});
test('F062: exhausted mail budget gates initial send and scheduler while links remain usable', async () => {
  const f = await fixture(); seedUsage(f.env, 150, { account: 'admin' });
  const sent = await checked(await f.send()); assert.equal(sent.delivery.limited, 1); assert.equal(f.env.emails.length, 0);
  f.env.DB.sql.prepare("UPDATE envelopes SET sent_at='2000-01-01T00:00:00.000Z'").run();
  let pending; await worker.scheduled({}, f.env, { waitUntil(p) { pending = p; } }); await pending;
  assert.equal(f.env.emails.length, 0); assert.equal((await f.session(0, '')).status, 200);
});
test('F062: completed-document delivery also uses the shared budget', async () => {
  const f = await fixture(); await checked(await f.send()); seedUsage(f.env, 149, { account: 'admin' });
  await checked(await f.consent(0)); await checked(await f.complete(0));
  assert.equal(f.envelope().status, 'completed'); assert.equal(f.env.emails.length, 1);
  assert.equal((await f.session(0, '/download')).status, 200);
});
test('F062: global envelope cap covers public uploads', async () => {
  const f = await publicFixture(), auth = f.authFor(await f.start());
  await checked(await f.upload(auth));
  seedUsage(f.env,199,{kind:'envelope'});
  assert.equal((await f.upload(auth)).status,429);
});
test('F062: expired reservations release allowance and hourly sweep removes only old usage', async () => {
  const f = await publicFixture(); seedUsage(f.env, 10, { kind: 'signup', network: '192.0.2.10' }, 3 * 86400);
  assert.equal((await f.start()).status, 200);
  let pending; await worker.scheduled({}, f.env, { waitUntil(p) { pending = p; } }); await pending;
  const rows = f.env.DB.sql.prepare('SELECT * FROM abuse_usage').all(); assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'signup'); assert.doesNotMatch(JSON.stringify(rows), /owner@example|192\.0\.2/);
});
test('F062: unavailable quota storage fails closed before any provider call', async () => {
  const f = await authFixture(); f.env.DB.sql.exec('DROP TABLE abuse_usage'); const before = f.env.emails.length;
  assert.equal((await f.issue()).status, 502); assert.equal(f.env.emails.length, before);
});
test('F062: invalid upload does not consume a valid envelope slot', async () => {
  const f = await publicFixture(), auth = f.authFor(await f.start());
  const form = new FormData(); form.set('title', 'Bad'); form.set('file', new File(['not pdf'], 'bad.pdf'));
  assert.equal((await f.request('/api/public/envelopes', { method: 'POST', auth, form })).status, 400);
  for (let i = 0; i < 3; i++) await checked(await f.upload(auth));
});
