# Contributing to LiteSign

Thanks for helping! A few things to know first.

- **Bugs and ideas:** open an issue. For PDF problems, attach a PDF that shows it if you can (not a real signed document).
- **Branches:** open pull requests against `development`. `main` only gets tested releases.
- **Checks:** `npm test` and the Docker build must pass. CI runs both. See [BUILDING.md](BUILDING.md).
- **Security first:** LiteSign is meant to face the internet. Don't add inline scripts, CDNs or third-party requests, and keep rate limiting and validation on public routes. Changes to signing, stamping or the audit trail need tests.
- **Keep it light:** one container, one SQLite file, no frontend build step. Please discuss new dependencies in an issue first.
- **Licence:** contributions are accepted under the project's licence (AGPL-3.0-or-later). Third-party code must be AGPL-compatible.
- **Security issues:** please report them privately, see [SECURITY.md](SECURITY.md).
