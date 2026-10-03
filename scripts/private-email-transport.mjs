// Private acceptance tooling only. Importing this module never contacts a provider.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildDeliveryEmail, buildVerificationEmail, MAIL_FROM } from '../src/mail.mjs';

export const PRIVATE_EMAIL = Object.freeze({
  title: 'BL SIGN TEST ONLY 20261003-1816 — NOT A CONTRACT',
  senderName: 'BL SIGN TEST ONLY synthetic sender',
  signerName: 'TEST ONLY synthetic signer 1',
  subjectPrefix: '[BL SIGN TEST ONLY 20261003-1816]',
  maxAttempts: 8,
  port: 18889,
});
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, code = 'E_VALIDATION_ERROR') => Object.assign(new Error(message), { code });
const recoveryText = code => `Your BL Sign recovery code is ${code}. It expires in 10 minutes. Enter it on My envelopes to recover your documents. Recovery signs out other browser sessions. If you did not request this code, ignore this email.`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function approvedAddress(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value.trim()))
    throw failure('An explicit valid OWNER_APPROVED_TEST_EMAIL is required.');
  return value.trim().toLowerCase();
}

// Worker binding accepts named objects; REST requires canonical address strings.
// Only the already approved owner can receive, originate replies, or be a party.
export function restPayload(mail, ownerEmail) {
  const owner = approvedAddress(ownerEmail);
  if (!mail || Object.keys(mail).some(key => !['to', 'from', 'replyTo', 'subject', 'html', 'text'].includes(key)))
    throw failure('Private review refuses additional recipients, headers or attachments.');
  const address = value => approvedAddress(typeof value === 'string' ? value : value?.email);
  if (address(mail.from) !== MAIL_FROM || address(mail.to) !== owner || (mail.replyTo && address(mail.replyTo) !== owner))
    throw failure('Private review sender, recipient and reply address must match the approved allowlist.', 'E_RECIPIENT_NOT_ALLOWED');
  if (typeof mail.subject !== 'string' || /[\r\n]/.test(mail.subject) || !mail.subject || mail.subject.length > 250)
    throw failure('Invalid private review subject.');
  if (![mail.text, mail.html].some(body => typeof body === 'string' && body.length > 0) ||
      [mail.text, mail.html].some(body => body !== undefined && (typeof body !== 'string' || body.length > 100_000)))
    throw failure('Invalid private review message body.');
  return { from: MAIL_FROM, to: [owner], reply_to: owner,
    subject: `${PRIVATE_EMAIL.subjectPrefix} ${mail.subject}`,
    ...(mail.html !== undefined ? { html: mail.html } : {}), ...(mail.text !== undefined ? { text: mail.text } : {}) };
}

function mailFor(kind, owner, { code = '123456', link = 'http://localhost:18889/s/TEST_ONLY_RECIPIENT_LINK' } = {}) {
  const envelope = { title: PRIVATE_EMAIL.title, expires_at: null };
  const signer = { email: owner, name: PRIVATE_EMAIL.signerName, role: 'signer' };
  const sender = { email: owner, name: PRIVATE_EMAIL.senderName };
  if (kind === 'verification') return buildVerificationEmail({ envelope, signer, sender, code });
  if (kind === 'recovery') return { to: owner, from: { email: MAIL_FROM, name: 'BL Sign' },
    subject: 'Your BL Sign envelope recovery code', text: recoveryText(code) };
  return buildDeliveryEmail({ envelope, signer, sender, kind: kind === 'invitation' ? 'request' : 'completion', link });
}

export function reviewedTemplates(ownerEmail, origin = 'http://localhost:18889') {
  const owner = approvedAddress(ownerEmail);
  return { label: 'PRIVATE TEST ONLY — REVIEW TEMPLATES, NO ACTIVE CODE OR SIGNING LINK', ownerEmail: owner,
    origin, title: PRIVATE_EMAIL.title, senderName: PRIVATE_EMAIL.senderName, signerName: PRIVATE_EMAIL.signerName,
    maxReservedAttemptsIncludingPrior: PRIVATE_EMAIL.maxAttempts,
    variableApproval: 'The code 123456 and TEST_ONLY_RECIPIENT_LINK below are inert placeholders. Only a newly issued six-digit code and the bound private recipient URL may vary.',
    templates: Object.fromEntries(['invitation', 'verification', 'completion', 'recovery'].map(kind =>
      [kind, restPayload(mailFor(kind, owner, { link: `${origin}/s/TEST_ONLY_RECIPIENT_LINK` }), owner)])) };
}

