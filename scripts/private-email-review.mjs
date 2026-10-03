// Explicit private acceptance entry point. Imports and preparation never send mail.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveHarness, syntheticPdf, candidateIdentity } from '../tests/helpers/worker-harness.mjs';
import { PRIVATE_EMAIL, approvedAddress, PrivateEmailTransport, reviewedTemplates } from './private-email-transport.mjs';

const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export function preparePrivateReview({ ownerEmail, templatePath, transport = 'http', port = PRIVATE_EMAIL.port } = {}) {
  if (!['http', 'https'].includes(transport)) throw new Error('Private review transport must be http or https.');
  const templates = reviewedTemplates(approvedAddress(ownerEmail), `${transport}://localhost:${port}`);
  if (!templatePath) throw new Error('An explicit template output path is required.');
  const path = resolve(templatePath); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(templates, null, 2) + '\n', { mode: 0o600 });
  return { templates, path };
}

async function seedOnly(harness, ownerEmail) {
  const request = (path, { method = 'GET', body, form, cookie, headers = {} } = {}) => {
    const h = new Headers({ 'cf-connecting-ip': '192.0.2.10', 'user-agent': 'BL Sign private TEST ONLY preparation', ...headers });
    if (cookie) h.set('cookie', cookie);
    if (body !== undefined) h.set('content-type', 'application/json');
    // The loopback HTTP listener models edge TLS termination. Keep the public
    // HTTP link origin, but route its preparation through the HTTPS Worker.
    return harness.worker.fetch(new Request(harness.env.PUBLIC_ORIGIN.replace(/^http:/, 'https:') + path,
      { method, headers: h, ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }) }), harness.env);
  };
  const start = await request('/api/public/start', { method: 'POST', body: { name: PRIVATE_EMAIL.senderName, email: ownerEmail } });
  if (start.status !== 200) throw new Error('Synthetic private sender could not be prepared.');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const form = new FormData(); form.set('title', PRIVATE_EMAIL.title);
  form.set('file', new File([await syntheticPdf()], 'BL-SIGN-TEST-ONLY-NOT-A-CONTRACT.pdf', { type: 'application/pdf' }));
  const uploaded = await request('/api/public/envelopes', { method: 'POST', form, cookie,
    headers: { 'idempotency-key': 'PRIVATE_TEST_ONLY_20261003_REVIEW' } });
  if (uploaded.status !== 200) throw new Error('Synthetic private PDF could not be prepared.');
  const { id } = await uploaded.json();
  const setup = await request(`/api/envelopes/${id}/setup`, { method: 'PUT', cookie, body: {
    signers: [{ name: PRIVATE_EMAIL.signerName, email: ownerEmail }],
    fields: [{ signer_index: 0, type: 'signature', page: 0, x: .1, y: .3, w: .5, h: .12 }],
  } });
  if (setup.status !== 200) throw new Error('Synthetic private signer could not be prepared.');
  const read = await request(`/api/envelopes/${id}`, { cookie });
  const { envelope, signers } = await read.json();
  if (envelope.status !== 'draft' || signers.length !== 1) throw new Error('Private preparation must remain a single-recipient draft.');
  return { id, cookie, originalHash: envelope.original_sha256, recipientLink: `${harness.env.PUBLIC_ORIGIN}/s/${signers[0].token}` };
}

