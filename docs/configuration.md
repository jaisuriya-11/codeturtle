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

| File               | Contents                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `credentials.json` | per-forge tokens (`token`, `method`, `user`, `url`, `backend`).                                                               |
| `config.json`      | the `reviewer`, `watch`, and `norms` sections.                                                                                |
| `norms/`           | custom norm **packs** (`*.yml`) and code **transforms** (`*.mjs`) — see [Custom norms](#custom-norms-global--packs--plugins). |
| `watcher.log`      | log output (path constant; used by the roadmap daemon).                                                                       |
| `watcher.pid`      | daemon pid (roadmap).                                                                                                         |
| `locks/`           | per-PR lock files (10-min TTL) — see [`state.ts`](./engine-reference.md#statets).                                             |

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

When GitHub is connected via **OAuth device flow** (`method: "oauth"`), the `github` entry also
carries `refresh_token`, `expires_at` (ms epoch), and the `client_id` used to obtain it. The
access token is refreshed automatically before it expires; you never manage it by hand.

### GitHub authentication methods

| `method` | How it's obtained                                                      | Notes                                                                             |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pat`    | A personal access token you paste, or your `gh auth token` CLI session | Long-lived; you manage rotation.                                                  |
| `oauth`  | "Sign in with GitHub" device flow (needs `GITHUB_CLIENT_ID`)           | Tokens may expire and are refreshed automatically via the stored `refresh_token`. |

> **Device flow requires a registered GitHub OAuth App or GitHub App** whose client id you supply
> via `GITHUB_CLIENT_ID`. For refresh to work, the app must issue **expiring** user tokens (a
> GitHub App, or an OAuth App with "Expire user authorization tokens" enabled). The app needs
> read/write access to pull requests on the repos you review.

### Registering a GitHub App for OAuth

The `client_id` comes from a GitHub app you register once. Because Code Turtle is built for
**expiring tokens with refresh**, a **GitHub App** is the right choice — it issues short-lived user
tokens _plus_ a refresh token and supports device flow. (A plain OAuth App also yields a client id
and works, but its tokens never expire and have no refresh token, so the refresh path stays
dormant.)

**Recommended — GitHub App:**

1. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (org-owned: **Org Settings → Developer settings → GitHub Apps**).
2. **Name** — anything (e.g. "My Code Turtle"). **Homepage URL** — any URL.
3. **Callback URL** — the form requires one; any URL works (device flow ignores it).
4. **Enable Device Flow** — ✅ check this. _(The key setting.)_
5. **Webhook** — uncheck **Active** (Code Turtle is webhook-free).
6. **Repository permissions:** Pull requests → **Read & write**; Contents → **Read-only**
   (fetch files for review context); Metadata → **Read-only** (mandatory).
7. Leave **"Expire user authorization tokens"** checked — this is what produces the refresh token.
8. **Create**. The **Client ID** (e.g. `Iv23li…`) is shown on the app page.
9. **Install App** (left sidebar) onto your account/org and grant the repos you want reviewed.

**Simpler — OAuth App** (non-expiring, no refresh): **Settings → Developer settings → OAuth Apps
→ New OAuth App** → fill name/homepage/callback → create → enable **Device Flow** → copy the
**Client ID**.

> The **Client ID is public** — safe to put in an env var or commit. A **client secret is not
> needed**: device flow doesn't use one, and Code Turtle never reads it. Never store secrets
> outside `~/.codeturtle` (see [Invariant 3](./invariants.md#3-secrets-stay-in-codeturtle-with-chmod-600)).

**Using it:**

```bash
# bash / zsh
GITHUB_CLIENT_ID="Iv23li…" codeturtle
```

```powershell
# PowerShell
$env:GITHUB_CLIENT_ID = "Iv23li…"
codeturtle
```

Pick **"Sign in with GitHub (OAuth)"**, open `github.com/login/device`, and enter the shown code.
After the first sign-in the client id is also persisted to `credentials.json`, so later runs work
without the env var.

> **MCP caveat:** it's unconfirmed whether the default Copilot MCP backend accepts a GitHub
> App / OAuth user token. If a review fails on auth, set `GITHUB_BACKEND=rest` — the REST backend
> accepts these tokens.

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
  "norms": {
    // your personal review baseline, applied to EVERY repo (see "Custom norms" below).
    // same keys as .codeturtle.yml, plus `use` to activate packs/transforms by name.
    "use": ["security-strict"],
    "confidence_threshold": 0.65,
  },
}
```

`codeturtle reset` (or the TUI reset overlay) wipes all of the above via `resetAll()`.

## Environment variables

Env vars take precedence over the store. (Resolution lives in
[`config.ts`](./engine-reference.md#configts) / [`forge.ts`](./engine-reference.md#forgets).)

| Variable                                            | Effect                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `CODETURTLE_HOME`                                   | override the store directory.                                                           |
| `GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN` | forge token fallback when not in the store.                                             |
| `GITHUB_BACKEND`                                    | `rest` forces the GitHub REST client; anything else → MCP (default).                    |
| `GITHUB_CLIENT_ID`                                  | GitHub OAuth/App client id that enables the "Sign in with GitHub" device flow in setup. |
| `GITHUB_URL`                                        | GitHub REST API base (default `https://api.github.com`).                                |
| `GITLAB_URL`                                        | GitLab base URL (self-hosted).                                                          |
| `REVIEWER_API_KEY` / `GEMINI_API_KEY`               | reviewer key (the latter is a legacy fallback).                                         |
| `REVIEWER_BASE_URL`                                 | reviewer endpoint (any OpenAI-compatible URL).                                          |
| `REVIEWER_MODEL`                                    | reviewer model id.                                                                      |
| `REVIEWER_BOT_NAME`                                 | display name on posted comments.                                                        |
| `MAX_DIFF_CHARS`                                    | diff budget sent to the LLM (default 40000).                                            |
| `MAX_CONTEXT_FILES`                                 | max context files in the bundle (default 12).                                           |
| `MAX_CONTEXT_CHARS`                                 | max total context chars (default 40000).                                                |
| `CT_DEBUG`                                          | log the first 800 chars of the raw model response.                                      |

For local servers (Ollama, LM Studio) the reviewer works with no API key as long as the base URL
contains `localhost`.

## Per-repo norms (`.codeturtle.yml`)

Drop a `.codeturtle.yml` at the root of the repo **being reviewed** to tune the reviewer for that
team. It's read at the MR head commit and layered on top of the built-in defaults and your global
norms ([`norms.ts`](./engine-reference.md#normsts)).

```yaml
# .codeturtle.yml — all keys optional; shown with their defaults
extends: [security-strict] # pull in installed global packs by name (see "Custom norms")
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

## Custom norms (global + packs + plugins)

Norms are resolved in **layers**, lowest → highest precedence — the **project wins** on any
overlapping scalar:

```
1. built-in DEFAULTS                       (norms.ts)
2. global norms        config.json `norms` section        → applied to every repo
3. global-activated packs   `norms.use: [name]`           → ~/.codeturtle/norms/<name>.yml
4. repo-activated packs     .codeturtle.yml `extends: [name]`  (installed packs, by name only)
5. repo inline norms        .codeturtle.yml top-level fields    ← wins
   then: code transforms    global-activated *.mjs only         (run on the merged result)
```

How fields combine across layers: `confidence_threshold` / `max_findings` are **last-writer-wins**;
`categories` shallow-merge; `exclude` and `examples` **accumulate** (union / concat); `guidelines`
**append** (each layer's text is kept and labelled, so a one-line repo note never wipes your
baseline).

### Packs — reusable declarative rule sets

A **pack** is a named `.yml` file in `~/.codeturtle/norms/` with the same keys as `.codeturtle.yml`
(plus an optional `name:`; the filename is the fallback name):

```yaml
# ~/.codeturtle/norms/security-strict.yml
name: security-strict
confidence_threshold: 0.6
categories: { security: true }
guidelines: |
  Flag any secret in code, injection sink, or missing authz check.
```

Activate it **globally** for every repo via `config.json` → `"norms": { "use": ["security-strict"] }`,
or let a repo opt in with `extends: [security-strict]` in its `.codeturtle.yml`. A repo `extends`
resolves **by name only** against packs already installed on your machine — an unknown or path-like
name is silently ignored, never fetched.

### Transforms — code plugins (power users)

A **transform** is a `.mjs` module in `~/.codeturtle/norms/` that adjusts the merged norms
programmatically:

```js
// ~/.codeturtle/norms/scale-by-size.mjs
export default {
  name: "scale-by-size",
  transform(norms, ctx) {
    if ((ctx.diffLines ?? 0) > 500) norms.maxFindings = 50; // be thorough on big diffs
    return norms;
  },
};
```

Transforms run **only** when listed in the **global** `norms.use` — a repo can never trigger one.
`ctx` is `{ forge, projectId, mr, diffLines }` (read-only facts; no client handles).

> ⚠️ **A transform runs code with your privileges.** It lives in the same trusted, `chmod 600`
> store as your tokens — treat dropping a `.mjs` here like installing a CLI plugin. This is exactly
> why a repo can't activate one.

### Security: what repo config CANNOT do

`norms.ts` **strips `agent` and `key_ref`** from the parsed YAML before use, restricts a repo's
`extends` to **safe bare names** that map to already-installed packs, and **never lets a repo run a
transform**. A pull-request author (or a fork) must never be able to redirect the reviewer to a
different model/endpoint, exfiltrate your API key, escape the norms dir, or execute code through a
committed config file. **Never add a way for repo files to set URLs, keys, or commands, or to run
code.** This is a hard security invariant — see
[Invariant 2](./invariants.md#2-security-repo-config-is-untrusted).

---

[← Docs index](./README.md) · Next: [Hard Invariants](./invariants.md)
