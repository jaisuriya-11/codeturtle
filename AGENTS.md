# Code Turtle — AI Agent Guide

This is the canonical guide for ALL AI coding agents (Claude Code, Gemini CLI, Copilot CLI,
Codex, aider, …). `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` all point here.
Read this fully before changing anything.

## What this project is

`code-turtle` — an npm-distributed CLI/TUI (`codeturtle`) that reviews GitHub PRs and GitLab MRs
with any OpenAI-compatible LLM (cloud or local). No server, no webhooks: reviews run on the
user's machine, triggered by pasting a PR link in the TUI or by polling watched repos.

- Language: TypeScript (strict), ESM only, Node ≥ 18
- TUI: React + Ink
- GitHub I/O: official GitHub remote MCP server (`@modelcontextprotocol/sdk`)
- GitLab I/O: REST v4
- LLM: `openai` SDK pointed at any compatible base URL
- Build: `tsup` → `dist/cli.js` (single bin).
- Tests: **Vitest** (`npm test`). Specs are co-located in `src/**/__tests__/*.test.ts`; the
  seven hard invariants below are locked in `src/engine/__tests__/invariants.test.ts`.

## Map

```
src/
├── cli/index.ts          commander entry. Bare `codeturtle` → TUI. Subcommands: review, status, reset.
├── engine/               ALL business logic. No UI imports here, ever.
│   ├── types.ts          Job, Finding, ReviewResult, FileDiff, ContextBundle, Norms, MrInfo
│   ├── config.ts         ~/.codeturtle store: credentials.json, config.json, resetAll(). chmod 600.
│   ├── providers.ts      model-provider registry + local-server model detection
│   ├── prLink.ts         pasted URL → {forge, projectId, prNumber}
│   ├── forge.ts          ForgeClient interface + GitLab REST + GitHub REST fallback + markers
│   ├── forgeMcp.ts       GitHub via MCP. Pending-review flow. Default GitHub backend.
│   ├── forgeCommits.ts   commit-level REST ops: branches, push diffs, commit comments
│   ├── norms.ts          defaults <- repo .codeturtle.yml merge, exclude globs
│   ├── repoFiles.ts      pure heuristics: imports, exported symbols, test paths
│   ├── bundler.ts        context bundle: changed files + imports + callers + tests, ranked, budgeted
│   ├── reviewer.ts       LLM call, strict JSON parse, finding validation
│   ├── poster.ts         inline comments + summary review + labels. Dedup lives here.
│   ├── state.ts          in-process locks, event dedup, latest-commit superseding
│   ├── pipeline.ts       runReview() + runPushReview(): the review entrypoints. Everything goes through them.
│   └── watch.ts          poll watched repos → runReview on new PR / PR push; runPushReview on branch push without a PR
└── tui/                  React/Ink components. No business logic here, ever.
    ├── App.tsx           router: login → model (once) → repo → dashboard
    ├── Login.tsx         sign in: GitHub OAuth / gh CLI / PAT, GitLab PAT
    ├── RepoScreen.tsx    pick the session repo the dashboard works on
    ├── Dashboard.tsx     open/closed PR tabs, auto-watch, events feed, settings
    ├── ReviewViewer.tsx  posted review browser: findings, code context, file filter
    ├── ModelPicker.tsx   provider → model → key (opencode-style)
    ├── RepoPicker.tsx    pick extra repos to auto-review from live forge list
    └── theme.tsx         ASCII logo, ACCENT/DIM colors, KeyHint
```

Data flow: `cli|tui → pipeline.runReview(job)|runPushReview(job) → forge client → bundler → reviewer → poster`.

## Hard invariants — breaking these is a bug, not a refactor

1. **Markers are the idempotency system.** Every bot artifact carries a hidden HTML marker:
   `<!-- ct:f:FILE:LINE -->` (inline finding), `<!-- ct:review -->` (summary review),
   `<!-- ct:status -->` (status note), `<!-- ct:recheck:SHA -->` (clean re-review note,
   once per head commit). Poster dedups findings against existing markers with
   **±3 line tolerance** (LLM line jitter). Never post without a marker; never remove the
   tolerance; never change marker formats (breaks dedup against already-posted comments).
   Push reviews reuse the same markers on commit comments, deduped per head commit.
