# Contributing to Code Turtle 🐢

Thank you for your interest in contributing to Code Turtle! We welcome community contributions to help improve this local AI code reviewer.

Before you begin, please read this document and our [Code of Conduct](CODE_OF_CONDUCT.md).

> 📚 **New here? Start with the [developer docs](docs/README.md).** They cover the
> architecture, a per-module engine reference, the TUI components, configuration, and the hard
> invariants in depth. This file is the quick-start; the docs are the deep dive.

---

## Codebase Architecture

Code Turtle is built with TypeScript, Node.js (ESM), and React/Ink. It is structured into distinct areas:

- `src/cli/`: The Commander-based command-line interface entry points.
- `src/engine/`: Core business logic (forge integrations, AI reviewer, context bundler, watch loop). **No UI imports allowed here.**
- `src/tui/`: React/Ink components for the TUI. **No business logic or API calls here.**
- `~/.codeturtle/`: User configuration and data directory.

Everything funnels through a single review entrypoint — `pipeline.runReview(job)` — which the
CLI, the TUI paste box, and the watcher all call. See the
[architecture overview](docs/architecture.md) for the full data-flow diagram.

For a detailed map of the files and components, see the [AGENTS.md](AGENTS.md) guide (canonical
for AI agents) or the human-friendly [Engine Reference](docs/engine-reference.md) and
[TUI Reference](docs/tui-reference.md).

---

## Development Setup

### Prerequisites

- Node.js (>= 22.12)
- npm (or your preferred package manager)

### Installation

1.  Fork and clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```

### Building and Running

Code Turtle compiles from TypeScript to a single ESM bundle using `tsup`.

- **Build the project:**
  ```bash
  npm run build # runs tsup
  ```
- **Run the compiled CLI:**
  ```bash
  node dist/cli.js status
  ```
- **Run a review locally:**
  ```bash
  node dist/cli.js review <PR-link>
  ```

### Testing locally with `npm link`

To test your local changes as if `codeturtle` were globally installed:

```bash
# 1. Build first
npm run build

# 2. Link the package globally — this creates a global `codeturtle` symlink
npm link

# 3. Now `codeturtle` uses your local build
codeturtle status
codeturtle review <PR-link>

# 4. When you make more changes, rebuild and the symlink picks them up
npm run build

# 5. To undo the link and restore the published version
npm unlink -g code-turtle
npm install -g code-turtle
```

> The symlink points at your `dist/` output, so you **must rebuild** after each change.
> No need to re-link — just `npm run build` and the global `codeturtle` command updates.

---

## Coding Standards

To maintain a clean and reliable codebase, please adhere to the following standards:

1.  **Strict TypeScript**: Avoid `any` in exported signatures.
2.  **ESM Compliance**: All relative imports **must** end with the `.js` extension (e.g., `import { runReview } from './engine/pipeline.js';`), even when importing from `.ts` or `.tsx` files.
3.  **Engine/TUI Separation**: Keep the business logic completely decoupled from React/Ink components. TUI components should call engine functions and not make raw API/network calls.
4.  **Network Calls**: Use native `fetch` with `AbortSignal.timeout(...)`. Avoid adding external networking libraries like Axios.
5.  **Lean Dependencies**: Code Turtle is installed globally via `npm i -g`. Keep the package size lean; discuss adding new dependencies with the maintainers first.
6.  **TUI Styles**: Keep TUI styling consistent with our theme. Use colors defined in `src/tui/theme.tsx` (`ACCENT` / `DIM`). Keep text short and avoid exclamation marks.
7.  **Error Handling**: "Soft" forge calls return `null` and log; pipeline-level failures mark the PR failed and release the lock in a `finally`. **One PR's failure must never kill the watcher.**
8.  **Config Keys**: Don't invent new config keys when an existing section fits (`reviewer`, `watch`).

---

## Hard Invariants

Some rules are **not** stylistic — breaking them is a bug. Please read the full
[Hard Invariants](docs/invariants.md) doc before touching the engine. In short:

1.  **Markers are the idempotency system.** Every posted artifact carries a hidden marker
    (`<!-- ct:f:FILE:LINE -->`, `<!-- ct:review -->`, `<!-- ct:status -->`). Dedup uses a ±3 line
    tolerance. Never post without a marker; never change marker formats; never remove the tolerance.
2.  **Repo config is untrusted.** `norms.ts` strips `agent` and `key_ref` from a repo's
    `.codeturtle.yml`. Never let repo files set URLs, keys, or commands.
3.  **Secrets stay in `~/.codeturtle/` (chmod 600).** Never log tokens/keys or write them elsewhere.
4.  **The `~/.codeturtle` file shapes are a compatibility contract** — additive changes only.
5.  **GitHub MCP has no comment-edit tool** — the summary posts as one review via the
    pending-review flow. One review per run.
6.  **Reviewer output is hostile input** — `reviewer.ts` validates every finding and drops invalid ones.
7.  **One review at a time per PR** — everything must go through `pipeline.runReview`, which holds
    the lock and supersedes by head SHA.

---

## Verification Checklist

Before submitting your pull request, please verify:

```bash
# 1. Type-check (covers src + co-located tests), must be clean
npm run typecheck

# 2. Run the test suite (Vitest), must pass
npm test          # add `npm run test:cov` for a coverage report

# 3. Ensure the bundler builds successfully
npm run build

# 4. Smoke-test the built CLI
node dist/cli.js status
```

### Tests

Specs live next to the code in `src/**/__tests__/*.test.ts` (Vitest). The seven hard invariants
above are locked in `src/engine/__tests__/invariants.test.ts`. **When you change engine logic or
touch an invariant, add or update the matching test.** Shared fixtures live in
`src/engine/__tests__/helpers/` (`tmpHome`, `fakeForge`, `fetchMock`). CI runs typecheck + build +
tests on every push/PR (`.github/workflows/ci.yml`).

> To smoke-test a TUI component headlessly, use
> [`ink-testing-library`](https://github.com/vadimdemedes/ink-testing-library) in a throwaway
> `src/tui-smoke.tsx` run with `npx tsx` (`render(...)` → `lastFrame()`), then delete it.

### Please do NOT

- Run reviews against repos you weren't asked to — **reviews post real comments.**
- Commit, push, publish, or open PRs on someone's behalf without being asked.
- Store anything outside `~/.codeturtle/`, or weaken its 0600 perms.
- Re-introduce Python (v2.0 is intentionally TS-only), add webhooks/a server (local-first is the
  core promise), or bump deps while fixing an unrelated bug.

---

## Submitting a Pull Request

1.  Create a branch for your changes: `git checkout -b feature/my-cool-feature` or `bugfix/issue-description`.
2.  Make your changes following the [Coding Standards](#coding-standards).
3.  Commit your changes with clear, descriptive commit messages.
4.  Verify your changes build and compile correctly.
5.  Push to your fork and submit a Pull Request to the main repository.

Thank you for helping make Code Turtle better! 🐢
