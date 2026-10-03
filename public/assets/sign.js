import * as pdfjsLib from '/assets/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };
const token = location.pathname.split('/').pop();

let session, pageEls = [], values = {}, activeSigField = null;
let authBusy = false, completing = false;
function message(text, error = false) {
  $('#sign-message').textContent = text; $('#sign-message').hidden = !text;
  $('#sign-message').classList.toggle('error', error);
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
const refreshButton = '<div class="row"><button type="button" data-refresh>Check document status</button></div>';
function failureText(response, body, fallback) {
  if (response.status >= 500) return 'This step is temporarily unavailable. Your document remains saved. Please try again later.';
  if (response.status === 429) return body.error || 'Too many attempts. Wait before requesting another code.';
  return body.error || fallback;
}
function authControls(value) {
  authBusy = value; $('#sendcode').disabled = value; $('#verifycode').disabled = value;
  $('#authcard').setAttribute('aria-busy', String(value));
}

function statusCard(html) {
  const card = $('#statuscard'); card.style.display = ''; card.innerHTML = html; message('');
  card.querySelectorAll('[data-refresh]').forEach(button => button.onclick = () => location.reload());
  card.querySelectorAll('[data-download]').forEach(link => link.onclick = event => downloadDocument(event, link));
}
async function downloadDocument(event, link) {
  event.preventDefault(); if (link.dataset.busy) return; link.dataset.busy = 'true'; message('Preparing your signed PDF…');
  try {
    const response = await fetch(link.href, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) { message(response.status === 401 ? 'Verify your email again to download. Refresh this recipient link to continue.' : 'The signed PDF is unavailable right now. Check document status and try the download again.', true); return; }
    const blob = await response.blob();
    if (!response.headers.get('content-type')?.includes('application/pdf') || !(await blob.slice(0, 5).text()).startsWith('%PDF-')) throw new Error('invalid document');
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${session?.title || 'document'}-signed.pdf`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000); message('Signed PDF downloaded. Keep this recipient link to return to your copy.');
  } catch { message('Connection interrupted. Check your connection, then download your signed PDF again.', true); }
  finally { delete link.dataset.busy; }
}

function showEmailAuth(d) {
  $('#authcard').style.display = '';
  $('#authintro').textContent = `Send a one-time code to ${d.maskedEmail} to securely open this document.`;
  const send = $('#sendcode');
  const requestCode = async () => {
    if (authBusy) return; authControls(true); message('');
    $('#authmsg').textContent = 'Requesting your verification code…';
    try {
      const { response, data: body } = await request(`/api/session/${token}/auth-request`, { method: 'POST' });
      if (!response.ok || !body.codeSent) { $('#authmsg').textContent = failureText(response, body, 'Could not request a verification code.'); return; }
      $('#authentry').style.display = ''; $('#authcode').value = ''; $('#authcode').focus();
      send.textContent = 'Request a new code';
      $('#authmsg').textContent = `Code request accepted for ${body.maskedEmail}. Check your inbox and spam folder. Use the newest code within 10 minutes.`;
    } catch { $('#authmsg').textContent = 'Connection interrupted. Check your inbox before requesting another code.'; }
    finally { authControls(false); }
  };
  send.onclick = requestCode;
  $('#verifycode').onclick = async () => {
    if (authBusy) return;
    const code = $('#authcode').value.trim();
    if (!/^\d{6}$/.test(code)) { $('#authmsg').textContent = 'Enter the six-digit code from your newest email.'; $('#authcode').focus(); return; }
    authControls(true); $('#authmsg').textContent = 'Confirming your code…';
    try {
      const { response, data: body } = await request(`/api/session/${token}/auth-verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      });
      if (!response.ok || !body.authenticated) { $('#authmsg').textContent = failureText(response, body, 'That code is invalid, expired, or already used. Request a new code.'); return; }
      location.reload();
    } catch { $('#authmsg').textContent = 'Connection interrupted. Refresh this link to check whether verification succeeded before requesting another code.'; }
    finally { authControls(false); }
  };
  $('#authcode').onkeydown = event => { if (event.key === 'Enter') $('#verifycode').click(); };
}