export async function startPrivateEmailReview({ ownerEmail, reviewApproved = false, templatePath, ledgerPath,
  priorReconciliation, expectedPriorAttempts, resumeReconciliation, accountId, apiToken,
  port = PRIVATE_EMAIL.port, transport = 'http', fetchImpl } = {}) {
  const owner = approvedAddress(ownerEmail);
  if (reviewApproved !== true) throw new Error('Starting email tooling requires the explicit --review-approved flag.');
  if (!templatePath || !existsSync(templatePath)) throw new Error('Prepare and inspect the exact templates before starting.');
  const origin = `${transport}://localhost:${port}`;
  const templates = reviewedTemplates(owner, origin);
  if (JSON.stringify(JSON.parse(readFileSync(templatePath, 'utf8'))) !== JSON.stringify(templates))
    throw new Error('Prepared template file differs from this private flow; inspect the current templates first.');
  let adapter, seed;
  const requestHook = async (req, harness) => {
    if (req.url === '/__sandbox/inbox') return jsonResponse({ outcome: 'NOT DONE', verificationScope: 'PRIVATE_CONTROLLED_EMAIL',
      message: 'This review uses the real provider adapter. Active codes and mail bodies are never available through a sandbox route. Read the owner-controlled inbox and enter its code in the browser.' }, 410);
    if (adapter && !adapter.summary().enabled && req.method === 'POST' &&
        (/^\/api\/envelopes\/[^/]+\/(send|resend)$/.test(req.url) || /^\/api\/session\/[^/]+\/auth-request$/.test(req.url) || req.url === '/api/public/recover'))
      return jsonResponse({ error: 'Private email adapter is paused. Open the private review and enable owner readiness before sending.' }, 503);
    if (!req.url?.startsWith('/__private')) return null;
    if (req.headers.host !== new URL(harness.env.PUBLIC_ORIGIN).host || req.headers['sec-fetch-site'] === 'cross-site')
      return jsonResponse({ error: 'Private review requires this localhost origin.' }, 403);
    if (!adapter || !seed) return jsonResponse({ state: 'preparing', startupSends: 0 }, 503);
    if (req.method === 'GET' && req.url === '/__private/templates') return jsonResponse(templates);
    if (req.method === 'GET' && req.url === '/__private/status') return jsonResponse(adapter.summary());
    if (req.method === 'POST' && req.url === '/__private/owner-ready') {
      if (req.headers.origin !== harness.env.PUBLIC_ORIGIN) return jsonResponse({ error: 'Same-origin owner action required.' }, 403);
      adapter.ownerReady(); return new Response(null, { status: 303, headers: { location: '/__private', 'cache-control': 'no-store' } });
    }
    if (req.method === 'GET' && req.url === '/__private/start') return new Response(null, {
      status: 303, headers: { location: `/e/${seed.id}`, 'set-cookie': `${seed.cookie}; Path=/; HttpOnly; Secure; SameSite=Lax`, 'cache-control': 'no-store' },
    });
    if (req.method === 'GET' && ['/__private', '/__private/'].includes(req.url)) {
      const status = adapter.summary();
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BL Sign private email review</title><style>body{margin:auto;padding:24px;max-width:850px;font:17px/1.5 system-ui;background:#f4f3ef;color:#171719}h1{line-height:1.2}a,button{display:inline-block;padding:12px 18px;border:0;border-radius:8px;background:#171719;color:white;text-decoration:none;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px;border-radius:12px}details{margin:20px 0}button{cursor:pointer}</style></head><body><h1>Private synthetic email review</h1><p><b>TEST ONLY — NOT A CONTRACT</b></p><p>One recipient: ${esc(owner)}<br>Sender: ${esc(templates.templates.invitation.from)}<br>${esc(PRIVATE_EMAIL.title)}</p><p>Startup sends: 0. Reserved attempts: ${status.reservedAttempts} of 8. This listener is separate from the sandbox on port 18788.</p><p>Read each newly issued code in your owner-controlled inbox and type it into the BL Sign browser page. Codes expire after ten minutes. The connector withholds codes; this page and receipt endpoint never disclose them. Every sign or recovery action below uses this same running private Worker and synthetic document.</p>${status.enabled ? '<p>Email adapter enabled by owner readiness. Send the prepared invitation only when ready to open the inbox and complete the flow.</p>' : '<p>Email adapter is paused. Enable it only when ready to complete the inbox and browser steps now.</p><form method="post" action="/__private/owner-ready"><button>Ready to complete the private test</button></form>'}<p><a href="/__private/start">Open prepared synthetic document</a></p><p>After sending: open the invitation from your inbox; request one verification code; enter it and sign the synthetic document; open the completed email and retrieve the PDF. Then open <a href="/me">My envelopes</a> in a fresh browser session and request one recovery code.</p><p>One attempt per approved invitation, verification, completion and recovery template. No resend, alternate sender or automated timer. Provider acceptance does not establish inbox receipt.</p><details><summary>Exact reviewed templates (inert code and link placeholders)</summary><pre>${esc(JSON.stringify(templates, null, 2))}</pre></details><p><a href="/__private/status">Redacted receipt status</a></p></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    return jsonResponse({ error: 'Private route not found.' }, 404);
  };
  let harness;
  try {
    harness = await serveHarness({ port, transport, requestHook });
    seed = await seedOnly(harness, owner);
    adapter = new PrivateEmailTransport({ ownerEmail: owner, reviewApproved, origin, ledgerPath,
      priorReconciliation, expectedPriorAttempts, resumeReconciliation, accountId, apiToken,
      resolveRecipientLink() {
        // The Worker rotates the draft recipient token when sending. Resolve the
        // current token from this isolated DB; never expose it as a code receipt.
        const envelope = harness.env.DB.sql.prepare('SELECT title,original_sha256 FROM envelopes WHERE id=?').get(seed.id);
        const signers = harness.env.DB.sql.prepare('SELECT token,name,email FROM signers WHERE envelope_id=?').all(seed.id);
        const sender = harness.env.DB.sql.prepare('SELECT name,email FROM senders WHERE id=(SELECT sender_id FROM envelopes WHERE id=?)').get(seed.id);
        if (envelope?.title !== PRIVATE_EMAIL.title || envelope.original_sha256 !== seed.originalHash || signers.length !== 1 || signers[0].email !== owner ||
            signers[0].name !== PRIVATE_EMAIL.signerName || sender?.email !== owner || sender.name !== PRIVATE_EMAIL.senderName)
          throw new Error('Private document identity no longer matches the approved single-recipient fixture.');
        return `${origin}/s/${signers[0].token}`;
      }, ...(fetchImpl ? { fetchImpl } : {}) });
    harness.env.EMAIL = adapter;
    // No EMAIL.send here: the draft, templates and paused UI are reviewable first.
    return { origin: harness.origin, reviewUrl: `${harness.origin}/__private`, adapter, harness,
      identity: candidateIdentity(), async close() { await harness.close(); await adapter.close(); } };
  } catch (error) { if (harness) await harness.close(); if (adapter) await adapter.close(); throw error; }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const ownerEmail = env.OWNER_APPROVED_TEST_EMAIL;
  const templatePath = env.BL_SIGN_PRIVATE_EMAIL_TEMPLATES || 'output/private/email-review-templates.json';
  const transport = args.includes('--https-fixture') ? 'https' : 'http';
  const port = Number(env.BL_SIGN_PRIVATE_EMAIL_PORT || PRIVATE_EMAIL.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid private loopback port.');
  if (args.some(arg => !['--serve', '--review-approved', '--https-fixture'].includes(arg))) throw new Error('Unknown private review option.');
  if (!args.includes('--serve')) {
    const prepared = preparePrivateReview({ ownerEmail, templatePath, transport, port });
    console.log(`Private templates prepared: ${prepared.path}`);
    console.log('Preparation only. No provider calls, active codes, sender sessions or email sends.');
    return prepared;
  }
  const readJson = path => path ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  const review = await startPrivateEmailReview({ ownerEmail, reviewApproved: args.includes('--review-approved'), templatePath,
    ledgerPath: env.BL_SIGN_PRIVATE_EMAIL_LEDGER,
    priorReconciliation: readJson(env.BL_SIGN_PRIVATE_EMAIL_PRIOR_RECONCILIATION),
    expectedPriorAttempts: env.OWNER_APPROVED_PRIOR_EMAIL_ATTEMPTS === undefined ? undefined : Number(env.OWNER_APPROVED_PRIOR_EMAIL_ATTEMPTS),
    resumeReconciliation: readJson(env.BL_SIGN_PRIVATE_EMAIL_RESUME_RECONCILIATION),
    accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, port, transport });
  console.log(`Prepared private owner review: ${review.reviewUrl}`);
  console.log(`Exact Worker SHA-256: ${review.harness.sourceHash}`);
  console.log('Startup sends: 0. Email is paused until the owner readiness action. Use the owner inbox for codes.');
  if (transport === 'https') console.log('Automated fixture mode only; no manual certificate bypass or system trust change.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await review.close(); process.exit(0); });
  return review;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error('Private email review did not start. Verify explicit approval, inspected templates, credentials and sanitized prior/resume reconciliation; no automatic sends or restart.'); process.exitCode = 1; });
