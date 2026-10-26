import { api, escapeHtml, toast, fmtDate, FIELD_LABELS } from './common.js';
import { renderPdf, placeBox } from './pdfview.js';

const token = new URLSearchParams(window.location.search).get('token') || '';
const base = `/api/sign/${encodeURIComponent(token)}`;
const $ = id => document.getElementById(id);

let data = null;
let pages = [];
let current = null;
const values = {};

const isImage = f => f.type === 'signature' || f.type === 'initials';
const labelOf = f => f.label || FIELD_LABELS[f.type];
const remaining = () => data.fields.filter(f => !values[f.id]);

function banner(kind, html) {
  $('banner').innerHTML = `<div class="status-banner ${kind}">${html}</div>`;
}

function downloadLink() {
  return `<a class="btn" href="${base}/download">Download signed copy</a>`;
}

async function load() {
  try {
    data = await api('GET', base, undefined, { redirectOn401: false });
  } catch (e) {
    $('canvasWrap').innerHTML = `<div class="empty">${e.status === 404 ? 'This signing link is invalid. Check that you copied the whole link from your email.' : escapeHtml(e.message)}</div>`;
    return;
  }
  const { document: doc, signer } = data;
  document.title = `Sign: ${doc.title}`;
  $('docTitle').textContent = doc.title;
  $('signerNameTop').textContent = signer.name;

  if (doc.status === 'voided') {
    $('canvasWrap').innerHTML = '<div class="empty">The sender has cancelled this signing request, so there is nothing to sign. Contact them if you think this is a mistake.</div>';
    return;
  }
  if (signer.status === 'signed') {
    banner('completed', doc.status === 'completed'
      ? `You signed this on ${escapeHtml(fmtDate(signer.signed_at))}, and everyone has now signed. ${downloadLink()}`
      : `You signed this on ${escapeHtml(fmtDate(signer.signed_at))}. We're waiting on others. Come back to this link to download the finished copy once everyone has signed.`);
    $('panel').hidden = true;
    await showPdf(true);
    return;
  }
  if (doc.status !== 'pending') {
    $('canvasWrap').innerHTML = '<div class="empty">This document is no longer accepting signatures.</div>';
    return;
  }

  $('panel').hidden = false;
  $('intro').textContent = data.fields.length === 1
    ? `Hi ${signer.name}, there is 1 field for you to fill in. Tap it on the document.`
    : `Hi ${signer.name}, there are ${data.fields.length} fields for you to fill in. Tap each highlighted box on the document.`;
  renderChecklist();
  await showPdf(false);
}