async function init() {
  try {
  const { response: r, data: d } = await request(`/api/session/${token}`);
  if (!r.ok || !d.signer) {
    statusCard(r.status === 404 || r.status === 410 ? '<h1>This signing link is unavailable</h1><p class="muted">The link is invalid, expired, or belongs to a deleted envelope. Ask the sender for the correct recipient link.</p>' : `<h1>Document could not be opened</h1><p class="muted">Check your connection and try opening this same recipient link again.</p>${refreshButton}`); return;
  }
  message('');
  session = d;
  $('#who').textContent = `${d.signer.name} · ${d.signer.email}`;

  if (d.authRequired) { showEmailAuth(d); return; }

  if (d.status === 'voided') { statusCard('<h1>This envelope was voided</h1><p class="muted">Contact the sender if you believe this is an error.</p>'); return; }
  if (d.status === 'declined') { statusCard('<h1>Envelope declined</h1><p class="muted">A recipient declined to sign, which closed this envelope. Contact the sender to restart.</p>'); return; }
  if (d.status === 'expired') { statusCard('<h1>Envelope expired</h1><p class="muted">The signing window for this document has passed. Contact the sender to reissue it.</p>'); return; }
  if (d.status === 'completed') {
    statusCard(`<h1>✓ Completed</h1><p class="muted" style="margin:8px 0 14px">Everyone has signed “${esc(d.title)}”.</p>
      <a class="btn" href="/api/session/${token}/download" data-download>Download signed PDF</a>`);
    return;
  }
  if (d.viewer) {
    $('#finish').style.display = 'none';
    $('#dsub').textContent = "You're receiving a copy (CC) — no signature required. This link becomes your download once everyone signs.";
    await showDoc();
    return;
  }
  if (d.finalizationError) {
    statusCard('<h1>Signed PDF needs attention</h1><p class="muted">Your recorded signature remains saved, but the completed PDF could not be prepared. Contact the sender to review this envelope.</p>' + refreshButton); return;
  }
  if (d.sealing) {
    statusCard('<h1>Signature recorded</h1><p class="muted">Everyone has signed. BL Sign is preparing the completed PDF. Check this same link shortly for your copy.</p>' + refreshButton); return;
  }
  if (d.signer.status === 'signed') {
    statusCard(`<h1>✓ You've signed</h1><p class="muted">Waiting on ${esc(d.waitingOn || 'other signers')}. You'll be able to download the completed PDF from this link once everyone signs.</p>${refreshButton}`);
    return;
  }
  if (!d.myTurn) {
    statusCard(`<h1>Not your turn yet</h1><p class="muted">Waiting on ${esc(d.waitingOn || 'a prior signer')} to sign first. Check back later — this link will activate after the prior signer finishes.</p>${refreshButton}`);
    return;
  }
  if (!d.signer.consented) {
    $('#ctitle').textContent = d.title;
    $('#csender').textContent = 'Sent by ' + d.sender;
    $('#consentcard').style.display = '';
    $('#agree').onchange = e => $('#continue').disabled = !e.target.checked;
    $('#continue').onclick = async () => {
      if ($('#continue').disabled) return; $('#continue').disabled = true;
      try {
        const { response, data } = await request(`/api/session/${token}/consent`, { method: 'POST' });
        if (!response.ok || !data.ok) { message(failureText(response, data, 'Consent could not be recorded. Refresh this link to check its status.'), true); return; }
        $('#consentcard').style.display = 'none'; await showDoc();
      } catch { message('Connection interrupted. Refresh this recipient link to check whether consent was recorded.', true); }
      finally { $('#continue').disabled = !$('#agree').checked; }
    };
  } else await showDoc();
  } catch { statusCard(`<h1>Document could not be opened</h1><p class="muted">Check your connection and reopen this same recipient link. No account is required.</p>${refreshButton}`); }

}

