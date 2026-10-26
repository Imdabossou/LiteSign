import { api, escapeHtml, toast, requireLogin, bindLogout, copyText, signerColor, FIELD_LABELS, fmtDate } from './common.js';
import { renderPdf, placeBox } from './pdfview.js';

const docId = new URLSearchParams(window.location.search).get('doc');
let doc = null;
let pages = [];
let activeSignerId = null;
let placeType = null;

const DEFAULT_SIZES = {
  signature: { width: 0.24, height: 0.055 },
  initials: { width: 0.09, height: 0.05 },
  text: { width: 0.24, height: 0.035 },
  date: { width: 0.15, height: 0.035 }
};

const AUDIT_LABELS = {
  document_created: 'Uploaded',
  document_sent: 'Sent for signing',
  email_sent: 'Email sent',
  email_resent: 'Email resent',
  email_failed: 'Email failed',
  signer_viewed: 'Opened by',
  signer_consented: 'Consent given',
  signer_signed: 'Signed by',
  document_completed: 'Completed',
  completion_failed: 'Completion failed',
  completion_email_sent: 'Signed copy emailed to',
  completion_email_failed: 'Signed copy email failed',
  document_voided: 'Cancelled'
};

const $ = id => document.getElementById(id);
const isDraft = () => doc.status === 'draft';
const signerIndex = id => doc.signers.findIndex(s => s.id === id);

async function load() {
  try {
    doc = await api('GET', `/api/documents/${encodeURIComponent(docId)}`);
  } catch (e) {
    $('canvasWrap').innerHTML = `<div class="empty">${escapeHtml(e.status === 404 ? 'Document not found.' : e.message)}</div>`;
    return;
  }
  document.title = `${doc.title} — LiteSign`;
  $('docTitleTop').textContent = doc.title;
  if (!doc.signers.some(s => s.id === activeSignerId)) activeSignerId = doc.signers[0] ? doc.signers[0].id : null;

  $('addSignerForm').hidden = !isDraft();
  $('fieldCard').hidden = !isDraft();
  $('sendCard').hidden = !isDraft();
  $('auditCard').hidden = isDraft();
  $('smtpNotice').textContent = doc.smtpConfigured
    ? 'Signers with an email address will be emailed their link automatically.'
    : 'Email (SMTP) is not set up on the server, so you\'ll get links to send yourself.';

  renderBanner();
  renderSigners();
  renderActions();
  if (!isDraft()) loadAudit();
  if (pages.length === 0) {
    try {
      // Once complete, show the real signed PDF instead of field placeholders.
      const which = doc.status === 'completed' ? 'download' : 'file';
      pages = await renderPdf($('canvasWrap'), `/api/documents/${encodeURIComponent(docId)}/${which}`);
      pages.forEach(p => p.addEventListener('click', onPageClick));
    } catch (e) {
      $('canvasWrap').innerHTML = `<div class="empty">Could not display this PDF: ${escapeHtml(e.message)}</div>`;
      return;
    }
  }
  renderFields();
}

function renderBanner() {
  const el = $('statusBanner');
  const waiting = doc.signers.filter(s => s.status !== 'signed').length;
  if (doc.status === 'pending') {
    el.innerHTML = waiting
      ? `<div class="status-banner pending">Out for signing: waiting on ${waiting} of ${doc.signers.length} signer${doc.signers.length === 1 ? '' : 's'}.</div>`
      : '<div class="status-banner danger">Everyone has signed, but the final PDF couldn\'t be produced. Try "Retry completion" below.</div>';
  } else if (doc.status === 'completed') {
    el.innerHTML = `<div class="status-banner completed">Completed ${escapeHtml(fmtDate(doc.completed_at))}. <a href="/api/documents/${encodeURIComponent(doc.id)}/download">Download the signed PDF</a></div>`;
  } else if (doc.status === 'voided') {
    el.innerHTML = '<div class="status-banner danger">This document was cancelled. Its signing links no longer work.</div>';
  } else {
    el.innerHTML = '';
  }
}

function signerStatus(s) {
  if (s.status === 'signed') return `Signed ${fmtDate(s.signed_at)}`;
  if (isDraft()) {
    const n = doc.fields.filter(f => f.signer_id === s.id).length;
    return n ? `${n} field${n === 1 ? '' : 's'}` : 'No fields yet';
  }
  return s.viewed_at ? `Opened ${fmtDate(s.viewed_at)}` : 'Not opened yet';
}

