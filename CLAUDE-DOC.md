# 🐢 Code Turtle — Engineering Reference

Open-source, self-hostable AI code review for GitLab merge requests. An alternative to
CodeRabbit where **you bring your own agent**, **your own review norms** (or the defaults), and
reviews read the **surrounding codebase**, not just the diff.

> **This document is the source of truth for anyone — human or AI agent — working on this
> codebase.** It explains what each file does, the contracts between them, the control flow, the
> invariants you must not break, and where to change things. Read the "Mental model" and
> "Invariants" sections before editing anything.

---

## 1. Mental model (read this first)

Two ideas explain the whole design:

1. **Two clocks.** The reply to GitLab and the actual review run on *separate clocks*. A thin
   **ingest** service answers GitLab's webhook in milliseconds; a separate **worker** does the
   slow review off a **queue**. GitLab times out a webhook in ~10s and retries on failure — so we
   never do slow work before replying.

2. **At-least-once delivery, exactly-once effect.** The queue may deliver a job more than once
   (retries, crashes, duplicate webhooks). Three mechanisms in `worker/state.py` +
   `worker/poster.py` make the *effect* on the MR happen exactly once anyway:
   **dedupe** (ignore re-delivered events), **supersede** (skip stale commits), **lock** (one
   review per MR at a time), and **idempotent posting** (never double-post a comment).

The actual review logic lives in **`worker/pipeline.py` → `run_review()`**. Everything else is
either a thin entry point into it or a helper it calls.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Ingest** | The webhook-receiving service (`ingest/main.py`). Fast, does no slow work. |
| **Worker** | The service that runs the review (`worker/pipeline.py`, exposed by `worker/main.py`). |
| **Queue** | The handoff between them (`shared/queue.py`). `local` = in-process; `cloudtasks` = real queue. |
| **State** | Shared coordination memory (`worker/state.py`): dedupe set, latest-commit map, per-MR locks. |
| **Norms** | The review rules — defaults + a repo's `.codeturtle.yml` (Pillar 2). |
| **Context bundle** | The surrounding code gathered for a review (Pillar 3). |
| **Agent / Reviewer** | The LLM (or your own endpoint) that judges the code (Pillar 1). |
| **Supersede** | Dropping a queued review because a newer commit landed on the same MR. |
| **head / head_sha** | The MR's latest commit. We read repository files at this ref. |

---

## 3. Directory map (file → responsibility)

```
code-turtle/
├── ingest/
│   └── main.py              # FastAPI app. Route: POST /webhook. The door GitLab knocks on.
├── worker/
│   ├── main.py              # FastAPI app. Route: POST /task. The door the queue knocks on (prod).
│   ├── pipeline.py          # run_review(): the entire review sequence. THE CORE.
│   ├── gitlab_client.py     # All GitLab REST calls (MR, diff, files, search, notes, labels).
│   ├── state.py             # dedupe / supersede / lock. In-memory backend (swap for Firestore/Redis).
│   ├── config.py            # PILLAR 2: load+merge norms; apply excludes.
│   ├── poster.py            # sticky status note + idempotent inline comments + summary + label.
│   ├── reviewers/
│   │   ├── base.py          # PILLAR 1: Reviewer protocol + get_reviewer() factory.
│   │   └── openai_compat.py # PILLAR 1: default agent adapter (Gemini/OpenAI/OpenRouter/Ollama).
│   └── context/
│       ├── repo_files.py    # PILLAR 3: pure heuristics (imports, symbols, test paths). No I/O.
│       └── bundler.py       # PILLAR 3: build_context() — scope→imports→callers→tests, ranked+budgeted.
├── shared/
│   ├── settings.py          # Settings dataclass + get_settings() (env-driven, cached).
│   ├── schema.py            # Pydantic contracts: Job, Finding, ReviewResult, ContextBundle.
│   └── queue.py             # enqueue(): local (in-process) | cloudtasks.
├── defaults/
│   └── norms.yml            # PILLAR 2: shipped default rules.
├── requirements.txt
├── Dockerfile.ingest        # builds the ingest service
├── Dockerfile.worker        # builds the worker service
└── .env.example
```

### The two `main.py` files (common confusion)

Both are *thin doorways* into `worker/pipeline.run_review()`. Tell them apart by their route:

