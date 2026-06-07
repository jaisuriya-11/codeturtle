# Getting Started

[← Docs index](./README.md)

This page gets you from a fresh clone to a working review.

## Prerequisites

- **Node.js ≥ 22.12** (floor set by `commander@15`/`ink@7`; native `fetch` and `AbortSignal.timeout` are used)
- A package manager (`npm`)
- An API key for at least one LLM provider, **or** a local server (Ollama / LM Studio)
- A GitHub and/or GitLab token (or a logged-in `gh` CLI session)

## Install (as a user)

```bash
npm install -g code-turtle
codeturtle              # bare command opens the TUI; first run walks you through setup
```

## Develop (from source)

```bash
git clone <repo>
cd turtle-code
npm install

# build the single-file CLI
npm run build           # tsup → dist/cli.js  (shebang banner added automatically)

# type-check without emitting (covers src + co-located tests)
npm run typecheck

# run the test suite (Vitest)
npm test                # add `npm run test:cov` for a coverage report

# run the built CLI
node dist/cli.js status
```

> `package.json` scripts: `build` → `tsup`, `typecheck` → `tsc --noEmit`, `test` → `vitest run`,
> `test:watch`, `test:cov`. See the [Testing](#testing) section below and
> [Contributing](../CONTRIBUTING.md#tests) for the layout and conventions.

### Test locally with `npm link`

To use your local build as a global `codeturtle` command (instead of `node dist/cli.js ...`):

```bash
npm run build        # compile first
npm link             # symlink globally — creates the `codeturtle` command

# now use it like the published package
codeturtle status
codeturtle review <PR-link>

# after more edits, just rebuild — no need to re-link
npm run build

# clean up when done
npm unlink -g code-turtle
npm install -g code-turtle   # restore the published version
```

The symlink points at `dist/`, so every `npm run build` immediately reflects in the global
command. This is the easiest way to test end-to-end (TUI, reviews, watcher) against a real
repo without publishing.

## Testing

Specs are **co-located** with the code in `src/**/__tests__/*.test.ts` and run with
[Vitest](https://vitest.dev). The seven hard invariants are locked in
`src/engine/__tests__/invariants.test.ts`; shared fixtures live in
`src/engine/__tests__/helpers/` (`tmpHome`, `fakeForge`, `fetchMock`).

```bash
npm test            # run once
npm run test:watch  # watch mode
npm run test:cov    # with coverage (thresholds enforced)
```

Coverage floors are configured in `vitest.config.ts` and enforced in CI
(`.github/workflows/ci.yml` runs typecheck + build + `test:cov` on every push/PR). When you change
engine logic or touch an invariant, add or update the matching test.

## First-run setup (TUI wizard)

Running `codeturtle` with no config launches the [`Setup`](./tui-reference.md#setuptsx) wizard:

1. **Pick a provider & model** — Gemini, Anthropic, OpenAI, OpenRouter, Groq, Ollama (local),
   LM Studio (local), or a custom OpenAI-compatible endpoint. Local servers get live model
   detection. See [`providers.ts`](./engine-reference.md#providersts).
2. **Connect a forge (once)** — a single menu with every auth method:
   - **Sign in with GitHub (OAuth device flow)** — shown when `GITHUB_CLIENT_ID` is set; you open
     `github.com/login/device`, enter the code, and Code Turtle polls for the token (refreshed
     automatically).
   - **GitHub `gh` CLI session** (reuses `gh auth token`) or **a pasted GitHub PAT** (scope: `repo`).
   - **GitLab token** (scope: `api`; set `GITLAB_URL` for self-hosted).

   You only need **one** of these. GitHub uses the **MCP** backend by default.

3. **Pick a repo to watch** — for a GitHub connection, choose one (stored as `github:owner/repo`).
4. **Finish** — you land on a "connected" screen; press Enter to finish, or choose **Connect
   another forge** if you want both GitHub and GitLab.

Everything is written to `~/.codeturtle/` with `chmod 600`. See [Configuration](./configuration.md).

## CLI subcommands

The bare command opens the TUI. For scripting, three subcommands exist
(see [`src/cli/index.ts`](../src/cli/index.ts)):

```bash
# Review a single PR/MR — paste a link OR pass flags
codeturtle review https://github.com/owner/repo/pull/42
codeturtle review --forge github --repo owner/repo --pr 42

# Show connection + model status
codeturtle status

# Wipe ALL local config (tokens, model, logs). -y skips the confirm prompt.
codeturtle reset
```

> **Note:** the top-level `README.md` mentions `start` / `logs` / `stop` daemon commands.
> Those are **not implemented** in the current `cli/index.ts` — the only subcommands are
> `review`, `status`, and `reset`. Background watching today happens inside the TUI via the
> [`watch`](./engine-reference.md#watchts) loop. Treat the daemon commands as roadmap.

## Your first review

```bash
# from the TUI: paste a PR/MR link into the input box and press enter
# or from the shell:
node dist/cli.js review https://github.com/owner/repo/pull/42
```

⚠️ **This posts real comments on the PR.** Only run it against repos you own or have been
asked to review. See the [Contributing "do not" list](../CONTRIBUTING.md#please-do-not).

## Next steps

- Understand what happens during a review → [Architecture](./architecture.md)
- Tune the reviewer per-repo → [Configuration › `.codeturtle.yml`](./configuration.md#per-repo-norms-codeturtleyml)
- Before you submit a change → [Contributing › Verify](../CONTRIBUTING.md#verification-checklist)
