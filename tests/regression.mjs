import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDeliveryEmail, buildVerificationEmail, MAIL_FROM } from '../src/mail.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const worker = read('src/index.js');
const editor = read('public/assets/editor.js');
const signer = read('public/assets/sign.js');
const landing = read('public/landing.html');

const relativeLuminance = hex => {
  const channels = hex.match(/[0-9a-f]{2}/gi).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrastRatio = (foreground, background) => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
};

assert.match(worker, /private, no-store, max-age=0/, 'private routes must not be cached');
assert.match(worker, /needs a valid email/, 'every recipient must have a valid email');
assert.match(worker, /field geometry must stay inside its document page/, 'out-of-page fields must be rejected');
assert.match(worker, /env\.EMAIL\.send/, 'transactional email must use the authenticated Worker binding');
assert.match(worker, /async scheduled/, 'hourly notification and expiry sweep must be wired');
assert.match(worker, /\/api\/estate\/deal/, 'estate deal packets must be created on the sign worker');
assert.match(worker, /email not sent/, 'estate deal packets must not email the owner');
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
const tinyColor = landing.match(/\.tiny\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)?.[1];
assert.ok(tinyColor, 'landing must define the helper-text color');
assert.ok(contrastRatio(tinyColor, '#050506') >= 4.5,
  `start-card helper text must meet WCAG AA contrast, found ${contrastRatio(tinyColor, '#050506').toFixed(2)}:1`);
assert.match(landing, /#startcard\.fx\s*\{[^}]*opacity:\s*1[^}]*animation-name:\s*startSlide/,
  'start-card animation must not fade helper text through a low-contrast state');
const startSlide = landing.match(/@keyframes\s+startSlide\s*\{[^}]*\}/)?.[0] || '';
assert.doesNotMatch(startSlide, /opacity\s*:/,
  'start-card motion must preserve full text opacity throughout the animation');
assert.match(landing, /@media \(max-width: 520px\)[\s\S]*?\.mockwrap \.page\.cert, \.mockwrap \.seal \{ right: 0; \}/,
  'mobile decorative document layers must stay inside the viewport');

const workflow = landing.match(/<section class="flow-showcase"[\s\S]*?<\/section>/)?.[0];
assert.ok(workflow, 'landing must show the signing workflow directly under the hero');
assert.match(workflow, /Upload document[\s\S]*Place &amp; share[\s\S]*Sign &amp; complete/,
  'workflow must preserve the real upload, field placement/share, and completion sequence');
assert.equal((workflow.match(/<li class="flow-stage">/g) || []).length, 3,
  'workflow must stay focused on three buyer-visible stages');
const workflowWords = workflow.replace(/<[^>]+>/g, ' ').match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || [];
assert.ok(workflowWords.length <= 36, `workflow copy must remain concise, found ${workflowWords.length} words`);
assert.match(landing, /prefers-reduced-motion: reduce[\s\S]*\.flow-packet[\s\S]*animation: none !important/,
  'workflow animation must expose a reduced-motion end state');

for (const page of ['privacy', 'terms', 'accessibility']) {
  const html = read(`public/${page}.html`);
  assert.match(html, new RegExp(`<title>[^<]+`), `${page} must have a unique title`);
  assert.match(html, new RegExp(`rel="canonical" href="https://sign\\.blacklabeltec\\.com/${page}"`),
    `${page} must have a canonical URL`);
  assert.match(html, /<main id="main">/, `${page} must expose a main landmark`);
}
assert.match(worker, /strict-transport-security[\s\S]*max-age=63072000; includeSubDomains; preload/,
  'worker must set portfolio HSTS baseline');
assert.match(worker, /incoming\.protocol !== 'https:'[\s\S]*Response\.redirect\(incoming\.toString\(\), 308\)/,
  'worker must upgrade raw HTTP');
assert.match(worker, /req\.method === 'HEAD'[\s\S]*new Request\(req, \{ method: 'GET' \}\)[\s\S]*new Response\(null/,
  'public GET routes must answer HEAD with the same status and headers but no body');
assert.match(worker, /p === '\/llms\.txt'/, 'worker must publish llms.txt');
assert.match(worker, /p === '\/privacy'[\s\S]*p === '\/terms'[\s\S]*p === '\/accessibility'/,
  'worker must route all public legal pages');
assert.match(worker, /p === '\/legal\.css'[\s\S]*serveAsset\(env, url, '\/legal\.css'\)/,
  'worker must serve the shared legal stylesheet through run_worker_first');
assert.doesNotMatch(landing, /href="\/verify\/"/, 'landing must not ship a dead generic verification link');
assert.match(landing, /footer nav \{[^}]*flex-wrap: wrap/, 'footer legal navigation must reflow on narrow screens');
assert.doesNotMatch(landing, /<a href="\/admin" style=/, 'footer links must not carry low-contrast inline colors');
assert.match(worker, /async function purgeEnvelope[\s\S]*DOCS\.delete[\s\S]*DELETE FROM fields[\s\S]*DELETE FROM signers[\s\S]*DELETE FROM events[\s\S]*DELETE FROM envelopes/,
  'privacy deletion must remove document objects and every envelope record class');
assert.match(worker, /m === 'DELETE' && p === '\/api\/public\/account'/,
  'senders must have a self-service full-account deletion route');
assert.match(read('public/me.html'), /Delete all account data[\s\S]*\/api\/public\/account/,
  'sender workspace must expose the full-account deletion control');

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
