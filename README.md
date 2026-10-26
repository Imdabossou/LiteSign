# LiteSign

A genuinely lightweight, self-hosted document signing tool, built for
sending documents to people *outside* your organization to sign over the
web. One container. SQLite on disk. Sends real email via your own SMTP
provider. No paid tier holding features back — there is no paid tier.

## What it does

- Upload a PDF, add one or more signers (name + email), click on the
  document to place signature / initials / text / date fields for each.
  Drag fields to move them, drag the corner to resize, and double-click a
  text field to give it a label (e.g. "Company name"). Each signer gets
  their own colour.
- Click "Send for signing" — LiteSign emails each signer a unique signing
  link via SMTP (or shows you the links to send yourself if you haven't
  configured SMTP).
- Signers open their link (no account needed, works on phones), are
  walked through each field in turn, draw or type their signature, agree
  to sign electronically, and submit.
- Once every signer has signed, LiteSign stamps all the values into the
  PDF, appends a signature certificate (who signed, when they first opened
  it, when they signed, from what IP, and the SHA-256 of the original
  file), emails every signer a copy of the finished PDF, and makes it
  available for download from the admin dashboard and from each signer's
  own link.
- Light and dark themes for you and your signers, following the device's
  setting by default, with a System / Light / Dark toggle on every page.
- Copy any signer's link or resend their email while you wait, follow
  every step in the per-document audit trail, or cancel a request (which
  kills its links) if you sent the wrong version.
- Everything — the dashboard, audit log, and completed PDFs — lives in one
  SQLite file and a folder of PDFs under `/app/data`.

## This is meant to be internet-facing

Because it's for sending documents to people outside your org, this app is
built to sit on the open internet behind a reverse proxy, and includes:

- Rate limiting on login and on the public signer endpoints.
- Security headers via `helmet`, including a strict Content-Security-Policy
  (all scripts are served by the app itself; no inline script, no CDN).
- Cross-origin request blocking on the API, SameSite session cookies, and a
  new session ID on every login.
- `trust proxy` support so signer IP addresses in the audit log and secure
  cookies work correctly behind nginx/Caddy/Cloudflare Tunnel.
- Session cookies automatically marked HTTPS-only once `BASE_URL` starts
  with `https://`.

You still need to put a real reverse proxy with TLS in front of it — this
app speaks plain HTTP itself (see "Putting it behind HTTPS" below).

## Quick start

```bash
cp .env.example .env
# edit .env: set ADMIN_PASSWORD (required), your public BASE_URL, and your SMTP
# credentials (Gmail app password, SendGrid, Mailgun, SES, Postmark, or
# your own mail server all work)

docker compose up -d --build
```

Open **http://localhost:8080** (or your real domain), log in, and upload a
PDF. If SMTP isn't configured yet, the app still works — you just get
links to copy and paste into an email yourself instead of automatic
sending.

### Or plain `docker run`, no compose

```bash
docker build -t litesign .
docker run -d \
  --name litesign \
  -p 8080:8080 \
  -e ADMIN_PASSWORD=your-real-password \
  -e BASE_URL=https://sign.yourdomain.com \
  -e SMTP_HOST=smtp.yourprovider.com \
  -e SMTP_PORT=587 \
  -e SMTP_USER=you@yourdomain.com \
  -e SMTP_PASS=your-smtp-password \
  -e SMTP_FROM=you@yourdomain.com \
  -v litesign_data:/app/data \
  litesign
```

## Configuration (environment variables)

| Variable          | Default      | Purpose                                                                 |
|--------------------|--------------|--------------------------------------------------------------------------|
| `ADMIN_PASSWORD`   | *(required)* | Password for the single admin account. The app won't start without it (or with `changeme`). |
| `BASE_URL`         | `""`         | Public URL used to build signing links and to enable secure cookies (e.g. `https://sign.yourdomain.com`). |
| `SMTP_HOST`        | *(unset)*    | SMTP server hostname. Leave unset to disable automatic email — links are still shown in the dashboard. |
| `SMTP_PORT`        | `587`        | SMTP port. 587/25 use STARTTLS automatically; 465 needs `SMTP_SECURE=true`. |
| `SMTP_SECURE`      | `false`      | Set `true` only for port 465 (implicit TLS).                            |
| `SMTP_USER`        | *(unset)*    | SMTP auth username, if your provider requires auth.                     |
| `SMTP_PASS`        | *(unset)*    | SMTP auth password / app password / API key.                            |
| `SMTP_FROM`        | `SMTP_USER`  | From address on outgoing emails.                                        |
| `TRUST_PROXY`      | `1`          | Number of reverse-proxy hops in front of the app. Needed for correct signer IPs and secure cookies. |
| `PORT`             | `8080`       | Port the app listens on inside the container.                          |
| `SESSION_SECRET`   | generated    | Cookie signing secret. Generated once and stored in the database if unset. |
| `DATA_DIR`         | `/app/data`  | Where the SQLite DB and uploaded/completed PDFs are stored.            |
| `APP_NAME`         | `LiteSign`   | Name shown in emails ("Sent via …").                                   |
| `MAX_UPLOAD_MB`    | `25`         | Largest PDF you can upload.                                            |

## Putting it behind HTTPS

LiteSign speaks plain HTTP — put a reverse proxy in front of it for TLS.
The simplest option is Caddy, which gets you free automatic HTTPS:

```
sign.yourdomain.com {
  reverse_proxy litesign:8080
}
```

Set `BASE_URL=https://sign.yourdomain.com` so the links you email out are
correct and secure cookies get enabled.

## Backups

Everything durable lives under the `/app/data` volume:
- `litesign.sqlite` — documents, signers, fields, audit log, login sessions
- `files/` — original uploaded PDFs and completed signed PDFs

Back it up with e.g.:
```bash
docker run --rm -v litesign_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/litesign-backup.tar.gz /data
```

## No third-party requests

PDF.js (which renders documents in the browser) is installed from npm and
served by the app itself, so neither you nor your signers' browsers load
anything from a CDN. The container makes no outbound network calls at
runtime other than SMTP.

## Security notes

- Exactly one admin account, gated by `ADMIN_PASSWORD` — built for a single
  team/individual sending documents out, not multi-tenant SaaS use.
- Signing links contain a random 192-bit token; anyone with the link
  can sign as that signer — email delivery is the access control. Public
  signer endpoints are rate-limited, but treat links like you would a
  DocuSign envelope link. Links only work once a document is sent, and
  stop working if you cancel it.
- No inbound-facing admin surface beyond the login page and the API, both
  rate-limited; consider also putting basic IP allowlisting or a WAF in
  front if your reverse proxy supports it, especially for `/login.html`.
- This has not been audited for legal admissibility (eIDAS/ESIGN
  compliance) in regulated industries — it captures signer name, drawn/typed
  signature image, consent, timestamps, and IP address in an appended certificate
  page and audit log, which covers most business use cases, but get your
  own legal sign-off if this needs to hold up as evidence in court.

## Development

```bash
npm install
ADMIN_PASSWORD=dev-password-123 BASE_URL=http://localhost:8080 npm start
npm test   # end-to-end API tests against a throwaway data directory
```

Requires Node.js 22 or newer.

## Stack

Node.js + Express 5, `better-sqlite3` (embedded, file-based), `pdf-lib` for
stamping values into PDFs, `nodemailer` for SMTP, `multer` for uploads,
`helmet` + `express-rate-limit` for internet-facing hardening, and
`pdfjs-dist` for rendering in the browser. No frontend build step: plain
HTML, CSS and ES modules.
