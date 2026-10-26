const nodemailer = require('nodemailer');
const config = require('./config');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const APP_NAME = config.APP_NAME;

let transporter = null;
let configured = false;

if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true for 465, false for 587/25 (STARTTLS)
    auth: (SMTP_USER && SMTP_PASS) ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
  configured = true;
} else {
  console.warn('[mailer] SMTP_HOST not set — emails will NOT be sent automatically. ' +
    'Signing links will still be shown in the dashboard for you to send manually.');
}

function isConfigured() {
  return configured;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendSigningRequest({ to, signerName, documentTitle, signUrl, senderNote }) {
  if (!transporter) throw new Error('SMTP is not configured (set SMTP_HOST, SMTP_PORT, etc.)');
  const subject = `Please sign: ${documentTitle}`;
  const text = `Hi ${signerName},\n\n` +
    `You've been asked to sign "${documentTitle}".\n\n` +
    `Open this link to review and sign:\n${signUrl}\n\n` +
    (senderNote ? `Note: ${senderNote}\n\n` : '') +
    `— ${APP_NAME}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; max-width:520px;">
      <p>Hi ${escapeHtml(signerName)},</p>
      <p>You've been asked to sign <strong>${escapeHtml(documentTitle)}</strong>.</p>
      ${senderNote ? `<p style="color:#555;">${escapeHtml(senderNote)}</p>` : ''}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(signUrl)}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">
          Review &amp; sign document
        </a>
      </p>
      <p style="color:#888; font-size:12px;">If the button doesn't work, copy this link into your browser:<br>${escapeHtml(signUrl)}</p>
      <p style="color:#888; font-size:12px;">Sent via ${escapeHtml(APP_NAME)}</p>
    </div>`;
  return transporter.sendMail({ from: SMTP_FROM, to, subject, text, html });
}

async function sendCompletionCopy({ to, signerName, documentTitle, downloadNote, attachment }) {
  if (!transporter) throw new Error('SMTP is not configured');
  const subject = `Signed: ${documentTitle}`;
  const text = `Hi ${signerName},\n\n"${documentTitle}" has been signed by all parties.\n\n${downloadNote || ''}\n\n— ${APP_NAME}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; max-width:520px;">
      <p>Hi ${escapeHtml(signerName)},</p>
      <p><strong>${escapeHtml(documentTitle)}</strong> has been signed by all parties.</p>
      <p style="color:#555;">${escapeHtml(downloadNote || '')}</p>
      <p style="color:#888; font-size:12px;">Sent via ${escapeHtml(APP_NAME)}</p>
    </div>`;
  const mail = { from: SMTP_FROM, to, subject, text, html };
  if (attachment) {
    mail.attachments = [{ filename: attachment.filename, content: attachment.content }];
  }
  return transporter.sendMail(mail);
}

async function verifyConnection() {
  if (!transporter) return { ok: false, error: 'SMTP not configured' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isConfigured, sendSigningRequest, sendCompletionCopy, verifyConnection };
