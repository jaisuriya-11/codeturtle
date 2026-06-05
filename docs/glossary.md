# Glossary

[← Docs index](./README.md)

Domain terms used throughout the code and these docs.

| Term                    | Meaning                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **forge**               | A git host: `github` or `gitlab` (`bitbucket` is declared but not yet wired).                                                                                                                                                                                    |
| **projectId**           | The repo identifier. GitHub: `owner/repo`. GitLab: URL-encoded path or numeric ID.                                                                                                                                                                               |
| **PR / MR**             | Pull request (GitHub) / merge request (GitLab). Used interchangeably; internally `prNumber`.                                                                                                                                                                     |
| **job**                 | The unit of work for a review: `{ forge, projectId, prNumber, headSha }`.                                                                                                                                                                                        |
| **norms**               | The review rules — built-in defaults merged with the target repo's `.codeturtle.yml`. See [Configuration](./configuration.md#per-repo-norms-codeturtleyml).                                                                                                      |
| **context bundle**      | The files the LLM sees beyond the diff: changed files + their imports + callers + tests, ranked `changed > import > caller > test` and budgeted. Built by [`bundler.ts`](./engine-reference.md#bundlerts).                                                       |
| **finding**             | One review comment: `file`, `line`, `severity` (critical/warning/info), `category` (security/bug/perf/style/maintainability), `confidence` (0–1), title, comment, optional suggestion. Findings below the norms confidence threshold are dropped before posting. |
| **marker**              | A hidden HTML comment that tags a bot artifact for idempotent dedup: `<!-- ct:f:FILE:LINE -->`, `<!-- ct:review -->`, `<!-- ct:status -->`. See [Invariant 1](./invariants.md#1-markers-are-the-idempotency-system).                                             |
| **snapping**            | Nudging a finding's line onto the nearest visible diff line so inline anchoring succeeds (LLMs drift a few lines). Implemented in [`poster.snapFindings`](./engine-reference.md#posterts). A snapped finding loses its `suggestedCode`.                          |
| **backend**             | The forge transport: GitHub MCP (default), GitHub REST (`GITHUB_BACKEND=rest`), or GitLab REST. All implement the same [`ForgeClient`](./engine-reference.md#the-forgeclient-interface).                                                                         |
| **MCP**                 | [Model Context Protocol](https://modelcontextprotocol.io/) — the official GitHub remote server Code Turtle uses for GitHub I/O by default.                                                                                                                       |
| **pending review**      | The GitHub MCP flow where inline findings accumulate (`create` → `add_comment_to_pending_review`) and publish together as one review (`submit_pending`).                                                                                                         |
| **watch / auto-review** | The polling loop that reviews on new PR / new push. The first cycle _baselines_ open PRs without reviewing. See [`watch.ts`](./engine-reference.md#watchts).                                                                                                     |
| **superseding**         | When a newer head SHA arrives, an in-flight review for an older SHA is skipped. Enforced by [`state.ts`](./engine-reference.md#statets).                                                                                                                         |
| **diff refs**           | `{ head_sha, base_sha, start_sha }` — the commit triple GitLab needs to anchor an inline comment.                                                                                                                                                                |
| **status note**         | The "🐢 reviewing…" / result note. Editable (sticky) on GitLab & GitHub REST; absent on GitHub MCP (no edit tool).                                                                                                                                               |

---

[← Docs index](./README.md)
