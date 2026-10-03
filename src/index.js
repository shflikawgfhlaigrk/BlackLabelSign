// BL Sign — self-hosted e-signature (ESIGN/UETA: intent, consent, attribution, integrity, retention)
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { recoverSender, senderCookie } from './sender-recovery.mjs';
import { generateAuthCode } from './auth-code.mjs';
import { fieldPlacement } from './pdf-geometry.mjs';
import { buildDeliveryEmail, buildVerificationEmail, MAIL_FROM } from './mail.mjs';
import { normalizeSignaturePng, InvalidSignatureImage, MAX_SIGNATURE_BYTES } from './signature-png.mjs';
import { validateWholesaleTerms, buildWholesaleDrafts, appendWholesaleExecutionPage, WHOLESALE_DOCUMENT_KINDS } from './estate-wholesale.mjs';

const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...h } });
const bad = (m, s = 400) => J({ error: m }, s);
const uid = () => crypto.randomUUID().replaceAll('-', '');
const now = () => new Date().toISOString();
const TRANSLIT = { '—': '--', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', ' ': ' ', '•': '*' };
const clean = s => String(s ?? '').replace(/[—–‘’“”… •]/g, c => TRANSLIT[c]).replace(/[^\x20-\x7E]/g, '?');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CONSENT_VERSION = 'esign-v1';
const MAX_PDF = 15 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = value => EMAIL_RE.test(String(value || '').trim());
function estateBridgeAuthorized(req, env) {
  const got = new TextEncoder().encode(req.headers.get('x-estate-bridge') || '');
  const expected = new TextEncoder().encode(String(env.ESTATE_BRIDGE_TOKEN || ''));
  if (!expected.length) return false;
  let diff = got.length === expected.length ? 0 : 1;
  for (let i = 0, n = Math.max(got.length, expected.length); i < n; i++) diff |= (got[i] || 0) ^ (expected[i] || 0);
  return diff === 0;
}

async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const AUTH_CODE_TTL_MS = 10 * 60_000;
const AUTH_SESSION_TTL_MS = 12 * 60 * 60_000;
const AUTH_CODE_RESEND_MS = 60_000;
const textBytes = value => new TextEncoder().encode(String(value));
const authCookieName = signer => `blsa_${signer.id.slice(0, 24)}`;
const maskedEmail = value => {
  const [local, domain] = String(value || '').split('@');
  if (!domain) return '';
  const shown = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(2, local.length - shown.length))}@${domain}`;
};

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', textBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmacHex(secret, value) {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), textBytes(value));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// A single INSERT checks every applicable budget on D1's write primary.
// Attempts stay consumed after deletion, provider failure, or a crashed request.
// Fixed UTC-day quotas preserve the public tier; verification uses a rolling hour.
async function reserveUsage(env, kind, identity, limits, purpose = '', eligible = '1', args = [], after = () => []) {
  if (!env.SESSION_SECRET) throw new Error('usage protection is not configured');
  const keys = {};
  for (const scope of ['account', 'network', 'recipient', 'subject'])
    keys[scope] = await hmacHex(env.SESSION_SECRET, `usage:${scope}:${String(identity[scope] || 'unknown').trim().toLowerCase()}`);
  const id = uid(), conditions = [], bindings = [];
  for (const { scope, max, hourly = false, purpose: limitedPurpose } of limits) {
    const match = scope === 'global' ? '' : ` AND ${scope}_key=?`;
    conditions.push(`(SELECT COUNT(*) FROM abuse_usage WHERE kind=?${match}
      ${limitedPurpose ? 'AND purpose=?' : ''}
      AND used_at>=unixepoch('now', '${hourly ? '-1 hour' : 'start of day'}')) < ?`);
    bindings.push(kind);
    if (scope !== 'global') bindings.push(keys[scope]);
    if (limitedPurpose) bindings.push(limitedPurpose);
    bindings.push(max);
  }
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO abuse_usage (id,kind,purpose,account_key,network_key,recipient_key,subject_key)
      SELECT ?,?,?,?,?,?,? WHERE (${eligible}) AND ${conditions.join(' AND ')}`)
      .bind(id, kind, purpose, keys.account, keys.network, keys.recipient, keys.subject, ...args, ...bindings),
    ...after('EXISTS (SELECT 1 FROM abuse_usage WHERE id=?)', [id]),
  ]);
  return result[0].meta.changes ? id : null;
}

async function reserveEnvelopeUsage(env, sender, upload = null) {
  const eligible = `EXISTS (SELECT 1 FROM senders WHERE id=? AND token=?)${upload ?
    ' AND NOT EXISTS (SELECT 1 FROM envelope_uploads WHERE sender_id=? AND request_key=?)' : ''}`;
  return reserveUsage(env, 'envelope', { account: sender.email, network: sender.ip }, [
    { scope: 'account', max: 3 }, { scope: 'network', max: 30 }, { scope: 'global', max: 200 },
  ], '', eligible, [sender.id, sender.token, ...(upload ? [sender.id, upload.requestKey] : [])],
  upload ? (g,a) => [
    env.DB.prepare(`INSERT INTO envelopes (id,title,status,created_at,original_key,original_sha256,sender_id)
      SELECT ?,?,'uploading',?,?,?,? WHERE ${g}`).bind(upload.id,upload.title,now(),upload.key,upload.hash,sender.id,...a),
    env.DB.prepare(`INSERT INTO envelope_objects (envelope_id,key,published) SELECT ?,?,0 WHERE ${g}`).bind(upload.id,upload.key,...a),
    env.DB.prepare(`INSERT INTO envelope_uploads (sender_id,request_key,fingerprint,envelope_id)
      SELECT ?,?,?,? WHERE ${g}`).bind(sender.id,upload.requestKey,upload.fingerprint,upload.id,...a),
  ] : undefined);
}

async function reserveMailUsage(env, envelope, signer, kind, challengeId = null) {
  const owner = envelope.sender_id
    ? await env.DB.prepare('SELECT email,ip FROM senders WHERE id=?').bind(envelope.sender_id).first()
    : { email: 'admin', ip: 'admin' };
  if (!owner) return null;
  const verification = kind === 'verification';
  const limits = [
    { scope: 'account', max: 150 }, { scope: 'network', max: 300 },
    { scope: 'global', max: 10000 }, { scope: 'recipient', max: 50 },
    ...(verification ? [
      { scope: 'recipient', max: 5, hourly: true, purpose: 'verification' },
      { scope: 'subject', max: 5, hourly: true, purpose: 'verification' },
    ] : []),
  ];
  const eligible = `EXISTS (SELECT 1 FROM signers s JOIN envelopes e ON e.id=s.envelope_id
    WHERE s.id=? AND s.token=? AND e.id=? AND e.status!='deleting'
      AND (e.sender_id IS NULL OR EXISTS (SELECT 1 FROM senders WHERE id=e.sender_id))
      AND ${verification ? 's.auth_challenge_id=?' : `s.delivery_status NOT IN ('sending','uncertain') AND s.delivery_attempts<5
        AND ${kind === 'completion' ? "e.status='completed' AND COALESCE(s.last_delivery_kind,'')!='completion'" :
          "e.status='sent' AND s.status='pending' AND s.role='signer' AND (e.expires_at IS NULL OR e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (s.delivery_at IS NULL OR s.delivery_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))"}
        ${kind === 'reminder' ? 'AND s.reminder_count<3' : ''}`})`;
  return reserveUsage(env, 'mail', { account: owner.email, network: owner.ip, recipient: signer.email, subject: signer.id },
    limits, kind, eligible, [signer.id, signer.token, envelope.id, ...(verification ? [challengeId] : [])],
    verification ? undefined : (guard, guardArgs) => [
      env.DB.prepare(`UPDATE signers SET delivery_status='sending',delivery_attempts=delivery_attempts+1,
        delivery_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), reminder_count=reminder_count+?
        WHERE id=? AND ${guard}`).bind(kind === 'reminder' ? 1 : 0, signer.id, ...guardArgs),
    ]);
}

async function signerAuthenticated(req, env, signer) {
  if (!validEmail(signer.email)) return true;
  if (!env.SESSION_SECRET) return false;
  const name = authCookieName(signer);
  const match = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return false;
  const [expiryText, signature] = match[1].split('.');
  const expiry = Number(expiryText);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const bytes = Uint8Array.from(signature.match(/.{2}/g), pair => parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), bytes,
    textBytes(`${signer.id}:${signer.token}:${expiryText}`));
}

async function signerSessionCookie(env, signer) {
  const expiry = Date.now() + AUTH_SESSION_TTL_MS;
  const signature = await hmacHex(env.SESSION_SECRET, `${signer.id}:${signer.token}:${expiry}`);
  return `${authCookieName(signer)}=${expiry}.${signature}; Max-Age=${AUTH_SESSION_TTL_MS / 1000}; Path=/api/session/${signer.token}; HttpOnly; Secure; SameSite=Strict`;
}