| File | Route | Called by | Run locally? |
|---|---|---|---|
| `ingest/main.py` | `POST /webhook` | GitLab | ✅ **yes** — `uvicorn ingest.main:app` |
| `worker/main.py` | `POST /task` | the queue (Cloud Tasks) | ❌ prod only |

Locally `QUEUE_BACKEND=local`, so ingest calls the pipeline in-process and `worker/main.py` is
never used. You only run `worker/main.py` as its own service in production.

---

## 4. Request lifecycle (end to end)

```
GitLab ──webhook──▶ ingest/main.py ──Job──▶ shared/queue.py ──▶ worker/pipeline.run_review()
                         │                                              │
                         └─ 200 OK (<200ms)                             ├─ worker/state.py     (supersede, lock)
                                                                        ├─ worker/poster.py    (sticky status)
                                                                        ├─ worker/config.py    (norms, excludes)  ← Pillar 2
                                                                        ├─ worker/context/     (context bundle)   ← Pillar 3
                                                                        ├─ worker/reviewers/   (the agent)        ← Pillar 1
                                                                        └─ worker/poster.py    (inline + summary + label)
```

Step by step:

1. **`ingest/main.py:webhook`** — verify the `X-Gitlab-Token` secret (constant-time); ignore
   non-MR events and non-`open/reopen/update` actions; **dedupe** by `X-Gitlab-Event-UUID`;
   **record the latest commit**; build a `Job`; `enqueue(job)`; return `200`.
2. **`shared/queue.py:enqueue`** — `local`: `asyncio.create_task(run_review(job))`. `cloudtasks`:
   create a task that POSTs the job to `WORKER_URL/task`.
3. **`worker/pipeline.py:run_review`** — the sequence:
   - `state.is_latest` → bail if superseded.
   - `state.acquire_lock` → bail if another worker holds this MR.
   - `poster.post_status` → post/edit the sticky "🐢 reviewing…" note.
   - `gl.get_mr` (for `diff_refs`) + `gl.get_diffs`.
   - `config.load_norms` + `config.apply_excludes` (Pillar 2).
   - `context.bundler.build_context` at the head commit (Pillar 3).
   - `reviewers.get_reviewer(norms).review(...)` (Pillar 1).
   - filter by `confidence_threshold`, cap at `max_findings`.
   - `poster.finalize` → inline comments + edit the sticky note into a summary + label.
   - on error: `poster.mark_failed`; `finally`: release lock + close client.

---

## 5. Data contracts (`shared/schema.py`)

These pydantic models are the stable interfaces between layers. Don't change a field without
updating every producer/consumer.

- **`Job`** — `{project_id, mr_iid, head_sha, event_uuid}`. The queue payload (ingest → worker).
- **`Finding`** — `{file, line, severity, category, confidence, title, comment, suggestion}`.
  Every agent must return these. `severity ∈ critical|warning|info`,
  `category ∈ security|bug|perf|style|maintainability`.
- **`ReviewResult`** — `{findings: [Finding], summary: str}`. The agent's output.
- **`ContextFile`** — `{path, reason, content}`; `reason ∈ changed|import|caller|test`.
- **`ContextBundle`** — `{files: [ContextFile], notes: [str]}` with `.render()` → the text block
  the agent sees.

---

## 6. Module reference

### `shared/settings.py`
`get_settings()` (cached) returns a frozen `Settings` from env. Raises if `GITLAB_TOKEN`,
`WEBHOOK_SECRET`, or a reviewer key is missing. See §7 for the full env list.

### `shared/queue.py`
`async enqueue(job)`. Local backend spawns `run_review` as an asyncio task in the *same* process
(dev). Cloud Tasks backend creates an HTTP task to `WORKER_URL/task` (lazy-imports
`google-cloud-tasks`, an optional dep). Lazy imports avoid a circular import with the worker.

### `worker/state.py`  (coordination — in-memory backend)
The interface a production backend must implement:
- `seen_event(uuid) -> bool` — dedupe (marks seen; TTL 1h).
- `record_latest(p, iid, head)` / `is_latest(p, iid, head) -> bool` — supersede.
- `acquire_lock(p, iid) -> bool` / `release_lock(p, iid)` — per-MR lease (TTL 10m).
> ⚠️ In-memory = per-process. Multiple worker instances need a shared backend (Firestore/Redis).

