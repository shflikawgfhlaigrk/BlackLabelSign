import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { buildDeliveryEmail, buildVerificationEmail } from '../src/mail.mjs';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

function load(entropy) {
  let offset = 0;
  const context = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, console,
    buildDeliveryEmail, buildVerificationEmail,
    crypto: {
      subtle: webcrypto.subtle,
      randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef',
      getRandomValues: values => {
        for (let i = 0; i < values.length; i++) values[i] = entropy[offset++ % entropy.length];
        return values;
      },
    },
  });
  // Execute the actual Worker. PDF rendering is outside this email challenge
  // path, and the real mail-format functions are supplied above.
  vm.runInContext(source.replace(/^import .*;$/gm, '')
    .replace('export default {', 'globalThis.worker = {'), context);
  return { context, consumed: () => offset };
}

function fixture() {
  const signer = { id: 'signerfixture', envelope_id: 'envelopefixture', token: 'fixturetoken',
    name: 'Test Signer', email: 'signer@example.com', role: 'signer', status: 'pending', order_index: 0 };
  const envelope = { id: signer.envelope_id, title: 'Test agreement', status: 'draft' };
  const messages = [];
  const events = [];
  const DB = {
    prepare(sql) {
      return { bind(...args) {
        return {
          async first() {
            if (sql.startsWith('SELECT * FROM signers WHERE token=')) return signer;
            if (sql.startsWith('SELECT * FROM envelopes WHERE id=')) return envelope;
            if (sql.includes('COUNT(*) c FROM events')) return { c: 0 };
            throw new Error(`Unexpected read: ${sql}`);
          },
          async all() {
            assert.match(sql, /^SELECT \* FROM signers WHERE envelope_id=/);
            return { results: [signer] };
          },
          async run() {
            if (sql.startsWith('UPDATE signers SET auth_code_sent_at=')) signer.auth_code_sent_at = args[0];
            else if (sql.startsWith('UPDATE signers SET auth_code_hash=?')) {
              [signer.auth_code_hash, signer.auth_code_expires_at] = args;
              signer.auth_failures = 0;
            } else if (sql.startsWith('UPDATE signers SET auth_code_hash=NULL')) {
              signer.auth_code_hash = null;
              signer.auth_code_expires_at = null;
              signer.last_authenticated_at = args[0];
            } else if (sql.startsWith('INSERT INTO events')) events.push(args[3]);
            else throw new Error(`Unexpected write: ${sql}`);
            return { meta: { changes: 1 } };
          },
        };
      } };
    },
  };
  return { signer, messages, events, env: { DB, SESSION_SECRET: 'test-only-signing-secret',
    EMAIL: { async send(message) { messages.push(message); return { messageId: 'test-message' }; } } } };
}

test('signer challenge rejects biased bytes and the delivered code authenticates once', async () => {
  const { context, consumed } = load([250, 251, 252, 253, 254, 255, 0, 1, 2, 3, 4, 5]);
  const f = fixture();
  const url = 'https://sign.example.com/api/session/fixturetoken';
  const response = await context.worker.fetch(new Request(url + '/auth-request', { method: 'POST' }), f.env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).codeSent, true);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].subject, /\b012345\b/);
  assert.ok(consumed() >= 12, 'the six biased bytes must be discarded before code generation');
  assert.ok(f.signer.auth_code_hash && !f.signer.auth_code_hash.includes('012345'));
  const verify = await context.worker.fetch(new Request(url + '/auth-verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '012345' }),
  }), f.env);
  assert.equal(verify.status, 200);
  assert.equal((await verify.json()).authenticated, true);
  assert.match(verify.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(f.signer.auth_code_hash, null);
  const replay = await context.worker.fetch(new Request(url + '/auth-verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '012345' }),
  }), f.env);
  assert.equal(replay.status, 410);
  assert.deepEqual(f.events, ['auth-code-sent', 'email-authenticated']);
});

test('every accepted byte gives each decimal code the same number of preimages', () => {
  const counts = new Map();
  for (let byte = 0; byte < 250; byte++) {
    const { context } = load([byte]);
    const code = vm.runInContext('verificationCode()', context);
    assert.match(code, /^\d{6}$/);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  assert.equal(counts.size, 10);
  for (const count of counts.values()) assert.equal(count, 25);
  assert.ok(counts.has('000000'));
  assert.ok(counts.has('999999'));
});
