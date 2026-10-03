// Private test harness. Executes the actual Worker against local SQLite, memory
// R2 and a sandbox-only inbox. No Cloudflare resources or email networks are used.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer, request as httpsRequest } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const workerPath = new URL('src/index.js', root);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function loadWorker() {
  const source = readFileSync(workerPath, 'utf8').replace(/from '([^']+)'/g,
    (_, spec) => `from '${spec.startsWith('.') ? new URL(spec, workerPath).href : pathToFileURL(require.resolve(spec)).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
}

export class LocalD1 {
  constructor(filename = ':memory:') {
    this.sql = new DatabaseSync(filename);
    this.sql.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
    for (const name of readdirSync(new URL('migrations/', root)).filter(n => n.endsWith('.sql')).sort())
      this.sql.exec(readFileSync(new URL(`migrations/${name}`, root), 'utf8'));
  }
  prepare(query) {
    const db = this;
    return { args: [], query,
      bind(...args) { this.args = args; return this; },
      async first() { return db.sql.prepare(query).get(...this.args) || null; },
      async all() { return { results: db.sql.prepare(query).all(...this.args) }; },
      async run() {
        if (db.beforeRun) await db.beforeRun(this);
        return { meta: { changes: Number(db.sql.prepare(query).run(...this.args).changes) } };
      },
    };
  }
  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch(statements);
    // D1's atomic batch: no await between BEGIN and COMMIT.
    this.sql.exec('BEGIN');
    try {
      const result = statements.map(s => ({ meta: { changes: Number(this.sql.prepare(s.query).run(...s.args).changes) } }));
      this.sql.exec('COMMIT'); return result;
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  close() { this.sql.close(); }
}

export class MemoryR2 {
  objects = new Map();
  async put(key, data, options = {}) {
    if (this.beforePut) await this.beforePut(key);
    this.objects.set(key, { bytes: Buffer.from(data), ...options });
  }
  async head(key) { return this.objects.get(key) || null; }
  async get(key) {
    if (this.beforeGet) await this.beforeGet(key);
    const object = this.objects.get(key);
    return object ? { ...object, body: Uint8Array.from(object.bytes), arrayBuffer: async () => Uint8Array.from(object.bytes).buffer } : null;
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
}

export class SandboxInbox {
  accepted = [];
  received = [];
  mode = 'collect';
  async send(mail) {
    const to = typeof mail.to === 'string' ? mail.to : mail.to?.email;
    if (!/^[^@]+@[^@]+\.(test|invalid)$/i.test(to || '')) throw new Error('Sandbox rejects every non-test recipient');
    if (this.beforeSend) await this.beforeSend(mail);
    if (this.mode === 'reject') throw Object.assign(new Error('Synthetic sandbox provider rejection'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
    if (this.mode === 'uncertain') throw Object.assign(new Error('Synthetic sandbox provider outcome unknown'), { code: 'E_INTERNAL_SERVER_ERROR' });
    const receipt = { messageId: `sandbox-${this.accepted.length + 1}`, mail, acceptedAt: new Date().toISOString(), provider: 'LOCAL SANDBOX ONLY' };
    this.accepted.push(receipt);
    if (this.mode === 'collect') this.received.push({ ...receipt, receivedAt: new Date().toISOString() });
    return { messageId: receipt.messageId };
  }
  messages(email) { return this.received.filter(r => (typeof r.mail.to === 'string' ? r.mail.to : r.mail.to.email).toLowerCase() === email.toLowerCase()); }
  latestCode(email) {
    const mail = this.messages(email).toReversed().find(r => /\b\d{6}\b/.test(r.mail.subject + '\n' + r.mail.text));
    if (!mail) throw new Error(`No sandbox code received for ${email}`);
    return (mail.mail.subject + '\n' + mail.mail.text).match(/\b\d{6}\b/)[0];
  }
}

export async function syntheticPdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('BL SIGN TEST ONLY — NOT A CONTRACT');
  pdf.setSubject('Synthetic acceptance document; no legal agreement or real party.');
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  page.drawText('BL SIGN TEST ONLY - NOT A CONTRACT', { x: 35, y: 745, size: 18, font, color: rgb(.65, 0, 0) });
  page.drawText('Synthetic acceptance exercise. No legal obligations.', { x: 35, y: 715, size: 12, font });
  return Buffer.from(await pdf.save());
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const assets = { async fetch(input) {
  const path = new URL(typeof input === 'string' ? input : input.url).pathname;
  if (path.includes('..') || !/^\/[a-zA-Z0-9/._-]+$/.test(path)) return new Response('Not found', { status: 404 });
  try {
    const extension = path.substring(path.lastIndexOf('.'));
    return new Response(readFileSync(new URL('public' + path, root)), { headers: { 'content-type': contentTypes[extension] || 'application/octet-stream' } });
  } catch { return new Response('Not found', { status: 404 }); }
} };

export async function createHarness({ origin = 'https://localhost', database = ':memory:' } = {}) {
  const worker = await loadWorker();
  const inbox = new SandboxInbox();
  const env = { DB: new LocalD1(database), DOCS: new MemoryR2(), ASSETS: assets,
    EMAIL: inbox, SESSION_SECRET: 'LOCAL-SYNTHETIC-TEST-ONLY-NOT-A-DEPLOYMENT-SECRET',
    ADMIN_TOKEN: 'local-synthetic-admin-only', PUBLIC_ORIGIN: origin };
  const request = (path, { method = 'GET', body, form, headers = {}, cookie } = {}) => {
    const h = new Headers({ 'cf-connecting-ip': '192.0.2.10', 'user-agent': 'BL Sign private synthetic lifecycle', ...headers });
    if (cookie) h.set('cookie', cookie);
    const options = { method, headers: h };
    if (form) options.body = form;
    else if (body !== undefined) { h.set('content-type', 'application/json'); options.body = JSON.stringify(body); }
    return worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, options), env);
  };
  const close = () => env.DB.close();
  return { worker, env, inbox, request, close, sourceHash: sha256(readFileSync(workerPath)) };
}

export async function serveHarness({ port = 0, transport = 'https' } = {}) {
  if (!['https', 'http'].includes(transport)) throw new Error('Local preview transport must be https or http');
  const harness = await createHarness();
  // Deliberately untrusted, static synthetic TLS material; no system trust or
  // deployed credentials are changed. Clients trust this loopback fixture only.
  const handler = async (req, res) => {
    try {
      // Test receipt access is loopback-only and is never part of the Worker.
      if (req.url === '/__sandbox/inbox' && req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ label: 'LOCAL SANDBOX ONLY — NOT LIVE EMAIL RECEIPT', accepted: harness.inbox.accepted, received: harness.inbox.received })); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Local request too large'); chunks.push(chunk); }
      const headers = new Headers(req.headers);
      headers.set('cf-connecting-ip', '192.0.2.10');
      // Optional founder HTTP preview emulates a TLS-terminating edge. Default
      // HTTPS tests do not adapt requests. Cross-origin values remain unchanged.
      const workerOrigin = harness.env.PUBLIC_ORIGIN.replace(/^http:/, 'https:');
      if (transport === 'http' && headers.get('origin') === harness.env.PUBLIC_ORIGIN) headers.set('origin', workerOrigin);
      let response = await harness.worker.fetch(new Request(`${workerOrigin}${req.url}`, {
        method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      }), harness.env);
      if (transport === 'http' && response.headers.get('content-type')?.includes('application/json')) {
        // Worker-produced local links must retain the preview transport.
        response = new Response((await response.text()).replaceAll(workerOrigin, harness.env.PUBLIC_ORIGIN), { status: response.status, headers: response.headers });
      }
      res.statusCode = response.status;
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  };
  const server = transport === 'https' ? createServer({
    key: readFileSync(new URL('../fixtures/localhost-TEST-ONLY.key', import.meta.url)),
    cert: readFileSync(new URL('../fixtures/localhost-TEST-ONLY.crt', import.meta.url)),
  }, handler) : createHttpServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  harness.env.PUBLIC_ORIGIN = `${transport}://localhost:${server.address().port}`;
  return { ...harness, server, origin: harness.env.PUBLIC_ORIGIN,
    async close() { await new Promise(resolve => server.close(resolve)); harness.close(); } };
}

