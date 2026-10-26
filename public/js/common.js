// Shared helpers for every page.

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// fetch wrapper: JSON in, JSON out, throws Error(message) on failure.
// Admin pages bounce to the login page if the session has expired.
export async function api(method, url, body, { redirectOn401 = true } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 401 && redirectOn401) {
    window.location.href = '/login.html';
    return new Promise(() => {}); // page is navigating away
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
  return data;
}

let toastTimer;
export function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
}

export async function requireLogin() {
  const { authed } = await api('GET', '/api/session');
  if (!authed) {
    window.location.href = '/login.html';
    await new Promise(() => {}); // page is navigating away
  }
}

export function bindLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    window.location.href = '/login.html';
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    window.prompt('Copy this link:', text);
  }
}

// One colour per signer, by position, so fields are easy to tell apart.
export const SIGNER_COLORS = ['#2563eb', '#c026d3', '#ea580c', '#0d9488', '#7c3aed', '#be123c', '#4d7c0f', '#0369a1'];
export const signerColor = index => SIGNER_COLORS[index % SIGNER_COLORS.length];

export const FIELD_LABELS = { signature: 'Signature', initials: 'Initials', text: 'Text', date: 'Date' };

export function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
