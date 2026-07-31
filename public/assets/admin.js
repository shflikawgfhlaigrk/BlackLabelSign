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
    tr.innerHTML = `<td><a href="/admin/env/${e.id}">${esc(e.title)}</a></td>
      <td><span class="chip ${e.status}">${e.status}</span></td>
      <td>${e.n_signed}/${e.n_signers}</td>
      <td class="muted">${fmt(e.created_at)}</td>
      <td style="white-space:nowrap">${openBtn}${dlBtn}${voidBtn}</td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
    if (!confirm('Void this envelope? Signing links stop working.')) return;
    await fetch(`/api/envelopes/${b.dataset.void}/void`, { method: 'POST' });
    load();
  });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
