const path = require('path');

const env = process.env;

const DATA_DIR = env.DATA_DIR || path.join(__dirname, '..', 'data');
const BASE_URL = (env.BASE_URL || '').replace(/\/+$/, '');
let BASE_HOST = null;
if (BASE_URL) {
  try { BASE_HOST = new URL(BASE_URL).host; } catch {
    console.error(`[config] BASE_URL "${BASE_URL}" is not a valid URL (expected e.g. https://sign.example.com)`);
    process.exit(1);
  }
}

// Number of reverse-proxy hops in front of this app (nginx/Caddy/Cloudflare = 1).
// Needed so req.ip and secure cookies work when internet-facing. Accepts
// anything Express's "trust proxy" setting does (a hop count, "loopback", a CIDR list...).
const rawTrustProxy = env.TRUST_PROXY !== undefined ? env.TRUST_PROXY : '1';
const TRUST_PROXY = /^\d+$/.test(rawTrustProxy) ? Number(rawTrustProxy)
  : rawTrustProxy === 'true' ? true
  : rawTrustProxy === 'false' ? false
  : rawTrustProxy;

module.exports = {
  PORT: Number(env.PORT) || 8080,
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  SESSION_SECRET: env.SESSION_SECRET || '',
  DATA_DIR,
  FILES_DIR: path.join(DATA_DIR, 'files'),
  BASE_URL,
  BASE_HOST,
  SECURE_COOKIES: BASE_URL.startsWith('https://'),
  TRUST_PROXY,
  APP_NAME: env.APP_NAME || 'LiteSign',
  MAX_UPLOAD_MB: Number(env.MAX_UPLOAD_MB) || 25
};
