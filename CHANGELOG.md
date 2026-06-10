# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- Background daemon (`codeturtle start` / `logs` / `stop`) — currently watching runs inside the TUI.
- Per-language norm packs auto-selected by file type; a TUI manager for installed packs.

## [2.1.0] - 2026-06-10

### Added

- **Layered custom norms.** Norms now resolve as defaults ← personal **global** norms
  (`config.json` `norms` section) ← repo `.codeturtle.yml` (project wins). Reusable rule sets ship
  as **packs** (`~/.codeturtle/norms/*.yml`); power users can write **code transforms** (`*.mjs`).
  Repos opt into installed packs by name via `extends`. See the
  [Custom Norms Guide](docs/custom-norms-guide.md).
- GitHub OAuth device-flow sign-in with automatic token refresh (set `GITHUB_CLIENT_ID`); a unified
  "connect a forge once" setup flow.
- GitHub App sign-in: reviews post as `<app-slug>[bot]`. The CLI signs an RS256 JWT locally and
  mints/refreshes installation tokens — still no server, no webhooks. Key stored in `~/.codeturtle` (0600).
- Push reviews: a branch push with no open PR is reviewed via commit comments (`runPushReview`).
- **Vitest** test suite co-located in `src/**/__tests__/`, with the seven hard invariants locked in
  `invariants.test.ts`; coverage enforced in CI.
- ESLint (typescript-eslint + react-hooks) and Prettier with CI enforcement; Node 22/24 CI matrix.
- Release workflow: npm publish via Trusted Publisher (OIDC, automatic provenance) on version tags.
- Dashboard: PR lists auto-refresh on the watch cadence, plus manual refresh (`R`).

### Security

- A repo's `.codeturtle.yml` can never run code: `extends` resolves to installed packs by **safe
  bare name only** (no path traversal), and transforms (`*.mjs`) run **only** when the global
  config activates them. `agent`/`key_ref` are still stripped.

### Fixed

- `package.json` metadata: removed phantom `main` entry, added repository/author/keywords.
- Declared Node engine corrected to `>=22.12.0` (the floor required by `commander@15` and `ink@7`).

## [2.0.0]

- TypeScript rewrite: CLI/TUI (`codeturtle`) reviewing GitHub PRs and GitLab MRs
  with any OpenAI-compatible model. Python implementation removed.
- Multi-pass review, provider key validation, watcher and lock failsafes.
