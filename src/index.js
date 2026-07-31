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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      // ---------- pages ----------
      if (m === 'GET' && p === '/') return Response.redirect(url.origin + '/admin', 302);
      if (m === 'GET' && p === '/admin') return serveAsset(env, url, isAdmin(req, env) ? '/admin.html' : '/login.html');
      if (m === 'GET' && /^\/admin\/env\/[a-f0-9]+$/.test(p))
        return serveAsset(env, url, isAdmin(req, env) ? '/editor.html' : '/login.html');
      if (m === 'GET' && /^\/s\/[A-Za-z0-9]+$/.test(p)) return serveAsset(env, url, '/sign.html');
      if (m === 'GET' && p.startsWith('/assets/')) return env.ASSETS.fetch(req);
      if (m === 'GET' && p === '/favicon.ico') return new Response(null, { status: 204 });

      if (m === 'GET' && /^\/verify\/[a-f0-9]+$/.test(p)) return verifyPage(env, p.split('/').pop());

      // ---------- auth ----------
      if (m === 'POST' && p === '/api/login') {
        const body = await req.json().catch(() => ({}));
        if (!env.ADMIN_TOKEN || body.token !== env.ADMIN_TOKEN) return bad('nope', 403);
        return J({ ok: true }, 200, {
          'set-cookie': `blsign=${env.ADMIN_TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
      }
      if (m === 'POST' && p === '/api/logout')
        return J({ ok: true }, 200, { 'set-cookie': 'blsign=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });

      // ---------- admin API ----------
      if (p.startsWith('/api/envelopes')) {
        if (!isAdmin(req, env)) return bad('unauthorized', 401);

        if (m === 'POST' && p === '/api/envelopes') {
          const form = await req.formData();
          const file = form.get('file');
          const title = String(form.get('title') || '').trim();
          if (!title) return bad('title required');
          if (!file || typeof file === 'string') return bad('file required');
          const bytes = await file.arrayBuffer();
          if (bytes.byteLength > MAX_PDF) return bad('PDF too large (15MB max)');
          if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return bad('not a PDF');
          const id = uid();
          const key = `orig/${id}.pdf`;
          await env.DOCS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
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
        const envelope = await getEnvelope(env, em[1]);
        if (!envelope) return bad('not found', 404);
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
          const stmts = [
            env.DB.prepare('DELETE FROM fields WHERE envelope_id=?').bind(envelope.id),
            env.DB.prepare('DELETE FROM signers WHERE envelope_id=?').bind(envelope.id),
          ];
          const signerIds = [];
          body.signers.forEach((s, i) => {
            const sid = uid();
            signerIds.push(sid);
            stmts.push(env.DB.prepare('INSERT INTO signers (id,envelope_id,name,email,order_index,status) VALUES (?,?,?,?,?,?)')
              .bind(sid, envelope.id, String(s.name || '').trim().slice(0, 120), String(s.email || '').trim().slice(0, 200), i, 'pending'));
          });
          for (const f of body.fields) {
            const si = f.signer_index | 0;
            if (si < 0 || si >= signerIds.length) return bad('field assigned to unknown signer');
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
          const signers = await getSigners(env, envelope.id);
          const fields = await getFields(env, envelope.id);
          if (!signers.length) return bad('add at least one signer');
          for (const s of signers) {
            if (!s.name || !/.+@.+\..+/.test(s.email)) return bad(`signer "${s.name || '?'}" needs a name and valid email`);
            if (!fields.some(f => f.signer_id === s.id && (f.type === 'signature' || f.type === 'initials')))
              return bad(`signer "${s.name}" has no signature field`);
          }
          const stmts = signers.map(s =>
            env.DB.prepare('UPDATE signers SET token=? WHERE id=?').bind(uid() + uid(), s.id));
          stmts.push(env.DB.prepare("UPDATE envelopes SET status='sent', sent_at=? WHERE id=?").bind(now(), envelope.id));
          await env.DB.batch(stmts);
          await audit(env, envelope.id, null, 'sent', req);
          const fresh = await getSigners(env, envelope.id);
          return J({ ok: true, signers: fresh.map(s => ({ name: s.name, email: s.email, link: `${url.origin}/s/${s.token}` })) });
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
        const envelope = await getEnvelope(env, signer.envelope_id);
        if (!envelope) return bad('not found', 404);
        const sub = sm[2] || '';
        const all = await getSigners(env, envelope.id);
        const myTurn = envelope.status === 'sent' && signer.status !== 'signed' &&
          all.every(s => s.order_index >= signer.order_index || s.status === 'signed');
        const waitingOn = all.find(s => s.status !== 'signed');

        if (m === 'GET' && sub === '') {
          if (envelope.status !== 'voided' && signer.status !== 'signed') await audit(env, envelope.id, signer.id, 'viewed', req);
          const fields = (await getFields(env, envelope.id)).filter(f => f.signer_id === signer.id)
            .map(f => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, value: f.value }));
          return J({
            title: envelope.title, status: envelope.status,
            sender: 'Black Label Technologies', consentVersion: CONSENT_VERSION,
            signer: { name: signer.name, email: signer.email, status: signer.status, consented: !!signer.consent_at },
            myTurn, waitingOn: waitingOn && waitingOn.id !== signer.id ? waitingOn.name : null,
            fields,
          });
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
              const b64 = png.slice(22);
              const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
              if (bin.byteLength > MAX_SIG_PNG) return bad('signature image too large');
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
          stmts.push(env.DB.prepare("UPDATE signers SET status='signed', signed_at=?, ip=?, ua=? WHERE id=?")
            .bind(now(), req.headers.get('cf-connecting-ip') || '', (req.headers.get('user-agent') || '').slice(0, 300), signer.id));
          await env.DB.batch(stmts);
          await audit(env, envelope.id, signer.id, 'signed', req);
          const remaining = await env.DB.prepare("SELECT name FROM signers WHERE envelope_id=? AND status!='signed' ORDER BY order_index").bind(envelope.id).all();
          if (remaining.results.length === 0) {
            await finalize(env, envelope, req);
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
      return J({ error: 'server error', detail: String(e && e.message || e) }, 500);
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
  L('Sender: Black Label Technologies <michael@blacklabelbots.com>');
  L(`Created: ${envelope.created_at}   Sent: ${envelope.sent_at || '-'}   Completed: ${completedAt}`);
  L(`Original document SHA-256: ${envelope.original_sha256}`, { size: 8 });
  L('The SHA-256 of this signed file and its live status are recorded at:');
  L(`https://sign.blacklabeltec.com/verify/${envelope.id}`, { gap: 10 });
  L('SIGNERS', { bold: true, gap: 4 });
  for (const s of signers) {
    L(`${s.order_index + 1}. ${s.name} <${s.email}>`, { bold: true });
    L(`   Consented to electronic records & signatures (${CONSENT_VERSION}): ${s.consent_at || '-'}`);
    L(`   Signed: ${s.signed_at || '-'}   IP: ${s.ip || '-'}`);
    L(`   Device: ${(s.ua || '-').slice(0, 95)}`, { size: 8, gap: 5 });
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
  const envelope = await getEnvelope(env, id);
  if (!envelope) return new Response('Not found', { status: 404 });
  const signers = await getSigners(env, id);
  const rows = signers.map(s =>
    `<tr><td>${esc(s.name)}</td><td>${s.status === 'signed' ? '✓ signed' : s.status}</td><td>${esc(s.signed_at || '—')}</td></tr>`).join('');
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
<p class="muted small">To verify a copy of the signed document, compute its SHA-256
(<span class="mono">shasum -a 256 file.pdf</span>) and compare it to the hash above.</p>
</div></div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
}
