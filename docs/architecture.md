# Architecture

[← Docs index](./README.md)

## Layers

Code Turtle has a strict two-layer split. **Breaking this split is a bug, not a style choice.**

```
src/
├── cli/        commander entry — thin. Parses args, calls the engine.
├── engine/     ALL business logic. Never imports from tui/ or ink/react.
└── tui/        React + Ink components. Never talks to forges/LLMs directly — calls engine fns.
```

- The **engine** is pure logic + I/O. It can run headless (the `review` CLI subcommand and the
  watcher both drive it with no UI).
- The **TUI** is presentation only. Every action a user takes in the TUI ends up calling an
  engine function.

If you find yourself importing `ink` into `engine/`, or `fetch`-ing a forge from `tui/`, stop —
you're on the wrong side of the line.

## Module map

| Module                    | Responsibility                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cli/index.ts`            | commander entry. Bare `codeturtle` → TUI. Subcommands: `review`, `status`, `reset`.                                      |
| `engine/types.ts`         | Core types: `Job`, `Finding`, `ReviewResult`, `FileDiff`, `ContextBundle`, `Norms`, `MrInfo`. Plus `renderContext()`.    |
| `engine/config.ts`        | The `~/.codeturtle` store: `credentials.json`, `config.json`, `resetAll()`. chmod 600. Env-var overrides.                |
| `engine/providers.ts`     | Model-provider registry + local-server model detection.                                                                  |
| `engine/prLink.ts`        | Pasted URL → `{forge, projectId, prNumber}`.                                                                             |
| `engine/forge.ts`         | `ForgeClient` interface + GitLab REST + GitHub REST fallback + the marker constants.                                     |
| `engine/forgeMcp.ts`      | GitHub via the official MCP server. Pending-review flow. **Default GitHub backend.**                                     |
| `engine/norms.ts`         | Layered norms: defaults ← global config & packs ← repo `.codeturtle.yml`; runs global transforms; exclude-glob matching. |
| `engine/normsRegistry.ts` | The norm "plugin" loader: `*.yml` packs + `*.mjs` transforms from `~/.codeturtle/norms`; `mergeNorms`, `safePackName`.   |
| `engine/repoFiles.ts`     | Pure heuristics: parse imports, find exported symbols, guess test paths.                                                 |
| `engine/bundler.ts`       | Builds the context bundle: changed files + imports + callers + tests, ranked & budgeted.                                 |
| `engine/reviewer.ts`      | The LLM call. Strict JSON parse + per-finding validation.                                                                |
| `engine/poster.ts`        | Inline comments + summary review + labels. Dedup & line-snapping live here.                                              |
| `engine/state.ts`         | In-process + cross-process locks, event dedup, latest-commit superseding.                                                |
| `engine/pipeline.ts`      | `runReview()` + `runPushReview()` — the review entrypoints. Everything goes through them.                                |
| `engine/watch.ts`         | Poll watched repos → `runReview` on new PR / PR push; `runPushReview` on a branch push with no PR.                       |
| `tui/*`                   | React/Ink components — see the [TUI Reference](./tui-reference.md).                                                      |

Full per-module detail: [Engine Reference](./engine-reference.md).

## The review data flow

There is **one** entrypoint for a review: `pipeline.runReview(job, log)`. The CLI, the TUI's
paste box, and the watcher all converge on it.

```
 ┌─ trigger ──────────────────────────────────────────────┐
 │  CLI `review`   TUI paste box   watcher (new PR/push)   │
 └───────────────────────┬────────────────────────────────┘
                         ▼
              pipeline.runReview(job)
                         │
   1. state.isLatest? ───┤  superseded by a newer head SHA → skip
   2. state.acquireLock ─┤  already reviewing this PR → skip
                         │
   3. forge = getForgeClient(job.forge)        ── GitHub→MCP (default), GitLab→REST
   4. postStatus("🐢 reviewing…")              ── sticky note where editable
   5. mr   = forge.getMr()                      ── branches + diff refs
   6. diffs = forge.getDiffs()                  ── per-file unified diffs
   7. norms = loadNorms(...)                    ── defaults ← global cfg & packs ← repo cfg
                                                   (agent/key_ref stripped; transforms run last)
   8. filtered = applyExcludes(diffs, norms)    ── drop lockfiles, dist, etc.
   9. context = buildContext(...)               ── changed + imports + callers + tests
  10. result  = review(diff, context, norms)    ── LLM → validated findings
  11. kept = filter(confidence ≥ threshold)
            .slice(0, maxFindings)
            .then(snapFindings)                 ── nudge lines onto the diff
  12. finalize(...)                             ── post inline + summary + labels
                         │
   finally: forge.close() + state.releaseLock()
```

Step references:

- **1–2, locking & superseding** → [`state.ts`](./engine-reference.md#statets) and
  [Invariant 7](./invariants.md#7-one-review-at-a-time-per-pr)
- **3, backend selection** → [`forge.ts` factory](./engine-reference.md#forgets) +
  [`forgeMcp.ts`](./engine-reference.md#forgemcpts)
- **7, untrusted repo config** → [`norms.ts`](./engine-reference.md#normsts) and
  [Invariant 2](./invariants.md#2-security-repo-config-is-untrusted)
- **9, context assembly** → [`bundler.ts`](./engine-reference.md#bundlerts)
- **10, hostile LLM output** → [`reviewer.ts`](./engine-reference.md#reviewerts) and
  [Invariant 6](./invariants.md#6-reviewer-output-is-hostile-input)
- **11–12, dedup & posting** → [`poster.ts`](./engine-reference.md#posterts) and
  [Invariant 1](./invariants.md#1-markers-are-the-idempotency-system)

## Why GitHub goes through MCP

The default GitHub backend is the official remote MCP server
(`https://api.githubcopilot.com/mcp/`), not REST. This shapes the posting flow:

- The MCP server **has no comment-edit tool.** So there is no sticky status note on the MCP
  path (`postStatus` returns a sentinel), and the summary goes out as **one** native review via
  the pending-review flow: `create` → `add_comment_to_pending_review` (per finding) →
  `submit_pending` (with the summary). See [Invariant 5](./invariants.md#5-github-mcp-has-no-comment-edit-tool).
- A REST fallback exists for GitHub (`GITHUB_BACKEND=rest`) and is the only path for GitLab.

Both backends implement the same [`ForgeClient`](./engine-reference.md#the-forgeclient-interface)
interface, so the pipeline doesn't care which is in use.

## Triggering models

- **Manual** — a pasted PR/MR link (`prLink.parsePrLink`) or the `review` subcommand. One review,
  then done.
- **Watch / auto-review** — [`watch.ts`](./engine-reference.md#watchts) polls each target repo's
  open PRs on an interval. The **first cycle baselines** existing PRs without reviewing (so you
  don't get a wall of comments on startup); after that, a changed head SHA (new push) or a brand
  new PR queues a `runReview`.

## Next

- Drill into a specific module → [Engine Reference](./engine-reference.md)
- The rules that hold all this together → [Hard Invariants](./invariants.md)
