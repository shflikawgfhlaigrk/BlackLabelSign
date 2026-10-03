import * as pdfjsLib from '/assets/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };

const envId = location.pathname.split('/').pop();
const DEFAULTS = { signature: [0.24, 0.05], initials: [0.09, 0.04], date: [0.15, 0.032], text: [0.24, 0.032], checkbox: [0.028, 0.02] };
let signers = [];          // {name, email}
let fields = [];           // {signer_index, type, page, x, y, w, h}
let editable = false;
let placing = null;
let pageEls = [];          // {overlay, W, H}
let envelopeMeta = null;
let senderMeta = null;
let busy = false, dirty = false;
function message(text, error = false) {
  $('#editor-message').textContent = text;
  $('#editor-message').hidden = !text;
  $('#editor-message').classList.toggle('error', error);
}
function state(title, detail, recovery = false) {
  if ($('#etitle').textContent === 'Opening document…') $('#etitle').textContent = 'Document access';
  $('#signercard').hidden = true; $('#palette').style.display = 'none'; $('#pages').hidden = true;
  $('#save').style.display = 'none'; $('#send').style.display = 'none'; $('#links').style.display = 'none';
  $('#editor-state').hidden = false;
  $('#editor-state').innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(detail)}</p><div class="row">${recovery ? `<a class="btn" href="/me?return=${encodeURIComponent(location.pathname)}">Recover my envelopes</a>` : '<button id="retry-editor" type="button">Refresh document</button>'}<a class="btn ghost" href="/me">My envelopes</a></div>`;
  $('#retry-editor')?.addEventListener('click', () => location.reload());
  message('');
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) state('Restore access to this document', 'Your sender session is missing or expired. Confirm the email address you used to send it.', true);
  return { response, data };
}
function markDirty() { dirty = true; message('Changes in this tab are not saved yet. Save your draft before leaving.'); }
function controlsBusy(value) {
  busy = value;
  for (const id of ['save', 'send', 'adddoc', 'addsigner']) $('#' + id).disabled = value;
  $('#signers').querySelectorAll('input,button').forEach(control => control.disabled = value || !editable);
  $('#palette').querySelectorAll('select').forEach(control => control.disabled = value);
  document.querySelectorAll('[data-place]').forEach(button => button.disabled = value);
}
window.addEventListener('beforeunload', event => { if (dirty && editable) { event.preventDefault(); event.returnValue = ''; } });

async function init() {
  try {
  const { response: r, data: d } = await request(`/api/envelopes/${envId}`);
  if (r.status === 401) return;
  if (!r.ok || !d.envelope || !Array.isArray(d.signers) || !Array.isArray(d.fields)) {
    state(r.status === 404 ? 'Document unavailable' : 'Document could not be opened', r.status === 404 ? 'This envelope may have been deleted or you may be using a link from another sender. Open My envelopes to find your documents.' : 'Check your connection and refresh this page. Your saved document remains available.'); return;
  }
  $('#signercard').hidden = false;
  const e = d.envelope;
  envelopeMeta = e;
  senderMeta = d.sender || { name: 'Black Label Technologies', email: 'michael@blacklabelbots.com' };
  if (!e.sender_id) { $('#backlink').href = '/admin'; $('#backlink').textContent = '← Envelopes'; }
  editable = e.status === 'draft';
  $('#etitle').textContent = e.title;
  document.title = `${e.title} — BL Sign`;
  $('#echip').innerHTML = `<span class="chip ${e.status}">${e.status}</span>`;
  signers = d.signers.map(s => ({ name: s.name, email: s.email, role: s.role || 'signer' }));
  if (e.routing === 'parallel') $('#routing').insertAdjacentHTML('beforeend', '<option value="parallel">All at once (existing envelope)</option>');
  if (e.routing) $('#routing').value = e.routing;
  const idToIndex = Object.fromEntries(d.signers.map((s, i) => [s.id, i]));
  fields = d.fields.map(f => ({ signer_index: idToIndex[f.signer_id] ?? 0, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h }));
  if (!signers.length && editable) signers.push({ name: '', email: '' });

  if (editable) { $('#save').style.display = ''; $('#send').style.display = ''; $('#palette').style.display = ''; }
  else $('#addsigner').style.display = 'none';

  if (d.signers.some(s => s.link)) showLinks(d.signers.map(s => ({
    id: s.id, name: s.name, email: s.email, role: s.role || 'signer', link: s.link, status: s.status,
    delivery_status: s.delivery_status, delivery_error: s.delivery_error,
  })), e, senderMeta);
  renderSigners();
  await renderPdf();
  renderFields();
  message(editable ? 'Draft opened. Save changes before leaving this tab.' : e.status === 'sent' ? 'Envelope sent. Review each recipient’s progress and delivery status below.' : 'This envelope is closed for editing.');
  } catch { state('Document could not be opened', 'Check your connection and refresh this page. Your saved document remains available.'); }
}

function renderSigners() {
  const box = $('#signers');
  box.innerHTML = '';
  signers.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'row signer-row';
    row.style.marginTop = '8px';
    row.innerHTML = `<span class="chip" style="border-color:currentColor;color:${['#c9a227','#4f8ff7','#3ecf8e','#e46f6f'][i % 4]}">${i + 1}</span>
      <input aria-label="Signer ${i + 1} full name" maxlength="120" placeholder="Full name" value="${esc(s.name)}" data-i="${i}" data-k="name" class="grow" ${editable && !busy ? '' : 'disabled'}>
      <input aria-label="Signer ${i + 1} email" maxlength="200" type="email" placeholder="email@domain.com" value="${esc(s.email)}" data-i="${i}" data-k="email" class="grow" ${editable && !busy ? '' : 'disabled'}>
      ${s.role === 'cc' ? '<span class="chip">Copy recipient (existing envelope)</span>' : ''}
      ${editable && signers.length > 1 ? `<button class="ghost" aria-label="Remove signer ${i + 1}" data-rm="${i}">×</button>` : ''}`;
    box.appendChild(row);
  });
  box.querySelectorAll('input,select[data-k]').forEach(inp => inp.oninput = () => {
    signers[inp.dataset.i][inp.dataset.k] = inp.value; markDirty();
    if (inp.dataset.k === 'role' && inp.value === 'cc') {
      fields = fields.filter(f => f.signer_index !== +inp.dataset.i);
      renderFields();
    }
    syncWhofor();
  });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    if (busy) return;
    const i = +b.dataset.rm;
    fields = fields.filter(f => f.signer_index !== i).map(f => ({ ...f, signer_index: f.signer_index > i ? f.signer_index - 1 : f.signer_index }));
    signers.splice(i, 1); markDirty();
    renderSigners(); renderFields();
  });
  syncWhofor();
  $('#addsigner').disabled = busy || signers.length >= 8;
}
function syncWhofor() {
  const sel = $('#whofor');
  const cur = sel.value;
  sel.innerHTML = signers.map((s, i) => s.role === 'cc' ? '' : `<option value="${i}">${esc(s.name || 'Signer ' + (i + 1))}</option>`).join('');
  if (cur && +cur < signers.length) sel.value = cur;
}
$('#addsigner').onclick = () => { if (busy || signers.length >= 8) return; signers.push({ name: '', email: '' }); markDirty(); renderSigners(); };

async function renderPdf() {
  const doc = await pdfjsLib.getDocument({ url: `/api/envelopes/${envId}/pdf` }).promise;
  const container = $('#pages');
  const maxW = Math.min(860, container.clientWidth || 860);
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = maxW / base.width;
    const vp = page.getViewport({ scale });
    const box = document.createElement('div');
    box.className = 'pagebox';
    const canvas = document.createElement('canvas');
    canvas.width = vp.width * devicePixelRatio;
    canvas.height = vp.height * devicePixelRatio;
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.tabIndex = editable ? 0 : -1;
    overlay.setAttribute('aria-label', `Document page ${n}. Choose a field, then press Enter to place it in the center.`);
    box.append(canvas, overlay);
    container.appendChild(box);
    pageEls.push({ overlay, W: vp.width, H: vp.height });
    const ctx = canvas.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    overlay.addEventListener('pointerdown', ev => {
      if (busy || !editable || !placing || ev.target !== overlay) return;
      const rect = overlay.getBoundingClientRect();
      const [dw, dh] = DEFAULTS[placing];
      const f = {
        signer_index: +$('#whofor').value || 0, type: placing, page: pageEls.indexOf(pageEls.find(pe => pe.overlay === overlay)),
        x: Math.min(1 - dw, Math.max(0, (ev.clientX - rect.left) / rect.width - dw / 2)),
        y: Math.min(1 - dh, Math.max(0, (ev.clientY - rect.top) / rect.height - dh / 2)),
        w: dw, h: dh,
      };
      fields.push(f); markDirty();
      placing = null; $('#placemsg').textContent = '';
      document.querySelectorAll('[data-place]').forEach(b => b.classList.remove('on'));
      renderFields();
    });
    overlay.addEventListener('keydown', event => {
      if (event.target !== overlay || event.key !== 'Enter' || busy || !editable || !placing) return;
      event.preventDefault();
      const [w, h] = DEFAULTS[placing];
      fields.push({ signer_index: +$('#whofor').value || 0, type: placing, page: n - 1, x: (1 - w) / 2, y: (1 - h) / 2, w, h });
      placing = null; $('#placemsg').textContent = ''; markDirty();
      document.querySelectorAll('[data-place]').forEach(button => button.classList.remove('on'));
      renderFields();
      overlay.querySelector('.fld:last-child')?.focus();
    });
  }
}

function renderFields() {
  pageEls.forEach(pe => pe.overlay.querySelectorAll('.fld').forEach(el => el.remove()));
  fields.forEach((f, idx) => {
    const pe = pageEls[f.page];
    if (!pe) return;
    const el = document.createElement('div');
    el.className = 'fld s' + (f.signer_index % 4);
    Object.assign(el.style, { left: f.x * pe.W + 'px', top: f.y * pe.H + 'px', width: f.w * pe.W + 'px', height: f.h * pe.H + 'px' });
    const who = signers[f.signer_index] || {};
    el.innerHTML = `<span class="tag">${f.type === 'signature' ? '✍' : ''} ${f.type}${who.name ? ' · ' + esc(who.name.split(' ')[0]) : ''}</span>` +
      (editable ? `<span class="del">×</span><span class="rsz"></span>` : '');
    pe.overlay.appendChild(el);
    if (!editable) return;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${f.type} for ${who.name || 'signer ' + (f.signer_index + 1)}. Arrow keys move, Shift moves farther, Alt and arrows resize, Delete removes.`);
    el.addEventListener('keydown', event => {
      if (busy || event.target !== el) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); fields.splice(idx, 1); markDirty(); renderFields(); pe.overlay.focus(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const distance = event.shiftKey ? 0.025 : 0.005;
      const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
      const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
      if (event.altKey) { f.w = Math.min(1 - f.x, Math.max(0.02, f.w + dx)); f.h = Math.min(1 - f.y, Math.max(0.012, f.h + dy)); }
      else { f.x = Math.min(1 - f.w, Math.max(0, f.x + dx)); f.y = Math.min(1 - f.h, Math.max(0, f.y + dy)); }
      Object.assign(el.style, { left: f.x * pe.W + 'px', top: f.y * pe.H + 'px', width: f.w * pe.W + 'px', height: f.h * pe.H + 'px' }); markDirty();
    });
    el.querySelector('.del').onclick = () => { if (busy) return; fields.splice(idx, 1); markDirty(); renderFields(); };
    // drag to move
    el.addEventListener('pointerdown', ev => {
      if (busy) return;
      if (ev.target.classList.contains('del')) return;
      ev.preventDefault();
      const resizing = ev.target.classList.contains('rsz');
      el.setPointerCapture(ev.pointerId);
      const start = { x: ev.clientX, y: ev.clientY, fx: f.x, fy: f.y, fw: f.w, fh: f.h };
      const move = e2 => {
        const dx = (e2.clientX - start.x) / pe.W, dy = (e2.clientY - start.y) / pe.H;
        if (resizing) {
          f.w = Math.min(1 - f.x, Math.max(0.02, start.fw + dx));
          f.h = Math.min(1 - f.y, Math.max(0.012, start.fh + dy));
        } else {
          f.x = Math.min(Math.max(0, start.fx + dx), 1 - f.w);
          f.y = Math.min(Math.max(0, start.fy + dy), 1 - f.h);
        }
        Object.assign(el.style, { left: f.x * pe.W + 'px', top: f.y * pe.H + 'px', width: f.w * pe.W + 'px', height: f.h * pe.H + 'px' });
      };
      const up = () => { markDirty(); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  });
}

