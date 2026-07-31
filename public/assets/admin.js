const $ = s => document.querySelector(s);
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };
const fmt = iso => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

async function load() {
  const r = await fetch('/api/envelopes');
  if (r.status === 401) { location.href = '/admin'; return; }
  const { envelopes } = await r.json();
  const tb = $('#tbl tbody');
  tb.innerHTML = '';
  $('#empty').style.display = envelopes.length ? 'none' : 'block';
  for (const e of envelopes) {
    const tr = document.createElement('tr');
    const openBtn = `<a class="btn ghost" href="/admin/env/${e.id}">Open</a>`;
    const dlBtn = e.status === 'completed' ? ` <a class="btn ghost" href="/api/envelopes/${e.id}/final" target="_blank">Signed PDF</a>` : '';
    const voidBtn = (e.status === 'draft' || e.status === 'sent') ? ` <button class="danger" data-void="${e.id}">Void</button>` : '';
    const stale = e.status === 'sent' && (Date.now() - new Date(e.sent_at || e.created_at) > 3 * 86400e3)
      ? ' <span class="chip stale">stale</span>' : '';
    tr.innerHTML = `<td><a href="/admin/env/${e.id}">${esc(e.title)}</a></td>
      <td><span class="chip ${e.status}">${e.status}</span>${stale}</td>
      <td>${e.n_signed}/${e.n_signers}</td>
      <td class="muted">${fmt(e.created_at)}</td>
      <td style="white-space:nowrap">${openBtn}${dlBtn}${voidBtn}</td>`;
    tb.appendChild(tr);
  }
  loadTemplates();
  tb.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
    if (!confirm('Void this envelope? Signing links stop working.')) return;
    await fetch(`/api/envelopes/${b.dataset.void}/void`, { method: 'POST' });
    load();
  });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadTemplates() {
  const r = await fetch('/api/templates');
  if (!r.ok) return;
  const { templates } = await r.json();
  if (!templates.length) { $('#tplcard').style.display = 'none'; return; }
  $('#tplcard').style.display = '';
  const tb = $('#tpltbl tbody');
  tb.innerHTML = templates.map(t => `<tr><td>${esc(t.name)}</td><td>${t.pages || '—'}</td>
    <td class="muted">${fmt(t.created_at)}</td>
    <td style="white-space:nowrap"><button data-use="${t.id}">Use</button> <button class="ghost" data-deltpl="${t.id}">Delete</button></td></tr>`).join('');
  tb.querySelectorAll('[data-use]').forEach(b => b.onclick = async () => {
    const res = await fetch(`/api/templates/${b.dataset.use}/use`, { method: 'POST' });
    const d = await res.json();
    if (!res.ok) { toast(d.error || 'Failed'); return; }
    location.href = `/admin/env/${d.id}`;
  });
  tb.querySelectorAll('[data-deltpl]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this template?')) return;
    await fetch(`/api/templates/${b.dataset.deltpl}`, { method: 'DELETE' });
    loadTemplates();
  });
}

$('#create').onclick = async () => {
  const title = $('#title').value.trim();
  const file = $('#file').files[0];
  if (!title || !file) { toast('Title and a PDF are required'); return; }
  const fd = new FormData();
  fd.append('title', title);
  fd.append('file', file);
  $('#create').disabled = true;
  const r = await fetch('/api/envelopes', { method: 'POST', body: fd });
  const d = await r.json();
  $('#create').disabled = false;
  if (!r.ok) { toast(d.error || 'Upload failed'); return; }
  location.href = `/admin/env/${d.id}`;
};
$('#logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/admin'; };
load();
