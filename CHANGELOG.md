# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- ESLint (typescript-eslint + react-hooks) and Prettier with CI enforcement.
- Release workflow: npm publish via Trusted Publisher (OIDC, automatic provenance) on version tags.
- Node 22/24 CI test matrix.
- Dashboard: PR lists auto-refresh in place on the watch cadence (raised/closed/merged
  PRs stay current), plus manual refresh (`R`) for instant updates.
- GitHub App sign-in: reviews post as `<app-slug>[bot]` instead of the user. The CLI
  signs an RS256 JWT with the app's private key and mints/refreshes installation
  tokens locally — still no server, no webhooks. Key stored in `~/.codeturtle` (0600).

### Fixed

- `package.json` metadata: removed phantom `main` entry, added repository/author/keywords.
- Declared Node engine corrected to `>=22.12.0` (the actual floor required by
  `commander@15` and `ink@7`; `>=18` was inaccurate).

## [2.0.0]

- TypeScript rewrite: CLI/TUI (`codeturtle`) reviewing GitHub PRs and GitLab MRs
  with any OpenAI-compatible model. Python implementation removed.
- Multi-pass review, provider key validation, watcher and lock failsafes.
