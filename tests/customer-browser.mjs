// Node Playwright driver, using an already installed browser. No test-framework
// package, public deployment, persistent browser profile or live email is used.
import assert from 'node:assert/strict';
import { mkdir, access, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serveHarness, syntheticPdf, sha256, projectRoot, candidateIdentity } from './helpers/worker-harness.mjs';

async function installedPlaywright() {
  if (process.env.BL_SIGN_PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.BL_SIGN_PLAYWRIGHT_MODULE).href);
  try { return await import(pathToFileURL(createRequire(import.meta.url).resolve('playwright')).href); } catch {}
  const cache = join(homedir(), '.npm', '_npx');
  for (const directory of await readdir(cache)) {
    try { return await import(pathToFileURL(join(cache, directory, 'node_modules/playwright/index.mjs')).href); } catch {}
  }
  throw new Error('Existing Playwright driver required; set BL_SIGN_PLAYWRIGHT_MODULE to its index.mjs. No packages are installed by this test.');
}

const output = join(projectRoot, 'output/playwright'); await mkdir(output, { recursive: true });
const transport = process.env.BL_SIGN_BROWSER_TRANSPORT || 'https';
const harness = await serveHarness({ transport }); const pdf = await syntheticPdf();
await writeFile(join(output, 'TEST-ONLY-original.pdf'), pdf);
const { chromium } = await installedPlaywright();
async function installedChromium() {
  if (process.env.BL_SIGN_CHROMIUM_EXECUTABLE) return process.env.BL_SIGN_CHROMIUM_EXECUTABLE;
  try { await access(chromium.executablePath()); return undefined; } catch {}
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  for (const directory of (await readdir(cache)).filter(x => x.startsWith('chromium_headless_shell-')).sort().reverse())
    for (const platform of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
      const path = join(cache, directory, platform, 'chrome-headless-shell');
      try { await access(path); return path; } catch {}
    }
  throw new Error('Installed Chromium required; set BL_SIGN_CHROMIUM_EXECUTABLE. This test never downloads a browser.');
}
const browser = await chromium.launch({ headless: true, executablePath: await installedChromium() });
const checks = [], screenshots = [], pageErrors = [], externalRequests = [];
async function context(viewport = { width: 1440, height: 1000 }) {
  const result = await browser.newContext({ viewport, reducedMotion: 'reduce', ignoreHTTPSErrors: true });
  // Fail closed if an application screen tries to make a public network request.
  await result.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === harness.origin || ['data:', 'blob:'].includes(u.protocol)) return route.continue();
    externalRequests.push(u.origin + u.pathname); return route.abort('blockedbyclient');
  });
  result.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  return result;
}
async function screenshot(page, name) {
  const filename = `${name}.png`; await page.screenshot({ path: join(output, filename), fullPage: true }); screenshots.push(filename);
}
function check(name, condition = true) { assert.ok(condition, name); checks.push(name); }
async function verifyRecipient(page, email) {
  await page.locator('#authcard').waitFor({ state: 'visible' });
  await page.locator('#sendcode').click();
  await page.locator('#authentry').waitFor({ state: 'visible' });
  await page.locator('#authcode').fill(harness.inbox.latestCode(email));
  await Promise.all([page.waitForLoadState('load'), page.locator('#verifycode').click()]);
  await page.locator('#authcard').waitFor({ state: 'hidden' });
}
async function sign(page) {
  await page.locator('#consentcard').waitFor({ state: 'visible' });
  await page.locator('#agree').check(); await page.locator('#continue').click();
  await page.locator('.sfld[role="button"]').first().waitFor({ state: 'visible' });
  await page.reload(); await page.locator('.sfld[role="button"]').first().waitFor({ state: 'visible' });
  check('Reload after consent retains accepted consent and restores document');
  await page.locator('.sfld[role="button"]').first().click();
  await page.locator('#tabtype').click(); await page.locator('#typename').fill('SYNTHETIC TEST ONLY');
  await page.locator('#sigadopt').click();
  await page.locator('#finish:not([disabled])').waitFor({ state: 'visible' });
  await screenshot(page, screenshots.some(x => x.startsWith('recipient-ready')) ? 'recipient-ready-second' : 'recipient-ready-first');
  await page.locator('#finish').click(); await page.locator('#statuscard').waitFor({ state: 'visible' });
}

