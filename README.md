# LiteSign

A genuinely lightweight, self-hosted document signing tool, built for
sending documents to people *outside* your organization to sign over the
web. One container. SQLite on disk. Sends real email via your own SMTP
provider. No paid tier holding features back — there is no paid tier.

## What it does

- Upload a PDF, add one or more signers (name + email), click on the
  document to place signature / initials / text / date fields for each.
- Click "Send for signing" — LiteSign emails each signer a unique signing
  link via SMTP (or shows you the links to send yourself if you haven't
  configured SMTP).
- Signers open their link (no account needed), draw or type their
  signature, fill in any other fields, and submit.
- Once every signer has signed, LiteSign stamps all the values into the
  PDF, appends a one-page signature certificate (who signed, when, from
  what IP), emails every signer a copy of the finished PDF, and makes it
  available for download from the admin dashboard.
- Everything — the dashboard, audit log, and completed PDFs — lives in one
  SQLite file and a folder of PDFs under `/app/data`.

## This is meant to be internet-facing

Because it's for sending documents to people outside your org, this app is
built to sit on the open internet behind a reverse proxy, and includes:

- Rate limiting on login and on the public signer endpoints.
- Security headers via `helmet` (HSTS, `X-Frame-Options`, `X-Content-Type-Options`, etc.).
- `trust proxy` support so signer IP addresses in the audit log and secure
  cookies work correctly behind nginx/Caddy/Cloudflare Tunnel.
- Session cookies automatically marked HTTPS-only once `BASE_URL` starts
  with `https://`.

You still need to put a real reverse proxy with TLS in front of it — this
app speaks plain HTTP itself (see "Putting it behind HTTPS" below).

## Quick start

```bash
cp .env.example .env
# edit .env: set a real ADMIN_PASSWORD, your public BASE_URL, and your SMTP
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
| `ADMIN_PASSWORD`   | `changeme`   | Password for the single admin account. **Change this.**                 |
| `BASE_URL`         | `""`         | Public URL used to build signing links and to enable secure cookies (e.g. `https://sign.yourdomain.com`). |
| `SMTP_HOST`        | *(unset)*    | SMTP server hostname. Leave unset to disable automatic email — links are still shown in the dashboard. |
| `SMTP_PORT`        | `587`        | SMTP port. 587/25 use STARTTLS automatically; 465 needs `SMTP_SECURE=true`. |
| `SMTP_SECURE`      | `false`      | Set `true` only for port 465 (implicit TLS).                            |
| `SMTP_USER`        | *(unset)*    | SMTP auth username, if your provider requires auth.                     |
| `SMTP_PASS`        | *(unset)*    | SMTP auth password / app password / API key.                            |
| `SMTP_FROM`        | `SMTP_USER`  | From address on outgoing emails.                                        |
| `TRUST_PROXY`      | `1`          | Number of reverse-proxy hops in front of the app. Needed for correct signer IPs and secure cookies. |
| `PORT`             | `8080`       | Port the app listens on inside the container.                          |
| `SESSION_SECRET`   | random       | Cookie signing secret. Set a fixed value if you run multiple replicas. |
| `DATA_DIR`         | `/app/data`  | Where the SQLite DB and uploaded/completed PDFs are stored.            |

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
- `litesign.sqlite` — documents, signers, fields, audit log
- `files/` — original uploaded PDFs and completed signed PDFs

Back it up with e.g.:
```bash
docker run --rm -v litesign_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/litesign-backup.tar.gz /data
```

## A note on the frontend libraries

The signing/editor pages load PDF.js from a CDN in the *signer's browser*
(not from the container) to render pages. The container itself makes no
outbound network calls at runtime other than SMTP. If you need signers'
browsers to avoid a CDN entirely, download `pdf.min.js` / `pdf.worker.min.js`
and swap the `<script>` tags in `public/editor.html` and `public/sign.html`
to point at local files served from `/public` instead.

## Security notes

- Exactly one admin account, gated by `ADMIN_PASSWORD` — built for a single
  team/individual sending documents out, not multi-tenant SaaS use.
- Signing links contain a random 24-character token; anyone with the link
  can sign as that signer — email delivery is the access control. Public
  signer endpoints are rate-limited, but treat links like you would a
  DocuSign envelope link.
- No inbound-facing admin surface beyond the login page and the API, both
  rate-limited; consider also putting basic IP allowlisting or a WAF in
  front if your reverse proxy supports it, especially for `/login.html`.
- This has not been audited for legal admissibility (eIDAS/ESIGN
  compliance) in regulated industries — it captures signer name, drawn/typed
  signature image, timestamp, and IP address in an appended certificate
  page and audit log, which covers most business use cases, but get your
  own legal sign-off if this needs to hold up as evidence in court.

## Stack

Node.js + Express, `better-sqlite3` (embedded, file-based), `pdf-lib` for
stamping values into PDFs, `nodemailer` for SMTP, `multer` for uploads,
`helmet` + `express-rate-limit` for internet-facing hardening, PDF.js
(browser-side, via CDN) for rendering. That's the whole dependency list.