export function candidateIdentity() {
  const files = ['schema.sql', 'package.json', 'package-lock.json', 'wrangler.toml'];
  const visit = directory => {
    for (const item of readdirSync(new URL(directory + '/', root), { withFileTypes: true })) {
      const path = directory + '/' + item.name;
      if (item.isDirectory()) visit(path); else if (item.isFile()) files.push(path);
    }
  };
  for (const directory of ['src', 'public', 'migrations']) visit(directory);
  const hashes = Object.fromEntries(files.sort().map(path => [path, sha256(readFileSync(new URL(path, root)))]));
  let commit; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim(); } catch { commit = 'unknown'; }
  return { commit, treeSha256: sha256(JSON.stringify(hashes)), files: hashes };
}

export async function sandboxFetch(harness, path, options = {}) {
  // Trust is scoped to this request and this harness's loopback origin. No
  // global NODE_TLS_REJECT_UNAUTHORIZED or production TLS bypass is used.
  const req = new Request(harness.origin + path, options);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.from(await req.arrayBuffer());
  return new Promise((resolve, reject) => {
    const pending = httpsRequest(req.url, { method: req.method, headers: Object.fromEntries(req.headers), rejectUnauthorized: false }, async incoming => {
      try {
        const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
        resolve(new Response(['HEAD'].includes(req.method) || [204, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks),
          { status: incoming.statusCode, headers: incoming.headers }));
      } catch (error) { reject(error); }
    });
    pending.on('error', reject); pending.end(body);
  });
}

export const projectRoot = fileURLToPath(root);