2. **Security: repo config is untrusted.** `norms.ts` strips `agent` and `key_ref` from
   `.codeturtle.yml` — a PR author must never redirect the reviewer or exfiltrate keys.
   Keep stripping; never add a way for repo files to set URLs/keys/commands.
3. **Secrets stay in `~/.codeturtle/` with chmod 600.** Never log tokens or API keys, never
   write them anywhere else, never echo them in errors or TUI. Env vars override store.
4. **`~/.codeturtle` file shapes are a compatibility contract** (credentials.json, config.json).
   Additive changes only; never rename/remove existing fields.
5. **GitHub MCP has no comment-edit tool.** That's why there is no sticky status note on the
   MCP path and the summary goes out as ONE review via pending-review flow
   (create → add_comment_to_pending_review → submit_pending). Don't "fix" this by posting
   per-finding reviews — one review per run.
6. **Reviewer output is hostile input.** Models return wrong enums, word confidences
   ("high"), fenced JSON. `reviewer.ts` validates every finding and drops invalid ones
   silently. Keep validation strict; coerce only what's unambiguous.
7. **One review at a time per PR (and per branch for push reviews)** — `state.ts` lock +
   superseding by head SHA; branch locks are keyed `branch:<name>`. Anything that triggers
   reviews must go through `pipeline.runReview` / `pipeline.runPushReview`, which enforce this.

## Coding standards

- TypeScript strict; no `any` in exported signatures (internal parse code may cast).
- ESM: relative imports MUST end in `.js` (`./engine/forge.js`), even from `.tsx`.
- Engine never imports from `tui/` or ink/react. TUI never talks to forges/LLMs directly —
  it calls engine functions.
- Errors: forge "soft" calls return `null` and log; pipeline-level failures mark the PR
  failed and release the lock in `finally`. Never let one PR's failure kill the watcher.
- Network: native `fetch` with `AbortSignal.timeout(...)`. No axios/got/etc.
- New dependencies need a strong reason — the install is `npm i -g`, keep it lean.
- Naming/style: match neighbouring code. Comments explain *why*, not *what*. No decorative
  comment banners beyond the existing file-header pattern.
- User-facing TUI text: short, lowercase-ish, no exclamation marks. Colors only via
  `theme.tsx` ACCENT/DIM. Logo is the ASCII block in `theme.tsx` — no emoji in the header.

## Verify before you're done

```bash
npm run typecheck    # tsc --noEmit — must be clean (covers src + co-located tests)
npm test             # Vitest — must pass
npx tsup             # must build
node dist/cli.js status
node dist/cli.js review <a-real-PR-link>   # only with user consent — posts real comments
```

When you change engine logic or touch a hard invariant, add or update the matching test under
`src/**/__tests__/`. CI (`.github/workflows/ci.yml`) runs typecheck + build + tests on every push/PR.

TUI can't run in non-TTY contexts; smoke-test components headlessly with
`ink-testing-library` (`render(...)` → `lastFrame()`), via a throwaway `src/tui-smoke.tsx`
run with `npx tsx` — delete it afterwards.

## Do NOT

- Do not commit, push, publish (`npm publish`), or create PRs unless the user explicitly asks.
- Do not run reviews against repos the user didn't name — reviews post real comments.
- Do not store anything outside `~/.codeturtle/` (and never weaken its 0600 perms).
- Do not add Python back — the Python implementation was removed deliberately (v2.0 is TS-only).
- Do not add webhooks/servers — local-first is the product's core promise.
- Do not bump deps or rewrite working modules while fixing an unrelated bug — smallest
  correct change wins.
- Do not invent new config keys when an existing section fits (`reviewer`, `watch`).

## Domain glossary

- **forge** — git host (github | gitlab). `projectId`: GitHub `owner/repo`, GitLab path or numeric ID.
- **norms** — review rules: defaults merged with target repo's `.codeturtle.yml`.
- **context bundle** — files the LLM sees beyond the diff (changed files, imports, callers, tests),
  ranked changed > import > caller > test, budgeted by `limits` in config.ts.
- **finding** — one review comment: file, line, severity (critical|warning|info),
  category (security|bug|perf|style|maintainability), confidence 0-1. Findings below the
  norms confidence threshold are dropped before posting.
- **watch / auto-review** — polling loop; first cycle baselines open PRs without reviewing.