async function showDoc() {
  try {
  $('#statuscard').style.display = 'none';
  message('Loading your PDF…');
  $('#doccard').style.display = '';
  $('#dtitle').textContent = session.title;
  if (session.expiresAt) $('#dsub').textContent += ` Expires ${new Date(session.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`;
  const doc = await pdfjsLib.getDocument({ url: `/api/session/${token}/pdf` }).promise;
  const container = $('#pages');
  container.innerHTML = ''; pageEls = [];
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
  message('Your unfinished fields stay in this tab until you finish. Reopening the link preserves verified access and recorded consent; fill unfinished fields again.');
  } catch { $('#doccard').style.display = 'none'; statusCard(`<h1>PDF could not be opened</h1><p class="muted">Your recorded consent remains saved. Refresh this recipient link to check access and load the document again.</p>${refreshButton}`); }
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
        el.setAttribute('aria-checked', on ? 'true' : 'false'); checkDone();
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
  $('#finish').disabled = completing || !ok;
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
$('#tabtype').onclick = () => { mode = 'type'; $('#tabtype').classList.add('on'); $('#tabdraw').classList.remove('on'); $('#typename').style.display = ''; $('#typename').value = activeSigField?.type === 'initials' ? session.signer.name.split(/\s+/).map(part => part[0]).join('') : session.signer.name; typeToPad(); $('#typename').focus(); };
$('#sigclear').onclick = () => { clearPad(); if (mode === 'type') $('#typename').value = ''; };
$('#sigcancel').onclick = () => $('#sigmodal').classList.remove('show');

function closeSig() { $('#sigmodal').classList.remove('show'); $('#f_' + activeSigField?.id)?.focus(); }
function openSig(f) {
  activeSigField = f; $('#tabdraw').click();
  $('#typename').placeholder = f.type === 'initials' ? 'Type your initials' : 'Type your full name';
  $('#typename').setAttribute('aria-label', f.type === 'initials' ? 'Your initials' : 'Name for your signature');
  $('#sigmodal').classList.add('show'); $('#tabdraw').focus();
}
$('#sigcancel').onclick = closeSig;
$('#sigmodal').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeSig(); }
  if (event.key === 'Tab') {
    const controls = [...$('#sigmodal').querySelectorAll('button,input')].filter(control => control.offsetParent !== null);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

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
  closeSig();
  checkDone();
};

$('#finish').onclick = async () => {
  if (completing || $('#finish').disabled) return;
  completing = true; checkDone(); message('Recording your signature…');
  try {
    const { response: r, data: d } = await request(`/api/session/${token}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }),
    });
    if (!r.ok) {
      message(failureText(r, d, 'Signing could not be completed. Your unfinished fields remain in this tab.'), true);
      if ([401, 409, 410].includes(r.status)) { $('#doccard').style.display = 'none'; statusCard(`<h1>Check this recipient link</h1><p class="muted">Your verified access may have expired, or this envelope may already be signed or closed. Refresh this link to check its current status before continuing.</p>${refreshButton}`); }
      return;
    }
    if (!d.ok) throw new Error('unconfirmed signature');
    $('#doccard').style.display = 'none';
    if (d.completed)
      statusCard(`<h1>Everyone has signed</h1><p class="muted" style="margin:8px 0 14px">Your signed PDF and completion certificate are ready. Keep this recipient link to return to your copy.</p><a class="btn" href="/api/session/${token}/download" data-download>Download signed PDF</a>`);
    else if (d.sealing)
      statusCard(`<h1>Signature recorded</h1><p class="muted">Everyone has signed. The completed PDF is still being prepared. Check this same recipient link shortly for your copy.</p>${refreshButton}`);
    else
      statusCard(`<h1>Your signature is recorded</h1><p class="muted">${esc(d.next || 'The next recipient')} signs next. Once everyone has signed, this same link lets you download the completed PDF.</p>${d.nextDelivery?.state === 'failed' || d.nextDelivery?.state === 'uncertain' || d.nextDelivery?.state === 'limited' ? '<p class="muted" style="margin-top:12px">The next signing email needs sender attention. Your signature remains saved.</p>' : ''}${refreshButton}`);
  } catch {
    $('#doccard').style.display = 'none';
    statusCard(`<h1>Check whether your signature was recorded</h1><p class="muted">The connection interrupted the response. Refresh this recipient link to see the saved result before attempting to sign again.</p>${refreshButton}`);
  } finally { completing = false; checkDone(); }
};

init();