function checkedMail(mail, owner, origin, boundLink) {
  const payload = restPayload(mail, owner);
  let kind, variables;
  if (mail.subject === `Signature requested: ${PRIVATE_EMAIL.title}`) kind = 'invitation';
  else if (mail.subject === `Completed: ${PRIVATE_EMAIL.title}`) kind = 'completion';
  else if (/^Your BL Sign verification code: \d{6}$/.test(mail.subject)) {
    kind = 'verification'; variables = { code: mail.subject.slice(-6) };
  } else if (mail.subject === 'Your BL Sign envelope recovery code') {
    kind = 'recovery'; const code = /^Your BL Sign recovery code is (\d{6})\./.exec(mail.text || '')?.[1];
    if (!code) throw failure('Private recovery message does not match the reviewed template.');
    variables = { code };
  } else throw failure('Message is outside the four approved private templates.');
  if (['invitation', 'completion'].includes(kind)) {
    const link = /\nOpen document:\n([^\n]+)\n/.exec(mail.text || '')?.[1];
    if (!boundLink || link !== boundLink || new URL(link).origin !== origin)
      throw failure('Invitation must reference this running private Worker and its single controlled recipient.');
    variables = { link };
  }
  if (!same(payload, restPayload(mailFor(kind, owner, variables), owner)))
    throw failure('Private message body differs from the approved template.');
  return { kind, payload, fingerprint: digest(JSON.stringify(payload)) };
}

function atomicSave(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}

function checkedPrior(prior, owner, expectedCount) {
  // Root's sanitized receipt export intentionally contains no active codes,
  // message bodies, credentials or recipient URLs. Preserve those receipts.
  if (prior?.schemaVersion === 1 && prior.confirmedPriorReservedAttempts === expectedCount &&
      prior.maximumTotalAttempts === 8 && prior.from === MAIL_FROM &&
      approvedAddress(prior.to) === owner && prior.oldPrivateProcessClosed === true) {
    prior = { ownerEmail: owner, reviewed: true, attempts: prior.attempts.map(row => ({
      id: `prior-${row.index}`, state: row.state, messageId: row.messageId,
      providerCode: row.errorCodes?.[0] || row.httpStatus,
      evidenceRef: row.reconciliation?.gmailId ? `gmail-inbox:${row.reconciliation.gmailId}` : `prior-provider-http:${row.httpStatus}`,
      inboxReceipt: row.reconciliation?.inboxObserved === true,
      subjectSha256: row.subjectSha256, bodySha256: row.bodySha256, at: row.at,
      reconciliation: row.reconciliation,
    })) };
  }
  if (!prior || prior.ownerEmail !== owner || prior.reviewed !== true || !Array.isArray(prior.attempts) ||
      prior.attempts.length !== expectedCount || !Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount > 8)
    throw failure('An explicit reviewed reconciliation of every prior reserved attempt is required.');
  const ids = new Set();
  return prior.attempts.map(row => {
    if (!row.id || ids.has(row.id) || !['accepted', 'rejected'].includes(row.state) || !row.evidenceRef ||
        (row.state === 'accepted' && !row.messageId) || (row.state === 'rejected' && !row.providerCode))
      throw failure('Prior attempts must retain unique IDs, provider receipts/rejections and reconciliation evidence.');
    ids.add(row.id);
    return { id: String(row.id), prior: true, kind: String(row.kind || 'prior-reviewed-attempt'), state: row.state,
      ...(row.messageId ? { messageId: String(row.messageId) } : {}),
      ...(row.providerCode ? { providerCode: String(row.providerCode) } : {}),
      evidenceRef: String(row.evidenceRef), ...(row.fingerprint ? { fingerprint: String(row.fingerprint) } : {}),
      ...(row.subjectSha256 ? { subjectSha256: String(row.subjectSha256) } : {}),
      ...(row.bodySha256 ? { bodySha256: String(row.bodySha256) } : {}),
      ...(row.at ? { at: String(row.at) } : {}), ...(row.reconciliation ? { reconciliation: row.reconciliation } : {}),
      inboxReceipt: row.inboxReceipt === true };
  });
}