function renderSigners() {
  const el = $('signerList');
  if (doc.signers.length === 0) { el.innerHTML = '<p class="hint">Add the people who need to sign.</p>'; return; }
  el.innerHTML = doc.signers.map((s, i) => `
    <div class="signer-chip ${isDraft() && s.id === activeSignerId ? 'active' : ''} ${isDraft() ? 'selectable' : ''}" data-select="${s.id}" style="--signer:${signerColor(i)}">
      <span class="dot"></span>
      <span class="signer-info">
        <span class="signer-name">${escapeHtml(s.name)}${s.status === 'signed' ? ' ✓' : ''}</span>
        <span class="hint">${s.email ? escapeHtml(s.email) + ' · ' : ''}${escapeHtml(signerStatus(s))}</span>
      </span>
      <span class="signer-actions">
        ${isDraft() ? `<button class="icon-btn" data-remove="${s.id}" title="Remove ${escapeHtml(s.name)}" aria-label="Remove ${escapeHtml(s.name)}">✕</button>` : ''}
        ${doc.status === 'pending' && s.status !== 'signed' ? `<button class="btn secondary small-btn" data-copy="${escapeHtml(s.url)}">Copy link</button>` : ''}
        ${doc.status === 'pending' && s.status !== 'signed' && s.email && doc.smtpConfigured ? `<button class="btn secondary small-btn" data-resend="${s.id}">Resend</button>` : ''}
      </span>
    </div>`).join('');
}

function renderActions() {
  const el = $('actions');
  const parts = [];
  if (doc.status === 'completed') {
    parts.push(`<a class="btn block" href="/api/documents/${encodeURIComponent(doc.id)}/download">Download signed PDF</a>`);
    if (doc.completed_sha256) parts.push(`<p class="hint mono">SHA-256: ${escapeHtml(doc.completed_sha256)}</p>`);
  }
  if (doc.status === 'pending') {
    if (doc.signers.every(s => s.status === 'signed')) parts.push('<button class="btn block" id="finalizeBtn">Retry completion</button>');
    parts.push('<button class="btn ghost-danger block" id="voidBtn">Cancel signing request</button>');
  }
  $('actionsCard').hidden = parts.length === 0;
  el.innerHTML = parts.join('');
}

async function loadAudit() {
  try {
    const logs = await api('GET', `/api/documents/${encodeURIComponent(docId)}/audit`);
    $('auditList').innerHTML = logs.map(l => `
      <li>
        <div><strong>${escapeHtml(AUDIT_LABELS[l.event] || l.event)}</strong> ${escapeHtml(l.detail || '')}</div>
        <div class="hint">${escapeHtml(fmtDate(l.created_at))}${l.ip ? ` · ${escapeHtml(l.ip)}` : ''}</div>
      </li>`).join('');
  } catch { /* non-essential */ }
}

// ---------- Field overlays ----------
function renderFields() {
  document.querySelectorAll('.field-box').forEach(el => el.remove());
  if (doc.status === 'completed') return;
  for (const f of doc.fields) {
    const pageEl = pages[f.page];
    if (!pageEl) continue;
    const i = signerIndex(f.signer_id);
    const signer = doc.signers[i];
    const box = document.createElement('div');
    box.className = `field-box ${isDraft() ? 'editable' : ''} ${f.filled ? 'filled' : ''}`;
    box.style.setProperty('--signer', signerColor(i));
    box.dataset.id = f.id;
    placeBox(box, f);
    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = `${f.label || FIELD_LABELS[f.type]}${signer ? ` · ${signer.name}` : ''}`;
    box.appendChild(label);
    if (isDraft()) {
      box.title = f.type === 'text' ? 'Drag to move · double-click to rename' : 'Drag to move';
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Delete field');
      const handle = document.createElement('div');
      handle.className = 'resize';
      box.append(del, handle);
      enableDrag(box, f);
    }
    pageEl.appendChild(box);
  }
}

function enableDrag(box, f) {
  box.addEventListener('pointerdown', e => {
    if (e.target.closest('.del') || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const resizing = e.target.classList.contains('resize');
    const rect = box.parentElement.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, f: { ...f } };
    let moved = false;
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');

    const onMove = ev => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
      if (resizing) {
        f.width = Math.min(1 - f.x, Math.max(0.03, start.f.width + dx));
        f.height = Math.min(1 - f.y, Math.max(0.015, start.f.height + dy));
      } else {
        f.x = Math.min(1 - f.width, Math.max(0, start.f.x + dx));
        f.y = Math.min(1 - f.height, Math.max(0, start.f.y + dy));
      }
      placeBox(box, f);
    };
    const onUp = async () => {
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      box.classList.remove('dragging');
      if (!moved) return;
      try {
        await api('PATCH', `/api/fields/${encodeURIComponent(f.id)}`, { x: f.x, y: f.y, width: f.width, height: f.height });
      } catch (ex) {
        Object.assign(f, start.f);
        placeBox(box, f);
        toast(ex.message, 'error');
      }
    };
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
  });

  box.querySelector('.del').addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await api('DELETE', `/api/fields/${encodeURIComponent(f.id)}`);
      await load();
    } catch (ex) { toast(ex.message, 'error'); }
  });

  if (f.type === 'text') {
    box.addEventListener('dblclick', async e => {
      e.stopPropagation();
      const label = prompt('Label shown to the signer (e.g. "Company name"):', f.label || '');
      if (label === null) return;
      try {
        await api('PATCH', `/api/fields/${encodeURIComponent(f.id)}`, { label });
        await load();
      } catch (ex) { toast(ex.message, 'error'); }
    });
  }
}

