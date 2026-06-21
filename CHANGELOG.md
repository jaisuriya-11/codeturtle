# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- Background daemon (`codeturtle start` / `logs` / `stop`) — currently watching runs inside the TUI.
- Per-language norm packs auto-selected by file type; a TUI manager for installed packs.

## [2.2.1] - 2026-06-21

### Fixed

- **Review crashed on compat servers that return a 200 body without `choices`.** Some OpenAI-compatible endpoints (e.g. OpenRouter free tier under rate limiting) return a `{ error }` payload with HTTP 200 and no `choices` array; the reviewer threw `Cannot read properties of undefined (reading '0')` and failed the PR. It now degrades to an empty result, leaving the PR clean instead of failed.

## [2.2.0] - 2026-06-21

### Added

- **Code context scrolling and focus navigation.** Use Tab to switch focus to the code pane, and up/down arrows (or j/k keys) to scroll up and down the codebase with a green indicator pointing to the focused line, while keeping the red/yellow/cyan highlight for the error line.
- Full file fetching support in `fetchCodeSnippet` to allow scrolling beyond the original 11-line window around findings.

## [2.1.1] - 2026-06-17

### Fixed

- **Reviewer missed deletion-induced bugs.** The prompt instructed the model to flag only added
  (`+`) lines and "never report an issue that lives only on a `-` line", so a deletion that breaks
  surviving code (e.g. removing `const { x } = y` while `x` is still used) was uncatchable by design.
  The base prompt and the logic focus pass now carve a deletion-impact exception; evidence may quote
  the removed `-` line (it is present in the diff text, so the anti-fabrication gate still holds).
- A label permission gap (e.g. a GitHub App without Issues access → `403` on `issue_read`/`issue_write`)
  no longer marks an already-posted review as failed — labels are cosmetic and now soft-fail with a log.
- `package.json` repository/homepage/bugs URLs corrected to the renamed `CodeTurtle` repo, fixing npm
  provenance validation during release.

### Added

- `force` re-review for explicit user triggers (TUI `enter`, `review` command): steals a stale/held
  lock and ignores supersede, so a killed run's leftover lock no longer blocks a manual re-review.
  The watcher never forces — automated reviews keep their one-at-a-time discipline (invariant 7).
- Under `CT_DEBUG`, findings dropped by validation are logged, making an unexpected `found=0` diagnosable.

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