export class PrivateEmailTransport {
  #token; #endpoint; #fetch; #path; #lock; #save; #ledger; #enabled = false; #blocked = false;
  #writerId = randomUUID(); #closing = false; #pending = 0; #closedWaiters = [];
  constructor({ ownerEmail, reviewApproved = false, origin = 'http://localhost:18889', ledgerPath,
    priorReconciliation, expectedPriorAttempts, accountId, apiToken, fetchImpl = fetch,
    resumeReconciliation, saveImpl = atomicSave, resolveRecipientLink } = {}) {
    this.ownerEmail = approvedAddress(ownerEmail);
    if (reviewApproved !== true) throw failure('The exact private templates must be reviewed before transport can be created.');
    if (!/^https?:\/\/localhost:\d+$/.test(origin)) throw failure('Private review origin must be a loopback localhost port.');
    if (!/^[a-f0-9]{32}$/.test(accountId || '') || typeof apiToken !== 'string' || !apiToken || /[\r\n]/.test(apiToken))
      throw failure('Private provider credentials must be supplied internally.');
    if (!ledgerPath) throw failure('A persistent private email ledger path is required.');
    this.origin = origin; this.templateSha256 = digest(JSON.stringify(reviewedTemplates(this.ownerEmail, origin)));
    this.resolveRecipientLink = resolveRecipientLink;
    this.#token = apiToken; this.#endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`;
    this.#fetch = fetchImpl; this.#save = saveImpl; this.#path = resolve(ledgerPath);
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    // Single local writer. A crashed owner's lock requires explicit reconciliation;
    // never steal another process's lock or reset its attempt count.
    this.#lock = `${this.#path}.lock`;
    try { const fd = openSync(this.#lock, 'wx', 0o600); writeFileSync(fd, this.#writerId); closeSync(fd); }
    catch { throw failure('Private ledger already has an owner; no automatic restart or lock removal.'); }
    try {
      const knownPrior = checkedPrior(priorReconciliation, this.ownerEmail, expectedPriorAttempts);
      const knownPriorHash = digest(JSON.stringify(knownPrior));
      if (existsSync(this.#path)) {
        const bytes = readFileSync(this.#path, 'utf8'); this.#ledger = JSON.parse(bytes);
        if (this.#ledger.ownerEmail !== this.ownerEmail || this.#ledger.templateSha256 !== this.templateSha256 ||
            this.#ledger.maxAttempts !== 8 || !Array.isArray(this.#ledger.attempts) || this.#ledger.attempts.length > 8 ||
            this.#ledger.priorReservedAttempts !== expectedPriorAttempts || this.#ledger.priorAttemptsSha256 !== knownPriorHash ||
            !same(this.#ledger.attempts.filter(row => row.prior), knownPrior))
          throw failure('Existing ledger does not match this private approval.');
        if (!resumeReconciliation || resumeReconciliation.reviewed !== true || resumeReconciliation.ledgerSha256 !== digest(bytes) ||
            !Array.isArray(resumeReconciliation.attempts) || resumeReconciliation.attempts.length !== this.#ledger.attempts.length)
          throw failure('Existing ledger requires explicit reviewed reconciliation; blind restart is refused.');
        const priorIds = new Set();
        for (const row of this.#ledger.attempts) {
          const reconciled = resumeReconciliation.attempts.find(item => item.id === row.id);
          if (priorIds.has(row.id) || !reconciled || !reconciled.evidenceRef || !['accepted', 'rejected'].includes(reconciled.state) ||
              (reconciled.state === 'accepted' && (!reconciled.messageId || (row.messageId && row.messageId !== reconciled.messageId))) ||
              (row.state === 'accepted' && reconciled.state !== 'accepted') ||
              (reconciled.state === 'rejected' && (!reconciled.providerCode || (['reserved', 'uncertain'].includes(row.state) && reconciled.provenNotAccepted !== true))))
            throw failure('Every prior receipt or uncertain attempt needs provider evidence before restart.');
          priorIds.add(row.id);
          if (!row.prior) Object.assign(row, { state: reconciled.state, evidenceRef: reconciled.evidenceRef,
            ...(reconciled.messageId ? { messageId: reconciled.messageId } : {}),
            ...(reconciled.providerCode ? { providerCode: reconciled.providerCode } : {}) });
        }
      } else {
        this.#ledger = { version: 1, ownerEmail: this.ownerEmail, templateSha256: this.templateSha256,
          maxAttempts: 8, createdAt: new Date().toISOString(), priorReservedAttempts: expectedPriorAttempts,
          priorAttemptsSha256: knownPriorHash, attempts: knownPrior };
      }
      this.#persist();
    } catch (error) { unlinkSync(this.#lock); this.#lock = null; throw error; }
  }
  bindRecipient(link) {
    this.#assertOpen();
    if (this.recipientLink || typeof link !== 'string' || new URL(link).origin !== this.origin || !/^\/s\/[A-Za-z0-9_-]+$/.test(new URL(link).pathname))
      throw failure('Only one recipient from this private Worker can be bound.');
    this.recipientLink = link;
  }
  #assertWriter() {
    if (!this.#lock || !existsSync(this.#lock) || readFileSync(this.#lock, 'utf8') !== this.#writerId) {
      this.#blocked = true; throw failure('Private ledger writer ownership is lost; no further writes or sends.', 'E_OUTCOME_UNKNOWN');
    }
  }
  #assertOpen() { if (this.#closing) throw failure('Closed private transport cannot be reused.'); this.#assertWriter(); }
  ownerReady() { this.#assertOpen(); if (this.#blocked) throw failure('Uncertain delivery requires provider reconciliation.', 'E_OUTCOME_UNKNOWN'); this.#enabled = true; }
  #persist() { this.#assertWriter(); this.#save(this.#path, this.#ledger); }
  summary() {
    return { outcome: 'NOT DONE', verificationScope: 'PRIVATE_CONTROLLED_EMAIL', startupSends: 0,
      enabled: this.#enabled, blocked: this.#blocked, reservedAttempts: this.#ledger.attempts.length, maxAttempts: 8,
      attempts: this.#ledger.attempts.map(({ id, kind, prior, state, messageId, providerCode, fingerprint, inboxReceipt }) =>
        ({ id, kind, prior: Boolean(prior), state, messageId, providerCode, fingerprint, inboxReceipt: Boolean(inboxReceipt) })),
      missingRequirement: 'Owner reads the controlled inbox and enters issued codes in the private browser; provider acceptance alone is not inbox or full lifecycle proof.',
      ownerJob: 'BL Sign private acceptance (/root and founder)',
      nextCheckpoint: 'Owner opens the prepared loopback review, confirms readiness, then completes the single synthetic recipient and new-browser recovery.' };
  }
  async send(mail) {
    this.#assertOpen(); this.#pending++;
    try { return await this.#send(mail); }
    finally { this.#pending--; if (this.#closing && !this.#pending) this.#release(); }
  }
  async #send(mail) {
    if (!this.#enabled) throw failure('Private email review is prepared; owner readiness has not been enabled.');
    if (this.#blocked || this.#ledger.attempts.some(row => ['reserved', 'uncertain'].includes(row.state)))
      throw failure('Prior delivery outcome needs reconciliation; automatic retry is blocked.', 'E_OUTCOME_UNKNOWN');
    const boundLink = this.resolveRecipientLink ? this.resolveRecipientLink() : this.recipientLink;
    const { kind, payload, fingerprint } = checkedMail(mail, this.ownerEmail, this.origin, boundLink);
    const previous = this.#ledger.attempts.find(row => row.fingerprint === fingerprint && !row.prior);
    if (previous?.state === 'accepted') return { messageId: previous.messageId };
    if (previous || this.#ledger.attempts.some(row => !row.prior && row.kind === kind))
      throw failure('This approved template already has a reserved attempt; no automatic resend.', 'E_RECIPIENT_NOT_ALLOWED');
    if (this.#ledger.attempts.length >= 8) throw failure('The eight-attempt private allowance is exhausted.', 'E_DAILY_LIMIT_EXCEEDED');
    const row = { id: randomUUID(), kind, fingerprint, subjectSha256: digest(payload.subject),
      textSha256: payload.text === undefined ? null : digest(payload.text), htmlSha256: payload.html === undefined ? null : digest(payload.html),
      state: 'reserved', reservedAt: new Date().toISOString(), inboxReceipt: false };
    this.#ledger.attempts.push(row);
    // No external call until its reservation is durably committed.
    try { this.#persist(); } catch { this.#blocked = true; throw failure('Reservation persistence failed; no provider request was made.', 'E_OUTCOME_UNKNOWN'); }
    let response, result;
    try {
      response = await this.#fetch(this.#endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
      result = await response.json();
    } catch { return this.#uncertain(row); }
    if (!response.ok || result.success !== true) {
      if (response.status >= 400 && response.status < 500 && result.success === false && Array.isArray(result.errors) && result.errors.length) {
        const code = result.errors[0].code;
        row.state = 'rejected'; row.providerCode = /^[0-9]{1,9}$/.test(String(code)) && String(code) !== this.#token
          ? String(code) : `HTTP_${response.status}`; row.providerHttpStatus = response.status;
        try { this.#persist(); } catch { return this.#uncertain(row); }
        throw failure('Private provider definitively rejected this request; reviewed attempt remains consumed.', response.status === 429 ? 'E_RATE_LIMIT_EXCEEDED' : 'E_VALIDATION_ERROR');
      }
      return this.#uncertain(row);
    }
    const info = result.result;
    if (!info || typeof info.message_id !== 'string' || !/^<[^<>\s@]+@[A-Za-z0-9.-]+>$/.test(info.message_id) || info.message_id.length > 200 || info.message_id.includes(this.#token) ||
        !['delivered', 'queued', 'permanent_bounces', 'suppressed_recipients'].every(key => Array.isArray(info[key]) && info[key].every(address => address === this.ownerEmail)))
      return this.#uncertain(row);
    row.messageId = info.message_id;
    row.providerReceipt = { delivered: info.delivered, queued: info.queued, permanent_bounces: info.permanent_bounces, suppressed_recipients: info.suppressed_recipients };
    if (info.permanent_bounces.length || info.suppressed_recipients.length) {
      row.state = 'rejected'; row.providerCode = info.suppressed_recipients.length ? 'suppressed' : 'permanent_bounce';
      try { this.#persist(); } catch { return this.#uncertain(row); }
      throw failure('Private provider reports a bounce or suppression; no retry or alternate sender.', 'E_RECIPIENT_SUPPRESSED');
    }
    if (!info.delivered.length && !info.queued.length) return this.#uncertain(row);
    row.state = 'accepted'; row.acceptedAt = new Date().toISOString();
    try { this.#persist(); } catch { return this.#uncertain(row); }
    return { messageId: row.messageId };
  }
  #uncertain(row) {
    this.#blocked = true; row.state = 'uncertain';
    try { this.#persist(); } catch { /* Durable reservation already blocks a blind restart. */ }
    throw failure('Private provider outcome needs reviewed reconciliation; no automatic retry.', 'E_OUTCOME_UNKNOWN');
  }
  close() {
    this.#enabled = false; this.#closing = true;
    if (!this.#pending) { this.#release(); return Promise.resolve(); }
    return new Promise(resolve => this.#closedWaiters.push(resolve));
  }
  #release() {
    if (this.#lock) {
      if (existsSync(this.#lock) && readFileSync(this.#lock, 'utf8') === this.#writerId) unlinkSync(this.#lock);
      this.#lock = null;
    }
    this.#token = null;
    for (const resolve of this.#closedWaiters.splice(0)) resolve();
  }
}
