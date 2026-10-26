// End-to-end API tests: start a real server against a throwaway data
// directory and walk a document from upload to completion.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const PORT = 38000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-battery';
// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let server, dataDir, cookie = '';

async function api(method, url, body, { auth = true, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (auth && cookie) opts.headers.cookie = cookie;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && auth) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

async function makePdf(pages = 2) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) pdf.addPage().drawText(`Page ${i + 1}`, { x: 50, y: 700, font, size: 20 });
  return Buffer.from(await pdf.save());
}

async function uploadPdf(bytes, title = 'Test NDA') {
  const fd = new FormData();
  fd.append('title', title);
  fd.append('file', new Blob([bytes], { type: 'application/pdf' }), 'test.pdf');
  return api('POST', '/api/documents', fd);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'litesign-test-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, BASE_URL: BASE, TRUST_PROXY: '0', SMTP_HOST: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + log);
});

after(() => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('refuses to start without a real admin password', async () => {
  for (const pw of ['', 'changeme']) {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: PORT + 1, DATA_DIR: dataDir, ADMIN_PASSWORD: pw }, stdio: 'ignore'
    });
    const code = await new Promise(r => p.on('exit', r));
    assert.equal(code, 1);
  }
});

test('admin API requires login', async () => {
  assert.equal((await api('GET', '/api/documents', undefined, { auth: false })).status, 401);
  assert.equal((await api('POST', '/api/login', { password: 'nope' }, { auth: false })).status, 401);
  const r = await api('POST', '/api/login', { password: PASSWORD });
  assert.equal(r.status, 200);
  assert.ok(cookie.startsWith('litesign.sid='));
  assert.equal((await api('GET', '/api/documents')).status, 200);
});

test('rejects cross-origin state changes', async () => {
  const r = await api('POST', '/api/documents/x/send', {}, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('rejects non-PDF and broken uploads with a JSON error', async () => {
  const notPdf = await uploadPdf(Buffer.from('hello world'));
  assert.equal(notPdf.status, 400);
  assert.match(notPdf.data.error, /not a PDF/);
  const broken = await uploadPdf(Buffer.from('%PDF-1.7\ngarbage'));
  assert.equal(broken.status, 400);
  assert.match(broken.data.error, /could not be read/);
  // Rejected uploads don't leave files behind.
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'files')), []);
});

