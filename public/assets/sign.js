import * as pdfjsLib from '/assets/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };
const token = location.pathname.split('/').pop();

let session, pageEls = [], values = {}, activeSigField = null;

function statusCard(html) { const c = $('#statuscard'); c.style.display = ''; c.innerHTML = html; }

function showEmailAuth(d) {
  $('#authcard').style.display = '';
  $('#authintro').textContent = `Send a one-time code to ${d.maskedEmail} to securely open this document.`;
  const message = $('#authmsg');
  const send = $('#sendcode');
  const requestCode = async () => {
    send.disabled = true;
    message.textContent = 'Sending code...';
    const response = await fetch(`/api/session/${token}/auth-request`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) {
      message.textContent = body.error || 'Could not send the verification code.';
      send.disabled = false;
      return;
    }
    $('#authentry').style.display = '';
    $('#authcode').focus();
    send.textContent = 'Send another code';
    send.disabled = false;
    message.textContent = `Code sent to ${body.maskedEmail}. It expires in 10 minutes.`;
  };
  send.onclick = requestCode;
  $('#verifycode').onclick = async () => {
    const code = $('#authcode').value.trim();
    if (!/^\d{6}$/.test(code)) { message.textContent = 'Enter the six-digit code.'; return; }
    $('#verifycode').disabled = true;
    const response = await fetch(`/api/session/${token}/auth-verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const body = await response.json();
    if (!response.ok) {
      message.textContent = body.error || 'Verification failed.';
      $('#verifycode').disabled = false;
      return;
    }
    location.reload();
  };
  $('#authcode').onkeydown = event => { if (event.key === 'Enter') $('#verifycode').click(); };
}

async function init() {
  const r = await fetch(`/api/session/${token}`);
  const d = await r.json();
  if (!r.ok) { statusCard(`<h1>Link not valid</h1><p class="muted">${esc(d.error || '')}</p>`); return; }
  session = d;
  $('#who').textContent = `${d.signer.name} · ${d.signer.email}`;

  if (d.authRequired) { showEmailAuth(d); return; }

  if (d.status === 'voided') { statusCard('<h1>This envelope was voided</h1><p class="muted">Contact the sender if you believe this is an error.</p>'); return; }
  if (d.status === 'declined') { statusCard('<h1>Envelope declined</h1><p class="muted">A recipient declined to sign, which closed this envelope. Contact the sender to restart.</p>'); return; }
  if (d.status === 'expired') { statusCard('<h1>Envelope expired</h1><p class="muted">The signing window for this document has passed. Contact the sender to reissue it.</p>'); return; }
  if (d.status === 'completed') {
    statusCard(`<h1>✓ Completed</h1><p class="muted" style="margin:8px 0 14px">Everyone has signed “${esc(d.title)}”.</p>
      <a class="btn" href="/api/session/${token}/download">Download signed PDF</a>`);
    return;
  }
  if (d.viewer) {
    $('#decline').style.display = 'none';
    $('#finish').style.display = 'none';
    $('#dsub').textContent = "You're receiving a copy (CC) — no signature required. This link becomes your download once everyone signs.";
    showDoc();
    return;
  }
  if (d.signer.status === 'signed') {
    statusCard(`<h1>✓ You've signed</h1><p class="muted">Waiting on ${esc(d.waitingOn || 'other signers')}. You'll be able to download the completed PDF from this link once everyone signs.</p>`);
    return;
  }
  if (!d.myTurn) {
    statusCard(`<h1>Not your turn yet</h1><p class="muted">Waiting on ${esc(d.waitingOn || 'a prior signer')} to sign first. Check back later — this link will activate automatically.</p>`);
    return;
  }
  if (!d.signer.consented) {
    $('#ctitle').textContent = d.title;
    $('#csender').textContent = 'Sent by ' + d.sender;
    $('#consentcard').style.display = '';
    $('#agree').onchange = e => $('#continue').disabled = !e.target.checked;
    $('#continue').onclick = async () => {
      const cr = await fetch(`/api/session/${token}/consent`, { method: 'POST' });
      if (!cr.ok) { toast('Could not record consent'); return; }
      $('#consentcard').style.display = 'none';
      showDoc();
    };
  } else showDoc();
}

async function showDoc() {
  $('#doccard').style.display = '';
  $('#dtitle').textContent = session.title;
  if (session.expiresAt) $('#dsub').textContent += ` Expires ${new Date(session.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`;
  const doc = await pdfjsLib.getDocument({ url: `/api/session/${token}/pdf` }).promise;
  const container = $('#pages');
  const maxW = Math.min(860, container.clientWidth || 860);
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: maxW / base.width });
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
  }
  renderMyFields();
}

function renderMyFields() {
  for (const f of session.fields) {
    const pe = pageEls[f.page];
    if (!pe) continue;
    const el = document.createElement('div');
    el.className = 'sfld';
    el.id = 'f_' + f.id;
    Object.assign(el.style, { left: f.x * pe.W + 'px', top: f.y * pe.H + 'px', width: f.w * pe.W + 'px', height: f.h * pe.H + 'px' });
    if (f.type === 'signature' || f.type === 'initials') {
      el.innerHTML = `<span class="hint">${f.type === 'initials' ? 'Initial' : '✍ Sign'} here</span>`;
      el.onclick = () => openSig(f);
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', f.type === 'initials' ? 'Add initials' : 'Add signature');
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSig(f); } };
    } else if (f.type === 'date') {
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      el.innerHTML = `<input value="${today}">`;
      el.querySelector('input').setAttribute('aria-label', 'Signing date');
      values[f.id] = { v: today };
      el.querySelector('input').oninput = e => { values[f.id] = { v: e.target.value }; checkDone(); };
    } else if (f.type === 'text') {
      el.innerHTML = `<input placeholder="...">`;
      el.querySelector('input').setAttribute('aria-label', 'Required text');
      el.querySelector('input').oninput = e => { values[f.id] = { v: e.target.value }; checkDone(); };
    } else if (f.type === 'checkbox') {
      el.innerHTML = `<span class="hint"></span>`;
      el.tabIndex = 0;
      el.setAttribute('role', 'checkbox');
      el.setAttribute('aria-label', 'Checkbox');
      el.setAttribute('aria-checked', 'false');
      const toggleCheckbox = () => {
        const on = !(values[f.id] && values[f.id].v);
        values[f.id] = { v: on ? '1' : '' };
        el.querySelector('.hint').textContent = on ? '✕' : '';
        el.classList.toggle('done', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
      };
      el.onclick = toggleCheckbox;
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCheckbox(); } };
    }
    pe.overlay.appendChild(el);
  }
  checkDone();
}

function checkDone() {
  const ok = session.fields.every(f => {
    if (!f.required) return true;
    const v = values[f.id];
    if (f.type === 'signature' || f.type === 'initials') return v && v.png;
    return v && String(v.v || '').trim();
  });
  $('#finish').disabled = !ok;
}

// ---- signature modal ----
const pad = $('#sigpad');
const pctx = pad.getContext('2d');
let drawing = false, drew = false, last = null, mode = 'draw';
pctx.lineWidth = 5; pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.strokeStyle = '#101040';

function padPos(e) {
  const r = pad.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (pad.width / r.width), y: (e.clientY - r.top) * (pad.height / r.height) };
}
pad.addEventListener('pointerdown', e => { if (mode !== 'draw') return; drawing = true; drew = true; last = padPos(e); pad.setPointerCapture(e.pointerId); });
pad.addEventListener('pointermove', e => {
  if (!drawing) return;
  const p = padPos(e);
  pctx.beginPath();
  pctx.moveTo(last.x, last.y);
  pctx.quadraticCurveTo(last.x, last.y, (p.x + last.x) / 2, (p.y + last.y) / 2);
  pctx.lineTo(p.x, p.y);
  pctx.stroke();
  last = p;
});
pad.addEventListener('pointerup', () => drawing = false);

function clearPad() { pctx.clearRect(0, 0, pad.width, pad.height); drew = false; }
function typeToPad() {
  clearPad();
  const name = $('#typename').value.trim();
  if (!name) return;
  pctx.save();
  pctx.fillStyle = '#101040';
  pctx.font = 'italic 110px "Snell Roundhand","Savoye LET","Brush Script MT",cursive';
  pctx.textBaseline = 'middle';
  const w = pctx.measureText(name).width;
  const scale = Math.min(1, (pad.width - 80) / w);
  pctx.translate(40, pad.height / 2);
  pctx.scale(scale, scale);
  pctx.fillText(name, 0, 0);
  pctx.restore();
  drew = true;
}
$('#typename').oninput = typeToPad;
$('#tabdraw').onclick = () => { mode = 'draw'; $('#tabdraw').classList.add('on'); $('#tabtype').classList.remove('on'); $('#typename').style.display = 'none'; clearPad(); };
$('#tabtype').onclick = () => { mode = 'type'; $('#tabtype').classList.add('on'); $('#tabdraw').classList.remove('on'); $('#typename').style.display = ''; $('#typename').value = session.signer.name; typeToPad(); $('#typename').focus(); };
$('#sigclear').onclick = () => { clearPad(); if (mode === 'type') $('#typename').value = ''; };
$('#sigcancel').onclick = () => $('#sigmodal').classList.remove('show');

function openSig(f) { activeSigField = f; clearPad(); $('#sigmodal').classList.add('show'); }

$('#sigadopt').onclick = () => {
  if (!drew) { toast('Draw or type your signature first'); return; }
  // trim to ink bounding box
  const img = pctx.getImageData(0, 0, pad.width, pad.height);
  let minX = pad.width, minY = pad.height, maxX = 0, maxY = 0;
  for (let y = 0; y < pad.height; y++)
    for (let x = 0; x < pad.width; x++)
      if (img.data[(y * pad.width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
  if (maxX <= minX) { toast('Draw or type your signature first'); return; }
  const c = document.createElement('canvas');
  const padPx = 8;
  c.width = maxX - minX + padPx * 2; c.height = maxY - minY + padPx * 2;
  c.getContext('2d').drawImage(pad, minX - padPx, minY - padPx, c.width, c.height, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/png');
  values[activeSigField.id] = { png: dataUrl };
  const el = $('#f_' + activeSigField.id);
  el.innerHTML = `<img src="${dataUrl}" alt="signature">`;
  el.classList.add('done');
  $('#sigmodal').classList.remove('show');
  checkDone();
};

$('#decline').onclick = async () => {
  const reason = prompt('Decline to sign — tell the sender why (optional):');
  if (reason === null) return;
  if (!confirm('Decline this envelope? This closes it for all recipients.')) return;
  const r = await fetch(`/api/session/${token}/decline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Failed'); return; }
  $('#doccard').style.display = 'none';
  statusCard('<h1>Declined</h1><p class="muted">Your decision was recorded in the envelope audit log. Nothing was signed.</p>');
};
$('#finish').onclick = async () => {
  $('#finish').disabled = true;
  const r = await fetch(`/api/session/${token}/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Failed'); $('#finish').disabled = false; return; }
  $('#doccard').style.display = 'none';
  const upsell = `<p class="muted small" style="margin-top:18px">Signed free with <a href="/">BL Sign</a> — send your own documents at
    <a href="/">sign.blacklabeltec.com</a>. Custom tools for your business: <a href="https://blacklabeltec.com">blacklabeltec.com</a></p>`;
  if (d.completed)
    statusCard(`<h1>✓ All done</h1><p class="muted" style="margin:8px 0 14px">Everyone has signed. Your copy is ready.</p>
      <a class="btn" href="/api/session/${token}/download">Download signed PDF</a>${upsell}`);
  else if (d.sealing)
    statusCard(`<h1>✓ Signature recorded</h1><p class="muted">The completed PDF is still being sealed. Reopen this recipient link shortly to download it.</p>${upsell}`);
  else
    statusCard(`<h1>✓ Signed</h1><p class="muted">Thanks — ${esc(d.next)} signs next. Once everyone has signed, this same link lets you download the completed PDF.</p>${upsell}`);
};

init();
