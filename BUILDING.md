# Building LiteSign

Requires Node.js 22 or newer. There is no frontend build step: plain HTML, CSS and ES modules in `public/`, with the server in `server/`.

## Commands

```sh
npm install
ADMIN_PASSWORD=dev-password-123 BASE_URL=http://localhost:8080 npm start
npm test                       # end-to-end API tests against a throwaway data directory
docker build -t litesign .     # the container image, as CI builds it
```

CI runs `npm ci`, `npm test` and the Docker build.

## Source layout

| Path | What |
| --- | --- |
| `server/server.js` | Express app, routes, security headers and rate limits |
| `server/auth.js` | Admin login and sessions |
| `server/db.js` | SQLite schema and automatic upgrades |
| `server/stamp.js` | Stamps signatures into the PDF and appends the certificate |
| `server/mailer.js` | Signing and completion emails |
| `server/config.js` | Environment variables |
| `public/js/editor.js` | Placing fields |
| `public/js/sign.js` | The signer's page |
| `public/js/pdfview.js` | PDF rendering with pdf.js |
| `public/js/theme.js` | Light, dark and system theme |

**Stack:** Node.js and Express 5, `better-sqlite3`, `pdf-lib` (stamping PDFs), `pdfjs-dist` (rendering in the browser, served by the app), `nodemailer`, `multer`, `helmet` and `express-rate-limit`.
