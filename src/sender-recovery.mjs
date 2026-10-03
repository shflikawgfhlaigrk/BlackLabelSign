import { MAIL_FROM } from './mail.mjs';
import { generateAuthCode } from './auth-code.mjs';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (error, status = 400) => json({ error }, status);
const uid = () => crypto.randomUUID().replaceAll('-', '');
const token = () => uid() + uid();
async function codeHash(env, challenge, code) {
  const bytes = value => new TextEncoder().encode(value);
  const key = await crypto.subtle.importKey('raw', bytes(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(`sender-recovery:${challenge}:${code}`))), b => b.toString(16).padStart(2, '0')).join('');
}
export const senderCookie = value => `blsender=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;

export async function recoverSender(req, env, reserveUsage) {
  if (!env.SESSION_SECRET || !env.EMAIL?.send) return fail('Email recovery is temporarily unavailable. Please try again later.', 503);
  const body = await req.json().catch(() => ({}));
  if (!new URL(req.url).pathname.endsWith('/verify')) {
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
    if (!await reserveUsage(env, 'recovery', { account: email, network: req.headers.get('cf-connecting-ip') || '', recipient: email }, [
      { scope: 'account', max: 5, hourly: true }, { scope: 'network', max: 20, hourly: true }, { scope: 'global', max: 500, hourly: true },
    ])) return fail('Too many recovery requests. Please try again in an hour.', 429);
    const challenge = uid();
    const code = generateAuthCode();
    const hash = await codeHash(env, challenge, code);
    await env.DB.prepare(`INSERT INTO sender_recovery (id,email,code_hash,expires_at)
      VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'))`).bind(challenge, email, hash).run();
    const sender = await env.DB.prepare('SELECT id FROM senders WHERE lower(trim(email))=? ORDER BY created_at,id LIMIT 1').bind(email).first();
    if (sender) {
      try {
        const result = await env.EMAIL.send({ to: email, from: { email: MAIL_FROM, name: 'BL Sign' }, subject: 'Your BL Sign envelope recovery code',
          text: `Your BL Sign recovery code is ${code}. It expires in 10 minutes. Enter it on My envelopes to recover your documents. Recovery signs out other browser sessions. If you did not request this code, ignore this email.` });
        if (!result?.messageId) throw new Error('Provider outcome unknown');
        await env.DB.prepare('UPDATE sender_recovery SET accepted=1 WHERE id=?').bind(challenge).run();
      } catch {
        // Do not authorize a challenge without a persisted provider receipt.
        // The same public response avoids exposing whether this email has documents.
        await env.DB.prepare('UPDATE sender_recovery SET code_hash=NULL WHERE id=?').bind(challenge).run();
      }
    }
    return json({ ok: true, challenge_id: challenge, expires_minutes: 10,
      message: 'If this email has envelopes, a recovery code was requested. Check your inbox and spam folder.' }, 202);
  }
  const challenge = String(body.challenge_id || ''), code = String(body.code || '').trim();
  if (!/^[a-f0-9]{32}$/.test(challenge) || !/^\d{6}$/.test(code)) return fail('Enter the six-digit recovery code.');
  const row = await env.DB.prepare('SELECT * FROM sender_recovery WHERE id=?').bind(challenge).first();
  if (!row || !row.code_hash || !row.accepted || row.consumed_at || row.expires_at <= new Date().toISOString()) return fail('This recovery code is invalid or expired. Request a new code.');
  const reserved = await env.DB.prepare(`UPDATE sender_recovery SET attempts=attempts+1 WHERE id=? AND code_hash=? AND accepted=1
    AND consumed_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND attempts<5`).bind(challenge, row.code_hash).run();
  if (!reserved.meta.changes) return fail('Too many attempts. Request a new recovery code.', 429);
  if (await codeHash(env, challenge, code) !== row.code_hash) return fail('This recovery code is invalid or expired.');
  const primary = await env.DB.prepare('SELECT id FROM senders WHERE lower(trim(email))=? ORDER BY created_at,id LIMIT 1').bind(row.email).first();
  if (!primary) return fail('This recovery code is invalid or expired.');
  const newToken = token();
  const guard = 'EXISTS (SELECT 1 FROM sender_recovery WHERE id=? AND consumed_token=?)';
  // A winning consumed marker guards ownership merge and all token rotations.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE sender_recovery SET code_hash=NULL,consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),consumed_token=?
      WHERE id=? AND code_hash=? AND accepted=1 AND consumed_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(newToken, challenge, row.code_hash),
    env.DB.prepare(`UPDATE envelopes SET sender_id=? WHERE sender_id IN (SELECT id FROM senders WHERE lower(trim(email))=?) AND ${guard}`).bind(primary.id, row.email, challenge, newToken),
    env.DB.prepare(`UPDATE templates SET sender_id=? WHERE sender_id IN (SELECT id FROM senders WHERE lower(trim(email))=?) AND ${guard}`).bind(primary.id, row.email, challenge, newToken),
    env.DB.prepare(`INSERT OR IGNORE INTO envelope_uploads (sender_id,request_key,fingerprint,envelope_id)
      SELECT ?,request_key,fingerprint,envelope_id FROM envelope_uploads
      WHERE sender_id IN (SELECT id FROM senders WHERE lower(trim(email))=?) AND ${guard}`)
      .bind(primary.id,row.email,challenge,newToken),
    env.DB.prepare(`DELETE FROM envelope_uploads WHERE sender_id!=?
      AND sender_id IN (SELECT id FROM senders WHERE lower(trim(email))=?) AND ${guard}`)
      .bind(primary.id,row.email,challenge,newToken),
    env.DB.prepare(`UPDATE senders SET token=lower(hex(randomblob(32))),token_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days') WHERE lower(trim(email))=? AND ${guard}`).bind(row.email, challenge, newToken),
    env.DB.prepare(`UPDATE senders SET token=? WHERE id=? AND ${guard}`).bind(newToken, primary.id, challenge, newToken),
    env.DB.prepare(`UPDATE sender_recovery SET code_hash=NULL WHERE email=? AND id!=? AND ${guard}`).bind(row.email, challenge, challenge, newToken),
  ]);
  if (!result[0].meta.changes) return fail('This recovery code was already used. Request a new code.');
  return json({ ok: true }, 200, { 'set-cookie': senderCookie(newToken) });
}
