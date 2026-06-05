# Configuration

[← Docs index](./README.md)

There are two places configuration lives:

1. **The local store** `~/.codeturtle/` — your tokens, model choice, and watched repos.
2. **The per-repo `.codeturtle.yml`** — review rules ("norms") that travel with the repo being
   reviewed.

Env vars override the store at runtime.

## The local store (`~/.codeturtle/`)

Set the location with `CODETURTLE_HOME`; defaults to `~/.codeturtle`. Managed by
[`config.ts`](./engine-reference.md#configts). Every file is written with `chmod 600`.

| File               | Contents                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| `credentials.json` | per-forge tokens (`token`, `method`, `user`, `url`, `backend`).                   |
| `config.json`      | the `reviewer` and `watch` sections.                                              |
| `watcher.log`      | log output (path constant; used by the roadmap daemon).                           |
| `watcher.pid`      | daemon pid (roadmap).                                                             |
| `locks/`           | per-PR lock files (10-min TTL) — see [`state.ts`](./engine-reference.md#statets). |

> **These file shapes are a compatibility contract** (carried over from the old Python version).
> Additive changes only — never rename or remove existing fields. See
> [Invariant 4](./invariants.md#4-codeturtle-file-shapes-are-a-compatibility-contract).

### `credentials.json` shape

```jsonc
{
  "github": {
    "token": "…",
    "method": "pat",
    "user": "octocat",
    "backend": "mcp",
  },
  "gitlab": {
    "token": "…",
    "method": "pat",
    "user": "you",
    "url": "https://gitlab.com",
    "backend": "rest",
  },
}
```

### `config.json` shape

```jsonc
{
  "reviewer": {
    "provider": "gemini",
    "api_key": "…",
    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "model": "gemini-2.5-flash",
    "bot_name": "Code Turtle review", // optional; auto-derived from the model otherwise
  },
  "watch": {
    "targets": ["github:owner/repo", "gitlab:group/proj"],
    "interval": 30, // seconds
  },
}
```

`codeturtle reset` (or the TUI reset overlay) wipes all of the above via `resetAll()`.

## Environment variables

Env vars take precedence over the store. (Resolution lives in
[`config.ts`](./engine-reference.md#configts) / [`forge.ts`](./engine-reference.md#forgets).)

| Variable                                            | Effect                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `CODETURTLE_HOME`                                   | override the store directory.                                        |
| `GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN` | forge token fallback when not in the store.                          |
| `GITHUB_BACKEND`                                    | `rest` forces the GitHub REST client; anything else → MCP (default). |
| `GITHUB_URL`                                        | GitHub REST API base (default `https://api.github.com`).             |
| `GITLAB_URL`                                        | GitLab base URL (self-hosted).                                       |
| `REVIEWER_API_KEY` / `GEMINI_API_KEY`               | reviewer key (the latter is a legacy fallback).                      |
| `REVIEWER_BASE_URL`                                 | reviewer endpoint (any OpenAI-compatible URL).                       |
| `REVIEWER_MODEL`                                    | reviewer model id.                                                   |
| `REVIEWER_BOT_NAME`                                 | display name on posted comments.                                     |
| `MAX_DIFF_CHARS`                                    | diff budget sent to the LLM (default 40000).                         |
| `MAX_CONTEXT_FILES`                                 | max context files in the bundle (default 12).                        |
| `MAX_CONTEXT_CHARS`                                 | max total context chars (default 40000).                             |
| `CT_DEBUG`                                          | log the first 800 chars of the raw model response.                   |

For local servers (Ollama, LM Studio) the reviewer works with no API key as long as the base URL
contains `localhost`.

## Per-repo norms (`.codeturtle.yml`)

Drop a `.codeturtle.yml` at the root of the repo **being reviewed** to tune the reviewer for that
team. It's read at the MR head commit and merged over the built-in defaults
([`norms.ts`](./engine-reference.md#normsts)).

```yaml
# .codeturtle.yml — all keys optional; shown with their defaults
confidence_threshold: 0.7 # findings below this are dropped before posting
max_findings: 25 # hard cap per review
exclude: # globs (supports ** and *) excluded from review
  - "**/*.lock"
  - "**/*.min.js"
  - "**/__generated__/**"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"
categories: # toggle which categories the reviewer reports
  security: true
  bug: true
  perf: true
  style: true
  maintainability: true
guidelines: | # free text injected into the system prompt
  Review like a careful senior engineer. Prioritise security, then correctness, …
examples: # concrete things this team cares about
  - bad: "catch (e) {}"
    why: "swallowed errors hide failures"
```

### Security: what repo config CANNOT do

`norms.ts` **strips `agent` and `key_ref`** from the parsed YAML before use. A pull-request author
(or a fork) must never be able to redirect the reviewer to a different model/endpoint or
exfiltrate your API key through a committed config file. **Never add a way for repo files to set
URLs, keys, or commands.** This is a hard security invariant — see
[Invariant 2](./invariants.md#2-security-repo-config-is-untrusted).

---

[← Docs index](./README.md) · Next: [Hard Invariants](./invariants.md)
