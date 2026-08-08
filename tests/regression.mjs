import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDeliveryEmail, buildVerificationEmail, MAIL_FROM } from '../src/mail.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const worker = read('src/index.js');
const editor = read('public/assets/editor.js');
const signer = read('public/assets/sign.js');
const landing = read('public/landing.html');

assert.match(worker, /private, no-store, max-age=0/, 'private routes must not be cached');
assert.match(worker, /needs a valid email/, 'every recipient must have a valid email');
assert.match(worker, /field geometry must stay inside its document page/, 'out-of-page fields must be rejected');
assert.match(worker, /env\.EMAIL\.send/, 'transactional email must use the authenticated Worker binding');
assert.match(worker, /async scheduled/, 'hourly notification and expiry sweep must be wired');
assert.match(worker, /auth-request/, 'signer email challenge route must be wired');
assert.match(worker, /auth-verify/, 'signer email verification route must be wired');
assert.match(worker, /HttpOnly; Secure; SameSite=Strict/, 'signer session cookie must be hardened');
assert.match(worker, /if \(!authenticated\)/, 'document routes must be gated on signer authentication');
assert.match(editor, /Signature requested: \$\{envelopeTitle\}/, 'email subject must use the envelope title');
assert.doesNotMatch(editor, /— Michael\\nBlack Label Technologies/, 'self-serve mail must not impersonate the operator');
assert.doesNotMatch(editor, /document\.title\.replace/, 'email subject must not derive from the generic browser title');
assert.match(signer, /aria-label', f\.type === 'initials'/, 'signature fields must be keyboard-addressable');
assert.doesNotMatch(signer, /sender has been notified/, 'decline UI must not claim nonexistent delivery');
assert.doesNotMatch(landing, /Everything DocuSign charges for|verify — forever|ESIGN &amp; UETA compliant|not stored in someone's cloud/,
  'landing page must not overclaim parity, retention, compliance, or storage');

const requestMail = buildDeliveryEmail({
  envelope: { title: 'Services Agreement', expires_at: '2026-08-15T00:00:00Z' },
  signer: { name: 'Jane Buyer', email: 'JANE@example.com', role: 'signer' },
  sender: { name: 'Acme Services', email: 'owner@acme.example' },
  kind: 'request', link: 'https://sign.blacklabeltec.com/s/token',
});
assert.equal(requestMail.from.email, MAIL_FROM, 'mail uses the authenticated BL Sign sender');
assert.equal(requestMail.replyTo, 'owner@acme.example', 'reply-to routes to the actual envelope sender');
assert.equal(requestMail.to.email, 'jane@example.com', 'recipient email is normalized');
assert.equal(requestMail.subject, 'Signature requested: Services Agreement', 'request subject names the envelope');
assert.match(requestMail.text, /Acme Services/, 'request body names the actual sender');
assert.doesNotMatch(requestMail.text, /— Michael/, 'request body never impersonates the operator');

const completionMail = buildDeliveryEmail({
  envelope: { title: 'Services Agreement' },
  signer: { name: 'Copy Recipient', email: 'copy@example.com', role: 'cc' },
  sender: { name: 'Acme Services', email: 'owner@acme.example' },
  kind: 'completion', link: 'https://sign.blacklabeltec.com/s/copy',
});
assert.equal(completionMail.subject, 'Completed: Services Agreement', 'CC completion mail is not a signing request');

const verificationMail = buildVerificationEmail({
  envelope: { title: 'Services Agreement' },
  signer: { name: 'Jane Buyer', email: 'JANE@example.com' },
  sender: { name: 'Acme Services', email: 'owner@acme.example' },
  code: '042731', expiresMinutes: 10,
});
assert.equal(verificationMail.from.email, MAIL_FROM, 'verification uses the authenticated sender');
assert.equal(verificationMail.to.email, 'jane@example.com', 'verification recipient is normalized');
assert.match(verificationMail.subject, /042731/, 'verification subject contains the one-time code');
assert.match(verificationMail.text, /expires in 10 minutes/i, 'verification states code expiry');
assert.doesNotMatch(verificationMail.html, /owner@acme\.example/, 'verification markup does not expose the sender address');

console.log('BL Sign regression contracts passed');