test('full signing flow', async () => {
  const up = await uploadPdf(await makePdf(2));
  assert.equal(up.status, 200);
  const docId = up.data.id;

  // Signers and fields
  const alice = (await api('POST', `/api/documents/${docId}/signers`, { name: 'Alice Łukasiewicz', email: 'alice@example.com' })).data.id;
  const bob = (await api('POST', `/api/documents/${docId}/signers`, { name: 'Bob', email: '' })).data.id;
  assert.equal((await api('POST', `/api/documents/${docId}/signers`, { name: 'X', email: 'not-an-email' })).status, 400);

  const field = (signer_id, type, page, x, y) =>
    api('POST', `/api/documents/${docId}/fields`, { signer_id, type, page, x, y, width: 0.2, height: 0.05, label: type });
  assert.equal((await field(alice, 'signature', 5, 0.1, 0.1)).status, 400, 'page out of range');
  assert.equal((await field(alice, 'bogus', 0, 0.1, 0.1)).status, 400, 'bad type');
  assert.equal((await field('nope', 'signature', 0, 0.1, 0.1)).status, 400, 'unknown signer');

  const aSig = (await field(alice, 'signature', 0, 0.1, 0.7)).data.id;
  const aText = (await field(alice, 'text', 1, 0.1, 0.2)).data.id;

  // Can't send while Bob has no fields
  const early = await api('POST', `/api/documents/${docId}/send`, {});
  assert.equal(early.status, 400);
  assert.match(early.data.error, /Bob/);

  const bDate = (await field(bob, 'date', 1, 0.5, 0.5)).data.id;
  assert.equal((await api('PATCH', `/api/fields/${bDate}`, { x: 0.6, y: 0.6 })).status, 200);
  assert.equal((await api('PATCH', `/api/fields/${bDate}`, { x: 2 })).status, 400);

  // Links aren't live before sending
  const docBefore = (await api('GET', `/api/documents/${docId}`)).data;
  const tokenOf = id => docBefore.signers.find(s => s.id === id).token;
  assert.equal((await api('GET', `/api/sign/${tokenOf(alice)}`, undefined, { auth: false })).status, 404);

  const sent = await api('POST', `/api/documents/${docId}/send`, { note: 'Please sign' });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.links.length, 2);
  assert.ok(sent.data.links[0].url.startsWith(`${BASE}/sign.html?token=`));

  // Sent documents are locked
  assert.equal((await api('POST', `/api/documents/${docId}/send`, {})).status, 409);
  assert.equal((await field(alice, 'text', 0, 0.3, 0.3)).status, 409);
  assert.equal((await api('DELETE', `/api/fields/${aSig}`)).status, 409);
  assert.equal((await api('DELETE', `/api/signers/${bob}`)).status, 409);

  // Alice signs
  const aTok = tokenOf(alice);
  const view = await api('GET', `/api/sign/${aTok}`, undefined, { auth: false });
  assert.equal(view.status, 200);
  assert.equal(view.data.fields.length, 2);
  assert.equal(view.data.fields[0].value, undefined, 'signer view does not leak values');
  const file = await api('GET', `/api/sign/${aTok}/file`, undefined, { auth: false });
  assert.equal(file.data.subarray(0, 5).toString(), '%PDF-');

  const submit = (token, body) => api('POST', `/api/sign/${token}/submit`, body, { auth: false });
  const aliceValues = [{ field_id: aSig, value: PNG }, { field_id: aText, value: 'Zażółć gęślą jaźń 🙂 ACME Ltd' }];
  assert.equal((await submit(aTok, { values: aliceValues })).status, 400, 'consent required');
  assert.equal((await submit(aTok, { values: [{ field_id: aSig, value: 'data:image/png;base64,AAAA' }, aliceValues[1]], consent: true })).status, 400, 'bad png');
  // Spoofed X-Forwarded-For must not land in the audit log (TRUST_PROXY=0 here)
  const aRes = await api('POST', `/api/sign/${aTok}/submit`, { values: aliceValues, consent: true }, { auth: false, headers: { 'x-forwarded-for': '6.6.6.6' } });
  assert.equal(aRes.status, 200);
  assert.equal(aRes.data.completed, false);
  assert.equal((await submit(aTok, { values: aliceValues, consent: true })).status, 400, 'no double signing');

  // Bob signs, document completes
  const bRes = await submit(tokenOf(bob), { values: [{ field_id: bDate, value: '2026-10-26' }], consent: true });
  assert.equal(bRes.status, 200);
  assert.equal(bRes.data.completed, true);

  const done = (await api('GET', `/api/documents/${docId}`)).data;
  assert.equal(done.status, 'completed');
  assert.match(done.completed_sha256, /^[0-9a-f]{64}$/);

  const signed = await api('GET', `/api/documents/${docId}/download`);
  assert.equal(signed.status, 200);
  const pdf = await PDFDocument.load(signed.data);
  assert.equal(pdf.getPageCount(), 3, 'original 2 pages + certificate');

  const signerCopy = await api('GET', `/api/sign/${aTok}/download`, undefined, { auth: false });
  assert.equal(signerCopy.status, 200);
  assert.ok(signerCopy.data.equals(signed.data));

  const audit = (await api('GET', `/api/documents/${docId}/audit`)).data;
  const events = audit.map(a => a.event);
  for (const e of ['document_created', 'document_sent', 'signer_viewed', 'signer_consented', 'signer_signed', 'document_completed']) {
    assert.ok(events.includes(e), `audit has ${e}`);
  }
  assert.ok(!audit.some(a => a.ip === '6.6.6.6'), 'spoofed IP not trusted');
});

test('voiding a document kills its links', async () => {
  const docId = (await uploadPdf(await makePdf(1), 'To void')).data.id;
  const s = (await api('POST', `/api/documents/${docId}/signers`, { name: 'Carol' })).data.id;
  const f = (await api('POST', `/api/documents/${docId}/fields`, { signer_id: s, type: 'text', page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.04 })).data.id;
  await api('POST', `/api/documents/${docId}/send`, {});
  const token = (await api('GET', `/api/documents/${docId}`)).data.signers[0].token;

  assert.equal((await api('POST', `/api/documents/${docId}/void`, { reason: 'wrong version' })).status, 200);
  const view = await api('GET', `/api/sign/${token}`, undefined, { auth: false });
  assert.equal(view.data.document.status, 'voided');
  assert.equal((await api('GET', `/api/sign/${token}/file`, undefined, { auth: false })).status, 410);
  const r = await api('POST', `/api/sign/${token}/submit`, { values: [{ field_id: f, value: 'hi' }], consent: true }, { auth: false });
  assert.equal(r.status, 409);

  assert.equal((await api('DELETE', `/api/documents/${docId}`)).status, 200);
  assert.equal((await api('GET', `/api/documents/${docId}`)).status, 404);
});

test('sessions survive a logout/login cycle and logout works', async () => {
  assert.equal((await api('POST', '/api/logout')).status, 200);
  assert.equal((await api('GET', '/api/documents')).status, 401);
  await api('POST', '/api/login', { password: PASSWORD });
  assert.equal((await api('GET', '/api/documents')).status, 200);
});
