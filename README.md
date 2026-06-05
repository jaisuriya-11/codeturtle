# 🐢 Code Turtle

Local AI code reviewer for GitHub & GitLab. Any model — cloud or local. No server, no webhooks, no cloud.

## Install

```bash
npm install -g code-turtle
```

## Use

```bash
codeturtle          # opens the TUI — first run walks you through setup
```

First run:
1. **Pick a provider** — Gemini, Claude, OpenAI, OpenRouter, Groq, Ollama (local), LM Studio (local), or any custom OpenAI-compatible endpoint. Local servers get live model detection.
2. **Connect GitHub** — sign in with GitHub (OAuth device flow, set `GITHUB_CLIENT_ID`), use your `gh` CLI session automatically, or paste a PAT. GitLab optional.
3. **Pick repos to watch** — `github:owner/repo gitlab:12345`

Then the dashboard watches your repos: every new PR and every push gets reviewed automatically. Inline comments + a summary review land on the PR, deduped across runs.

```
🐢 Code Turtle v2.0 — local AI code reviewer

╭──────────────────────────────────────────────────────╮
│ ⠧ watching · github:you/repo · every 60s             │
│ github ✓ you · model gemini-2.5-flash                │
╰──────────────────────────────────────────────────────╯

8:02:52 pm  new PR github:you/repo#42 — queueing review

w pause watcher · m model · s setup · q quit
```

## Scripting / daemon

```bash
codeturtle review --forge github --repo owner/repo --pr 42   # one-off review
codeturtle start          # background daemon (survives terminal close)
codeturtle logs -f
codeturtle stop
codeturtle status
```

## How it reviews

- **Smart context**: not just the diff — pulls changed files, their imports, callers, and tests from the repo at the head commit
- **GitHub via MCP**: all GitHub I/O goes through GitHub's official MCP server; findings post as one native PR review (inline comments + summary)
- **Custom norms**: drop a `.codeturtle.yml` in the target repo to tune guidelines, excludes, confidence threshold (reviewer/key overrides from repo files are ignored for security)
- **Idempotent**: re-reviews after a push only post new findings (±3 line tolerance for anchor jitter)

## Config

Everything lives in `~/.codeturtle/` — `credentials.json`, `config.json`, `watcher.log`. Env vars (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `REVIEWER_API_KEY`, `REVIEWER_BASE_URL`, `REVIEWER_MODEL`) override the store.

## Documentation

Full developer docs live in [`docs/`](docs/README.md) — architecture, a per-module engine
reference, the TUI components, configuration, and the hard invariants. Start at
[`docs/README.md`](docs/README.md).

## Contributing

Contributions are welcome! Please check out [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md) for guidelines on how to get started.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

