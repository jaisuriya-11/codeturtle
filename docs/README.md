# Code Turtle — Documentation

Welcome. This folder is the human-facing companion to [`AGENTS.md`](../AGENTS.md) (the
canonical guide for AI coding agents). If you're a new contributor, start here.

**Code Turtle** (`codeturtle`) is an npm-distributed CLI/TUI that reviews GitHub PRs and
GitLab MRs with any OpenAI-compatible LLM — cloud or local. There is no server and no
webhooks: reviews run entirely on the user's machine, triggered by pasting a PR link in the
TUI or by polling watched repos.

## Read in this order

| #   | Doc                                           | What you'll learn                                                     |
| --- | --------------------------------------------- | --------------------------------------------------------------------- |
| 1   | [Getting Started](./getting-started.md)       | Install, build, run, and do your first review                         |
| 2   | [Architecture](./architecture.md)             | The big picture: layers, modules, and the review data flow            |
| 3   | [Engine Reference](./engine-reference.md)     | Every module in `src/engine/` — what it does and its public surface   |
| 4   | [TUI Reference](./tui-reference.md)           | The React + Ink components in `src/tui/`                              |
| 5   | [Configuration](./configuration.md)           | `~/.codeturtle` store, env vars, and per-repo `.codeturtle.yml` norms |
| 6   | [Hard Invariants](./invariants.md)            | The seven rules you must not break — security, idempotency, locking   |
| 7   | [Custom Norms Guide](./custom-norms-guide.md) | Layered norms: global + packs + code transforms, with examples        |
| 8   | [Contributing](../CONTRIBUTING.md)            | Coding standards, verification steps, and the "do not" list           |
| 9   | [Glossary](./glossary.md)                     | Domain terms: forge, norms, finding, context bundle, marker           |

## 30-second mental model

```
  cli / tui  ──►  pipeline.runReview(job)  ──►  forge client  (GitHub MCP / GitLab REST)
                          │                            │
                          │                            ├─ getMr / getDiffs / getFile
                          ▼                            │
                     bundler  ◄───────────────────────┘   (changed files + imports + callers + tests)
                          │
                          ▼
                     reviewer  ──►  LLM (OpenAI-compatible)  ──►  strict-validated findings
                          │
                          ▼
                      poster   ──►  inline comments + one summary review + labels
```

Everything funnels through **one entrypoint**: `pipeline.runReview()`. The TUI and the CLI
both call it; the watcher calls it on every new PR / push. See
[Architecture](./architecture.md) for the full walk-through.

## Project facts

- **Language:** TypeScript (strict), ESM only, Node ≥ 22.12
- **TUI:** React + [Ink](https://github.com/vadimdemedes/ink)
- **GitHub I/O:** official GitHub remote MCP server (default) — REST fallback available
- **GitLab I/O:** REST v4
- **LLM:** the `openai` SDK pointed at any compatible base URL
- **Build:** [`tsup`](https://tsup.egoist.dev/) → `dist/cli.js` (single bin)
- **Tests:** [Vitest](https://vitest.dev) — specs co-located in `src/**/__tests__/`, invariants locked in `invariants.test.ts`, coverage enforced in CI. See [Getting Started › Testing](./getting-started.md#testing)

> These docs were generated from the source on the `dev-sam` branch. When code and docs
> disagree, the code wins — please open a PR to fix the doc.
