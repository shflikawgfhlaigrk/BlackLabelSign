const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let challengeId = null, busy = false;
const requestedReturn = new URLSearchParams(location.search).get('return');
const returnPath = /^\/e\/[a-f0-9]{32}$/.test(requestedReturn || '') ? requestedReturn : null;

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
function pageMessage(message, error = false) {
  $('#page-message').textContent = message;
  $('#page-message').hidden = !message;
  $('#page-message').classList.toggle('error', error);
}
function recoveryMessage(message, error = false) {
  $('#recover-message').textContent = message;
  $('#recover-message').classList.toggle('error', error);
}
function setBusy(value) {
  busy = value;
  for (const id of ['recover-send', 'recover-verify', 'recover-change']) $('#' + id).disabled = value;
  $('#recovery').setAttribute('aria-busy', String(value));
}
function failure(response, body, fallback) {
  if (response.status >= 500) return 'Recovery is temporarily unavailable. Please try again later. Your envelopes remain saved.';
  if (response.status === 429) return 'Too many attempts. Wait before trying again, then use the newest code.';
  return body.error || fallback;
}
function showRecovery() {
  $('#who').textContent = ''; $('#envelopes').hidden = true; $('#account-data').hidden = true;
  $('#recovery').hidden = false; pageMessage('');
}
async function loadEnvelopes() {
  $('#refresh').disabled = true;
  try {
    const { response, body } = await request('/api/public/envelopes');
    if (response.status === 401) { showRecovery(); return; }
    if (!response.ok || !body.sender || !Array.isArray(body.envelopes)) throw new Error('unavailable');
    $('#recovery').hidden = true; $('#envelopes').hidden = false; $('#account-data').hidden = false;
    $('#who').textContent = `${body.sender.name} · ${body.sender.email}`;
    const rows = $('#tbl tbody');
    rows.innerHTML = body.envelopes.map(envelope => {
      const id = /^[a-f0-9]{32}$/.test(envelope.id) ? envelope.id : '';
      const status = ['draft', 'sent', 'completed', 'voided', 'expired', 'declined', 'uploading'].includes(envelope.status) ? envelope.status : 'draft';
      const uploading = envelope.status === 'uploading';
      return `<tr><td>${uploading ? esc(envelope.title) : `<a href="/e/${id}">${esc(envelope.title)}</a>`}</td><td data-label="Status"><span class="chip ${status}">${uploading ? 'Upload paused' : esc(envelope.status)}</span></td>
        <td data-label="Signed">${Number(envelope.n_signed) || 0}/${Number(envelope.n_signers) || 0}</td><td data-label="Created" class="muted small">${esc(new Date(envelope.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</td>
        <td data-label="Actions"><div class="row">${uploading ? '<span class="muted small">Return to your upload form and retry with the same PDF and title.</span>' : envelope.status === 'completed' ? `<a class="btn ghost" href="/api/envelopes/${id}/final">Signed PDF</a>` : `<a class="btn ghost" href="/e/${id}">Open</a>`}<button class="ghost" data-delete-envelope="${id}" type="button">Delete</button></div></td></tr>`;
    }).join('');
    $('#tbl').hidden = !body.envelopes.length; $('#empty').hidden = !!body.envelopes.length;
    rows.querySelectorAll('[data-delete-envelope]').forEach(button => button.onclick = () => deleteEnvelope(button));
    pageMessage('');
  } catch {
    pageMessage('Your envelopes could not be loaded. Check your connection and refresh this page. Your documents remain saved.', true);
    if ($('#envelopes').hidden) $('#recovery').hidden = false;
  } finally { $('#refresh').disabled = false; }
}
$('#recover-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const email = $('#recover-email').value.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    recoveryMessage('Enter a valid email address.', true); $('#recover-email').setAttribute('aria-invalid', 'true'); $('#recover-email').focus(); return;
  }
  $('#recover-email').setAttribute('aria-invalid', 'false'); setBusy(true); recoveryMessage('Requesting your recovery code…');
  try {
    const { response, body } = await request('/api/public/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!response.ok || !body.challenge_id) { recoveryMessage(failure(response, body, 'Could not request a code. Please try again.'), true); return; }
    challengeId = body.challenge_id; $('#verify-form').hidden = false; $('#recover-send').textContent = 'Request a new code';
    $('#recover-email').readOnly = true; $('#recover-code').value = '';
    recoveryMessage(`If ${email} has sent envelopes, a recovery code has been requested. Check that inbox and spam folder. The code expires in 10 minutes.`);
    $('#recover-code').focus();
  } catch { recoveryMessage('Connection interrupted. Check your inbox before requesting another code.', true); }
  finally { setBusy(false); }
};
$('#verify-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const code = $('#recover-code').value.trim();
  if (!challengeId || !/^\d{6}$/.test(code)) { recoveryMessage('Enter the six-digit code from your newest email.', true); $('#recover-code').focus(); return; }
  setBusy(true); recoveryMessage('Confirming your code…');
  try {
    const { response, body } = await request('/api/public/recover/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge_id: challengeId, code }) });
    if (!response.ok || !body.ok) { recoveryMessage(failure(response, body, 'That code is invalid, expired, or already used. Request a new code.'), true); $('#recover-code').focus(); return; }
    if (returnPath) { location.href = returnPath; return; }
    await loadEnvelopes();
    if (!$('#recovery').hidden) recoveryMessage('The code was accepted, but access could not be confirmed. Enable cookies for BL Sign and refresh this page.', true);
  } catch { recoveryMessage('Connection interrupted. Refresh this page to check whether access was restored before requesting another code.', true); }
  finally { setBusy(false); }
};
$('#recover-change').onclick = () => {
  challengeId = null; $('#verify-form').hidden = true; $('#recover-email').readOnly = false;
  $('#recover-send').textContent = 'Send recovery code'; recoveryMessage(''); $('#recover-email').focus();
};
$('#refresh').onclick = loadEnvelopes;
async function deleteEnvelope(button) {
  if (!confirm('Permanently delete this envelope, its PDFs, signatures, participant records, audit events, and public verification page? This cannot be undone.')) return;
  button.disabled = true;
  try {
    const { response } = await request(`/api/envelopes/${button.dataset.deleteEnvelope}`, { method: 'DELETE' });
    if (response.status === 401) { showRecovery(); return; }
    if (!response.ok) { pageMessage('Deletion could not be completed. Refresh to check the envelope before trying again.', true); return; }
    await loadEnvelopes();
  } catch { pageMessage('Connection interrupted. Refresh to check the envelope before attempting deletion again.', true); }
  finally { button.disabled = false; }
}
$('#delete-account').onclick = async () => {
  if (prompt('Type DELETE to permanently erase all BL Sign account data.') !== 'DELETE') return;
  $('#delete-account').disabled = true;
  try {
    const { response } = await request('/api/public/account', { method: 'DELETE' });
    if (response.status === 401) { showRecovery(); return; }
    if (!response.ok) { pageMessage('Deletion could not be completed. Refresh to check your account before trying again.', true); return; }
    location.href = '/';
  } catch { pageMessage('Connection interrupted. Refresh to check your account before attempting deletion again.', true); }
  finally { $('#delete-account').disabled = false; }
};
loadEnvelopes();