function setPlacing(type) {
  placeType = type;
  document.querySelectorAll('#fieldButtons [data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  $('canvasWrap').classList.toggle('placing', !!type);
  if (type) {
    const s = doc.signers.find(x => x.id === activeSignerId);
    $('fieldHint').innerHTML = `Click on the document to place a <strong>${FIELD_LABELS[type].toLowerCase()}</strong> field for <strong>${escapeHtml(s.name)}</strong>. Press Esc to stop.`;
  } else {
    $('fieldHint').textContent = 'Pick a signer above, choose a field, then click on the document to place it. Drag fields to move them; drag the corner to resize.';
  }
}

async function onPageClick(e) {
  if (!placeType || !isDraft() || e.target.closest('.field-box')) return;
  const pageEl = e.currentTarget;
  const rect = pageEl.getBoundingClientRect();
  const size = DEFAULT_SIZES[placeType];
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top) / rect.height;
  try {
    await api('POST', `/api/documents/${encodeURIComponent(docId)}/fields`, {
      signer_id: activeSignerId,
      type: placeType,
      page: Number(pageEl.dataset.page),
      x: Math.max(0, Math.min(1 - size.width, cx - size.width / 2)),
      y: Math.max(0, Math.min(1 - size.height, cy - size.height / 2)),
      width: size.width,
      height: size.height,
      label: FIELD_LABELS[placeType]
    });
    await load();
  } catch (ex) { toast(ex.message, 'error'); }
}

// ---------- Sidebar events ----------
$('signerList').addEventListener('click', async e => {
  const remove = e.target.closest('[data-remove]');
  const copy = e.target.closest('[data-copy]');
  const resend = e.target.closest('[data-resend]');
  const select = e.target.closest('[data-select]');
  try {
    if (remove) {
      const s = doc.signers.find(x => x.id === remove.dataset.remove);
      const n = doc.fields.filter(f => f.signer_id === s.id).length;
      if (n && !confirm(`Remove ${s.name} and their ${n} field${n === 1 ? '' : 's'}?`)) return;
      await api('DELETE', `/api/signers/${encodeURIComponent(s.id)}`);
      await load();
    } else if (copy) {
      await copyText(copy.dataset.copy);
    } else if (resend) {
      resend.disabled = true;
      await api('POST', `/api/signers/${encodeURIComponent(resend.dataset.resend)}/resend`, {});
      toast('Email resent');
      loadAudit();
      resend.disabled = false;
    } else if (select && isDraft()) {
      activeSignerId = select.dataset.select;
      renderSigners();
      if (placeType) setPlacing(placeType);
    }
  } catch (ex) {
    toast(ex.message, 'error');
    if (resend) resend.disabled = false;
  }
});

$('addSignerForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const data = await api('POST', `/api/documents/${encodeURIComponent(docId)}/signers`, {
      name: $('signerName').value.trim(),
      email: $('signerEmail').value.trim()
    });
    $('signerName').value = '';
    $('signerEmail').value = '';
    activeSignerId = data.id;
    await load();
  } catch (ex) { toast(ex.message, 'error'); }
});

$('fieldButtons').addEventListener('click', e => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  if (!activeSignerId) { toast('Add a signer first.', 'error'); return; }
  setPlacing(placeType === b.dataset.type ? null : b.dataset.type);
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && placeType) setPlacing(null); });

$('sendBtn').addEventListener('click', async () => {
  const btn = $('sendBtn');
  if (!confirm(`Send "${doc.title}" to ${doc.signers.length} signer${doc.signers.length === 1 ? '' : 's'}? You won't be able to edit it afterwards.`)) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const data = await api('POST', `/api/documents/${encodeURIComponent(docId)}/send`, { note: $('sendNote').value.trim() });
    setPlacing(null);
    const failed = data.links.filter(l => l.emailError);
    const unsent = data.links.filter(l => !l.emailed);
    if (failed.length) toast(`Sent, but ${failed.length} email${failed.length === 1 ? '' : 's'} failed: ${failed[0].emailError}. Use "Copy link" instead.`, 'error');
    else if (unsent.length) toast(`Sent. Use "Copy link" to send ${unsent.length === data.links.length ? 'the links' : `${unsent.length} link${unsent.length === 1 ? '' : 's'}`} yourself.`);
    else toast('Sent. Everyone has been emailed.');
    await load();
  } catch (ex) {
    toast(ex.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send for signing';
  }
});

$('actions').addEventListener('click', async e => {
  try {
    if (e.target.id === 'voidBtn') {
      const reason = prompt('Cancel this signing request? Links will stop working and nobody else can sign.\n\nReason (optional, kept in the audit trail):');
      if (reason === null) return;
      await api('POST', `/api/documents/${encodeURIComponent(docId)}/void`, { reason });
      toast('Signing request cancelled');
      await load();
    } else if (e.target.id === 'finalizeBtn') {
      e.target.disabled = true;
      await api('POST', `/api/documents/${encodeURIComponent(docId)}/finalize`, {});
      toast('Document completed');
      await load();
    }
  } catch (ex) {
    toast(ex.message, 'error');
    e.target.disabled = false;
  }
});

bindLogout();
if (!docId) window.location.href = '/';
else requireLogin().then(() => load());
