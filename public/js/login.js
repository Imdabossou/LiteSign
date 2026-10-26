import { api } from './common.js';

const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const btn = document.getElementById('loginBtn');

// Already logged in? Skip straight to the dashboard.
api('GET', '/api/session').then(d => { if (d.authed) window.location.href = '/'; }).catch(() => {});

form.addEventListener('submit', async e => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    await api('POST', '/api/login', { password: document.getElementById('password').value }, { redirectOn401: false });
    window.location.href = '/';
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
});
