# Code Turtle

Code Turtle is an open-source, self-hostable AI-powered code review system designed specifically for GitLab merge requests. It provides contextual reviews by analyzing not only the git diff but also the surrounding codebase, imports, callers, and tests. It allows teams to bring their own language model endpoints and enforce custom review guidelines.

---

## Architecture Overview

Code Turtle is designed around a dual-clock architecture to remain compliant with webhook timeout limits while conducting deep code analysis.

### Ingest vs. Worker Execution
1. **Ingest Service ([ingest/main.py](file:///Users/jai/Developer/code-turtle/ingest/main.py))**: A lightweight FastAPI application that receives GitLab webhooks, verifies tokens, filters actions, records the latest commit reference, and pushes jobs to the queue. It executes in milliseconds, protecting the webhook delivery from GitLab's 10-second timeout.
2. **Worker Service ([worker/main.py](file:///Users/jai/Developer/code-turtle/worker/main.py))**: A decoupled runner that consumes jobs asynchronously from the queue. It is responsible for gathering repository context, calling the LLM, and posting review findings back to the GitLab merge request.

### Delivery and Processing Guarantees
Code Turtle guarantees at-least-once delivery with exactly-once effects on the Merge Request using the coordination mechanisms in [worker/state.py](file:///Users/jai/Developer/code-turtle/worker/state.py) and [worker/poster.py](file:///Users/jai/Developer/code-turtle/worker/poster.py):
* **Deduplication**: Webhook events are tracked via `seen_event(uuid)` with a 1-hour TTL to prevent double processing of identical deliveries.
* **Superseding**: If a newer commit is pushed to a Merge Request while a review job for an older commit is still queued, the stale job is safely bypassed via `is_latest(...)`.
* **Lease Locking**: One concurrent review is permitted per Merge Request using a 10-minute lease lock to prevent race conditions from concurrent pushes.
* **Idempotent Posting**: Every posted review comment carries a hidden HTML marker. Prior to writing inline discussions, the poster verifies existing discussions on the MR to avoid duplicate comments.

---

## Directory Structure

```
code-turtle/
├── ingest/
│   └── main.py              # Webhook endpoint receiving GitLab Merge Request events.
├── worker/
│   ├── main.py              # Worker HTTP target endpoint (production queue backend).
│   ├── pipeline.py          # Core review loop: runs context bundle, LLM calls, and posts.
│   ├── gitlab_client.py     # GitLab REST API wrappers.
│   ├── state.py             # Coordination memory backend (deduplication, locks, superseding).
│   ├── config.py            # Configuration loader, norms merger, and exclude patterns.
│   ├── poster.py            # Summary post, inline annotations, and label attachments.
│   ├── reviewers/
│   │   ├── base.py          # Reviewer interface contract.
│   │   └── openai_compat.py # Default reviewer client using the OpenAI compatibility layer.
│   └── context/
│       ├── repo_files.py    # Code heuristics (exports, symbols, test paths).
│       └── bundler.py       # Context bundle processor.
├── shared/
│   ├── settings.py          # Environment settings loader.
│   ├── schema.py            # Pydantic data schemas.
│   └── queue.py             # In-process or Cloud Tasks queue handler.
├── defaults/
│   └── norms.yml            # System default review guidelines.
├── requirements.txt         # Core dependencies.
├── Dockerfile.ingest        # Ingest service container definition.
├── Dockerfile.worker        # Worker service container definition.
└── .env.example             # Configuration reference file.
```

---

## The Three Pillars of Code Turtle

### 1. Bring Your Own Agent
Code Turtle is model-agnostic. The default adapter [worker/reviewers/openai_compat.py](file:///Users/jai/Developer/code-turtle/worker/reviewers/openai_compat.py) communicates with any OpenAI-compatible API endpoint (such as Google AI Studio Gemini, OpenAI, OpenRouter, or a local Ollama server). Custom SDK adapters can be added by implementing the `Reviewer` protocol in [worker/reviewers/base.py](file:///Users/jai/Developer/code-turtle/worker/reviewers/base.py).

### 2. Custom Review Norms
Review guidelines are loaded from a global default file [defaults/norms.yml](file:///Users/jai/Developer/code-turtle/defaults/norms.yml) and can be overridden on a per-repository basis by adding a `.codeturtle.yml` configuration file to the root of the target repository.
* **Security Isolation**: Code Turtle strips fields like `agent` and `key_ref` from repository-level config files. This prevents untrusted repository contributors from redirecting reviewers or leaking API keys.

### 3. Smart Codebase Context
Unlike simple review tools that only read the diff patch, [worker/context/bundler.py](file:///Users/jai/Developer/code-turtle/worker/context/bundler.py) constructs a context package for the changed files:
1. **Changed Files**: The full text of modified files.
2. **Imports**: One hop of relative imports.
3. **Callers**: Symbol searches to identify and include files that invoke modified functions.
4. **Tests**: Matching test suites identified through naming conventions.
5. **Budgets**: The context elements are ranked and truncated to respect character and file limits defined in configuration settings.

---

## Local Development and Configuration

### Environment Variables
Configure the following keys in your `.env` file (copied from `.env.example`):
* `GITLAB_URL`: GitLab instance base URL (default: `https://gitlab.com`).
* `GITLAB_TOKEN`: GitLab personal access token with `api` scope permissions.
* `WEBHOOK_SECRET`: A secure token shared with the GitLab webhook configuration.
* `REVIEWER_API_KEY`: API key for your LLM (such as Gemini or OpenAI).
* `REVIEWER_BASE_URL`: API endpoint (defaults to Google Generative Language OpenAI wrapper).
* `REVIEWER_MODEL`: LLM identifier (defaults to `gemini-2.5-flash`).
* `QUEUE_BACKEND`: Queue engine (`local` for local execution or `cloudtasks` for production).

### Local Setup
1. Instantiate and activate a python virtual environment:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```
2. Install the package dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Copy and fill out the environment file:
   ```bash
   cp .env.example .env
   ```
4. Run the development server:
   ```bash
   uvicorn ingest.main:app --reload --port 8080
   ```
5. Set up an HTTP tunnel (such as localtunnel or ngrok) to expose port `8080` to the internet.
6. Register the webhook in your GitLab Project's **Settings → Webhooks**:
   * **URL**: `https://<your-tunnel-subdomain>/webhook`
   * **Secret token**: Your configured `WEBHOOK_SECRET`.
   * **Trigger**: Check **Merge request events** only.

---

## Production Deployment

For production deployments:
1. Expose `Dockerfile.ingest` and `Dockerfile.worker` as separate services.
2. Configure `QUEUE_BACKEND=cloudtasks` and provide `WORKER_URL` and `CLOUDTASKS_QUEUE` settings.
3. Implement a persistent coordination store in [worker/state.py](file:///Users/jai/Developer/code-turtle/worker/state.py) (such as Redis or Firestore) to coordinate deduplication and lock mechanisms across multiple worker instances.
