// BL Sign — self-hosted e-signature (ESIGN/UETA: intent, consent, attribution, integrity, retention)
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...h } });
const bad = (m, s = 400) => J({ error: m }, s);
const uid = () => crypto.randomUUID().replaceAll('-', '');
const now = () => new Date().toISOString();
const TRANSLIT = { '—': '--', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', ' ': ' ', '•': '*' };
const clean = s => String(s ?? '').replace(/[—–‘’“”… •]/g, c => TRANSLIT[c]).replace(/[^\x20-\x7E]/g, '?');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CONSENT_VERSION = 'esign-v1';
const MAX_PDF = 15 * 1024 * 1024;
const MAX_SIG_PNG = 600 * 1024;

async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function isAdmin(req, env) {
  const auth = req.headers.get('authorization') || '';
  if (env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`) return true;
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)blsign=([^;]+)/);
  return !!(m && env.ADMIN_TOKEN && m[1] === env.ADMIN_TOKEN);
}

async function senderFromReq(req, env) {
  const h = req.headers.get('x-sender-token') || '';
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)blsender=([^;]+)/);
  const tok = h || (m && m[1]);
  if (!tok) return null;
  return env.DB.prepare('SELECT * FROM senders WHERE token=?').bind(tok).first();
}
const canAccess = (envelope, admin, sender) =>
  admin || !!(sender && envelope.sender_id && envelope.sender_id === sender.id);

async function audit(env, envelopeId, signerId, type, req, detail = '') {
  await env.DB.prepare('INSERT INTO events (id, envelope_id, signer_id, type, ts, ip, ua, detail) VALUES (?,?,?,?,?,?,?,?)')
    .bind(uid(), envelopeId, signerId, type, now(),
      req ? (req.headers.get('cf-connecting-ip') || '') : '',
      req ? (req.headers.get('user-agent') || '') : '', detail).run();
}

const getEnvelope = (env, id) => env.DB.prepare('SELECT * FROM envelopes WHERE id=?').bind(id).first();
const getSigners = (env, id) => env.DB.prepare('SELECT * FROM signers WHERE envelope_id=? ORDER BY order_index').bind(id).all().then(r => r.results);
const getFields = (env, id) => env.DB.prepare('SELECT * FROM fields WHERE envelope_id=?').bind(id).all().then(r => r.results);

async function serveAsset(env, url, path) {
  return env.ASSETS.fetch(new URL(path, url.origin).toString());
}

const NOINDEX = [/^\/s\//, /^\/e\//, /^\/admin/, /^\/verify\//, /^\/me$/, /^\/api\//];
function addSecurityHeaders(res, path) {
  const h = new Headers(res.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  h.set('content-security-policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (NOINDEX.some(r => r.test(path))) h.set('x-robots-tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, headers: h });
}

// Retry-safe completion: if everyone signed but a prior finalize attempt crashed
// (corrupt asset, transient error), any later read re-runs it instead of
// stranding the envelope in 'sent' forever.
async function ensureFinalized(env, envelope, req) {
  if (envelope.status !== 'sent') return envelope;
  if (envelope.expires_at && envelope.expires_at < now()) {
    await env.DB.prepare("UPDATE envelopes SET status='expired' WHERE id=? AND status='sent'").bind(envelope.id).run();
    await audit(env, envelope.id, null, 'expired', null);
    return getEnvelope(env, envelope.id);
  }
  const unsigned = await env.DB.prepare(
    "SELECT COUNT(*) c FROM signers WHERE envelope_id=? AND role='signer' AND status!='signed'")
    .bind(envelope.id).first();
  if (unsigned.c > 0) return envelope;
  try { await finalize(env, envelope, req); } catch (e) {
    console.error('finalize retry failed', envelope.id, e && e.stack || e);
    return envelope;
  }
  return getEnvelope(env, envelope.id);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = b => b.length > 8 && PNG_MAGIC.every((v, i) => b[i] === v);

async function validatePdf(bytes) {
  if (bytes.byteLength > MAX_PDF) return 'PDF too large (15MB max)';
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return 'not a PDF';
  try {
    const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
    const pages = doc.getPageCount();
    if (pages < 1) return 'PDF has no pages';
    return { pages };
  } catch {
    return 'PDF could not be parsed (corrupt or password-protected)';
  }
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    const res = await this.route(req, env);
    return addSecurityHeaders(res, path);
  },

  async route(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      // ---------- pages ----------
      if (m === 'GET' && p === '/') return serveAsset(env, url, '/landing.html');
      if (m === 'GET' && p === '/me') return serveAsset(env, url, '/me.html');
      if (m === 'GET' && /^\/e\/[a-f0-9]+$/.test(p)) return serveAsset(env, url, '/editor.html');
      if (m === 'GET' && p === '/admin') return serveAsset(env, url, isAdmin(req, env) ? '/admin.html' : '/login.html');
      if (m === 'GET' && /^\/admin\/env\/[a-f0-9]+$/.test(p))
        return serveAsset(env, url, isAdmin(req, env) ? '/editor.html' : '/login.html');
      if (m === 'GET' && /^\/s\/[A-Za-z0-9]+$/.test(p)) return serveAsset(env, url, '/sign.html');
      if (m === 'GET' && p.startsWith('/assets/')) return env.ASSETS.fetch(req);
      if (m === 'GET' && p === '/favicon.ico') return new Response(null, { status: 204 });
      if (m === 'GET' && p === '/robots.txt')
        return new Response('User-agent: *\nDisallow: /s/\nDisallow: /e/\nDisallow: /admin\nDisallow: /verify/\nDisallow: /me\nDisallow: /api/\n',
          { headers: { 'content-type': 'text/plain' } });

      if (m === 'GET' && /^\/verify\/[a-f0-9]+$/.test(p)) return verifyPage(env, p.split('/').pop());

      // ---------- auth ----------
      if (m === 'POST' && p === '/api/login') {
        const ip = req.headers.get('cf-connecting-ip') || '';
        const hourAgo = new Date(Date.now() - 3600_000).toISOString();
        const fails = (await env.DB.prepare(
          "SELECT COUNT(*) c FROM events WHERE envelope_id='auth' AND type='login-failed' AND ip=? AND ts>=?")
          .bind(ip, hourAgo).first()).c;
        if (fails >= 10) return bad('too many attempts — try later', 429);
        const body = await req.json().catch(() => ({}));
        if (!env.ADMIN_TOKEN || body.token !== env.ADMIN_TOKEN) {
          await audit(env, 'auth', null, 'login-failed', req);
          return bad('nope', 403);
        }
        return J({ ok: true }, 200, {
          'set-cookie': `blsign=${env.ADMIN_TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
      }
      if (m === 'POST' && p === '/api/logout')
        return J({ ok: true }, 200, { 'set-cookie': 'blsign=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });

      // ---------- public self-serve senders ----------
      if (m === 'POST' && p === '/api/public/start') {
        const b = await req.json().catch(() => ({}));
        const name = String(b.name || '').trim().slice(0, 120);
        const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
        if (!name || !/.+@.+\..+/.test(email)) return bad('name and a valid email are required');
        const ip = req.headers.get('cf-connecting-ip') || '';
        const today = now().slice(0, 10);
        const nIp = (await env.DB.prepare('SELECT COUNT(*) c FROM senders WHERE ip=? AND created_at>=?').bind(ip, today).first()).c;
        if (nIp >= 10) return bad('daily limit reached for this network — try tomorrow', 429);
        const sid = uid(), stok = uid() + uid();
        await env.DB.prepare('INSERT INTO senders (id,name,email,token,ip,created_at) VALUES (?,?,?,?,?,?)')
          .bind(sid, name, email, stok, ip, now()).run();
        return J({ ok: true, name }, 200, {
          'set-cookie': `blsender=${stok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`,
        });
      }
      if (p === '/api/public/envelopes') {
        const sender = await senderFromReq(req, env);
        if (!sender) return bad('unauthorized', 401);
        if (m === 'GET') {
          const rows = (await env.DB.prepare(`
            SELECT e.id, e.title, e.status, e.created_at,
              (SELECT COUNT(*) FROM signers s WHERE s.envelope_id=e.id) AS n_signers,
              (SELECT COUNT(*) FROM signers s WHERE s.envelope_id=e.id AND s.status='signed') AS n_signed
            FROM envelopes e WHERE e.sender_id=? ORDER BY e.created_at DESC`).bind(sender.id).all()).results;
          return J({ sender: { name: sender.name, email: sender.email }, envelopes: rows });
        }
        if (m === 'POST') {
          const today = now().slice(0, 10);
          const nEnv = (await env.DB.prepare(
            'SELECT COUNT(*) c FROM envelopes e JOIN senders s ON e.sender_id=s.id WHERE s.email=? AND e.created_at>=?')
            .bind(sender.email, today).first()).c;
          if (nEnv >= 3) return bad('free tier: 3 envelopes per day — need more? blacklabeltec.com', 429);
          const nGlobal = (await env.DB.prepare(
            'SELECT COUNT(*) c FROM envelopes WHERE sender_id IS NOT NULL AND created_at>=?').bind(today).first()).c;
          if (nGlobal >= 200) return bad('high demand today — try again tomorrow', 429);
          const form = await req.formData();
          const file = form.get('file');
          const title = String(form.get('title') || '').trim();
          if (!title) return bad('title required');
          if (!file || typeof file === 'string') return bad('file required');
          const bytes = await file.arrayBuffer();
          const v = await validatePdf(bytes);
          if (typeof v === 'string') return bad(v);
          const id = uid();
          const key = `orig/${id}.pdf`;
          await env.DOCS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { pages: String(v.pages) } });
          await env.DB.prepare('INSERT INTO envelopes (id,title,status,created_at,original_key,original_sha256,sender_id) VALUES (?,?,?,?,?,?,?)')
            .bind(id, title, 'draft', now(), key, await sha256hex(bytes), sender.id).run();
          await audit(env, id, null, 'created', req, `public sender ${sender.name} <${sender.email}>`);
          return J({ id });
        }
        return bad('not found', 404);
      }

      // ---------- templates (reusable field layouts + recipients) ----------
      if (p.startsWith('/api/templates')) {
        const admin = isAdmin(req, env);
        const sender = admin ? null : await senderFromReq(req, env);
        if (!admin && !sender) return bad('unauthorized', 401);
        const owns = t => admin || (sender && t.sender_id === sender.id);

        if (m === 'GET' && p === '/api/templates') {
          const rows = admin
            ? (await env.DB.prepare('SELECT id,name,pages,created_at,sender_id FROM templates ORDER BY created_at DESC').all()).results
            : (await env.DB.prepare('SELECT id,name,pages,created_at FROM templates WHERE sender_id=? ORDER BY created_at DESC').bind(sender.id).all()).results;
          return J({ templates: rows });
        }

        if (m === 'POST' && p === '/api/templates') {
          const b = await req.json().catch(() => ({}));
          const srcEnv = await getEnvelope(env, String(b.envelope_id || ''));
          if (!srcEnv || !canAccess(srcEnv, admin, sender)) return bad('envelope not found', 404);
          const name = clean(String(b.name || srcEnv.title)).slice(0, 120) || 'Template';
          if (sender) {
            const n = (await env.DB.prepare('SELECT COUNT(*) c FROM templates WHERE sender_id=?').bind(sender.id).first()).c;
            if (n >= 5) return bad('free tier: 5 templates max');
          }
          const signers = await getSigners(env, srcEnv.id);
          const fields = await getFields(env, srcEnv.id);
          const sIndex = Object.fromEntries(signers.map((s, i) => [s.id, i]));
          const tid = uid();
          const src = await env.DOCS.get(srcEnv.original_key);
          const head = await env.DOCS.head(srcEnv.original_key);
          await env.DOCS.put(`tpl/${tid}.pdf`, await src.arrayBuffer(),
            { httpMetadata: { contentType: 'application/pdf' }, customMetadata: head?.customMetadata || {} });
          await env.DB.prepare('INSERT INTO templates (id,name,sender_id,key,sha256,pages,roles_json,fields_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .bind(tid, name, sender ? sender.id : null, `tpl/${tid}.pdf`, srcEnv.original_sha256,
              parseInt(head?.customMetadata?.pages || '0', 10) || 0,
              JSON.stringify(signers.map(s => ({ name: s.name, email: s.email, role: s.role || 'signer' }))),
              JSON.stringify(fields.map(f => ({ signer_index: sIndex[f.signer_id], type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h }))),
              now()).run();
          return J({ id: tid });
        }

        const tm = p.match(/^\/api\/templates\/([a-f0-9]+)(\/[a-z]+)?$/);
        if (!tm) return bad('not found', 404);
        const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id=?').bind(tm[1]).first();
        if (!tpl || !owns(tpl)) return bad('not found', 404);

        if (m === 'DELETE' && !tm[2]) {
          await env.DOCS.delete(tpl.key);
          await env.DB.prepare('DELETE FROM templates WHERE id=?').bind(tpl.id).run();
          return J({ ok: true });
        }

        if (m === 'POST' && tm[2] === '/use') {
          if (sender) {
            const today = now().slice(0, 10);
            const nEnv = (await env.DB.prepare(
              'SELECT COUNT(*) c FROM envelopes e JOIN senders s ON e.sender_id=s.id WHERE s.email=? AND e.created_at>=?')
              .bind(sender.email, today).first()).c;
            if (nEnv >= 3) return bad('free tier: 3 envelopes per day — need more? blacklabeltec.com', 429);
          }
          const id = uid();
          const key = `orig/${id}.pdf`;
          const src = await env.DOCS.get(tpl.key);
          const head = await env.DOCS.head(tpl.key);
          const bytes = await src.arrayBuffer();
          await env.DOCS.put(key, bytes,
            { httpMetadata: { contentType: 'application/pdf' }, customMetadata: head?.customMetadata || {} });
          const stmts = [env.DB.prepare('INSERT INTO envelopes (id,title,status,created_at,original_key,original_sha256,sender_id) VALUES (?,?,?,?,?,?,?)')
            .bind(id, `${tpl.name} — ${now().slice(0, 10)}`, 'draft', now(), key, await sha256hex(bytes), sender ? sender.id : null)];
          const roles = JSON.parse(tpl.roles_json);
          const newIds = roles.map(() => uid());
          roles.forEach((r, i) => stmts.push(
            env.DB.prepare('INSERT INTO signers (id,envelope_id,name,email,order_index,status,role) VALUES (?,?,?,?,?,?,?)')
              .bind(newIds[i], id, r.name, r.email || '', i, 'pending', r.role === 'cc' ? 'cc' : 'signer')));
          for (const f of JSON.parse(tpl.fields_json)) {
            if (f.signer_index == null || !newIds[f.signer_index]) continue;
            stmts.push(env.DB.prepare('INSERT INTO fields (id,envelope_id,signer_id,type,page,x,y,w,h,required) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .bind(uid(), id, newIds[f.signer_index], f.type, f.page | 0, f.x, f.y, f.w, f.h, f.type === 'checkbox' ? 0 : 1));
          }
          await env.DB.batch(stmts);
          await audit(env, id, null, 'created', req, `from template ${tpl.name}`);
          return J({ id });
        }
        return bad('not found', 404);
      }

      // ---------- envelope API (admin, or the public sender who owns it) ----------
      if (p.startsWith('/api/envelopes')) {
        const admin = isAdmin(req, env);
        const sender = admin ? null : await senderFromReq(req, env);
        if (!admin && !sender) return bad('unauthorized', 401);

        if ((m === 'POST' || m === 'GET') && p === '/api/envelopes' && !admin) return bad('unauthorized', 401);

        if (m === 'POST' && p === '/api/envelopes') {
          const form = await req.formData();
          const file = form.get('file');
          const title = String(form.get('title') || '').trim();
          if (!title) return bad('title required');
          if (!file || typeof file === 'string') return bad('file required');
          const bytes = await file.arrayBuffer();
          const v = await validatePdf(bytes);
          if (typeof v === 'string') return bad(v);
          const id = uid();
          const key = `orig/${id}.pdf`;
          await env.DOCS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { pages: String(v.pages) } });
          await env.DB.prepare('INSERT INTO envelopes (id,title,status,created_at,original_key,original_sha256) VALUES (?,?,?,?,?,?)')
            .bind(id, title, 'draft', now(), key, await sha256hex(bytes)).run();
          await audit(env, id, null, 'created', req, title);
          return J({ id });
        }

        if (m === 'GET' && p === '/api/envelopes') {
          const rows = (await env.DB.prepare(`
            SELECT e.*,
              (SELECT COUNT(*) FROM signers s WHERE s.envelope_id=e.id) AS n_signers,
              (SELECT COUNT(*) FROM signers s WHERE s.envelope_id=e.id AND s.status='signed') AS n_signed
            FROM envelopes e ORDER BY e.created_at DESC`).all()).results;
          return J({ envelopes: rows });
        }

        const em = p.match(/^\/api\/envelopes\/([a-f0-9]+)(\/[a-z]+)?$/);
        if (!em) return bad('not found', 404);
        let envelope = await getEnvelope(env, em[1]);
        if (!envelope) return bad('not found', 404);
        if (!canAccess(envelope, admin, sender)) return bad('unauthorized', 401);
        envelope = await ensureFinalized(env, envelope, req);
        const sub = em[2] || '';

        if (m === 'GET' && sub === '') {
          const signers = await getSigners(env, envelope.id);
          const fields = await getFields(env, envelope.id);
          const events = (await env.DB.prepare('SELECT * FROM events WHERE envelope_id=? ORDER BY ts').bind(envelope.id).all()).results;
          for (const s of signers) if (s.token) s.link = `${url.origin}/s/${s.token}`;
          return J({ envelope, signers, fields, events });
        }

        if (m === 'PUT' && sub === '/setup') {
          if (envelope.status !== 'draft') return bad('envelope is not editable after send');
          const body = await req.json().catch(() => null);
          if (!body || !Array.isArray(body.signers) || !Array.isArray(body.fields)) return bad('signers[] and fields[] required');
          if (body.signers.length > 8 || body.fields.length > 200) return bad('too many signers/fields');
          const head = await env.DOCS.head(envelope.original_key);
          const pageCount = parseInt(head?.customMetadata?.pages || '0', 10) || 0;
          if (pageCount && body.fields.some(f => (f.page | 0) >= pageCount))
            return bad(`field placed on a page past the end of the document (${pageCount} pages)`);
          const stmts = [
            env.DB.prepare('DELETE FROM fields WHERE envelope_id=?').bind(envelope.id),
            env.DB.prepare('DELETE FROM signers WHERE envelope_id=?').bind(envelope.id),
          ];
          const signerIds = [];
          const roles = [];
          body.signers.forEach((s, i) => {
            const sid = uid();
            const role = s.role === 'cc' ? 'cc' : 'signer';
            signerIds.push(sid);
            roles.push(role);
            stmts.push(env.DB.prepare('INSERT INTO signers (id,envelope_id,name,email,order_index,status,role) VALUES (?,?,?,?,?,?,?)')
              .bind(sid, envelope.id, String(s.name || '').trim().slice(0, 120), String(s.email || '').trim().slice(0, 200), i, 'pending', role));
          });
          for (const f of body.fields) {
            const si = f.signer_index | 0;
            if (si < 0 || si >= signerIds.length) return bad('field assigned to unknown signer');
            if (roles[si] === 'cc') return bad('CC recipients cannot have fields');
            if (!['signature', 'initials', 'date', 'text', 'checkbox'].includes(f.type)) return bad('bad field type');
            const num = v => Math.max(0, Math.min(1, Number(v) || 0));
            stmts.push(env.DB.prepare('INSERT INTO fields (id,envelope_id,signer_id,type,page,x,y,w,h,required) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .bind(uid(), envelope.id, signerIds[si], f.type, Math.max(0, f.page | 0), num(f.x), num(f.y), num(f.w), num(f.h), f.type === 'checkbox' ? 0 : 1));
          }
          await env.DB.batch(stmts);
          return J({ ok: true });
        }

        if (m === 'POST' && sub === '/send') {
          if (envelope.status !== 'draft') return bad('already sent');
          const body = await req.json().catch(() => ({}));
          const signers = await getSigners(env, envelope.id);
          const fields = await getFields(env, envelope.id);
          if (!signers.some(s => (s.role || 'signer') === 'signer')) return bad('add at least one signer (not just CC)');
          for (const s of signers) {
            if (!s.name) return bad('every recipient needs a name');
            if (s.email && !/.+@.+\..+/.test(s.email)) return bad(`recipient "${s.name}" has an invalid email`);
            if ((s.role || 'signer') === 'signer' &&
              !fields.some(f => f.signer_id === s.id && (f.type === 'signature' || f.type === 'initials')))
              return bad(`signer "${s.name}" has no signature field`);
          }
          const routing = body.routing === 'parallel' ? 'parallel' : 'sequential';
          const expireDays = [7, 14, 30].includes(body.expireDays | 0) ? body.expireDays | 0 : 0;
          const expiresAt = expireDays ? new Date(Date.now() + expireDays * 86400_000).toISOString() : null;
          const stmts = signers.map(s =>
            env.DB.prepare('UPDATE signers SET token=? WHERE id=?').bind(uid() + uid(), s.id));
          stmts.push(env.DB.prepare("UPDATE envelopes SET status='sent', sent_at=?, routing=?, expires_at=? WHERE id=?")
            .bind(now(), routing, expiresAt, envelope.id));
          await env.DB.batch(stmts);
          await audit(env, envelope.id, null, 'sent', req, String((body && body.note) || '').slice(0, 300));
          const fresh = await getSigners(env, envelope.id);
          return J({ ok: true, signers: fresh.map(s => ({ name: s.name, email: s.email, link: `${url.origin}/s/${s.token}` })) });
        }

        if (m === 'POST' && sub === '/adddoc') {
          if (envelope.status !== 'draft') return bad('documents can only be added while draft');
          const docs = JSON.parse(envelope.docs_json || 'null') || [{ name: 'Document 1', sha256: envelope.original_sha256 }];
          if (docs.length >= 5) return bad('max 5 documents per envelope');
          const form = await req.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') return bad('file required');
          const bytes = await file.arrayBuffer();
          const v = await validatePdf(bytes);
          if (typeof v === 'string') return bad(v);
          const origObj = await env.DOCS.get(envelope.original_key);
          const merged = await PDFDocument.create();
          for (const src of [await origObj.arrayBuffer(), bytes]) {
            const d = await PDFDocument.load(src);
            (await merged.copyPages(d, d.getPageIndices())).forEach(pg => merged.addPage(pg));
          }
          const out = await merged.save();
          if (out.byteLength > MAX_PDF * 2) return bad('combined document too large');
          docs.push({ name: clean(String(form.get('name') || file.name || `Document ${docs.length + 1}`)).slice(0, 80), sha256: await sha256hex(bytes) });
          await env.DOCS.put(envelope.original_key, out,
            { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { pages: String(merged.getPageCount()) } });
          await env.DB.prepare('UPDATE envelopes SET original_sha256=?, docs_json=? WHERE id=?')
            .bind(await sha256hex(out), JSON.stringify(docs), envelope.id).run();
          await audit(env, envelope.id, null, 'doc-added', req, docs[docs.length - 1].name);
          return J({ ok: true, pages: merged.getPageCount() });
        }

        if (m === 'POST' && sub === '/void') {
          if (envelope.status === 'completed') return bad('completed envelopes cannot be voided');
          await env.DB.prepare("UPDATE envelopes SET status='voided' WHERE id=?").bind(envelope.id).run();
          await audit(env, envelope.id, null, 'voided', req);
          return J({ ok: true });
        }

        if (m === 'GET' && (sub === '/pdf' || sub === '/final')) {
          const key = sub === '/pdf' ? envelope.original_key : envelope.final_key;
          if (!key) return bad('not available', 404);
          const obj = await env.DOCS.get(key);
          if (!obj) return bad('missing object', 404);
          return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${clean(envelope.title).replace(/"/g, '')}${sub === '/final' ? '-signed' : ''}.pdf"` } });
        }
        return bad('not found', 404);
      }

      // ---------- signer API ----------
      const sm = p.match(/^\/api\/session\/([A-Za-z0-9]+)(\/[a-z]+)?$/);
      if (sm) {
        const signer = await env.DB.prepare('SELECT * FROM signers WHERE token=?').bind(sm[1]).first();
        if (!signer) return bad('invalid or expired link', 404);
        let envelope = await getEnvelope(env, signer.envelope_id);
        if (!envelope) return bad('not found', 404);
        envelope = await ensureFinalized(env, envelope, req);
        const sub = sm[2] || '';
        const all = await getSigners(env, envelope.id);
        const signersOnly = all.filter(s => (s.role || 'signer') === 'signer');
        const isViewer = (signer.role || 'signer') === 'cc';
        const myTurn = !isViewer && envelope.status === 'sent' && signer.status === 'pending' &&
          (envelope.routing === 'parallel' ||
            signersOnly.every(s => s.order_index >= signer.order_index || s.status === 'signed'));
        const waitingOn = signersOnly.find(s => s.status !== 'signed');

        if (m === 'GET' && sub === '') {
          if (envelope.status !== 'voided' && signer.status !== 'signed') await audit(env, envelope.id, signer.id, 'viewed', req);
          const fields = (await getFields(env, envelope.id)).filter(f => f.signer_id === signer.id)
            .map(f => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, value: f.value }));
          const senderRow = envelope.sender_id
            ? await env.DB.prepare('SELECT name,email FROM senders WHERE id=?').bind(envelope.sender_id).first() : null;
          return J({
            title: envelope.title, status: envelope.status,
            sender: senderRow ? `${senderRow.name} (${senderRow.email} — unverified)` : 'Black Label Technologies',
            consentVersion: CONSENT_VERSION, viewer: isViewer, routing: envelope.routing,
            expiresAt: envelope.expires_at || null,
            signer: { name: signer.name, email: signer.email, status: signer.status, consented: !!signer.consent_at },
            myTurn, waitingOn: waitingOn && waitingOn.id !== signer.id ? waitingOn.name : null,
            fields,
          });
        }

        if (m === 'POST' && sub === '/decline') {
          if (!myTurn) return bad('not your turn or already signed');
          const b = await req.json().catch(() => ({}));
          const reason = clean(b.reason || '').slice(0, 300);
          const claim = await env.DB.prepare("UPDATE signers SET status='declined' WHERE id=? AND status='pending'")
            .bind(signer.id).run();
          if (!claim.meta.changes) return bad('already acted', 409);
          await env.DB.prepare("UPDATE envelopes SET status='declined' WHERE id=? AND status='sent'").bind(envelope.id).run();
          await audit(env, envelope.id, signer.id, 'declined', req, reason);
          return J({ ok: true });
        }

        if (m === 'GET' && sub === '/pdf') {
          if (envelope.status === 'voided') return bad('envelope voided', 410);
          const obj = await env.DOCS.get(envelope.status === 'completed' && envelope.final_key ? envelope.final_key : envelope.original_key);
          if (!obj) return bad('missing object', 404);
          return new Response(obj.body, { headers: { 'content-type': 'application/pdf' } });
        }

        if (m === 'POST' && sub === '/consent') {
          if (!myTurn) return bad('not your turn or already signed');
          await env.DB.prepare('UPDATE signers SET consent_at=COALESCE(consent_at,?) WHERE id=?').bind(now(), signer.id).run();
          await audit(env, envelope.id, signer.id, 'consented', req, CONSENT_VERSION);
          return J({ ok: true });
        }

        if (m === 'POST' && sub === '/complete') {
          if (!myTurn) return bad('not your turn or already signed');
          if (!signer.consent_at) return bad('consent required first');
          const body = await req.json().catch(() => null);
          const values = body && body.values ? body.values : {};
          const mine = (await getFields(env, envelope.id)).filter(f => f.signer_id === signer.id);
          const stmts = [];
          for (const f of mine) {
            const v = values[f.id] || {};
            if (f.type === 'signature' || f.type === 'initials') {
              const png = typeof v.png === 'string' ? v.png : '';
              if (!png.startsWith('data:image/png;base64,')) { if (f.required) return bad(`missing ${f.type}`); continue; }
              let bin;
              try { bin = Uint8Array.from(atob(png.slice(22)), c => c.charCodeAt(0)); }
              catch { return bad('signature image is not valid base64'); }
              if (bin.byteLength > MAX_SIG_PNG) return bad('signature image too large');
              if (!isPng(bin)) return bad('signature image must be a PNG');
              await env.DOCS.put(`sig/${f.id}.png`, bin, { httpMetadata: { contentType: 'image/png' } });
              stmts.push(env.DB.prepare('UPDATE fields SET value=? WHERE id=?').bind('png', f.id));
            } else if (f.type === 'checkbox') {
              stmts.push(env.DB.prepare('UPDATE fields SET value=? WHERE id=?').bind(v.v ? '1' : '', f.id));
            } else {
              const t = clean(v.v || '').slice(0, 300);
              if (f.required && !t.trim()) return bad(`missing required ${f.type} field`);
              stmts.push(env.DB.prepare('UPDATE fields SET value=? WHERE id=?').bind(t, f.id));
            }
          }
          if (stmts.length) await env.DB.batch(stmts);
          // Optimistic claim — a double-submit (two tabs, retry) loses here instead of
          // double-logging and double-finalizing.
          const claim = await env.DB.prepare(
            "UPDATE signers SET status='signed', signed_at=?, ip=?, ua=? WHERE id=? AND status!='signed'")
            .bind(now(), req.headers.get('cf-connecting-ip') || '', (req.headers.get('user-agent') || '').slice(0, 300), signer.id).run();
          if (!claim.meta.changes) return bad('already signed', 409);
          await audit(env, envelope.id, signer.id, 'signed', req);
          const remaining = await env.DB.prepare("SELECT name FROM signers WHERE envelope_id=? AND role='signer' AND status!='signed' ORDER BY order_index").bind(envelope.id).all();
          if (remaining.results.length === 0) {
            try { await finalize(env, envelope, req); }
            catch (e) {
              // Signature is recorded; ensureFinalized() re-runs sealing on any later read.
              console.error('finalize failed, will retry on read', envelope.id, e && e.stack || e);
            }
            return J({ ok: true, completed: true });
          }
          return J({ ok: true, completed: false, next: remaining.results[0].name });
        }

        if (m === 'GET' && sub === '/download') {
          if (envelope.status !== 'completed' || !envelope.final_key) return bad('not completed yet', 409);
          const obj = await env.DOCS.get(envelope.final_key);
          if (!obj) return bad('missing object', 404);
          await audit(env, envelope.id, signer.id, 'downloaded', req);
          return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${clean(envelope.title).replace(/"/g, '')}-signed.pdf"` } });
        }
        return bad('not found', 404);
      }

      return bad('not found', 404);
    } catch (e) {
      console.error('unhandled', p, e && e.stack || e);
      return J({ error: 'server error' }, 500);
    }
  },
};

// ---------- finalize: burn fields + certificate into the PDF ----------
async function finalize(env, envelope, req) {
  const obj = await env.DOCS.get(envelope.original_key);
  const orig = await obj.arrayBuffer();
  const doc = await PDFDocument.load(orig);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const signers = await getSigners(env, envelope.id);
  const fields = await getFields(env, envelope.id);
  const ink = rgb(0.07, 0.09, 0.35);

  for (const f of fields) {
    if (f.page >= doc.getPageCount()) continue;
    const page = doc.getPage(f.page);
    const { width: W, height: H } = page.getSize();
    const x = f.x * W, wpt = f.w * W, hpt = f.h * H, y = H - f.y * H - hpt;
    if (f.type === 'signature' || f.type === 'initials') {
      if (f.value !== 'png') continue;
      const s = await env.DOCS.get(`sig/${f.id}.png`);
      if (!s) continue;
      const png = await doc.embedPng(await s.arrayBuffer());
      const scale = Math.min(wpt / png.width, hpt / png.height);
      const dw = png.width * scale, dh = png.height * scale;
      page.drawImage(png, { x: x + (wpt - dw) / 2, y: y + (hpt - dh) / 2, width: dw, height: dh });
    } else if (f.type === 'checkbox') {
      if (f.value) {
        const size = Math.min(hpt * 0.9, 14);
        page.drawText('X', { x: x + (wpt - bold.widthOfTextAtSize('X', size)) / 2, y: y + (hpt - size) / 2 + size * 0.1, size, font: bold, color: ink });
      }
    } else {
      const t = clean(f.value || '');
      if (!t) continue;
      let size = Math.min(hpt * 0.65, 13);
      while (size > 5 && helv.widthOfTextAtSize(t, size) > wpt - 2) size -= 0.5;
      page.drawText(t, { x: x + 1, y: y + (hpt - size) / 2 + size * 0.16, size, font: helv, color: ink });
    }
  }

  const stampText = `BL Sign  ·  Envelope ${envelope.id}  ·  verify: sign.blacklabeltec.com/verify/${envelope.id}`;
  for (const page of doc.getPages())
    page.drawText(stampText, { x: 10, y: 4, size: 6.5, font: helv, color: rgb(0.45, 0.45, 0.45) });

  // certificate of completion
  const events = (await env.DB.prepare('SELECT * FROM events WHERE envelope_id=? ORDER BY ts').bind(envelope.id).all()).results;
  const completedAt = now();
  const lines = [];
  const L = (t, o = {}) => lines.push([clean(t), o]);
  L('CERTIFICATE OF COMPLETION', { size: 15, bold: true, gap: 6 });
  L('Black Label Sign — sign.blacklabeltec.com', { size: 9, gray: true, gap: 10 });
  L(`Envelope ID: ${envelope.id}`);
  L(`Title: ${envelope.title}`);
  const senderRow = envelope.sender_id
    ? await env.DB.prepare('SELECT name,email FROM senders WHERE id=?').bind(envelope.sender_id).first() : null;
  L(senderRow
    ? `Sender: ${senderRow.name} <${senderRow.email}> (self-serve; email unverified)`
    : 'Sender: Black Label Technologies <michael@blacklabelbots.com>');
  L(`Created: ${envelope.created_at}   Sent: ${envelope.sent_at || '-'}   Completed: ${completedAt}`);
  L(`Routing: ${envelope.routing || 'sequential'}${envelope.expires_at ? `   Expires: ${envelope.expires_at}` : ''}`);
  L(`Original document SHA-256: ${envelope.original_sha256}`, { size: 8 });
  const docParts = JSON.parse(envelope.docs_json || 'null');
  if (docParts && docParts.length > 1) {
    L(`Combined from ${docParts.length} documents:`, { size: 8.5 });
    for (const dp of docParts) L(`   ${dp.name} — sha256 ${dp.sha256}`, { size: 7.5 });
  }
  L('The SHA-256 of this signed file and its live status are recorded at:');
  L(`https://sign.blacklabeltec.com/verify/${envelope.id}`, { gap: 10 });
  L('SIGNERS', { bold: true, gap: 4 });
  for (const s of signers.filter(x => (x.role || 'signer') === 'signer')) {
    L(`${s.order_index + 1}. ${s.name}${s.email ? ` <${s.email}>` : ''}`, { bold: true });
    L(`   Consented to electronic records & signatures (${CONSENT_VERSION}): ${s.consent_at || '-'}`);
    L(`   Signed: ${s.signed_at || '-'}   IP: ${s.ip || '-'}`);
    L(`   Device: ${(s.ua || '-').slice(0, 95)}`, { size: 8, gap: 5 });
  }
  const ccs = signers.filter(x => x.role === 'cc');
  if (ccs.length) {
    L('COPIED (CC — received the completed document, no signature required)', { bold: true, gap: 4 });
    for (const s of ccs) L(`   ${s.name}${s.email ? ` <${s.email}>` : ''}`, { size: 8.5 });
  }
  L('EVENT LOG', { bold: true, gap: 4 });
  const byId = Object.fromEntries(signers.map(s => [s.id, s.name]));
  for (const ev of events.slice(0, 120))
    L(`${ev.ts}  ${ev.type.padEnd(10)}  ${(byId[ev.signer_id] || 'sender').padEnd(20).slice(0, 20)}  ${ev.ip || ''}`, { size: 7.5, mono: true });

  let page = doc.addPage([612, 792]);
  let ypos = 752;
  for (const [text, o] of lines) {
    const size = o.size || 9.5;
    if (ypos < 40) { page = doc.addPage([612, 792]); ypos = 752; }
    page.drawText(text, {
      x: 46, y: ypos, size, font: o.bold ? bold : helv,
      color: o.gray ? rgb(0.45, 0.45, 0.45) : rgb(0.1, 0.1, 0.1),
    });
    ypos -= size + 3 + (o.gap || 0);
  }
  page.drawText(stampText, { x: 10, y: 4, size: 6.5, font: helv, color: rgb(0.45, 0.45, 0.45) });

  const bytes = await doc.save();
  const finalKey = `final/${envelope.id}.pdf`;
  await env.DOCS.put(finalKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  await env.DB.prepare("UPDATE envelopes SET status='completed', completed_at=?, final_key=?, final_sha256=? WHERE id=?")
    .bind(completedAt, finalKey, await sha256hex(bytes), envelope.id).run();
  await audit(env, envelope.id, null, 'completed', req);
}

// ---------- public integrity page ----------
async function verifyPage(env, id) {
  let envelope = await getEnvelope(env, id);
  if (!envelope) return new Response('Not found', { status: 404 });
  envelope = await ensureFinalized(env, envelope, null);
  const signers = await getSigners(env, id);
  const rows = signers.map(s =>
    `<tr><td>${esc(s.name)}${s.role === 'cc' ? ' <span class="muted small">(cc)</span>' : ''}</td><td>${s.status === 'signed' ? '✓ signed' : esc(s.status)}</td><td>${esc(s.signed_at || '—')}</td></tr>`).join('');
  const docParts = JSON.parse(envelope.docs_json || 'null');
  const partsRows = docParts && docParts.length > 1
    ? `<h3>Source documents</h3><table class="kv">${docParts.map(dp =>
        `<tr><td>${esc(dp.name)}</td><td class="mono small">${esc(dp.sha256)}</td></tr>`).join('')}</table>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify — BL Sign</title><link rel="stylesheet" href="/assets/app.css"></head><body>
<div class="wrap narrow"><div class="card">
<h1 class="gold">BL Sign — Envelope Verification</h1>
<p class="muted">Black Label Technologies · sign.blacklabeltec.com</p>
<table class="kv">
<tr><td>Envelope</td><td class="mono">${esc(envelope.id)}</td></tr>
<tr><td>Title</td><td>${esc(envelope.title)}</td></tr>
<tr><td>Status</td><td><span class="chip ${esc(envelope.status)}">${esc(envelope.status)}</span></td></tr>
<tr><td>Created</td><td>${esc(envelope.created_at)}</td></tr>
<tr><td>Completed</td><td>${esc(envelope.completed_at || '—')}</td></tr>
<tr><td>Original SHA-256</td><td class="mono small">${esc(envelope.original_sha256)}</td></tr>
<tr><td>Signed-file SHA-256</td><td class="mono small">${esc(envelope.final_sha256 || '— (not completed)')}</td></tr>
</table>
<h3>Signers</h3><table class="kv">${rows}</table>
${partsRows}
<p class="muted small">To verify a copy of the signed document, compute its SHA-256
(<span class="mono">shasum -a 256 file.pdf</span>) and compare it to the hash above.</p>
</div></div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
}
