# Getting Started

[← Docs index](./README.md)

This page gets you from a fresh clone to a working review.

## Prerequisites

- **Node.js ≥ 18** (the build targets `node18`; native `fetch` and `AbortSignal.timeout` are used)
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
npx tsup                # → dist/cli.js  (shebang banner added automatically)

# type-check without emitting
npx tsc --noEmit

# run the built CLI
node dist/cli.js status
```

> `package.json` scripts: `build` → `tsup`, `prepublishOnly` → `tsup`. There is no real
> `test` script yet (it intentionally exits 1).

## First-run setup (TUI wizard)

Running `codeturtle` with no config launches the [`Setup`](./tui-reference.md#setuptsx) wizard:

1. **Pick a provider & model** — Gemini, Anthropic, OpenAI, OpenRouter, Groq, Ollama (local),
   LM Studio (local), or a custom OpenAI-compatible endpoint. Local servers get live model
   detection. See [`providers.ts`](./engine-reference.md#providersts).
2. **Connect GitHub** — reuse your `gh auth token` session automatically, or paste a personal
   access token (scope: `repo`). GitHub uses the **MCP** backend by default.
3. **Connect GitLab** (optional) — paste a PAT (scope: `api`). Set `GITLAB_URL` for self-hosted.
4. **Pick a repo to watch** — stored as `forge:repo` targets, e.g. `github:owner/repo`.

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
