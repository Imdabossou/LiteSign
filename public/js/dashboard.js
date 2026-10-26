import { api, escapeHtml, toast, requireLogin, bindLogout, fmtDate } from './common.js';

const STATUS_LABELS = { draft: 'Draft', pending: 'Out for signing', completed: 'Completed', voided: 'Cancelled' };
let docs = [];
let filter = 'all';

function render() {
  const el = document.getElementById('docList');
  const shown = filter === 'all' ? docs : docs.filter(d => d.status === filter);
  if (docs.length === 0) { el.innerHTML = '<div class="empty">No documents yet. Upload one above.</div>'; return; }
  if (shown.length === 0) { el.innerHTML = '<div class="empty">Nothing here.</div>'; return; }
  el.innerHTML = shown.map(d => {
    const signed = d.signers.filter(s => s.status === 'signed').length;
    const progress = d.signers.length ? `${signed} of ${d.signers.length} signed` : 'No signers yet';
    const when = d.status === 'completed' ? `Completed ${fmtDate(d.completed_at)}` : `Created ${fmtDate(d.created_at)}`;
    const who = d.signers.map(s => `<span class="who ${s.status}">${escapeHtml(s.name)}</span>`).join('');
    return `
      <div class="doc-row">
        <a class="doc-main" href="/editor.html?doc=${encodeURIComponent(d.id)}">
          <div class="doc-title">${escapeHtml(d.title)}</div>
          <div class="doc-meta"><span class="badge ${d.status}">${STATUS_LABELS[d.status] || d.status}</span> ${progress} · ${when}</div>
          ${who ? `<div class="doc-signers">${who}</div>` : ''}
        </a>
        <div class="doc-actions">
          ${d.status === 'completed' ? `<a class="btn secondary small-btn" href="/api/documents/${encodeURIComponent(d.id)}/download">Download</a>` : ''}
          <button class="btn ghost-danger small-btn" data-delete="${escapeHtml(d.id)}" data-title="${escapeHtml(d.title)}">Delete</button>
        </div>
      </div>`;
  }).join('');
}

async function load() {
  try {
    docs = await api('GET', '/api/documents');
    render();
  } catch (e) {
    document.getElementById('docList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById('docList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  if (!confirm(`Delete "${btn.dataset.title}" permanently? This removes the PDF, signatures and audit log.`)) return;
  try {
    await api('DELETE', `/api/documents/${encodeURIComponent(btn.dataset.delete)}`);
    toast('Document deleted');
    load();
  } catch (ex) { toast(ex.message, 'error'); }
});

document.getElementById('filters').addEventListener('click', e => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  filter = chip.dataset.filter;
  document.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('active', c === chip));
  render();
});

// Upload, with drag and drop onto the drop zone.
const fileInput = document.getElementById('file');
const dropzone = document.getElementById('dropzone');
function showFile() {
  const f = fileInput.files[0];
  document.getElementById('dropText').innerHTML = f ? `<strong>${escapeHtml(f.name)}</strong> (${(f.size / 1048576).toFixed(1)} MB)` : '<strong>Choose a PDF</strong> or drag it here';
  dropzone.classList.toggle('has-file', !!f);
}
fileInput.addEventListener('change', showFile);
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, () => dropzone.classList.remove('drag')));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; showFile(); }
});

document.getElementById('uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('uploadErr');
  const btn = document.getElementById('uploadBtn');
  errEl.textContent = '';
  const file = fileInput.files[0];
  if (!file) { errEl.textContent = 'Please choose a PDF file.'; return; }
  const fd = new FormData();
  fd.append('title', document.getElementById('title').value.trim());
  fd.append('file', file);
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const data = await api('POST', '/api/documents', fd);
    window.location.href = `/editor.html?doc=${encodeURIComponent(data.id)}`;
  } catch (ex) {
    errEl.textContent = ex.message;
    btn.disabled = false;
    btn.textContent = 'Upload & set up signing';
  }
});

bindLogout();
requireLogin().then(load);