async function authCodeHash(env, signer, code) {
  return sha256hex(textBytes(`${env.SESSION_SECRET}:${signer.id}:${signer.token}:${code}`));
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
  return env.DB.prepare("SELECT * FROM senders WHERE token=? AND (token_expires_at IS NULL OR token_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(tok).first();
}
const canAccess = (envelope, admin, sender) =>
  admin || !!(sender && envelope.sender_id && envelope.sender_id === sender.id);

async function audit(env, envelopeId, signerId, type, req, detail = '') {
  await env.DB.prepare(`INSERT INTO events (id, envelope_id, signer_id, type, ts, ip, ua, detail) SELECT ?,?,?,?,?,?,?,? WHERE (?='auth' OR EXISTS (SELECT 1 FROM envelopes WHERE id=? AND status!='deleting'))`)
    .bind(uid(), envelopeId, signerId, type, now(),
      req ? (req.headers.get('cf-connecting-ip') || '') : '',
      req ? (req.headers.get('user-agent') || '') : '', detail, envelopeId, envelopeId).run();
}

const getEnvelope = (env, id) => env.DB.prepare('SELECT * FROM envelopes WHERE id=?').bind(id).first();
const getSigners = (env, id) => env.DB.prepare('SELECT * FROM signers WHERE envelope_id=? ORDER BY order_index').bind(id).all().then(r => r.results);
const getFields = (env, id) => env.DB.prepare('SELECT * FROM fields WHERE envelope_id=?').bind(id).all().then(r => r.results);

// D1 batch is a transaction. Only its winning envelope claim can change
// dependent rows or publish an object reference; every attempt has a unique ID.
async function mutateEnvelope(env, id, condition, args, build, set = '', values = []) {
  const claimId = uid();
  const guard = 'EXISTS (SELECT 1 FROM envelopes WHERE id=? AND mutation_id=?)';
  const guardArgs = [id, claimId];
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE envelopes SET revision=revision+1, mutation_id=?${set ? ', ' + set : ''}
      WHERE id=? AND (${condition})`).bind(claimId, ...values, id, ...args),
    ...build(guard, guardArgs),
  ]);
  return !!result[0].meta.changes;
}
function guardedAudit(env, id, signerId, type, req, detail, guard, args) {
  return env.DB.prepare(`INSERT INTO events (id,envelope_id,signer_id,type,ts,ip,ua,detail)
    SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(uid(), id, signerId, type, now(),
    req?.headers.get('cf-connecting-ip') || '', req?.headers.get('user-agent') || '', detail || '', ...args);
}
function objectReference(env, id, key, guard, args) {
  return env.DB.prepare(`INSERT INTO envelope_objects (envelope_id,key,published)
    SELECT ?,?,1 WHERE ${guard} ON CONFLICT(key) DO UPDATE SET published=1`).bind(id, key, ...args);
}
// Register before upload, independently of acceptance, so DB outages and worker
// crashes leave recoverable keys. Publication requires a still-live staging row.
async function stageObject(env, id, key, bytes, options) {
  const registered = await env.DB.prepare(`INSERT INTO envelope_objects (envelope_id,key,published)
    SELECT ?,?,0 WHERE EXISTS (SELECT 1 FROM envelopes WHERE id=? AND status!='deleting')`).bind(id, key, id).run();
  if (!registered.meta.changes) return false;
  await env.DOCS.put(key, bytes, options);
  return true;
}
const stagedObject = 'EXISTS (SELECT 1 FROM envelope_objects WHERE key=? AND published=0)';
async function discardUnpublished(env, keys) {
  for (const key of keys) {
    const row = await env.DB.prepare('SELECT published FROM envelope_objects WHERE key=?').bind(key).first();
    if (row?.published !== 1) {
      await env.DOCS.delete(key);
      await env.DB.prepare('DELETE FROM envelope_objects WHERE key=? AND published!=1').bind(key).run();
    }
  }
}
async function cleanAbandonedObjects(env) {
  // Cancel before deleting. Keep opaque cancellation markers after a crashed
  // request, so even a late upload is reaped on subsequent hourly sweeps.
  await env.DB.prepare(`UPDATE envelope_objects SET published=-1 WHERE published=0 AND
    (NOT EXISTS (SELECT 1 FROM envelopes WHERE id=envelope_id) OR
      created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))`).run();
  const abandoned = (await env.DB.prepare('SELECT key FROM envelope_objects WHERE published=-1').all()).results;
  for (const row of abandoned) await env.DOCS.delete(row.key);
}
async function documentIntegrityFailure(env,envelope,req,kind='original') {
  await mutateEnvelope(env,envelope.id,"status!='deleting' AND finalization_error IS NULL",[],
    (g,a) => [guardedAudit(env,envelope.id,null,'integrity-failed',req,`${kind}-integrity-mismatch`,g,a)],
    'finalization_error=?',[`${kind}-integrity-mismatch`]);
  return bad('Document integrity check failed. Contact the sender.',409);
}
const activeEnvelope = "status='sent' AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const eligibleSigner = `${activeEnvelope} AND EXISTS (
  SELECT 1 FROM signers s WHERE s.envelope_id=envelopes.id AND s.id=? AND s.token=?
    AND s.role='signer' AND s.status='pending'
    AND (envelopes.routing='parallel' OR NOT EXISTS (
      SELECT 1 FROM signers prior WHERE prior.envelope_id=envelopes.id AND prior.role='signer'
        AND prior.order_index<s.order_index AND prior.status!='signed')))`;
const allSigned = `EXISTS (SELECT 1 FROM signers WHERE envelope_id=envelopes.id AND role='signer')
  AND NOT EXISTS (SELECT 1 FROM signers WHERE envelope_id=envelopes.id AND role='signer' AND status!='signed')`;
async function expireEnvelope(env, id) {
  return mutateEnvelope(env, id,
    "status='sent' AND expires_at IS NOT NULL AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')", [],
    (g, a) => [guardedAudit(env, id, null, 'expired', null, '', g, a)], "status='expired'");
}

async function purgeEnvelope(env, envelope, sender = null) {
  // Close publication first so delayed requests cannot add references during purge.
  const claim = await env.DB.prepare(`UPDATE envelopes SET status='deleting',revision=revision+1 WHERE id=?
    AND (? IS NULL OR EXISTS (SELECT 1 FROM senders own WHERE own.id=envelopes.sender_id AND own.id=? AND own.token=?))`)
    .bind(envelope.id,sender?.id || null,sender?.id || null,sender?.token || null).run();
  if (!claim.meta.changes) return false;
  envelope = await getEnvelope(env, envelope.id);
  if (!envelope) return;
  const fields = await getFields(env, envelope.id);
  const objects = (await env.DB.prepare('SELECT key FROM envelope_objects WHERE envelope_id=?').bind(envelope.id).all()).results;
  const keys = [envelope.original_key, envelope.final_key, ...objects.map(o => o.key),
    ...fields.filter(field => field.value === 'png').map(field => field.signature_key || `sig/${field.id}.png`),
  ].filter(Boolean);
  if (keys.length) await env.DOCS.delete([...new Set(keys)]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM fields WHERE envelope_id=?').bind(envelope.id),
    env.DB.prepare('DELETE FROM signers WHERE envelope_id=?').bind(envelope.id),
    env.DB.prepare('DELETE FROM events WHERE envelope_id=?').bind(envelope.id),
    env.DB.prepare('DELETE FROM envelope_objects WHERE envelope_id=? AND published=1').bind(envelope.id),
    env.DB.prepare('UPDATE envelope_objects SET published=-1 WHERE envelope_id=?').bind(envelope.id),
    env.DB.prepare('DELETE FROM envelopes WHERE id=?').bind(envelope.id),
  ]);
  return true;
}

async function purgeTemplate(env,template,sender=null) {
  const claimId = uid();
  const claim = await env.DB.prepare(`UPDATE templates SET deletion_claim=? WHERE id=?
    AND (? IS NULL OR EXISTS (SELECT 1 FROM senders own WHERE own.id=templates.sender_id AND own.id=? AND own.token=?))`)
    .bind(claimId,template.id,sender?.id || null,sender?.id || null,sender?.token || null).run();
  if (!claim.meta.changes) return false;
  await env.DOCS.delete(template.key);
  await env.DB.prepare('DELETE FROM templates WHERE id=? AND deletion_claim=?').bind(template.id,claimId).run();
  return true;
}

async function serveAsset(env, url, path) {
  return env.ASSETS.fetch(new URL(path, url.origin).toString());
}

const NOINDEX = [/^\/s\//, /^\/e\//, /^\/admin/, /^\/verify\//, /^\/me$/, /^\/api\//];
function addSecurityHeaders(res, path) {
  const h = new Headers(res.headers);
  h.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  h.set('content-security-policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (NOINDEX.some(r => r.test(path))) {
    h.set('x-robots-tag', 'noindex, nofollow');
    h.set('cache-control', 'private, no-store, max-age=0');
    h.set('pragma', 'no-cache');
  }
  return new Response(res.body, { status: res.status, headers: h });
}

// Retry-safe completion: if everyone signed but a prior finalize attempt crashed
// (transient storage error), a later read retries. Invalid signature assets
// persist a failure marker and require sender review instead of read retries.
async function ensureFinalized(env, envelope, req) {
  if (envelope.status !== 'sent' || envelope.finalization_error) return envelope;
  if (envelope.expires_at && envelope.expires_at <= now()) {
    await expireEnvelope(env, envelope.id);
    return getEnvelope(env, envelope.id);
  }
  const ready = await env.DB.prepare(`SELECT id FROM envelopes WHERE id=? AND ${allSigned}`).bind(envelope.id).first();
  if (!ready) return envelope;
  try { await finalize(env, envelope, req); } catch (e) {
    console.error('finalize retry failed', envelope.id, e && e.stack || e);
    return envelope;
  }
  return getEnvelope(env, envelope.id);
}

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

async function senderIdentityFor(env, envelope) {
  const row = envelope.sender_id
    ? await env.DB.prepare('SELECT name,email FROM senders WHERE id=?').bind(envelope.sender_id).first()
    : null;
  const estate = !row ? await env.DB.prepare('SELECT sender_email FROM estate_wholesale_signing WHERE envelope_id=?')
    .bind(envelope.id).first() : null;
  return row
    ? { name: row.name, email: row.email, verified: false }
    : estate ? { name: 'SalesSwipe transaction', email: estate.sender_email, verified: false }
    : { name: 'Black Label Technologies', email: 'michael@blacklabelbots.com', verified: true };
}

const DEFINITIVE_MAIL_REJECTIONS = new Set([
  'E_VALIDATION_ERROR','E_FIELD_MISSING','E_TOO_MANY_RECIPIENTS','E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED','E_RECIPIENT_NOT_ALLOWED','E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE','E_CONTENT_TOO_LARGE','E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED',
  'E_HEADER_NOT_ALLOWED','E_HEADER_USE_API_FIELD','E_HEADER_VALUE_INVALID','E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID','E_HEADERS_TOO_LARGE','E_HEADERS_TOO_MANY','E_DELIVERY_FAILED',
]);
function emailFailure(error) {
  const code = String(error?.code || 'E_OUTCOME_UNKNOWN');
  return DEFINITIVE_MAIL_REJECTIONS.has(code) ? `${code}: Email service did not accept this request.`
    : 'E_OUTCOME_UNKNOWN: Delivery outcome needs review before another attempt.';
}

async function deliverRecipientEmail(env, envelope, signer, kind, senderIdentity = null) {
  if (!env.EMAIL?.send) return { signerId: signer.id, state: 'failed', error: 'Email delivery is temporarily unavailable.' };
  if (!await reserveMailUsage(env, envelope, signer, kind))
    return { signerId: signer.id, state: 'limited', error: 'delivery allowance exhausted or recipient no longer eligible' };
  const attemptedAt = now();
  const sender = senderIdentity || await senderIdentityFor(env, envelope);
  const link = `${env.PUBLIC_ORIGIN || 'https://sign.blacklabeltec.com'}/s/${signer.token}`;
  let result;
  try {
    result = await env.EMAIL.send(buildDeliveryEmail({ envelope, signer, sender, kind, link }));
  } catch (error) {
    const state = DEFINITIVE_MAIL_REJECTIONS.has(error?.code) ? 'failed' : 'uncertain';
    const detail = emailFailure(error);
    await env.DB.prepare(`UPDATE signers SET delivery_status=?, delivery_message_id=NULL,delivery_at=?,delivery_error=? WHERE id=?`)
      .bind(state, attemptedAt, detail, signer.id).run();
    await audit(env, envelope.id, signer.id, `email-${kind}-${state}`, null, detail);
    return { signerId: signer.id, state, error: detail };
  }
  const messageId = clean(result?.messageId || '').slice(0, 200);
  // A provider receipt is acceptance only. Losing receipt persistence is ambiguous:
  // retain the reserved sending state so neither scheduler nor sender can retry.
  try {
    if (!messageId) throw new Error('missing provider receipt');
    await env.DB.prepare(`UPDATE signers SET delivery_status='accepted',delivery_message_id=?,delivery_at=?,delivery_error=NULL,
      last_delivery_kind=?,last_reminded_at=CASE WHEN ?=1 THEN ? ELSE last_reminded_at END WHERE id=?`)
      .bind(messageId, attemptedAt, kind, kind === 'reminder' ? 1 : 0, attemptedAt, signer.id).run();
    await audit(env, envelope.id, signer.id, `email-${kind}-accepted`, null, messageId);
    return { signerId: signer.id, state: 'accepted', messageId };
  } catch {
    await env.DB.prepare(`UPDATE signers SET delivery_status='uncertain',delivery_error=? WHERE id=?`)
      .bind('Provider outcome needs review before another attempt.', signer.id).run().catch(() => {});
    return { signerId: signer.id, state: 'uncertain', error: 'Provider outcome needs review before another attempt.' };
  }
}

async function runNotificationSweep(env) {
  // No budget looks back more than 24 hours. Keep at most two days plus
  // the hourly sweep interval; deletion never resets an active allowance.
  await env.DB.prepare("DELETE FROM abuse_usage WHERE used_at<unixepoch('now','-2 days')").run();
  await cleanAbandonedObjects(env);
  await env.DB.prepare("DELETE FROM sender_recovery WHERE expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").run();
  const current = now();
  const expired = (await env.DB.prepare(
    "SELECT id FROM envelopes WHERE status='sent' AND expires_at IS NOT NULL AND expires_at<=?")
    .bind(current).all()).results;
  for (const envelope of expired) {
    await expireEnvelope(env, envelope.id);
  }

  const reminderBefore = new Date(Date.now() - 48 * 3600_000).toISOString();
  const pending = (await env.DB.prepare(`
    SELECT s.*, e.id AS env_id, e.title AS env_title, e.status AS env_status,
      e.sender_id AS env_sender_id, e.routing AS env_routing, e.expires_at AS env_expires_at,
      e.sent_at AS env_sent_at
    FROM signers s JOIN envelopes e ON e.id=s.envelope_id
    WHERE e.status='sent' AND s.role='signer' AND s.status='pending'
      AND (e.sender_id IS NULL OR s.last_delivery_kind IS NULL)
      AND s.delivery_attempts<5 AND s.delivery_status NOT IN ('sending','uncertain') AND COALESCE(s.delivery_at,e.sent_at)<=?
      AND (e.expires_at IS NULL OR e.expires_at>?)
      AND (e.routing='parallel' OR NOT EXISTS (
        SELECT 1 FROM signers prior WHERE prior.envelope_id=e.id AND prior.role='signer'
          AND prior.order_index<s.order_index AND prior.status!='signed'))
    ORDER BY e.sent_at, s.order_index LIMIT 50`)
    .bind(reminderBefore, current).all()).results;
  for (const row of pending) {
    if (row.last_delivery_kind && row.reminder_count >= 3) continue;
    const envelope = { id: row.env_id, title: row.env_title, status: row.env_status,
      sender_id: row.env_sender_id, routing: row.env_routing, expires_at: row.env_expires_at,
      sent_at: row.env_sent_at };
    await deliverRecipientEmail(env, envelope, row, row.last_delivery_kind ? 'reminder' : 'request');
  }

  const completionRetryBefore = new Date(Date.now() - 3600_000).toISOString();
  const completed = (await env.DB.prepare(`
    SELECT s.*, e.id AS env_id, e.title AS env_title, e.status AS env_status,
      e.sender_id AS env_sender_id, e.routing AS env_routing, e.expires_at AS env_expires_at
    FROM signers s JOIN envelopes e ON e.id=s.envelope_id
    WHERE e.status='completed' AND s.delivery_attempts<5 AND s.delivery_status NOT IN ('sending','uncertain')
      AND (s.last_delivery_kind IS NULL OR s.last_delivery_kind!='completion')
      AND (s.delivery_at IS NULL OR s.delivery_at<=?)
    ORDER BY e.completed_at LIMIT 50`).bind(completionRetryBefore).all()).results;
  for (const row of completed) {
    const envelope = { id: row.env_id, title: row.env_title, status: row.env_status,
      sender_id: row.env_sender_id, routing: row.env_routing, expires_at: row.env_expires_at };
    await deliverRecipientEmail(env, envelope, row, 'completion');
  }
}

export default {
  async fetch(req, env) {
    const incoming = new URL(req.url);
    const path = incoming.pathname;
    if (incoming.protocol !== 'https:') {
      incoming.protocol = 'https:';
      return addSecurityHeaders(Response.redirect(incoming.toString(), 308), path);
    }
    if (!['GET','HEAD','OPTIONS'].includes(req.method) &&
      ((req.headers.get('origin') && req.headers.get('origin') !== incoming.origin) || req.headers.get('sec-fetch-site') === 'cross-site'))
      return addSecurityHeaders(bad('This request must come from the BL Sign page.', 403), path);
    const routeRequest = req.method === 'HEAD' ? new Request(req, { method: 'GET' }) : req;
    const routed = await this.route(routeRequest, env);
    const res = req.method === 'HEAD'
      ? new Response(null, { status: routed.status, headers: routed.headers })
      : routed;
    return addSecurityHeaders(res, path);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runNotificationSweep(env));
  },

  async route(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      // ---------- pages ----------
      if (m === 'GET' && p === '/') return serveAsset(env, url, '/landing.html');
      if (m === 'GET' && p === '/privacy') return serveAsset(env, url, '/privacy.html');
      if (m === 'GET' && p === '/terms') return serveAsset(env, url, '/terms.html');
      if (m === 'GET' && p === '/accessibility') return serveAsset(env, url, '/accessibility.html');
      if (m === 'GET' && p === '/legal.css') return serveAsset(env, url, '/legal.css');
      if (m === 'GET' && p === '/me') return serveAsset(env, url, '/me.html');
      if (m === 'GET' && /^\/e\/[a-f0-9]+$/.test(p)) return serveAsset(env, url, '/editor.html');
      if (m === 'GET' && p === '/admin') return serveAsset(env, url, isAdmin(req, env) ? '/admin.html' : '/login.html');
      if (m === 'GET' && /^\/admin\/env\/[a-f0-9]+$/.test(p))
        return serveAsset(env, url, isAdmin(req, env) ? '/editor.html' : '/login.html');
      if (m === 'GET' && /^\/s\/[A-Za-z0-9]+$/.test(p)) return serveAsset(env, url, '/sign.html');
      if (m === 'GET' && p.startsWith('/assets/')) return env.ASSETS.fetch(req);
      if (m === 'GET' && p === '/favicon.ico') return new Response(null, { status: 204 });
      if (m === 'GET' && p === '/robots.txt')
        return new Response('User-agent: *\nDisallow: /s/\nDisallow: /e/\nDisallow: /admin\nDisallow: /verify/\nDisallow: /me\nDisallow: /api/\nSitemap: https://sign.blacklabeltec.com/sitemap.xml\n',
          { headers: { 'content-type': 'text/plain' } });
      if (m === 'GET' && p === '/sitemap.xml')
        return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://sign.blacklabeltec.com/</loc></url>\n<url><loc>https://sign.blacklabeltec.com/privacy</loc></url>\n<url><loc>https://sign.blacklabeltec.com/terms</loc></url>\n<url><loc>https://sign.blacklabeltec.com/accessibility</loc></url>\n</urlset>\n',
          { headers: { 'content-type': 'application/xml' } });
      if (m === 'GET' && p === '/llms.txt')
        return new Response([
          '# BL Sign',
          '',
          '> Free electronic-signature software with signer consent, audit certificates, and public SHA-256 hash verification.',
          '',
          'Canonical website: https://sign.blacklabeltec.com/',
          'Publisher: BlackLabel Tech (https://blacklabeltec.com/)',
          '',
          '## Public pages',
          '- [Product](https://sign.blacklabeltec.com/)',
          '- [Privacy](https://sign.blacklabeltec.com/privacy)',
          '- [Terms](https://sign.blacklabeltec.com/terms)',
          '- [Accessibility](https://sign.blacklabeltec.com/accessibility)',
          '',
          'Signer links, envelope workspaces, verification records, account pages, and APIs are intentionally excluded from indexing.',
          '',
        ].join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });

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

      if (m === 'DELETE' && p === '/api/public/account') {
        const sender = await senderFromReq(req, env);
        if (!sender) return bad('unauthorized', 401);
        const envelopes = (await env.DB.prepare('SELECT * FROM envelopes WHERE sender_id=?').bind(sender.id).all()).results;
        for (const envelope of envelopes)
          if (!await purgeEnvelope(env,envelope,sender)) return bad('Your session changed. Recover access before deleting.',409);
        const templates = (await env.DB.prepare('SELECT id,key FROM templates WHERE sender_id=?').bind(sender.id).all()).results;
        for (const template of templates)
          if (!await purgeTemplate(env,template,sender)) return bad('Your session changed. Recover access before deleting.',409);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM templates WHERE sender_id=? AND EXISTS (SELECT 1 FROM senders WHERE id=? AND token=?)').bind(sender.id,sender.id,sender.token),
          env.DB.prepare('DELETE FROM envelope_uploads WHERE sender_id=? AND EXISTS (SELECT 1 FROM senders WHERE id=? AND token=?)').bind(sender.id,sender.id,sender.token),
          env.DB.prepare('DELETE FROM senders WHERE id=? AND token=?').bind(sender.id,sender.token),
        ]);
        return J({ ok: true }, 200, {
          'set-cookie': 'blsender=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
        });
      }

      // ---------- public self-serve senders ----------
      if (m === 'POST' && ['/api/public/recover','/api/public/recover/verify'].includes(p))
        return recoverSender(req, env, reserveUsage);
      if (m === 'POST' && p === '/api/public/start') {
        if (!env.SESSION_SECRET) return bad('Sending is temporarily unavailable. Please try again later.', 503);
        const b = await req.json().catch(() => ({}));
        const name = String(b.name || '').trim().slice(0, 120);
        const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
        if (!name || !validEmail(email)) return bad('name and a valid email are required');
        const ip = req.headers.get('cf-connecting-ip') || '';
        if (!await reserveUsage(env, 'signup', { account: email, network: ip }, [
          { scope: 'network', max: 10 }, { scope: 'account', max: 10 }, { scope: 'global', max: 2000 },
        ])) return bad('daily limit reached — try tomorrow', 429);
        const sid = uid(), stok = uid() + uid();
        await env.DB.prepare(`INSERT INTO senders (id,name,email,token,ip,created_at,token_expires_at) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'))`)
          .bind(sid, name, email, stok, ip, now()).run();
        return J({ ok: true, name }, 200, {
          'set-cookie': senderCookie(stok),
        });
      }
      if (m === 'POST' && p === '/api/estate/deal') {
        if (!estateBridgeAuthorized(req, env)) return bad('unauthorized', 401);
        const body = await req.json().catch(() => ({}));
        const title = clean(String(body.title || 'Offer summary')).slice(0, 140);
        const signerName = clean(String(body.signer_name || 'Signer')).slice(0, 120);
        const signerEmail = String(body.signer_email || '').trim().toLowerCase();
        if (!title || !signerName || !validEmail(signerEmail)) return bad('title, signer_name, and signer_email are required');
        const lines = (Array.isArray(body.lines) ? body.lines : []).map(line => clean(String(line)).slice(0, 96)).filter(Boolean).slice(0, 36);
        const pdf = await PDFDocument.create();
        const page = pdf.addPage([612, 792]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        page.drawText(title, { x: 54, y: 740, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
        page.drawText('Screening summary. Not an appraisal and not a guaranteed price.', { x: 54, y: 716, size: 10, font, color: rgb(0.25, 0.25, 0.25) });
        let y = 688;
        for (const line of lines) {
          page.drawText(line, { x: 54, y, size: 11, font, color: rgb(0, 0, 0) });
          y -= 16;
          if (y < 160) break;
        }
        page.drawText('Signature', { x: 54, y: 120, size: 11, font, color: rgb(0, 0, 0) });
        const bytes = await pdf.save();
        const v = await validatePdf(bytes);
        if (typeof v === 'string') return bad(v);
        const id = uid();
        const key = `orig/${id}.pdf`;
        const sid = uid();
        const token = uid() + uid();
        const sentAt = now();
        await env.DOCS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { pages: String(v.pages) } });
        await env.DB.batch([
          env.DB.prepare('INSERT INTO envelopes (id,title,status,created_at,sent_at,original_key,original_sha256,routing) VALUES (?,?,?,?,?,?,?,?)')
            .bind(id, title, 'sent', sentAt, sentAt, key, await sha256hex(bytes), 'sequential'),
          env.DB.prepare('INSERT INTO signers (id,envelope_id,name,email,order_index,status,role,token,delivery_status) VALUES (?,?,?,?,?,?,?,?,?)')
            .bind(sid, id, signerName, signerEmail, 0, 'pending', 'signer', token, 'not_sent'),
          env.DB.prepare('INSERT INTO fields (id,envelope_id,signer_id,type,page,x,y,w,h,required) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .bind(uid(), id, sid, 'signature', 0, 0.09, 0.78, 0.42, 0.08, 1),
        ]);
        await audit(env, id, sid, 'sent', req, 'estate deal packet; email not sent');
        return J({ id, sign_path: `/s/${token}` });
      }
      if (m === 'POST' && p === '/api/estate/wholesale') {
        if (!estateBridgeAuthorized(req, env)) return bad('unauthorized', 401);
        const body = await req.json().catch(() => ({}));
        const checked = validateWholesaleTerms(body);
        if (!checked.ok) return bad(checked.error);
        const id = uid();
        const prefix = `estate-wholesale/${id}`;
        const drafts = await buildWholesaleDrafts(checked.terms);
        const packet = await PDFDocument.create();
        packet.setTitle(`SalesSwipe deal packet - ${checked.terms.property_address}`);
        for (const kind of Object.keys(drafts)) {
          const source = await PDFDocument.load(drafts[kind]);
          for (const page of await packet.copyPages(source, source.getPageIndices())) packet.addPage(page);
        }
        const executionFields = await appendWholesaleExecutionPage(packet, checked.terms);
        drafts.packet = await packet.save();
        try {
          for (const [kind, bytes] of Object.entries(drafts)) {
            const valid = await validatePdf(bytes);
            if (typeof valid === 'string') throw new Error(valid);
            await env.DOCS.put(`${prefix}/${kind}.pdf`, bytes, {
              httpMetadata: { contentType: 'application/pdf' },
              customMetadata: { pages: String(valid.pages), status: 'draft' },
            });
          }
          await env.DOCS.put(`${prefix}/manifest.json`, JSON.stringify({
            property_address: checked.terms.property_address,
            documents: Object.keys(drafts),
            signers: [
              { role: 'seller', name: checked.terms.seller_signer_name, email: checked.terms.seller_email },
              { role: 'buyer', name: checked.terms.buyer_signer_name, email: checked.terms.buyer_email },
              ...(checked.terms.assignment_rights === 'prohibited' ? [] :
                [{ role: 'assignee', name: checked.terms.assignee_signer_name, email: checked.terms.assignee_email }]),
            ],
            execution_fields: executionFields,
          }), { httpMetadata: { contentType: 'application/json' } });
        } catch (error) {
          await env.DOCS.delete([...Object.keys(drafts).map(kind => `${prefix}/${kind}.pdf`), `${prefix}/manifest.json`]);
          return bad('Could not save the draft packet.', 502);
        }
        return J({ ok: true, id, documents: Object.keys(drafts), status: 'draft' });
      }
      const estateSigning = p.match(/^\/api\/estate\/wholesale\/([a-f0-9]{32})\/signing$/);
      if (estateSigning && (m === 'POST' || m === 'GET')) {
        if (!estateBridgeAuthorized(req, env)) return bad('unauthorized', 401);
        const packetId = estateSigning[1];
        const manifestObject = await env.DOCS.get(`estate-wholesale/${packetId}/manifest.json`);
        if (!manifestObject) return bad('draft packet not found', 404);
        const manifest = await manifestObject.json();
        if (!Array.isArray(manifest.signers) || !Array.isArray(manifest.execution_fields))
          return bad('regenerate this packet for signing', 409);
        let binding = await env.DB.prepare('SELECT * FROM estate_wholesale_signing WHERE packet_id=?').bind(packetId).first();
        if (!binding && m === 'POST') {
          const body = await req.clone().json().catch(() => ({}));
          const senderEmail = String(body.sender_email || '').trim().toLowerCase();
          if (!validEmail(senderEmail)) return bad('sender email is required');
          const packetObject = await env.DOCS.get(`estate-wholesale/${packetId}/packet.pdf`);
          if (!packetObject) return bad('draft packet not found', 404);
          const bytes = await packetObject.arrayBuffer();
          const valid = await validatePdf(bytes);
          if (typeof valid === 'string') return bad(valid);
          if (manifest.execution_fields.some(f => f.page < 0 || f.page >= valid.pages ||
              !['signature', 'date'].includes(f.type) ||
              !manifest.signers.some(s => s.role === f.role)) ||
              manifest.signers.some(s => manifest.execution_fields.filter(f => f.role === s.role && f.type === 'signature').length !== 1))
            return bad('signature page does not match the packet', 409);
          const envelopeId = uid(), originalKey = `orig/${envelopeId}.pdf`;
          const expiresAt = new Date(Date.now() + 14 * 86400_000).toISOString();
          const signerIds = Object.fromEntries(manifest.signers.map(s => [s.role, uid()]));
          const tokens = Object.fromEntries(manifest.signers.map(s => [s.role, uid() + uid()]));
          await env.DOCS.put(originalKey, bytes,
            { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { pages: String(valid.pages) } });
          try {
            await env.DB.batch([
              env.DB.prepare('INSERT INTO envelopes (id,title,status,created_at,original_key,original_sha256,routing,expires_at) VALUES (?,?,?,?,?,?,?,?)')
                .bind(envelopeId, `SalesSwipe agreement - ${manifest.property_address}`.slice(0, 140), 'draft', now(),
                  originalKey, await sha256hex(bytes), 'sequential', expiresAt),
              env.DB.prepare('INSERT INTO estate_wholesale_signing (packet_id,envelope_id,sender_email,created_at) VALUES (?,?,?,?)')
                .bind(packetId, envelopeId, senderEmail, now()),
              ...manifest.signers.map((s, index) => env.DB.prepare(
                'INSERT INTO signers (id,envelope_id,name,email,order_index,status,role,token,delivery_status) VALUES (?,?,?,?,?,?,?,?,?)')
                .bind(signerIds[s.role], envelopeId, s.name, s.email, index, 'pending', 'signer', tokens[s.role], 'not_sent')),
              ...manifest.execution_fields.map(f => env.DB.prepare(
                'INSERT INTO fields (id,envelope_id,signer_id,type,page,x,y,w,h,required) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .bind(uid(), envelopeId, signerIds[f.role], f.type, f.page, f.x, f.y, f.w, f.h, 1)),
            ]);
          } catch (error) {
            await env.DOCS.delete(originalKey);
            binding = await env.DB.prepare('SELECT * FROM estate_wholesale_signing WHERE packet_id=?').bind(packetId).first();
            if (!binding) throw error;
          }
          if (!binding) {
            await audit(env, envelopeId, null, 'created', req, `SalesSwipe packet ${packetId}`);
            binding = { packet_id: packetId, envelope_id: envelopeId, sender_email: senderEmail };
          }
        }
        if (!binding) return J({ ok: true, status: 'not_prepared' });
        let envelope = await getEnvelope(env, binding.envelope_id);
        if (!envelope) return bad('signing envelope not found', 404);
        envelope = await ensureFinalized(env, envelope, req);
        const signers = await getSigners(env, binding.envelope_id);
        if (m === 'GET') return J({ ok: true, status: envelope.status,
          envelope_id: envelope.id, signers: signers.map(s => ({ name: s.name, email: s.email,
            status: s.status, delivery_status: s.delivery_status, signed_at: s.signed_at || null })),
          signed_pdf_ready: envelope.status === 'completed' && !!envelope.final_key });
        const body = await req.json().catch(() => ({}));
        if (body.sender_email && body.sender_email.trim().toLowerCase() !== binding.sender_email)
          return bad('signing sender does not match the prepared packet', 409);
        if (envelope.status !== 'draft') return bad('signing has already started', 409);
        if (envelope.expires_at && envelope.expires_at <= now())
          return bad('This signing request expired. Prepare a fresh packet.', 410);
        const sender = { name: 'SalesSwipe transaction', email: binding.sender_email, verified: false };
        const review = signers.map(s => {
          const message = buildDeliveryEmail({ envelope, signer: s, sender, kind: 'request',
            link: `${env.PUBLIC_ORIGIN || 'https://sign.blacklabeltec.com'}/s/${s.token}` });
          return { role: manifest.signers.find(item => item.email === s.email)?.role || 'signer',
            from: message.from.email, reply_to: message.replyTo, to: message.to.email,
            recipient_name: message.to.name, subject: message.subject, text: message.text };
        });
        const reviewHash = await sha256hex(new TextEncoder().encode(JSON.stringify(review)));
        if (body.action === 'preview') return J({ ok: true, status: 'draft', review, review_hash: reviewHash });
        if (body.action !== 'send' || body.approved_hash !== reviewHash)
          return bad('Review the exact signing invitations before sending.', 409);
        if (!env.EMAIL) return bad('Email delivery is not configured.', 503);
        const started = await mutateEnvelope(env, envelope.id, "status='draft' AND revision=?", [envelope.revision],
          (g, a) => [guardedAudit(env, envelope.id, null, 'sent', req, `SalesSwipe packet ${packetId}`, g, a)],
          "status='sent', sent_at=?, routing='sequential'", [now()]);
        if (!started) return bad('signing changed; refresh before sending', 409);
        const first = await deliverRecipientEmail(env, { ...envelope, status: 'sent', routing: 'sequential' }, signers[0], 'request', sender);
        return J({ ok: true, status: 'sent', envelope_id: envelope.id,
          delivery: { recipient: signers[0].email, state: first.state, message_id: first.messageId || null } });
      }
      const estateSigned = p.match(/^\/api\/estate\/wholesale\/([a-f0-9]{32})\/signed$/);
      if (estateSigned && m === 'GET') {
        if (!estateBridgeAuthorized(req, env)) return bad('unauthorized', 401);
        const binding = await env.DB.prepare('SELECT envelope_id FROM estate_wholesale_signing WHERE packet_id=?')
          .bind(estateSigned[1]).first();
        if (!binding) return bad('signing not prepared', 404);
        const current = await getEnvelope(env, binding.envelope_id);
        if (!current) return bad('signing envelope not found', 404);
        const envelope = await ensureFinalized(env, current, req);
        if (!envelope || envelope.status !== 'completed' || !envelope.final_key) return bad('signing not complete', 409);
        const obj = await env.DOCS.get(envelope.final_key);
        if (!obj) return bad('signed PDF not found', 404);
        return new Response(obj.body, { headers: { 'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="salesswipe-signed-agreement.pdf"',
          'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
      }
      const wholesaleDownload = p.match(/^\/api\/estate\/wholesale\/([a-f0-9]{32})\/([a-z]+)$/);
      if (m === 'GET' && wholesaleDownload) {
        if (!estateBridgeAuthorized(req, env)) return bad('unauthorized', 401);
        const [, id, kind] = wholesaleDownload;
        if (!WHOLESALE_DOCUMENT_KINDS.includes(kind)) return bad('unknown draft', 404);
        const obj = await env.DOCS.get(`estate-wholesale/${id}/${kind}.pdf`);
        if (!obj) return bad('draft not found', 404);
        return new Response(obj.body, { headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${kind}-agreement-draft.pdf"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        } });
      }
      const wholesaleEmail = p.match(/^\/api\/estate\/wholesale\/([a-f0-9]{32})\/email$/);
      if (m === 'POST' && wholesaleEmail) {
        if (!estateBridgeAuthorized(req, env)) return bad('unauthorized', 401);
        const id = wholesaleEmail[1];
        const manifestObject = await env.DOCS.get(`estate-wholesale/${id}/manifest.json`);
        if (!manifestObject) return bad('draft packet not found', 404);
        const manifest = await manifestObject.json();
        const body = await req.json().catch(() => ({}));
        const recipientName = clean(String(body.recipient_name || '')).trim().slice(0, 120);
        const recipientEmail = String(body.recipient_email || '').trim().toLowerCase();
        const senderEmail = String(body.sender_email || '').trim().toLowerCase();
        const note = clean(String(body.note || '')).trim().slice(0, 600);
        if (!recipientName || !validEmail(recipientEmail) || !validEmail(senderEmail))
          return bad('recipient name, recipient email, and sender email are required');
        const subject = `SalesSwipe draft deal packet: ${clean(manifest.property_address).slice(0, 95)}`;
        const mailText = `Hi ${recipientName},\n\n${senderEmail} has shared the attached unsigned SalesSwipe real estate deal packet for ${manifest.property_address}.\n\nThe packet contains the purchase agreement and the applicable addenda, disclosure questions, closing sheet, and property rider. Review the actual deal terms and every page before anyone signs.\n${note ? `\nNote from sender: ${note}\n` : ''}\nReply to this message to reach ${senderEmail}.\n\nMade by Black Label`;
        const review = { from: MAIL_FROM, to: recipientEmail, recipient_name: recipientName,
          reply_to: senderEmail, subject, text: mailText, attachment: 'salesswipe-deal-packet.pdf' };
        const reviewHash = await sha256hex(new TextEncoder().encode(JSON.stringify(review)));
        if (body.action === 'preview') return J({ ok: true, review, review_hash: reviewHash });
        if (body.action !== 'send' || body.approved_hash !== reviewHash) return bad('Review the exact email before sending.', 409);
        if (!env.EMAIL) return bad('Email delivery is not configured.', 503);
        const packetObject = await env.DOCS.get(`estate-wholesale/${id}/packet.pdf`);
        if (!packetObject) return bad('draft packet not found', 404);
        const reserved = await reserveUsage(env, 'estate_packet_email',
          { account: senderEmail, recipient: recipientEmail, subject: id },
          [{ scope: 'subject', max: 1 }, { scope: 'account', max: 10 }, { scope: 'global', max: 200 }]);
        if (!reserved) return bad('This packet already has an email attempt or the send limit was reached.', 409);
        const content = await packetObject.arrayBuffer();
        try {
          const result = await env.EMAIL.send({
            to: { email: recipientEmail, name: recipientName },
            from: { email: MAIL_FROM, name: 'BL Sign' },
            replyTo: senderEmail,
            subject, text: mailText,
            html: `<div style="font:16px/1.55 sans-serif;color:#171719;max-width:620px;margin:auto"><h1>SalesSwipe deal packet</h1><p>${esc(mailText).replaceAll('\n', '<br>')}</p><p>Made by Black Label</p></div>`,
            attachments: [{ filename: review.attachment, content, type: 'application/pdf', disposition: 'attachment' }],
          });
          const messageId = clean(result?.messageId || '').slice(0, 200);
          await env.DOCS.put(`estate-wholesale/${id}/delivery.json`, JSON.stringify({
            recipient_email: recipientEmail, sender_email: senderEmail, accepted_at: now(), message_id: messageId,
          }), { httpMetadata: { contentType: 'application/json' } }).catch(() => {});
          return J({ ok: true, status: 'accepted', message_id: messageId });
        } catch (error) {
          return bad(`Email provider did not accept this packet: ${emailFailure(error)}`, 502);
        }
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
          const form = await req.formData();
          const file = form.get('file');
          const title = String(form.get('title') || '').trim();
          if (!title) return bad('title required');
          if (!file || typeof file === 'string') return bad('file required');
          const bytes = await file.arrayBuffer();
          const v = await validatePdf(bytes);
          if (typeof v === 'string') return bad(v);
          const suppliedKey = req.headers.get('idempotency-key');
          if (suppliedKey && !/^[A-Za-z0-9_-]{16,128}$/.test(suppliedKey)) return bad('Invalid upload request key.');
          const requestKey = await sha256hex(textBytes(suppliedKey || uid()));
          const documentHash = await sha256hex(bytes);
          const fingerprint = await sha256hex(textBytes(`${title}:${documentHash}`));
          const findUpload = () => env.DB.prepare('SELECT * FROM envelope_uploads WHERE sender_id=? AND request_key=?').bind(sender.id,requestKey).first();
          let previous = await findUpload();
          let id = previous?.envelope_id || uid();
          const key = `orig/${id}.pdf`;
          if (!previous) {
            const reserved = await reserveEnvelopeUsage(env, sender, { id,title,key,hash:documentHash,requestKey,fingerprint });
            if (!reserved) {
              previous = await findUpload();
              if (!previous) return bad('daily envelope allowance reached — try tomorrow (free tier: 3 per day)', 429);
              id = previous.envelope_id;
            }
          }
          if (previous && previous.fingerprint !== fingerprint) return bad('This upload request key belongs to a different document.', 409);
          const pending = await getEnvelope(env,id);
          if (!pending || !canAccess(pending,false,sender)) return bad('This upload was removed. Start a new upload.',409);
          if (pending.status !== 'uploading') return J({ id });
          const staged = await env.DB.prepare('SELECT published FROM envelope_objects WHERE key=?').bind(pending.original_key).first();
          if (staged?.published !== 0) return bad('This interrupted upload expired. Start a new upload.',409);
          await env.DOCS.put(pending.original_key,bytes,{ httpMetadata:{contentType:'application/pdf'},customMetadata:{pages:String(v.pages)} });
          await mutateEnvelope(env,id,`status='uploading' AND ${stagedObject} AND EXISTS (SELECT 1 FROM senders own WHERE own.id=envelopes.sender_id AND own.id=? AND own.token=?)`,[pending.original_key,sender.id,sender.token], (g,a) => [
            objectReference(env,id,pending.original_key,g,a),
            guardedAudit(env,id,null,'created',req,`public sender ${sender.name} <${sender.email}>`,g,a),
          ], "status='draft'");
          const accepted = await getEnvelope(env,id);
          if (!accepted || !canAccess(accepted,false,sender) || accepted.status==='uploading') return bad('Upload was interrupted. Retry this document.',409);
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
        if (!admin && m === 'POST') return bad('Templates are not available in the public free tier.',400);

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
        if (!tpl || !owns(tpl) || tpl.deletion_claim) return bad('not found', 404);

        if (m === 'DELETE' && !tm[2]) {
          if (!await purgeTemplate(env,tpl,sender)) return bad('Your session changed. Recover access before deleting.',409);
          return J({ ok: true });
        }

        if (m === 'POST' && tm[2] === '/use') {
          if (sender && !await reserveEnvelopeUsage(env, sender))
            return bad('daily envelope allowance reached — try tomorrow (free tier: 3 per day)', 429);
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
        const mutateOwnedEnvelope = (env,id,condition,args,build,set='',values=[]) => mutateEnvelope(env,id,
          condition + (sender ? " AND EXISTS (SELECT 1 FROM senders own WHERE own.id=envelopes.sender_id AND own.id=? AND own.token=? AND (own.token_expires_at IS NULL OR own.token_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))" : ''),
          [...args,...(sender ? [sender.id,sender.token] : [])],build,set,values);

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

        if (m === 'DELETE' && sub === '') {
          if (!await purgeEnvelope(env,envelope,sender)) return bad('Your session changed. Recover access before deleting.',409);
          return J({ ok: true });
        }

        if (m === 'GET' && sub === '') {
          const signers = await getSigners(env, envelope.id);
          const fields = await getFields(env, envelope.id);
          const events = (await env.DB.prepare('SELECT * FROM events WHERE envelope_id=? ORDER BY ts').bind(envelope.id).all()).results;
          for (const s of signers) if (s.token) s.link = `${url.origin}/s/${s.token}`;
          const senderIdentity = await senderIdentityFor(env, envelope);
          return J({ envelope, signers, fields, events, sender: senderIdentity });
        }

        if (m === 'PUT' && sub === '/setup') {
          if (envelope.status !== 'draft') return bad('envelope is not editable after send');
          const body = await req.json().catch(() => null);
          if (!body || !Array.isArray(body.signers) || !Array.isArray(body.fields)) return bad('signers[] and fields[] required');
          if (!admin && body.signers.some(s => s.role === 'cc')) return bad('CC recipients are not available in the public free tier.');
          if (body.signers.length > 8 || body.fields.length > 200) return bad('too many signers/fields');
          const head = await env.DOCS.head(envelope.original_key);
          const pageCount = parseInt(head?.customMetadata?.pages || '0', 10) || 0;
          if (pageCount && body.fields.some(f => (f.page | 0) >= pageCount))
            return bad(`field placed on a page past the end of the document (${pageCount} pages)`);
          const build = (guard, args) => [
            env.DB.prepare(`DELETE FROM fields WHERE envelope_id=? AND ${guard}`).bind(envelope.id, ...args),
            env.DB.prepare(`DELETE FROM signers WHERE envelope_id=? AND ${guard}`).bind(envelope.id, ...args),
            ...rows.map(row => env.DB.prepare(`${row.sql} WHERE ${guard}`).bind(...row.values, ...args)),
          ];
          const rows = [];
          const signerIds = [];
          const roles = [];
          body.signers.forEach((s, i) => {
            const sid = uid();
            const role = s.role === 'cc' ? 'cc' : 'signer';
            signerIds.push(sid);
            roles.push(role);
            rows.push({ sql: 'INSERT INTO signers (id,envelope_id,name,email,order_index,status,role) SELECT ?,?,?,?,?,?,?',
              values: [sid, envelope.id, String(s.name || '').trim().slice(0, 120), String(s.email || '').trim().slice(0, 200), i, 'pending', role] });
          });
          for (const f of body.fields) {
            const si = f.signer_index | 0;
            if (si < 0 || si >= signerIds.length) return bad('field assigned to unknown signer');
            if (roles[si] === 'cc') return bad('CC recipients cannot have fields');
            if (!['signature', 'initials', 'date', 'text', 'checkbox'].includes(f.type)) return bad('bad field type');
            const page = Number(f.page);
            const x = Number(f.x), y = Number(f.y), w = Number(f.w), h = Number(f.h);
            if (!Number.isInteger(page) || page < 0 ||
                ![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 ||
                x + w > 1.001 || y + h > 1.001)
              return bad('field geometry must stay inside its document page');
            rows.push({ sql: 'INSERT INTO fields (id,envelope_id,signer_id,type,page,x,y,w,h,required) SELECT ?,?,?,?,?,?,?,?,?,?',
              values: [uid(), envelope.id, signerIds[si], f.type, page, x, y, w, h, f.type === 'checkbox' ? 0 : 1] });
          }
          if (!await mutateOwnedEnvelope(env, envelope.id, "status='draft' AND revision=?", [envelope.revision], build))
            return bad('document changed; reload before editing', 409);
          return J({ ok: true });
        }

        if (m === 'POST' && sub === '/send') {
          if (envelope.status !== 'draft') return bad('already sent');
          if (!env.EMAIL?.send || !env.SESSION_SECRET) return bad('Signing email is temporarily unavailable. Your draft is saved.',503);
          const body = await req.json().catch(() => ({}));
          const signers = await getSigners(env, envelope.id);
          const fields = await getFields(env, envelope.id);
          if (!signers.some(s => (s.role || 'signer') === 'signer')) return bad('add at least one signer (not just CC)');
          for (const s of signers) {
            if (!s.name) return bad('every recipient needs a name');
            if (!validEmail(s.email)) return bad(`recipient "${s.name}" needs a valid email`);
            if ((s.role || 'signer') === 'signer' &&
              !fields.some(f => f.signer_id === s.id && (f.type === 'signature' || f.type === 'initials')))
              return bad(`signer "${s.name}" has no signature field`);
          }
          if (!admin && body.routing === 'parallel') return bad('The public free tier supports sequential signing.');
          const routing = body.routing === 'parallel' ? 'parallel' : 'sequential';
          const expireDays = [7, 14, 30].includes(body.expireDays | 0) ? body.expireDays | 0 : 0;
          const expiresAt = expireDays ? new Date(Date.now() + expireDays * 86400_000).toISOString() : null;
          const sentAt = now();
          const sent = await mutateOwnedEnvelope(env, envelope.id, "status='draft' AND revision=?", [envelope.revision],
            (g, a) => [
              ...signers.map(s => env.DB.prepare(`UPDATE signers SET token=? WHERE id=? AND ${g}`).bind(uid() + uid(), s.id, ...a)),
              guardedAudit(env, envelope.id, null, 'sent', req, String(body?.note || '').slice(0, 300), g, a),
            ], "status='sent', sent_at=?, routing=?, expires_at=?", [sentAt, routing, expiresAt]);
          if (!sent) return bad('document changed or already sent; reload', 409);
          const fresh = await getSigners(env, envelope.id);
          const signersOnly = fresh.filter(s => (s.role || 'signer') === 'signer');
          const notify = routing === 'parallel' ? signersOnly : signersOnly.slice(0, 1);
          const senderIdentity = await senderIdentityFor(env, envelope);
          const deliveryResults = [];
          for (const recipient of notify)
            deliveryResults.push(await deliverRecipientEmail(env, { ...envelope, routing, expires_at: expiresAt }, recipient, 'request', senderIdentity));
          const withDelivery = await getSigners(env, envelope.id);
          return J({
            ok: true,
            delivery: {
              accepted: deliveryResults.filter(x => x.state === 'accepted').length,
              failed: deliveryResults.filter(x => x.state === 'failed').length,
              uncertain: deliveryResults.filter(x => x.state === 'uncertain').length,
              limited: deliveryResults.filter(x => x.state === 'limited').length,
              deferred: withDelivery.filter(s => s.delivery_status === 'not_sent').length,
            },
            signers: withDelivery.map(s => ({
              id: s.id, name: s.name, email: s.email, role: s.role || 'signer', status: s.status,
              delivery_status: s.delivery_status, delivery_error: s.delivery_error,
              link: `${url.origin}/s/${s.token}`,
            })),
          });
        }

        if (m === 'POST' && sub === '/resend') {
          if (!admin) return bad('Reminders are not available in the public free tier.');
          if (envelope.status !== 'sent') return bad('only active envelopes can send reminders');
          const body = await req.json().catch(() => ({}));
          const recipients = await getSigners(env, envelope.id);
          const signer = recipients.find(s => s.id === String(body.signer_id || ''));
          if (!signer || (signer.role || 'signer') !== 'signer' || signer.status !== 'pending')
            return bad('pending signer not found', 404);
          if (envelope.routing !== 'parallel' && !recipients.filter(s => (s.role || 'signer') === 'signer')
            .every(s => s.order_index >= signer.order_index || s.status === 'signed'))
            return bad('that signer is not active yet', 409);
          if (signer.delivery_status === 'uncertain')
            return bad('Delivery outcome needs review before another attempt. Use the existing link or contact support.', 409);
          if (signer.delivery_status === 'sending') return bad('A delivery attempt is in progress. Please check its outcome before retrying.', 429);
          if (signer.delivery_at && Date.now() - new Date(signer.delivery_at).getTime() < 60_000)
            return bad('wait one minute before sending again', 429);
          if ((signer.delivery_attempts || 0) >= 5) return bad('delivery attempt limit reached', 429);
          const kind = signer.last_delivery_kind ? 'reminder' : 'request';
          const result = await deliverRecipientEmail(env, envelope, signer, kind);
          return J({ ok: result.state === 'accepted', delivery: result }, result.state === 'accepted' ? 200 : result.state === 'limited' ? 429 : 502);
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
          const stagedKey = `orig/${envelope.id}/${uid()}.pdf`;
          try {
            if (!await stageObject(env, envelope.id, stagedKey, out,
              { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { pages: String(merged.getPageCount()) } }))
              return bad('envelope deleted', 409);
            const published = await mutateOwnedEnvelope(env, envelope.id, `status='draft' AND revision=? AND ${stagedObject}`, [envelope.revision, stagedKey],
              (g, a) => [objectReference(env, envelope.id, envelope.original_key, g, a),
                objectReference(env, envelope.id, stagedKey, g, a),
                guardedAudit(env, envelope.id, null, 'doc-added', req, docs[docs.length - 1].name, g, a)],
              'original_key=?, original_sha256=?, docs_json=?', [stagedKey, await sha256hex(out), JSON.stringify(docs)]);
            if (!published) return bad('document changed or already sent; reload', 409);
          } finally { await discardUnpublished(env, [stagedKey]); }
          return J({ ok: true, pages: merged.getPageCount() });
        }

        if (m === 'POST' && sub === '/void') {
          if (envelope.status === 'completed') return bad('completed envelopes cannot be voided');
          const changed = await mutateOwnedEnvelope(env, envelope.id, "status IN ('draft','sent')", [],
            (g, a) => [guardedAudit(env, envelope.id, null, 'voided', req, '', g, a)], "status='voided'");
          if (!changed) return bad('envelope is already closed', 409);
          return J({ ok: true });
        }

        if (m === 'GET' && (sub === '/pdf' || sub === '/final')) {
          const key = sub === '/pdf' ? envelope.original_key : envelope.final_key;
          if (!key) return bad('not available', 404);
          const obj = await env.DOCS.get(key);
          if (!obj) return bad('missing object', 404);
          const documentBytes = await obj.arrayBuffer();
          if (await sha256hex(documentBytes) !== (sub === '/final' ? envelope.final_sha256 : envelope.original_sha256))
            return documentIntegrityFailure(env,envelope,req,sub === '/final' ? 'final' : 'original');
          return new Response(documentBytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${clean(envelope.title).replace(/"/g, '')}${sub === '/final' ? '-signed' : ''}.pdf"` } });
        }
        return bad('not found', 404);
      }

      // ---------- signer API ----------
      const sm = p.match(/^\/api\/session\/([A-Za-z0-9]+)(\/[a-z-]+)?$/);
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
        const requiresEmailAuth = validEmail(signer.email);
        const authenticated = await signerAuthenticated(req, env, signer);
        const senderRow = await senderIdentityFor(env, envelope);
        if (['expired','voided','declined','deleting'].includes(envelope.status))
          return bad('This signing request is closed. Contact the sender for a new link.', 410);

        if (m === 'POST' && sub === '/auth-request') {
          if (!requiresEmailAuth) return J({ ok: true, authRequired: false });
          if (!env.SESSION_SECRET || !env.EMAIL?.send) return bad('Email verification is temporarily unavailable. Try again later.', 503);
          if (['sending','uncertain'].includes(signer.auth_delivery_status) && signer.auth_code_expires_at > now())
            return bad('The previous verification email outcome is being checked. Try again after ten minutes.',409);
          const sentAt = signer.auth_code_sent_at ? Date.parse(signer.auth_code_sent_at) : 0;
          if (sentAt && Date.now() - sentAt < AUTH_CODE_RESEND_MS)
            return bad('wait one minute before requesting another code', 429);
          const since = new Date(Date.now() - 60 * 60_000).toISOString();
          const recent = await env.DB.prepare(
            "SELECT COUNT(*) c FROM events WHERE signer_id=? AND type='auth-code-sent' AND ts>=?")
            .bind(signer.id, since).first();
          if (recent.c >= 5) return bad('too many verification codes requested; try again later', 429);

          const code = generateAuthCode();
          const hash = await authCodeHash(env, signer, code);
          const challengeId = uid();
          // Publish the challenge and reserve the resend window together. A
          // delayed issuer cannot overwrite a newer challenge after a hash await.
          const claim = await env.DB.prepare(`UPDATE signers SET auth_challenge_id=?, auth_code_hash=?,
            auth_code_sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            auth_code_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), auth_failures=0
             ,auth_delivery_status='sending'
            WHERE id=? AND token=? AND auth_challenge_id IS ? AND auth_code_sent_at IS ? AND (auth_code_sent_at IS NULL OR
              auth_code_sent_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))`)
            .bind(challengeId, hash, signer.id, signer.token, signer.auth_challenge_id, signer.auth_code_sent_at).run();
          if (!claim.meta.changes) return bad('wait one minute before requesting another code', 429);
          try {
            if (!await reserveMailUsage(env, envelope, signer, 'verification', challengeId)) {
              const error = new Error('verification email allowance reached; try again later');
              error.status = 429; throw error;
            }
            const result = await env.EMAIL.send(buildVerificationEmail({
              envelope, signer, sender: senderRow, code, expiresMinutes: AUTH_CODE_TTL_MS / 60_000,
            }));
            if (!result?.messageId) throw new Error('Provider receipt missing');
            await env.DB.prepare("UPDATE signers SET auth_delivery_status='accepted' WHERE id=? AND auth_challenge_id=?").bind(signer.id,challengeId).run();
            await audit(env, envelope.id, signer.id, 'auth-code-sent', req, clean(result.messageId));
          } catch (error) {
            const definitive = error.status === 429 || DEFINITIVE_MAIL_REJECTIONS.has(error?.code);
            await env.DB.prepare(`UPDATE signers SET auth_code_hash=NULL,auth_delivery_status=?,
              auth_code_sent_at=CASE WHEN ?=1 THEN NULL ELSE auth_code_sent_at END
              WHERE id=? AND auth_challenge_id=?`).bind(definitive ? 'failed' : 'uncertain',definitive ? 1 : 0,signer.id,challengeId).run();
            await audit(env, envelope.id, signer.id, 'auth-code-failed', req, emailFailure(error));
            return error.status === 429 ? bad(error.message,429) : bad(definitive ? 'Verification email was not accepted. Try again later.' : 'Verification email outcome is uncertain. Any code from this attempt is inactive. Request a new code after ten minutes.',502);
          }
          return J({ ok: true, codeSent: true, maskedEmail: maskedEmail(signer.email), expiresInSeconds: AUTH_CODE_TTL_MS / 1000 });
        }

        if (m === 'POST' && sub === '/auth-verify') {
          if (!requiresEmailAuth) return J({ ok: true, authRequired: false });
          if (!env.SESSION_SECRET) return bad('signer verification is not configured', 503);
          const body = await req.json().catch(() => ({}));
          const code = String(body.code || '').trim();
          if (!/^\d{6}$/.test(code)) return bad('enter the six-digit code');
          if (!signer.auth_challenge_id || !signer.auth_code_hash || !signer.auth_code_expires_at || signer.auth_code_expires_at <= now())
            return bad('verification code expired; request a new code', 410);
          // Reserve before comparing. All guesses, including a correct fifth
          // guess, consume one of this challenge's five slots at the database.
          const reserve = await env.DB.prepare(`UPDATE signers SET auth_failures=COALESCE(auth_failures,0)+1
            WHERE id=? AND token=? AND auth_challenge_id=? AND auth_code_hash=?
              AND auth_code_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND COALESCE(auth_failures,0)<5`)
            .bind(signer.id, signer.token, signer.auth_challenge_id, signer.auth_code_hash).run();
          if (!reserve.meta.changes) {
            const current = await env.DB.prepare(`SELECT auth_challenge_id,auth_code_hash,auth_failures,
              auth_code_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AS expired FROM signers WHERE id=?`)
              .bind(signer.id).first();
            if (!current?.auth_code_hash || current.expired) return bad('verification code expired; request a new code', 410);
            if (current.auth_challenge_id !== signer.auth_challenge_id) return bad('verification code replaced; use the latest code', 409);
            return bad('too many incorrect attempts; request a new code', 429);
          }
          const supplied = await authCodeHash(env, signer, code);
          if (supplied !== signer.auth_code_hash) {
            return bad('incorrect verification code', 401);
          }
          const authenticatedAt = now();
          const consumed = await env.DB.prepare(`UPDATE signers SET auth_code_hash=NULL, auth_code_expires_at=NULL,
            auth_challenge_id=NULL, auth_failures=0, last_authenticated_at=?
            WHERE id=? AND token=? AND auth_challenge_id=? AND auth_code_hash=?
              AND auth_code_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
            .bind(authenticatedAt, signer.id, signer.token, signer.auth_challenge_id, signer.auth_code_hash).run();
          if (!consumed.meta.changes) return bad('verification code expired or already used; request a new code', 410);
          await audit(env, envelope.id, signer.id, 'email-authenticated', req, maskedEmail(signer.email));
          return J({ ok: true, authenticated: true }, 200, { 'set-cookie': await signerSessionCookie(env, signer) });
        }

        if (!authenticated) {
          if (m === 'GET' && sub === '') return J({
            authRequired: true,
            maskedEmail: maskedEmail(signer.email),
            signer: { name: signer.name, email: maskedEmail(signer.email), status: signer.status },
          });
          return bad('email verification required', 401);
        }
        const myTurn = !isViewer && envelope.status === 'sent' && signer.status === 'pending' &&
          (envelope.routing === 'parallel' ||
            signersOnly.every(s => s.order_index >= signer.order_index || s.status === 'signed'));
        const waitingOn = signersOnly.find(s => s.status !== 'signed');

        if (m === 'GET' && sub === '') {
          if (envelope.status !== 'voided' && signer.status !== 'signed') await audit(env, envelope.id, signer.id, 'viewed', req);
          const fields = (await getFields(env, envelope.id)).filter(f => f.signer_id === signer.id)
            .map(f => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, value: f.value }));
          return J({
            title: envelope.title, status: envelope.status,
            sender: senderRow.verified ? `${senderRow.name} (${senderRow.email})` : `${senderRow.name} (${senderRow.email} — unverified)`,
            sealing: envelope.status === 'sent' && !waitingOn && !envelope.finalization_error,
            finalizationError: envelope.finalization_error ? 'Completion is paused. Contact the sender to arrange a new request.' : null,
            consentVersion: CONSENT_VERSION, viewer: isViewer, routing: envelope.routing,
            expiresAt: envelope.expires_at || null,
            signer: { name: signer.name, email: signer.email, status: signer.status, consented: !!signer.consent_at },
            myTurn, waitingOn: waitingOn && waitingOn.id !== signer.id ? waitingOn.name : null,
            fields,
          });
        }

        if (m === 'POST' && sub === '/decline') {
          if (envelope.sender_id) return bad('Decline is not available for this request. Contact the sender.');
          if (!myTurn) return bad('not your turn or already signed');
          const b = await req.json().catch(() => ({}));
          const reason = clean(b.reason || '').slice(0, 300);
          const changed = await mutateEnvelope(env, envelope.id, eligibleSigner, [signer.id, signer.token],
            (g, a) => [env.DB.prepare(`UPDATE signers SET status='declined' WHERE id=? AND ${g}`).bind(signer.id, ...a),
              guardedAudit(env, envelope.id, signer.id, 'declined', req, reason, g, a)], "status='declined'");
          if (!changed) return bad('already acted or envelope closed', 409);
          return J({ ok: true });
        }

        if (m === 'GET' && sub === '/pdf') {
          if (envelope.status === 'voided') return bad('envelope voided', 410);
          const obj = await env.DOCS.get(envelope.status === 'completed' && envelope.final_key ? envelope.final_key : envelope.original_key);
          if (!obj) return bad('missing object', 404);
          const documentBytes = await obj.arrayBuffer();
          if (await sha256hex(documentBytes) !== (envelope.status === 'completed' ? envelope.final_sha256 : envelope.original_sha256))
            return documentIntegrityFailure(env,envelope,req,envelope.status === 'completed' ? 'final' : 'original');
          return new Response(documentBytes, { headers: { 'content-type': 'application/pdf' } });
        }

        if (m === 'POST' && sub === '/consent') {
          if (!myTurn) return bad('not your turn or already signed');
          const changed = await mutateEnvelope(env, envelope.id, eligibleSigner, [signer.id, signer.token],
            (g, a) => [env.DB.prepare(`UPDATE signers SET consent_at=COALESCE(consent_at,?) WHERE id=? AND ${g}`).bind(now(), signer.id, ...a),
              guardedAudit(env, envelope.id, signer.id, 'consented', req, CONSENT_VERSION, g, a)]);
          if (!changed) return bad('already acted or envelope closed', 409);
          return J({ ok: true });
        }

        if (m === 'POST' && sub === '/complete') {
          if (!myTurn) return bad('not your turn or already signed');
          if (!signer.consent_at) return bad('consent required first');
          const original = await env.DOCS.get(envelope.original_key);
          const originalBytes = original ? await original.arrayBuffer() : null;
          if (!originalBytes || await sha256hex(originalBytes) !== envelope.original_sha256)
            return documentIntegrityFailure(env,envelope,req);
          if (envelope.finalization_error) return bad('Document completion is paused. Contact the sender.',409);
          const body = await req.json().catch(() => null);
          const values = body && body.values ? body.values : {};
          const mine = (await getFields(env, envelope.id)).filter(f => f.signer_id === signer.id);
          const validated = [];
          const originalDoc = await PDFDocument.load(originalBytes);
          const originalFont = await originalDoc.embedFont(StandardFonts.Helvetica);
          if (!mine.some(f => f.type === 'signature' || f.type === 'initials')) return bad('signer has no signature fields', 409);
          for (const f of mine) {
            const v = values[f.id] || {};
            if (f.type === 'signature' || f.type === 'initials') {
              const png = typeof v.png === 'string' ? v.png : '';
              if (!png.startsWith('data:image/png;base64,')) { if (f.required) return bad(`missing ${f.type}`); continue; }
              if (png.length > 22 + 4 * Math.ceil(MAX_SIGNATURE_BYTES / 3)) return bad('signature image too large');
              let bin;
              try { bin = Uint8Array.from(atob(png.slice(22)), c => c.charCodeAt(0)); }
              catch { return bad('signature image is not valid base64'); }
              try { bin = await normalizeSignaturePng(bin,{requireInk:true}); }
              catch (e) { if (e instanceof InvalidSignatureImage) return bad(e.message); throw e; }
              validated.push({ id: f.id, value: 'png', key: `sig/${envelope.id}/${uid()}.png`, bytes: bin });
            } else if (f.type === 'checkbox') {
              validated.push({ id: f.id, value: v.v ? '1' : '', key: null });
            } else {
              const t = clean(v.v || '').slice(0, 300);
              if (f.required && !t.trim()) return bad(`missing required ${f.type} field`);
              if (f.page < 0 || f.page >= originalDoc.getPageCount()) return bad('A field is outside the document. Contact the sender.',409);
              const box = fieldPlacement(originalDoc.getPage(f.page),f);
              if (t && (box.height * .65 < 5 || originalFont.widthOfTextAtSize(t,5) > box.width-2))
                return bad('This text is too long for its field. Shorten it or ask the sender to enlarge the field.');
              validated.push({ id: f.id, value: t, key: null });
            }
          }
          // Validate the whole submission before staging any bytes. Field values,
          // immutable image references, signer acceptance and audit commit together.
          const assets = validated.filter(f => f.key);
          try {
            for (const f of assets)
              if (!await stageObject(env, envelope.id, f.key, f.bytes, { httpMetadata: { contentType: 'image/png' } }))
                return bad('envelope deleted', 409);
            const staged = assets.map(() => ` AND ${stagedObject}`).join('');
            const accepted = await mutateEnvelope(env, envelope.id,
              `${eligibleSigner} AND EXISTS (SELECT 1 FROM signers WHERE id=? AND consent_at IS NOT NULL)${staged}`,
              [signer.id, signer.token, signer.id, ...assets.map(f => f.key)], (g, a) => [
                ...validated.map(f => env.DB.prepare(`UPDATE fields SET value=?, signature_key=? WHERE id=? AND ${g}`)
                  .bind(f.value, f.key, f.id, ...a)),
                ...assets.map(f => objectReference(env, envelope.id, f.key, g, a)),
                env.DB.prepare(`UPDATE signers SET status='signed', signed_at=?, ip=?, ua=? WHERE id=? AND ${g}`)
                  .bind(now(), req.headers.get('cf-connecting-ip') || '', (req.headers.get('user-agent') || '').slice(0, 300), signer.id, ...a),
                guardedAudit(env, envelope.id, signer.id, 'signed', req, '', g, a),
              ]);
            if (!accepted) return bad('already acted or envelope closed', 409);
          } finally { await discardUnpublished(env, assets.map(f => f.key)); }
          const remaining = await env.DB.prepare("SELECT * FROM signers WHERE envelope_id=? AND role='signer' AND status!='signed' ORDER BY order_index").bind(envelope.id).all();
          if (remaining.results.length === 0) {
            let sealed = false;
            try { sealed = await finalize(env, envelope, req); }
            catch (e) {
              // Signature is recorded; ensureFinalized() re-runs sealing on any later read.
              console.error('finalize failed, will retry on read', envelope.id, e && e.stack || e);
            }
            if (!sealed) {
              const current = await getEnvelope(env, envelope.id);
              return J({ ok: true, completed: current?.status === 'completed', sealing: current?.status === 'sent', status: current?.status || 'deleted' });
            }
            const completedEnvelope = await getEnvelope(env, envelope.id);
            const allRecipients = await getSigners(env, envelope.id);
            const senderIdentity = await senderIdentityFor(env, completedEnvelope);
            const completionDelivery = [];
            for (const recipient of allRecipients)
              completionDelivery.push(await deliverRecipientEmail(env, completedEnvelope, recipient, 'completion', senderIdentity));
            return J({ ok: true, completed: true,
              delivery: { accepted: completionDelivery.filter(x => x.state === 'accepted').length,
                          failed: completionDelivery.filter(x => x.state === 'failed').length } });
          }
          let nextDelivery = null;
          if (envelope.routing !== 'parallel')
            nextDelivery = await deliverRecipientEmail(env, envelope, remaining.results[0], 'request');
          return J({ ok: true, completed: false, next: remaining.results[0].name, nextDelivery });
        }

        if (m === 'GET' && sub === '/download') {
          if (envelope.status !== 'completed' || !envelope.final_key) return bad('not completed yet', 409);
          const obj = await env.DOCS.get(envelope.final_key);
          if (!obj) return bad('missing object', 404);
          const documentBytes = await obj.arrayBuffer();
          if (await sha256hex(documentBytes) !== envelope.final_sha256) return documentIntegrityFailure(env,envelope,req,'final');
          await audit(env, envelope.id, signer.id, 'downloaded', req);
          return new Response(documentBytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${clean(envelope.title).replace(/"/g, '')}-signed.pdf"` } });
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
  envelope = await getEnvelope(env, envelope.id);
  if (!envelope || envelope.status !== 'sent' || envelope.finalization_error) return false;
  const ready = await env.DB.prepare(`SELECT id FROM envelopes WHERE id=? AND ${activeEnvelope} AND ${allSigned}`).bind(envelope.id).first();
  if (!ready) return false;
  const obj = await env.DOCS.get(envelope.original_key);
  if (!obj) throw new Error('Original document is unavailable');
  const orig = await obj.arrayBuffer();
  if (await sha256hex(orig) !== envelope.original_sha256) {
    await env.DB.prepare("UPDATE envelopes SET finalization_error='original-integrity-mismatch' WHERE id=? AND status='sent'").bind(envelope.id).run();
    throw new Error('Original document integrity check failed');
  }
  const doc = await PDFDocument.load(orig);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const signers = await getSigners(env, envelope.id);
  const fields = await getFields(env, envelope.id);
  const ink = rgb(0.07, 0.09, 0.35);

  for (const f of fields) {
    if (f.page < 0 || f.page >= doc.getPageCount()) throw new Error('Accepted field is outside the document');
    const page = doc.getPage(f.page);
    const placement = fieldPlacement(page,f);
    const wpt = placement.width, hpt = placement.height, rotate = degrees(placement.angle);
    if (f.type === 'signature' || f.type === 'initials') {
      if (f.value !== 'png') continue;
      const s = await env.DOCS.get(f.signature_key || `sig/${f.id}.png`);
      if (!s) throw new Error("accepted signature object is missing");
      let image;
      try { image = await normalizeSignaturePng(await s.arrayBuffer(),{requireInk:true}); }
      catch (e) {
        if (!(e instanceof InvalidSignatureImage)) throw e;
        await mutateEnvelope(env, envelope.id, `${activeEnvelope} AND revision=? AND finalization_error IS NULL`, [envelope.revision],
          (g, a) => [guardedAudit(env, envelope.id, null, 'sealing-failed', req, 'invalid_signature_image', g, a)],
          "finalization_error='invalid_signature_image'");
        return false;
      }
      const png = await doc.embedPng(image);
      const scale = Math.min(wpt / png.width, hpt / png.height);
      const dw = png.width * scale, dh = png.height * scale;
      page.drawImage(png, { ...placement.point((wpt-dw)/2,(hpt-dh)/2), width: dw, height: dh, rotate });
    } else if (f.type === 'checkbox') {
      if (f.value) {
        const size = Math.min(hpt * 0.9, 14);
        page.drawText('X', { ...placement.point((wpt-bold.widthOfTextAtSize('X',size))/2,(hpt-size)/2+size*.1), size, font: bold, color: ink, rotate });
      }
    } else {
      const t = clean(f.value || '');
      if (!t) continue;
      let size = Math.min(hpt * 0.65, 13);
      while (size > 5 && helv.widthOfTextAtSize(t,size) > wpt-2) size = Math.max(5,size-.5);
      if (size < 5 || helv.widthOfTextAtSize(t,size) > wpt-2) {
        await documentIntegrityFailure(env,envelope,req,'text-layout');
        return false;
      }
      page.drawText(t, { ...placement.point(1,(hpt-size)/2+size*.16), size, font: helv, color: ink, rotate });
    }
  }

  const stampText = `BL Sign  ·  Envelope ${envelope.id}  ·  verify: ${env.PUBLIC_ORIGIN || 'https://sign.blacklabeltec.com'}/verify/${envelope.id}`;
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
  L(`${env.PUBLIC_ORIGIN || 'https://sign.blacklabeltec.com'}/verify/${envelope.id}`, { gap: 10 });
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
  const finalKey = `final/${envelope.id}/${uid()}.pdf`;
  try {
    if (!await stageObject(env, envelope.id, finalKey, bytes, { httpMetadata: { contentType: 'application/pdf' } })) return false;
    return await mutateEnvelope(env, envelope.id, `${activeEnvelope} AND revision=? AND ${allSigned} AND ${stagedObject}`, [envelope.revision, finalKey],
      (g, a) => [objectReference(env, envelope.id, finalKey, g, a),
        guardedAudit(env, envelope.id, null, 'completed', req, '', g, a)],
      "status='completed', completed_at=?, final_key=?, final_sha256=?", [completedAt, finalKey, await sha256hex(bytes)]);
  } finally { await discardUnpublished(env, [finalKey]); }
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
<p class="muted">BlackLabel Tech · sign.blacklabeltec.com</p>
<table class="kv">
<tr><td>Envelope</td><td class="mono">${esc(envelope.id)}</td></tr>
<tr><td>Title</td><td>${esc(envelope.title)}</td></tr>
<tr><td>Status</td><td><span class="chip ${esc(envelope.status)}">${esc(envelope.status)}</span></td></tr>
<tr><td>Created</td><td>${esc(envelope.created_at)}</td></tr>
<tr><td>Completed</td><td>${esc(envelope.completed_at || '—')}</td></tr>
<tr><td>Original SHA-256</td><td class="mono small">${esc(envelope.original_sha256)}</td></tr>
<tr><td>Signed-file SHA-256</td><td class="mono small">${esc(envelope.final_sha256 || '— (not completed)')}</td></tr>
</table>
${envelope.finalization_error ? '<p role="alert">Completion paused: document integrity requires review. Contact the sender to arrange a new signing request.</p>' : ''}
<h3>Signers</h3><table class="kv">${rows}</table>
${partsRows}
<p class="muted small">To verify a copy of the signed document, compute its SHA-256
(<span class="mono">shasum -a 256 file.pdf</span>) and compare it to the hash above.</p>
</div></div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
}