try {
  const senderContext = await context(), sender = await senderContext.newPage();
  await sender.goto(harness.origin); await sender.locator('#startcard').waitFor({ state: 'visible' });
  await screenshot(sender, 'landing-desktop');
  await sender.locator('#name').fill('Synthetic Sender TEST ONLY'); await sender.locator('#email').fill('sender-browser@example.test');
  await sender.locator('#start').click(); await sender.locator('#upcard').waitFor({ state: 'visible' });
  check('Fresh browser starts a sender session without creating an account or subscription');
  await sender.locator('#title').fill('BL SIGN TEST ONLY — NOT A CONTRACT');
  await sender.locator('#file').setInputFiles({ name: 'TEST-ONLY-NOT-A-CONTRACT.pdf', mimeType: 'application/pdf', buffer: pdf });
  await sender.locator('#create').click(); await sender.waitForURL(/\/e\/[a-f0-9]{32}$/);
  await sender.locator('.pagebox canvas').first().waitFor({ state: 'visible' });
  const id = sender.url().split('/').pop(); check('Upload opens the integrated PDF field editor');
  for (let i = 0; i < 2; i++) {
    if (i) await sender.locator('#addsigner').click();
    await sender.locator(`#signers input[data-i="${i}"][data-k="name"]`).fill(`Synthetic Recipient ${i} TEST ONLY`);
    await sender.locator(`#signers input[data-i="${i}"][data-k="email"]`).fill(`browser${i}@example.test`);
    await sender.locator('#whofor').selectOption(String(i));
    await sender.locator('[data-place="signature"]').click();
    const overlay = sender.locator('.pagebox .overlay').first(), size = await overlay.boundingBox();
    assert.ok(size);
    if (!i) await overlay.click({ position: { x: size.width * .25, y: size.height * .3 } });
    else {
      await overlay.focus(); await overlay.press('Enter');
      const field = sender.locator('.fld').last(); await field.focus();
      const initial = await field.boundingBox(); await field.press('ArrowRight'); await field.press('Alt+ArrowDown');
      const adjusted = await field.boundingBox();
      check('Keyboard can place, move and resize signature fields', adjusted.x > initial.x && adjusted.height > initial.height);
    }
  }
  await screenshot(sender, 'editor-placed-fields');
  await sender.locator('#send').click(); await sender.locator('#links').waitFor({ state: 'visible' });
  await screenshot(sender, 'sender-invitation-results');
  check('Send reports sandbox provider acceptance and defers the second sequential invitation', harness.inbox.messages('browser0@example.test').length === 1 && harness.inbox.messages('browser1@example.test').length === 0);
  const signers = harness.env.DB.sql.prepare('SELECT * FROM signers WHERE envelope_id=? ORDER BY order_index').all(id);
  const firstContext = await context(), first = await firstContext.newPage();
  await first.goto(`${harness.origin}/s/${signers[0].token}`); await first.locator('#authcard').waitFor({ state: 'visible' });
  await screenshot(first, 'recipient-email-verification');
  check('Fresh recipient browser requires its own email code before showing document');
  await verifyRecipient(first, 'browser0@example.test');
  const secondContext = await context({ width: 390, height: 844 }), second = await secondContext.newPage();
  await second.goto(`${harness.origin}/s/${signers[1].token}`); await verifyRecipient(second, 'browser1@example.test');
  await second.locator('#statuscard').waitFor({ state: 'visible' });
  check('Second sequential recipient sees its blocked turn', /Not your turn yet/.test(await second.locator('#statuscard').innerText()));
  await screenshot(second, 'recipient-waiting-mobile');
  await sign(first); check('First completion records its signature and waits for the next recipient', /signed|next|waiting/i.test(await first.locator('#statuscard').innerText()));
  await screenshot(first, 'recipient-signed-waiting');
  check('First completion activates and invites the next sequential recipient', harness.inbox.messages('browser1@example.test').some(x => /Signature requested/.test(x.mail.subject)));
  await second.reload(); await sign(second); check('Final completion exposes signed PDF retrieval', /done|completed|Everyone has signed/i.test(await second.locator('#statuscard').innerText()));
  await screenshot(second, 'recipient-completed-mobile');
  const [download] = await Promise.all([second.waitForEvent('download'), second.locator('[data-download]').click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(join(output, 'TEST-ONLY-completed.pdf')); const finalPdf = await readFile(join(output, 'TEST-ONLY-completed.pdf'));
  const envelope = harness.env.DB.sql.prepare('SELECT * FROM envelopes WHERE id=?').get(id);
  check('Browser recipient final download matches sealed Worker hash', sha256(finalPdf) === envelope.final_sha256);
  await sender.goto(harness.origin + '/me'); await sender.locator('#tbl tbody tr').first().waitFor({ state: 'visible' });
  check('Sender My envelopes exposes completed state and final PDF', /completed/i.test(await sender.locator('#tbl tbody').innerText()));
  await screenshot(sender, 'my-envelopes-completed');

  const recoveryContext = await context({ width: 390, height: 844 }), recovery = await recoveryContext.newPage();
  await recovery.goto(harness.origin + '/me');
  await recovery.locator('#recovery').waitFor({ state: 'visible' });
  check('Fresh browser My envelopes remains on recovery screen', new URL(recovery.url()).pathname === '/me');
  await screenshot(recovery, 'sender-recovery-mobile');
  await recovery.locator('#recover-email').fill('sender-browser@example.test'); await recovery.locator('#recover-send').click();
  await recovery.locator('#verify-form').waitFor({ state: 'visible' });
  await recovery.locator('#recover-code').fill(harness.inbox.latestCode('sender-browser@example.test')); await recovery.locator('#recover-verify').click();
  await recovery.locator('#tbl tbody tr').first().waitFor({ state: 'visible' });
  check('New device email recovery restores completed envelope and final PDF');
  const recoveredDownload = recovery.getByRole('link', { name: 'Signed PDF', exact: true });
  await recoveredDownload.scrollIntoViewIfNeeded(); const downloadBounds = await recoveredDownload.boundingBox();
  check('Recovered mobile Signed PDF action is visible within the 390px viewport', downloadBounds && downloadBounds.x >= 0 && downloadBounds.x + downloadBounds.width <= 390);
  await screenshot(recovery, 'sender-recovered-mobile');
  const editorRecoveryContext = await context(), editorRecovery = await editorRecoveryContext.newPage();
  await editorRecovery.goto(`${harness.origin}/e/${id}`); await editorRecovery.locator('#editor-state').waitFor({ state: 'visible' });
  await screenshot(editorRecovery, 'editor-session-recovery');
  const recoveryLink = editorRecovery.locator('#editor-state a[href^="/me?return="]');
  check('Signed-out editor preserves the requested document in its recovery route', (await recoveryLink.getAttribute('href')).includes(encodeURIComponent('/e/' + id)));
  await recoveryLink.click(); await editorRecovery.locator('#recovery').waitFor({ state: 'visible' });
  await editorRecovery.locator('#recover-email').fill('sender-browser@example.test'); await editorRecovery.locator('#recover-send').click();
  await editorRecovery.locator('#verify-form').waitFor({ state: 'visible' });
  await editorRecovery.locator('#recover-code').fill(harness.inbox.latestCode('sender-browser@example.test')); await editorRecovery.locator('#recover-verify').click();
  await editorRecovery.waitForURL(new RegExp(`/e/${id}$`)); await editorRecovery.locator('#links').waitFor({ state: 'visible' });
  check('Verified editor recovery returns to the exact requested completed document'); await screenshot(editorRecovery, 'editor-recovered-document');
  const invalidContext = await context(), invalid = await invalidContext.newPage();
  await invalid.goto(harness.origin + '/s/invalid'); await invalid.locator('#statuscard').waitFor({ state: 'visible' });
  check('Invalid recipient link produces an explicit usable error', /Link not valid|invalid|expired/i.test(await invalid.locator('#statuscard').innerText()));
  await screenshot(invalid, 'recipient-invalid-link');
  const failureContext = await context(), failure = await failureContext.newPage();
  await failure.goto(`${harness.origin}/s/${signers[0].token}`); await failure.locator('#authcard').waitFor({ state: 'visible' });
  harness.env.DB.sql.prepare("UPDATE signers SET auth_code_sent_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(signers[0].id);
  harness.inbox.mode = 'reject'; await failure.locator('#sendcode').click();
  await failure.locator('#sendcode:not([disabled])').waitFor({ state: 'visible' });
  check('Actual sandbox provider rejection leaves the recipient a recoverable error', /could not|unavailable|failed|try again/i.test(await failure.locator('#authmsg').innerText()));
  await screenshot(failure, 'recipient-provider-failure');
  harness.inbox.mode = 'collect';
  await failure.route('**/api/session/*/auth-request', route => route.abort('connectionfailed'));
  await failure.locator('#sendcode').click(); await failure.locator('#sendcode:not([disabled])').waitFor({ state: 'visible' });
  check('Interrupted OTP connection restores the button and gives recovery feedback', /connection|interrupted|try again/i.test(await failure.locator('#authmsg').innerText()));
  await screenshot(failure, 'recipient-network-interruption');
  check('No application page emitted a browser script error', pageErrors.length === 0);
  check('No application page made an external network request', externalRequests.length === 0);
  const evidence = { outcome: 'NOT DONE', verificationScope: 'LOCAL_SANDBOX',
    missingRequirement: 'Actual supported test-inbox receipt through the configured email provider has not been verified in a private runtime. Sandbox acceptance/collection does not meet that requirement.',
    ownerJob: 'BL Sign release verification (/root)',
    nextCorrectiveAction: 'Verify provider acceptance and actual inbox receipt separately using an already authorized, controlled test inbox and private provider runtime; record the provider receipt and inbox evidence.',
    nextCheckpoint: 'Before G3 closure and founder acceptance; rerun these checks against the final unchanged candidate.',
    date: new Date().toISOString(), browser: browser.version(), sourceHash: harness.sourceHash, transport,
    candidate: candidateIdentity(),
    origin: harness.origin, checks, screenshots, pageErrors, externalRequests,
    emailProof: 'LOCAL SANDBOX ONLY. Accepted and received below are simulated provider/sink states, not live provider or actual external inbox receipt.',
    sandboxAccepted: harness.inbox.accepted.length, sandboxReceived: harness.inbox.received.length,
    originalSha256: envelope.original_sha256, finalSha256: envelope.final_sha256 };
  await writeFile(join(output, 'customer-browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`${checks.length} integrated browser checks passed; ${screenshots.length} screenshots. LOCAL SANDBOX EMAIL ONLY.`);
} catch (error) {
  await writeFile(join(output, 'customer-browser-failure.json'), JSON.stringify({ outcome: 'NOT DONE', verificationScope: 'LOCAL_SANDBOX', sourceHash: harness.sourceHash, checks, screenshots, pageErrors, externalRequests, error: error.message }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); await harness.close(); }
