# AGENTS.md

Self-hosted PDF e-signing. Node.js 22 + Express 5 + better-sqlite3 + pdf-lib, one Docker container. Frontend is plain HTML, CSS and ES modules in `public/` with no build step.

## Commands

- Tests: `npm test` (end-to-end API tests; spawns the server on a random port with a temporary `DATA_DIR`)
- Run: `ADMIN_PASSWORD=dev-password-123 BASE_URL=http://localhost:8080 npm start`
- Image: `docker build -t litesign .`
- More in [BUILDING.md](BUILDING.md); settings in [docs/guide.md](docs/guide.md)

## Conventions

- Branches: work on `development`; `main` only gets tested releases.
- It's internet-facing. Keep the strict Content-Security-Policy: no inline scripts, no CDNs, no third-party requests. Every script is served by the app.
- Public signing routes are rate-limited and validate everything (uploads, field positions, signature images). New public routes need the same.
- The signing link token is the signer's only credential. Never log it or expose it to other signers.
- The database upgrades itself on start-up; old databases must keep working.
- Light, dark and system themes on every page, defaulting to the system, with the choice remembered.
- Keep README.md short. Admin how-to goes in `docs/guide.md`, developer detail in BUILDING.md.

## Traps

- The server refuses to start with an empty `ADMIN_PASSWORD` or `changeme`.
- For local test copies, use a throwaway `DATA_DIR` and a free high port.
- `TRUST_PROXY` must match the number of proxies in front, or signer IPs in the audit trail and certificate will be wrong.

## Left for later on purpose

Signing order, reminders and expiry, multiple admin users, and a handwriting font for typed signatures.