document.querySelectorAll('[data-place]').forEach(b => b.onclick = () => {
  placing = b.dataset.place;
  document.querySelectorAll('[data-place]').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#placemsg').textContent = 'Click the PDF, or focus a page and press Enter';
});

async function save(silent) {
  const { response: r, data: d } = await request(`/api/envelopes/${envId}/setup`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signers, fields }),
  });
  if (!r.ok) { message(d.error || 'Draft could not be saved. Your changes remain in this tab.', true); return false; }
  if (!d.ok) throw new Error('unconfirmed save');
  dirty = false;
  if (!silent) message('Draft saved. You can return to it from My envelopes.');
  return true;
}
$('#save').onclick = async () => {
  if (busy) return; controlsBusy(true);
  try { await save(false); }
  catch { message('Connection interrupted. Your changes remain in this tab. Check the saved draft before sending.', true); }
  finally { controlsBusy(false); renderSigners(); }
};

$('#adddoc').onclick = () => { if (!busy) $('#adddocfile').click(); };
$('#adddocfile').onchange = async () => {
  const file = $('#adddocfile').files[0];
  if (!file || busy) return;
  if (!file.size || file.size > 15 * 1024 * 1024 || (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')) { message('Choose a non-empty PDF up to 15 MB.', true); return; }
  controlsBusy(true);
  try {
    if (!await save(true)) return;
    const form = new FormData(); form.append('file', file); form.append('name', file.name);
    const { response: r, data: d } = await request(`/api/envelopes/${envId}/adddoc`, { method: 'POST', body: form });
    if (!r.ok) { message(d.error || 'Document could not be added.', true); return; }
    if (!d.ok) throw new Error('unconfirmed document');
    location.reload();
  } catch { message('Connection interrupted. Refresh to check whether the PDF was added before adding it again.', true); }
  finally { controlsBusy(false); renderSigners(); }
};
$('#send').onclick = async () => {
  if (busy || !editable) return;
  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    if (!signer.name.trim() || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(signer.email.trim())) {
      message(`Enter a full name and valid email for signer ${i + 1}.`, true); $('#signers').querySelector(`[data-i="${i}"][data-k="${signer.name.trim() ? 'email' : 'name'}"]`).focus(); return;
    }
    if (signer.role !== 'cc' && !fields.some(field => field.signer_index === i && ['signature', 'initials'].includes(field.type))) {
      message(`Place a signature or initials field for ${signer.name} before sending.`, true); return;
    }
  }
  controlsBusy(true); message('Saving your draft and preparing signing requests…');
  try {
    if (!await save(true)) return;
    const { response: r, data: d } = await request(`/api/envelopes/${envId}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routing: 'sequential', expireDays: +$('#expiry').value }),
    });
    if (!r.ok) { message(d.error || 'Signing request could not be completed. Refresh to check envelope status before sending again.', true); return; }
    if (!d.ok || !Array.isArray(d.signers)) throw new Error('unconfirmed send');
    const accepted = d.delivery?.accepted || 0, failed = d.delivery?.failed || 0, limited = d.delivery?.limited || 0, uncertain = d.delivery?.uncertain || 0;
    message(uncertain ? `Envelope sent. ${uncertain} email request has an unconfirmed provider result and needs review. Use the recipient link below; do not resend the email.` : limited ? `Envelope sent. ${accepted} email request accepted; ${limited} paused by delivery limits. Recipient links remain available.` : failed ? `Envelope sent. ${accepted} email request accepted; ${failed} failed. Share the recipient link below.` : accepted ? 'Envelope sent. The first signing email was accepted by the delivery service. Inbox receipt is not confirmed here.' : 'Envelope sent. Signing links are ready; email requests have not been accepted. Share the first recipient’s link below.');
    envelopeMeta = { ...envelopeMeta, status: 'sent' };
    showLinks(d.signers, envelopeMeta, senderMeta);
    $('#echip').innerHTML = '<span class="chip sent">sent</span>';
    editable = false; dirty = false;
    $('#save').style.display = 'none'; $('#send').style.display = 'none'; $('#palette').style.display = 'none'; $('#addsigner').style.display = 'none';
    renderFields();
  } catch {
    $('#send').style.display = 'none';
    state('Check the signing request', 'The connection interrupted the response. The envelope may already be sent. Refresh this document to check its status before attempting to send again.');
  } finally { controlsBusy(false); renderSigners(); }
};

function showLinks(rows, envelope, sender) {
  $('#links').style.display = '';
  $('#linkrows').innerHTML = rows.map((s, index) => {
    const isCC = s.role === 'cc';
    const queued = envelope?.status === 'sent' && envelope.routing !== 'parallel' && s.delivery_status === 'not_sent' &&
      !isCC && rows.slice(0, index).some(prior => prior.role !== 'cc' && prior.status !== 'signed');
    const deliveryChip = s.delivery_status === 'accepted' ? '<span class="chip sent">email request accepted</span>' :
      s.delivery_status === 'uncertain' ? '<span class="chip stale">email outcome needs review</span>' :
      s.delivery_status === 'sending' ? '<span class="chip stale">email request in progress</span>' :
      queued ? '<span class="chip draft">waiting for prior signer</span>' :
      (s.delivery_status === 'failed' ? '<span class="chip declined">email failed</span>' : '<span class="chip draft">email not accepted</span>');
    return `<div style="margin-bottom:12px">
      <div class="row"><b>${esc(s.name)}</b> <span class="muted small">${esc(s.email)}</span> ${isCC ? '<span class="chip">cc</span>' : ''} ${s.status === 'signed' ? '<span class="chip completed">signed</span>' : ''} ${deliveryChip}</div>
      ${s.link ? `<div class="linkbox"><input readonly value="${esc(s.link)}" class="grow mono" onclick="this.select()">
        <button class="ghost" data-copy="${esc(s.link)}">Copy</button>
</div>` : ''}
    </div>`;
  }).join('');
  if (envelope && envelope.status === 'completed')
    $('#linkrows').innerHTML += `<a class="btn" href="/api/envelopes/${envId}/final" target="_blank">Download signed PDF</a>
      <a class="btn ghost" href="/verify/${envId}" target="_blank">Verification page</a>`;
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); } catch { b.previousElementSibling.select(); toast('Select and copy this recipient link'); } });

}

init();
