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

async function init() {
  const r = await fetch(`/api/envelopes/${envId}`);
  if (r.status === 401) { location.href = location.pathname.startsWith('/admin') ? '/admin' : '/'; return; }
  const d = await r.json();
  const e = d.envelope;
  editable = e.status === 'draft';
  $('#etitle').textContent = e.title;
  $('#echip').innerHTML = `<span class="chip ${e.status}">${e.status}</span>`;
  signers = d.signers.map(s => ({ name: s.name, email: s.email }));
  const idToIndex = Object.fromEntries(d.signers.map((s, i) => [s.id, i]));
  fields = d.fields.map(f => ({ signer_index: idToIndex[f.signer_id] ?? 0, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h }));
  if (!signers.length && editable) signers.push({ name: '', email: '' });

  if (editable) { $('#save').style.display = ''; $('#send').style.display = ''; $('#palette').style.display = ''; }
  else $('#addsigner').style.display = 'none';

  if (d.signers.some(s => s.link)) showLinks(d.signers.map(s => ({ name: s.name, email: s.email, link: s.link, status: s.status })), e);
  renderSigners();
  await renderPdf();
  renderFields();
}

function renderSigners() {
  const box = $('#signers');
  box.innerHTML = '';
  signers.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '8px';
    row.innerHTML = `<span class="chip ${'s' + (i % 4) === 's0' ? '' : ''}" style="border-color:currentColor;color:${['#c9a227','#4f8ff7','#3ecf8e','#e46f6f'][i % 4]}">${i + 1}</span>
      <input placeholder="Full name" value="${esc(s.name)}" data-i="${i}" data-k="name" class="grow" ${editable ? '' : 'disabled'}>
      <input placeholder="email@domain.com" value="${esc(s.email)}" data-i="${i}" data-k="email" class="grow" ${editable ? '' : 'disabled'}>
      ${editable && signers.length > 1 ? `<button class="ghost" data-rm="${i}">×</button>` : ''}`;
    box.appendChild(row);
  });
  box.querySelectorAll('input').forEach(inp => inp.oninput = () => { signers[inp.dataset.i][inp.dataset.k] = inp.value; syncWhofor(); });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    const i = +b.dataset.rm;
    fields = fields.filter(f => f.signer_index !== i).map(f => ({ ...f, signer_index: f.signer_index > i ? f.signer_index - 1 : f.signer_index }));
    signers.splice(i, 1);
    renderSigners(); renderFields();
  });
  syncWhofor();
}
function syncWhofor() {
  const sel = $('#whofor');
  const cur = sel.value;
  sel.innerHTML = signers.map((s, i) => `<option value="${i}">${esc(s.name || 'Signer ' + (i + 1))}</option>`).join('');
  if (cur && +cur < signers.length) sel.value = cur;
}
$('#addsigner').onclick = () => { signers.push({ name: '', email: '' }); renderSigners(); };

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
    box.append(canvas, overlay);
    container.appendChild(box);
    pageEls.push({ overlay, W: vp.width, H: vp.height });
    const ctx = canvas.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    overlay.addEventListener('pointerdown', ev => {
      if (!placing || ev.target !== overlay) return;
      const rect = overlay.getBoundingClientRect();
      const [dw, dh] = DEFAULTS[placing];
      const f = {
        signer_index: +$('#whofor').value || 0, type: placing, page: pageEls.indexOf(pageEls.find(pe => pe.overlay === overlay)),
        x: Math.max(0, (ev.clientX - rect.left) / rect.width - dw / 2),
        y: Math.max(0, (ev.clientY - rect.top) / rect.height - dh / 2),
        w: dw, h: dh,
      };
      fields.push(f);
      placing = null; $('#placemsg').textContent = '';
      document.querySelectorAll('[data-place]').forEach(b => b.classList.remove('on'));
      renderFields();
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
    el.querySelector('.del').onclick = () => { fields.splice(idx, 1); renderFields(); };
    // drag to move
    el.addEventListener('pointerdown', ev => {
      if (ev.target.classList.contains('del')) return;
      ev.preventDefault();
      const resizing = ev.target.classList.contains('rsz');
      el.setPointerCapture(ev.pointerId);
      const start = { x: ev.clientX, y: ev.clientY, fx: f.x, fy: f.y, fw: f.w, fh: f.h };
      const move = e2 => {
        const dx = (e2.clientX - start.x) / pe.W, dy = (e2.clientY - start.y) / pe.H;
        if (resizing) {
          f.w = Math.max(0.02, start.fw + dx);
          f.h = Math.max(0.012, start.fh + dy);
        } else {
          f.x = Math.min(Math.max(0, start.fx + dx), 1 - f.w);
          f.y = Math.min(Math.max(0, start.fy + dy), 1 - f.h);
        }
        Object.assign(el.style, { left: f.x * pe.W + 'px', top: f.y * pe.H + 'px', width: f.w * pe.W + 'px', height: f.h * pe.H + 'px' });
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  });
}

document.querySelectorAll('[data-place]').forEach(b => b.onclick = () => {
  placing = b.dataset.place;
  document.querySelectorAll('[data-place]').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#placemsg').textContent = 'now click the document where it goes';
});

async function save(silent) {
  const r = await fetch(`/api/envelopes/${envId}/setup`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signers, fields }),
  });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Save failed'); return false; }
  if (!silent) toast('Saved');
  return true;
}
$('#save').onclick = () => save(false);

$('#send').onclick = async () => {
  if (!await save(true)) return;
  const r = await fetch(`/api/envelopes/${envId}/send`, { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Send failed'); return; }
  toast('Envelope sent — links ready');
  showLinks(d.signers.map(s => ({ ...s, status: 'pending' })));
  $('#echip').innerHTML = '<span class="chip sent">sent</span>';
  editable = false;
  $('#save').style.display = 'none'; $('#send').style.display = 'none'; $('#palette').style.display = 'none';
  renderSigners(); renderFields();
};

function showLinks(rows, envelope) {
  $('#links').style.display = '';
  $('#linkrows').innerHTML = rows.map(s => `
    <div style="margin-bottom:12px">
      <div class="row"><b>${esc(s.name)}</b> <span class="muted small">${esc(s.email)}</span> ${s.status === 'signed' ? '<span class="chip completed">signed</span>' : ''}</div>
      ${s.link ? `<div class="linkbox"><input readonly value="${esc(s.link)}" class="grow mono" onclick="this.select()">
        <button class="ghost" data-copy="${esc(s.link)}">Copy</button>
        <a class="btn ghost" href="mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent('Signature requested: ' + document.title.replace('BL Sign — ', ''))}&body=${encodeURIComponent(`Hi ${s.name.split(' ')[0]},\n\nPlease review and sign here:\n${s.link}\n\n— Michael\nBlack Label Technologies`)}">Email</a></div>` : ''}
    </div>`).join('');
  if (envelope && envelope.status === 'completed')
    $('#linkrows').innerHTML += `<a class="btn" href="/api/envelopes/${envId}/final" target="_blank">Download signed PDF</a>
      <a class="btn ghost" href="/verify/${envId}" target="_blank">Verification page</a>`;
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); });
}

init();