### `worker/gitlab_client.py`
`GitLabClient` wraps every REST call. Notable:
- `get_mr`, `get_diffs`
- `get_file(project, path, ref)`, `get_tree`, `search_blobs` — used by context, always at `head`.
- `post_status` — create-or-edit the single sticky note (found via `STATUS_MARKER`).
- `post_inline_note` — flattens `position[...]` form fields (GitLab requires this); returns
  `False` if the line can't be anchored.
- `add_labels`.
- Module fns: `STATUS_MARKER`, `finding_marker(file, line)` — the hidden markers that make
  posting idempotent.

### `worker/config.py`  (Pillar 2)
- `EffectiveNorms` — mechanical fields (`confidence_threshold`, `max_findings`, `exclude`,
  `categories`) + judgment fields (`guidelines`, `examples`).
- `load_norms(gl, project, mr)` — `defaults/norms.yml` ← repo `.codeturtle.yml` (read at head),
  deep-merged. **Security: strips `agent`/`key_ref` from the repo file** so a fork can't redirect
  the reviewer or leak keys.
- `is_excluded` / `apply_excludes` — glob matching that handles `**/` at any depth *including
  root* (a `**/*.lock` pattern matches a top-level `yarn.lock`).

### `worker/context/repo_files.py`  (Pillar 3 — pure, testable)
No I/O. `lang_of`, `parse_imports`, `resolve_import` (relative imports only — never fetches
node_modules/stdlib), `exported_symbols` (≤6 names for caller search), `test_candidates`.

### `worker/context/bundler.py`  (Pillar 3)
`build_context(gl, project, head, diffs, norms) -> ContextBundle`. Five stages: (1) **scope** = the
full changed file; (2) **imports** = 1 hop, relative; (3) **callers** = search the repo for the
file's exported symbols; (4) **tests** = convention paths; (5) **rank + budget** by
`MAX_CONTEXT_FILES` / `MAX_CONTEXT_CHARS`, order `changed > import > caller > test`.

### `worker/reviewers/base.py` + `openai_compat.py`  (Pillar 1)
`Reviewer` is a `Protocol` with one method: `review(diff_text, context, norms) -> ReviewResult`.
`get_reviewer(norms)` returns the configured adapter. `OpenAICompatReviewer` builds the system
prompt from `norms.guidelines` + `examples` + enabled `categories`, sends context + diff, asks for
JSON (`response_format`, with a no-format retry fallback), parses, and drops any finding that fails
validation.

### `worker/poster.py`
- `post_status` — the sticky note.
- `finalize` — posts each kept finding inline (skipping any whose `finding_marker` is already on
  the MR — *retry-safe*), edits the sticky note into the summary, applies a `code-turtle/*` label.
- `mark_failed` — edits the sticky note into an error message.

### `worker/pipeline.py`
`run_review(job)` — orchestrates everything above. `_format_diff` joins per-file diffs under a char
budget. This is the function the queue ultimately calls in both modes.

### `ingest/main.py` / `worker/main.py`
Thin FastAPI apps. `ingest` owns `/webhook`; `worker` owns `/task`. Both have `/healthz`.

---

## 7. Configuration (env / `.env`)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `GITLAB_URL` | no | `https://gitlab.com` | GitLab base URL (self-managed → your host). |
| `GITLAB_TOKEN` | **yes** | — | PAT/bot token, scope `api`. |
| `WEBHOOK_SECRET` | **yes** | — | Shared secret; must match the GitLab webhook's token. |
| `REVIEWER_API_KEY` (or `GEMINI_API_KEY`) | **yes** | — | The agent's key. |
| `REVIEWER_BASE_URL` | no | Gemini compat URL | OpenAI-compatible endpoint. |
| `REVIEWER_MODEL` | no | `gemini-2.5-flash` | Model id. |
| `CONFIDENCE_THRESHOLD` | no | `0.7` | Findings below this are dropped (norms can override). |
| `MAX_DIFF_CHARS` | no | `40000` | Diff truncation cap. |
| `MAX_CONTEXT_FILES` | no | `12` | Context budget — file count. |
| `MAX_CONTEXT_CHARS` | no | `40000` | Context budget — chars. |
| `QUEUE_BACKEND` | no | `local` | `local` (in-process) or `cloudtasks`. |
| `WORKER_URL` | cloudtasks | — | Worker service URL for Cloud Tasks. |
| `CLOUDTASKS_QUEUE` | cloudtasks | — | `projects/.../locations/.../queues/...`. |