async function showPdf(readonly) {
  try {
    pages = await renderPdf($('canvasWrap'), `${base}/file`);
  } catch (e) {
    $('canvasWrap').innerHTML = `<div class="empty">Could not display this document: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!readonly) renderFields();
}

function renderChecklist() {
  $('fieldChecklist').innerHTML = data.fields.map(f => `
    <li class="${values[f.id] ? 'done' : ''}">
      <button class="link-btn" data-goto="${f.id}">${escapeHtml(labelOf(f))}</button>
      <span class="hint">page ${f.page + 1}</span>
    </li>`).join('');
  const left = remaining().length;
  $('nextBtn').hidden = left === 0;
  $('nextBtn').textContent = left === data.fields.length ? 'Start' : `Next field (${left} left)`;
  updateComplete();
}

function updateComplete() {
  $('completeBtn').disabled = remaining().length > 0 || !$('consent').checked;
}

function renderFields() {
  document.querySelectorAll('.field-box').forEach(el => el.remove());
  for (const f of data.fields) {
    const pageEl = pages[f.page];
    if (!pageEl) continue;
    const box = document.createElement('div');
    box.className = `field-box mine ${values[f.id] ? 'filled' : ''}`;
    box.id = `box-${f.id}`;
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', `${labelOf(f)}${values[f.id] ? ' (filled in)' : ''}`);
    placeBox(box, f);
    if (values[f.id] && isImage(f)) {
      const img = document.createElement('img');
      img.src = values[f.id];
      img.alt = labelOf(f);
      box.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = values[f.id] ? 'field-value' : 'field-label';
      span.textContent = values[f.id] || `${labelOf(f)}`;
      box.appendChild(span);
    }
    box.addEventListener('click', () => openField(f));
    box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openField(f); } });
    pageEl.appendChild(box);
  }
}

function scrollToField(f, flash = true) {
  const box = $(`box-${f.id}`);
  if (!box) return;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (flash) {
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
  }
}

function setValue(f, value) {
  values[f.id] = value;
  renderFields();
  renderChecklist();
  // Move on to the next empty field automatically.
  const next = remaining()[0];
  if (next) scrollToField(next);
  else $('consent').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openField(f) {
  current = f;
  if (isImage(f)) openSigModal(f);
  else openTextModal(f);
}

// ---------- Text / date ----------
function openTextModal(f) {
  const input = $('textInput');
  $('textModalTitle').textContent = labelOf(f);
  input.type = f.type === 'date' ? 'date' : 'text';
  input.value = values[f.id] || (f.type === 'date' ? new Date().toLocaleDateString('en-CA') : '');
  $('textModal').hidden = false;
  input.focus();
}
$('textForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('textInput').value.trim();
  if (!v) return;
  $('textModal').hidden = true;
  setValue(current, v);
});
$('textCancel').addEventListener('click', () => { $('textModal').hidden = true; });

// ---------- Signature pad ----------
const sigCanvas = $('sigCanvas');
const sigCtx = sigCanvas.getContext('2d');
let drawing = false, hasInk = false, last = null;

function sizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  sigCanvas.width = sigCanvas.clientWidth * ratio;
  sigCanvas.height = sigCanvas.clientHeight * ratio;
  sigCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  sigCtx.lineWidth = 2.4;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = '#111';
  hasInk = false;
}

function initialsOf(name) {
  return name.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 4);
}

function openSigModal(f) {
  $('sigModalTitle').textContent = f.type === 'initials' ? 'Add your initials' : 'Add your signature';
  $('typedSig').value = f.type === 'initials' ? initialsOf(data.signer.name) : data.signer.name;
  updateTypedPreview();
  $('sigModal').hidden = false;
  showTab('draw');
}

function showTab(which) {
  $('tabDraw').classList.toggle('active', which === 'draw');
  $('tabType').classList.toggle('active', which === 'type');
  $('drawPane').hidden = which !== 'draw';
  $('typePane').hidden = which !== 'type';
  if (which === 'draw') sizeCanvas();
  else $('typedSig').focus();
}
$('tabDraw').addEventListener('click', () => showTab('draw'));
$('tabType').addEventListener('click', () => showTab('type'));

function pos(e) {
  const r = sigCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
sigCanvas.addEventListener('pointerdown', e => {
  drawing = true;
  last = pos(e);
  sigCanvas.setPointerCapture(e.pointerId);
  // A single tap still leaves a dot.
  sigCtx.beginPath();
  sigCtx.arc(last.x, last.y, sigCtx.lineWidth / 2, 0, Math.PI * 2);
  sigCtx.fillStyle = '#111';
  sigCtx.fill();
  e.preventDefault();
});
sigCanvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  const p = pos(e);
  sigCtx.beginPath();
  sigCtx.moveTo(last.x, last.y);
  sigCtx.lineTo(p.x, p.y);
  sigCtx.stroke();
  last = p;
  hasInk = true;
  e.preventDefault();
});
['pointerup', 'pointercancel'].forEach(ev => sigCanvas.addEventListener(ev, () => { drawing = false; }));

const SIG_FONT = '"Segoe Script", "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive';
function updateTypedPreview() {
  const el = $('typedPreview');
  el.textContent = $('typedSig').value || ' ';
  el.style.fontFamily = SIG_FONT;
}
$('typedSig').addEventListener('input', updateTypedPreview);

// Crop a canvas to its drawn pixels (plus padding), so the signature fills
// the field instead of sitting small in the middle of a big blank image.
function trimmed(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(width, height) * 0.02);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

$('sigClear').addEventListener('click', () => {
  if ($('drawPane').hidden) { $('typedSig').value = ''; updateTypedPreview(); $('typedSig').focus(); }
  else sizeCanvas();
});
$('sigCancel').addEventListener('click', () => { $('sigModal').hidden = true; });
$('sigConfirm').addEventListener('click', () => {
  let url;
  if (!$('typePane').hidden) {
    const name = $('typedSig').value.trim();
    if (!name) { toast('Type your name first', 'error'); return; }
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = `64px ${SIG_FONT}`;
    c.width = Math.ceil(ctx.measureText(name).width) + 40;
    c.height = 120;
    ctx.font = `64px ${SIG_FONT}`;
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 20, 60);
    url = trimmed(c);
  } else {
    if (!hasInk) { toast('Draw your signature first', 'error'); return; }
    url = trimmed(sigCanvas);
  }
  if (!url) return;
  $('sigModal').hidden = true;
  setValue(current, url);
});

// Close modals with Escape or by tapping the backdrop.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('sigModal').hidden = true; $('textModal').hidden = true; }
});
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.hidden = true; }));

// ---------- Sidebar ----------
$('fieldChecklist').addEventListener('click', e => {
  const b = e.target.closest('[data-goto]');
  if (!b) return;
  const f = data.fields.find(x => x.id === b.dataset.goto);
  scrollToField(f);
  openField(f);
});
$('nextBtn').addEventListener('click', () => {
  const next = remaining()[0];
  if (!next) return;
  scrollToField(next);
  openField(next);
});
$('consent').addEventListener('change', updateComplete);

$('completeBtn').addEventListener('click', async () => {
  const btn = $('completeBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const result = await api('POST', `${base}/submit`, {
      values: data.fields.map(f => ({ field_id: f.id, value: values[f.id] })),
      consent: $('consent').checked
    }, { redirectOn401: false });
    $('panel').hidden = true;
    document.querySelectorAll('.field-box').forEach(b => { b.classList.add('locked'); b.replaceWith(b.cloneNode(true)); });
    banner('completed', result.completed
      ? `Thank you, you're done. Everyone has now signed. ${downloadLink()}`
      : 'Thank you, you\'re done. Once everyone has signed, you can download the finished copy from this same link.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Finish signing';
  }
});

load();
