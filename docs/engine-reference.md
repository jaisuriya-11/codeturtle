# Engine Reference

[← Docs index](./README.md) · [Architecture](./architecture.md)

The engine is all of the business logic. **No module here imports from `tui/` or
`ink`/`react`.** Errors in "soft" forge calls return `null` and log; pipeline-level failures
mark the PR failed and always release the lock in a `finally`.

> Each module has co-located [Vitest](https://vitest.dev) specs in `src/engine/__tests__/`
> (e.g. `prLink.test.ts`). The seven hard invariants are locked in `invariants.test.ts`. See
> [Getting Started › Testing](./getting-started.md#testing).

Jump to: [pipeline](#pipelinets) · [types](#typests) · [config](#configts) ·
[providers](#providersts) · [prLink](#prlinkts) · [forge](#forgets) · [forgeMcp](#forgemcpts) ·
[norms](#normsts) · [repoFiles](#repofilests) · [bundler](#bundlerts) · [reviewer](#reviewerts) ·
[poster](#posterts) · [state](#statets) · [watch](#watchts)

---

## `pipeline.ts`

The single review entrypoint — **everything goes through `runReview`.**

```ts
runReview(job: Job, log?: Logger): Promise<void>
```

Sequence (see [Architecture › data flow](./architecture.md#the-review-data-flow) for the full diagram):

1. `state.isLatest()` — bail if a newer head SHA superseded this job.
2. `state.acquireLock()` — bail if this PR is already being reviewed.
3. Get the forge client, post a "reviewing…" status note.
4. `getMr` → `getDiffs` → `loadNorms` → `applyExcludes`. Empty diffs / all-excluded → status note and return.
5. `buildContext` → `review` (LLM).
6. Filter findings by `confidenceThreshold`, cap at `maxFindings`, then `snapFindings`.
7. `finalize` to post.
8. `finally`: `forge.close()` + `state.releaseLock()`. A failure calls `markFailed` (best-effort).

`formatDiff()` (local) concatenates per-file diffs up to `limits.maxDiffChars`, appending a
`(truncated — diff too large)` marker if it overflows.

> One PR's failure must never kill the watcher — that's why the whole body is wrapped and the
> lock is released in `finally`. See [Invariant 7](./invariants.md#7-one-review-at-a-time-per-pr).

---

## `types.ts`

Shared types — no logic except the one render helper.

| Type            | Notes                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Forge`         | `"github" \| "gitlab" \| "bitbucket"` (bitbucket is declared but not yet wired).                                                                                                                                           |
| `Job`           | `{ forge, projectId, prNumber, headSha }` — the unit of work for `runReview`.                                                                                                                                              |
| `Severity`      | `critical \| warning \| info`.                                                                                                                                                                                             |
| `Category`      | `security \| bug \| perf \| style \| maintainability`.                                                                                                                                                                     |
| `Finding`       | One review comment: file, line, severity, category, `confidence` (0–1), title, comment, optional `suggestion` (prose) and `suggestedCode` (exact single-line replacement → rendered as a committable ```suggestion block). |
| `ReviewResult`  | `{ findings: Finding[], summary: string }`.                                                                                                                                                                                |
| `FileDiff`      | `{ newPath, oldPath, diff, newFile, deletedFile }`.                                                                                                                                                                        |
| `ContextFile`   | `{ path, reason: "changed"\|"import"\|"caller"\|"test", content }`.                                                                                                                                                        |
| `ContextBundle` | `{ files: ContextFile[], notes: string[] }`.                                                                                                                                                                               |
| `Norms`         | `confidenceThreshold`, `maxFindings`, `exclude`, `categories`, `guidelines`, `examples`.                                                                                                                                   |
| `DiffRefs`      | `{ head_sha, base_sha, start_sha }` — needed for GitLab inline anchoring.                                                                                                                                                  |
| `MrInfo`        | `{ sourceBranch, targetBranch, headSha, diffRefs }`.                                                                                                                                                                       |

`renderContext(bundle)` flattens a `ContextBundle` into the `### FILE: … (reason: …)` text block
the LLM sees.

---

## `config.ts`

The `~/.codeturtle` store. Same file shapes as the (removed) Python version, so existing setups
keep working — **this is a [compatibility contract](./invariants.md#4-codeturtle-file-shapes-are-a-compatibility-contract); additive changes only.**

- `HOME` = `$CODETURTLE_HOME` or `~/.codeturtle`.
- Files: `credentials.json` (forge tokens), `config.json` (`reviewer` + `watch` sections),
  `watcher.log`, `watcher.pid`.
- Every write goes through `writeJson()`, which `mkdir -p`s `HOME` and `chmod 600`s the file.
  **Secrets never leave this directory and are never logged.** See [Invariant 3](./invariants.md#3-secrets-stay-in-codeturtle-with-chmod-600).

Key functions:

| Function                                         | Purpose                                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadCredentials()` / `setForge(forge, fields)`  | read / merge-write `credentials.json`.                                                                                                                                                                                |
| `resolveToken(forge)`                            | store token, else `GITHUB_TOKEN`/`GITLAB_TOKEN`/`BITBUCKET_TOKEN` env.                                                                                                                                                |
| `loadConfig()` / `updateConfig(section, fields)` | read / merge-write `config.json`.                                                                                                                                                                                     |
| `reviewerSettings()`                             | resolved `{ apiKey, baseUrl, model, botName }`. **Env vars override the store** (`REVIEWER_API_KEY`, `GEMINI_API_KEY`, `REVIEWER_MODEL`, `REVIEWER_BASE_URL`, `REVIEWER_BOT_NAME`). Default model `gemini-2.5-flash`. |
| `getBotName(model, custom?)`                     | maps a model to a display name (`claude`→"Claude review", etc.).                                                                                                                                                      |
| `resetAll()`                                     | wipes credentials, config, log, pid, and the `locks/` dir.                                                                                                                                                            |
| `limits`                                         | `maxDiffChars` (40k), `maxContextFiles` (12), `maxContextChars` (40k) — env-overridable.                                                                                                                              |

See [Configuration](./configuration.md) for the full env-var matrix and file shapes.

---

## `providers.ts`

The model-provider registry (opencode-style picker data). Every provider speaks the OpenAI
chat-completions dialect, so one [`reviewer`](#reviewerts) client covers all of them.

- `PROVIDERS: Provider[]` — Gemini, Anthropic, OpenAI, OpenRouter, Groq, Ollama (local),
  LM Studio (local), and "Custom endpoint". Each has `id`, `label`, `baseUrl`, optional
  `keyUrl`, `local`, and suggested `models` (the user can always type a custom id).
- `detectLocalModels(baseUrl)` — hits `GET {baseUrl}/models` with a 2s timeout to live-detect
  models on a local server; returns `[]` on any failure.

---

## `prLink.ts`

`parsePrLink(input): PrRef | null` — turns a pasted link into a target. Accepts:

- `https://github.com/owner/repo/pull/123`
- `https://<any-host>/group/sub/proj/-/merge_requests/45` (any GitLab host)
- `owner/repo#123` (GitHub shorthand)

Returns `{ forge, projectId, prNumber, label }`, or `null` if nothing matches.

---

## `forge.ts`

Defines the **forge abstraction** and the two REST clients, plus the marker constants and the
client factory.

### Marker constants

```ts
STATUS_MARKER = "<!-- ct:status -->";
REVIEW_MARKER = "<!-- ct:review -->";
findingMarker(file, line) = `<!-- ct:f:${file}:${line} -->`;
```

These hidden HTML comments are the **idempotency system** — see
[Invariant 1](./invariants.md#1-markers-are-the-idempotency-system).

### The `ForgeClient` interface

Every backend (GitLab REST, GitHub REST, GitHub MCP) implements:

```
close() · getMr · getDiffs · getFile · searchBlobs · createNote · editNote ·
listNotes · postStatus · postInlineNote · addLabels · submitReview · listOpenPrs
```

This is what lets [`pipeline`](#pipelinets), [`bundler`](#bundlerts), and [`poster`](#posterts)
stay backend-agnostic.

### `GitLabClient` (REST v4)

Talks to `{GITLAB_URL}/api/v4`. Inline comments use the `discussions` endpoint with a full
`position[...]` payload built from `DiffRefs`. `submitReview()` returns `false` — GitLab has no
formal review object, so the [poster](#posterts) falls back to a sticky summary note.
`postStatus()` finds-or-creates a note carrying `STATUS_MARKER` (editable sticky note).

### `GitHubRestClient` (the `GITHUB_BACKEND=rest` escape hatch)

Talks to `api.github.com`. `submitReview()` finds an existing review carrying `REVIEW_MARKER`
and updates it, else creates a new `COMMENT` review. Like GitLab, it supports an editable sticky
status note.

### `getForgeClient(forge)`

The factory:

- `github` → **`GitHubMcpClient`** unless `GITHUB_BACKEND=rest`, then `GitHubRestClient`.
- `gitlab` → `GitLabClient`.
- anything else → throws (`bitbucket lands in v2.1`).

---

## `forgeMcp.ts`

GitHub through the official remote MCP server (`https://api.githubcopilot.com/mcp/`). **This is
the default GitHub backend.** Uses `@modelcontextprotocol/sdk` over a streamable-HTTP transport
authenticated with the stored GitHub token.

The defining constraint: **the MCP server has no comment-edit tool.** Consequences:

- `postStatus()` returns a `"mcp-status"` sentinel instead of creating an editable note.
- Inline findings accumulate on a **pending review**: the first `postInlineNote` calls
  `pull_request_review_write { method: "create" }`, then each finding is
  `add_comment_to_pending_review`. The set of PRs with an open pending review is tracked in
  `hasPending`.
- `submitReview()` calls `pull_request_review_write { method: "submit_pending", event: "COMMENT", body: summary }`
  — publishing all inline findings + the summary as **one** native GitHub review. If there were
  no inline findings, it posts a standalone summary review (deduped against `REVIEW_MARKER`).
- `editNote()` is best-effort: no edit exists, so it only posts terminal one-off messages, and
  skips if the text is already present or is the "Review complete" line.
- `addLabels()` reads existing labels first and merges (the `issue_write update` call replaces
  the whole set).

**Do not** "fix" this by posting per-finding reviews — see
[Invariant 5](./invariants.md#5-github-mcp-has-no-comment-edit-tool).

---

## `norms.ts`

Review rules: built-in `DEFAULTS` ← the target repo's `.codeturtle.yml` (last wins).

- `loadNorms(gl, projectId, mr)` — fetches `.codeturtle.yml` at the MR head and merges. **It
  deletes `agent` and `key_ref` from the repo config** so a PR author can never redirect the
  reviewer or exfiltrate a key. This is a hard [security invariant](./invariants.md#2-security-repo-config-is-untrusted).
- `DEFAULTS` — `confidenceThreshold: 0.7`, `maxFindings: 25`, a sensible `exclude` list
  (lockfiles, `*.min.js`, generated, `node_modules`, `dist`, `build`), all categories on, and a
  prioritised senior-engineer guideline string.
- `isExcluded(path, norms)` / `applyExcludes(diffs, norms)` — glob matching via a small
  `globToRegex` (supports `**`, `*`, `?`); matches full path, `**/`-stripped path, and basename.

Recognised repo keys: `confidence_threshold`, `max_findings`, `exclude`, `categories`,
`guidelines`, `examples`. See [Configuration › per-repo norms](./configuration.md#per-repo-norms-codeturtleyml).

---

## `repoFiles.ts`

Pure, network-free heuristics that map a changed file to neighbouring paths worth fetching. Used
by [`bundler`](#bundlerts).

| Function                              | What it does                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `langOf(path)`                        | `"ts" \| "py" \| "other"` from the extension.                                                                                                                 |
| `parseImports(text, lang)`            | extract import specifiers (TS `import`/`require`, Py `import`/`from`).                                                                                        |
| `resolveImport(spec, fromPath, lang)` | resolve **relative** specs to candidate paths (TS tries `.ts/.tsx/.js/.jsx` + `/index.*`; Py tries `.py` + `/__init__.py`). Bare/package imports return `[]`. |
| `exportedSymbols(text, lang)`         | up to 6 exported names (TS `export function/const/class`, Py top-level `def`/`class`), skipping `_`-prefixed.                                                 |
| `testCandidates(path, lang)`          | convention-based test paths (`*.test.ts`, `__tests__/…`, `test_*.py`, `tests/…`).                                                                             |

---

## `bundler.ts`

`buildContext(gl, projectId, head, diffs, norms, log)` reconstructs what a human reviewer would
open — read at the **head commit**:

1. For each changed (non-deleted) file: fetch it (`reason: "changed"`).
2. **Imports** — one hop, relative only: resolve each import and fetch the first that exists (`"import"`).
3. **Callers** — for each exported symbol, `searchBlobs` the repo and fetch up to 3 hits (`"caller"`).
4. **Tests** — fetch the first matching `testCandidates` path (`"test"`). If a TS/Py file has no
   test, add a context note.

Then it **ranks** (`changed > import > caller > test`) and **budgets** to `limits.maxContextFiles`
/ `limits.maxContextChars`, clipping each file to ~6000 chars. Returns a `ContextBundle`.

---

## `reviewer.ts`

The LLM call. One OpenAI client for every provider (native or compat endpoint, including local
servers).

- `review(diffText, context, norms, log)` builds a system prompt (`BASE_PROMPT` + the repo's
  `guidelines`, `examples`, and enabled `categories`), then a user message of
  `renderContext(context)` + the diff.
- Calls `chat.completions.create` with `temperature: 0.2` and `response_format: json_object`;
  if that throws (some endpoints reject `response_format`), it retries without it.
- **Reviewer output is hostile input.** The raw text is de-fenced, JSON-parsed (non-JSON →
  empty result, logged), then every finding goes through `parseFinding`, which:
  - rejects findings missing a file, a finite line, a valid severity, or a valid category;
  - `coerceConfidence` clamps numbers to 0–1 and maps word confidences ("high"/"med"/"low") to
    0.9 / 0.6 / 0.3;
  - reads `suggested_code` → `suggestedCode`.

Invalid findings are dropped silently. See [Invariant 6](./invariants.md#6-reviewer-output-is-hostile-input).
Set `CT_DEBUG=1` to log the first 800 chars of the raw model response.

---

## `poster.ts`

Posting + the dedup/anchoring logic. This is where the marker system is enforced.

- `snapFindings(diffs, findings)` — LLMs drift a few lines off the hunk, and forges reject lines
  outside the diff. This nudges each finding's line onto the nearest **visible** diff line within
  `SNAP_TOLERANCE` (10). A snapped finding **loses its `suggestedCode`** (the replacement was
  written for the original line). `diffLines()` parses a unified diff into added (commentable +
  suggestable) and visible (commentable) new-side line numbers.
- `finalize(gl, projectId, prNumber, refs, result, kept, statusId, log)`:
  1. Reads existing notes, extracts all `ct:f:FILE:LINE` markers.
  2. For each kept finding **not already posted** (`±LINE_TOLERANCE` = 3 → absorbs jitter),
     `postInlineNote`; if anchoring fails, falls back to a plain note.
  3. Builds a summary (a per-severity findings table, or "✅ No issues found").
  4. `submitReview(summary)`. If it succeeds (GitHub), the status note just points at the review;
     if it returns `false` (GitLab), the summary becomes the sticky status note.
  5. Adds a severity label (`code-turtle/critical|warning|info`) or `code-turtle/clean`.
- `markFailed(...)` — edits the status note to an error line.

`commentBody()` renders each finding with its marker, severity emoji, category, confidence, body,
and a ```suggestion block (if `suggestedCode`) or prose suggestion. **Never post without a
marker; never change marker formats; never remove the tolerance** — see
[Invariant 1](./invariants.md#1-markers-are-the-idempotency-system).

---

## `state.ts`

In-process + on-disk coordination. Keyed by `${projectId}#${prNumber}`.

- `seenEvent(uuid)` — event-dedup with a 1-hour TTL.
- `recordLatest()` / `isLatest()` — track the latest head SHA per PR so an in-flight review for
  an old SHA is **superseded** (skipped) when a newer push arrives.
- `acquireLock()` / `releaseLock()` — a dual lock: an in-process `Map` **and** a lock file under
  `~/.codeturtle/locks/` (10-min TTL), so concurrent processes don't double-review. Always
  released in the pipeline's `finally`.

See [Invariant 7](./invariants.md#7-one-review-at-a-time-per-pr).

---

## `watch.ts`

The polling trigger.

- `parseTarget("github:owner/repo")` → `{ forge, repo }` (validates forge + repo).
- `watch(targets, opts)` loops until `opts.signal` aborts. Each cycle lists open PRs per target;
  a PR whose head SHA changed (or is new) queues a `Job`.
  - **First cycle baselines** existing PRs (logs `baseline …`, doesn't review) unless
    `reviewExisting` is set — this prevents a comment flood on startup.
  - Jobs run via `runReview` (fire-and-forget; `state` enforces one-at-a-time).
  - A failed poll on one repo logs and continues — it never aborts the loop.
- `opts`: `intervalSec`, `reviewExisting?`, `log?`, `signal?` (AbortSignal), `onJob?` (the TUI
  uses this to add a "reviewing…" row).

---

[← Docs index](./README.md) · Next: [TUI Reference](./tui-reference.md)