---

## 8. Running

### Local (single process; Gemini + ngrok)
```bash
cd code-turtle
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill GITLAB_TOKEN, WEBHOOK_SECRET, REVIEWER_API_KEY
uvicorn ingest.main:app --reload --port 8080
curl localhost:8080/healthz   # {"ok":true}
ngrok http 8080
```
GitLab repo → **Settings → Webhooks**: URL `https://<ngrok>/webhook`, secret = `WEBHOOK_SECRET`,
trigger **Merge request events** only. Open an MR to test.

### Production (two services + real queue)
- Deploy `Dockerfile.ingest` (public webhook target) and `Dockerfile.worker` (Cloud Tasks target,
  long request timeout) as separate services.
- Set `QUEUE_BACKEND=cloudtasks`, `WORKER_URL`, `CLOUDTASKS_QUEUE`; `pip install google-cloud-tasks`.
- Replace `worker/state.py`'s in-memory backend with Firestore/Redis so dedupe/supersede/lock work
  across instances.

---

## 9. Invariants — do not break these

1. **Ingest never does slow work.** No diff fetch, no LLM call in `ingest/`. It verifies, records,
   enqueues, returns. (Protects the webhook timeout.)
2. **Read repository files at `head_sha`**, never `main`. The reviewer must see the code as changed.
3. **Posting is idempotent.** Every comment carries a hidden marker; `finalize` checks existing
   notes before posting. A retry must not duplicate.
4. **One review per MR at a time** (the lock) and **only the latest commit** (supersede).
5. **Never honor `agent`/`key_ref` from a repo `.codeturtle.yml`.** Reviewer + keys come from env
   only. (Prevents a fork redirecting the reviewer or exfiltrating keys.)
6. **Keys/secrets never get logged** and never live in a repo file.
7. **Contracts in `shared/schema.py` are stable.** Change a field → update all producers/consumers.

---

## 10. How to extend (the three pillars)

- **Add an agent (Pillar 1):** create `worker/reviewers/<name>.py` implementing
  `review(diff_text, context, norms) -> ReviewResult`; wire it in `get_reviewer()`. The BYO-agent
  HTTP adapter and native Anthropic/Gemini SDK adapters go here.
- **Change norms (Pillar 2):** edit `defaults/norms.yml` for global defaults; teams override per
  repo via `.codeturtle.yml`. Mechanical rules belong in `config.py`/`pipeline.py` (applied in
  code); judgment rules belong in `guidelines` (prompt).
- **Improve context (Pillar 3):** the next big upgrade is *agentic* context — give the agent
  `read_file`/`search_code`/`list_dir` tools (a `worker/context/tools.py`) so it follows its own
  leads, seeded by the current static bundle. Tighten `repo_files.py` (tsconfig path aliases,
  barrel-file re-exports) to improve import resolution.

---

## 11. Deliberate simplifications (current state)

| Area | Now | Production upgrade |
|---|---|---|
| Context scope | full changed file | AST-precise enclosing function (tree-sitter) |
| Context mode | static bundle | + agentic tool-calling loop |
| State backend | in-memory (per process) | Firestore / Redis |
| Queue | in-process (`local`) | Cloud Tasks (`cloudtasks`) |
| Reviewer | OpenAI-compatible only | + native SDK + BYO-agent HTTP |
| Forge | GitLab | + GitHub (swap the client) |

Each is isolated behind a seam, so upgrading one doesn't touch the rest.

---

## 12. Quick "where do I change X?" index

| I want to… | File |
|---|---|
| Change what triggers a review | `ingest/main.py` (event/action filters) |
| Change the review steps/order | `worker/pipeline.py` |
| Add/My change a GitLab API call | `worker/gitlab_client.py` |
| Change comment/label formatting | `worker/poster.py` |
| Change the system prompt | `worker/reviewers/openai_compat.py` |
| Add a model provider | `worker/reviewers/` + `get_reviewer()` |
| Change default rules | `defaults/norms.yml` |
| Change how norms merge / excludes | `worker/config.py` |
| Change what context is gathered | `worker/context/bundler.py` (+ `repo_files.py`) |
| Change dedupe/lock/supersede | `worker/state.py` |
| Switch queue backend | `shared/queue.py` + `QUEUE_BACKEND` |
| Add a config knob | `shared/settings.py` + `.env.example` |