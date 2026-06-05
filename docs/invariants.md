# Hard Invariants

[← Docs index](./README.md)

These are the rules that keep Code Turtle correct and safe. **Breaking one is a bug, not a
refactor.** They are mirrored from [`AGENTS.md`](../AGENTS.md) with pointers into the code and
the rest of these docs. Read this before touching the engine.

> **Each invariant is locked by a test.** `src/engine/__tests__/invariants.test.ts` encodes all
> seven against the real code, so a change that violates one fails CI. If you intentionally change
> an invariant, update this doc, `AGENTS.md`, and the matching test together.

## 1. Markers are the idempotency system

Every bot artifact carries a hidden HTML marker:

- `<!-- ct:f:FILE:LINE -->` — an inline finding
- `<!-- ct:review -->` — the summary review
- `<!-- ct:status -->` — the status note

[`poster.ts`](./engine-reference.md#posterts) dedups findings against existing markers with a
**±3 line tolerance** (`LINE_TOLERANCE`) to absorb LLM line jitter across re-reviews.

**Never** post a bot artifact without a marker. **Never** remove the tolerance. **Never** change
a marker format — doing so breaks dedup against comments already on the PR, producing duplicates.

## 2. Security: repo config is untrusted

[`norms.ts`](./engine-reference.md#normsts) strips `agent` and `key_ref` from a repo's
`.codeturtle.yml`. A PR author must never be able to redirect the reviewer (to a different
model/endpoint) or exfiltrate your keys via a committed file.

Keep the stripping. **Never add any path** for repo files to set URLs, keys, or commands. See
[Configuration › security](./configuration.md#security-what-repo-config-cannot-do).

## 3. Secrets stay in `~/.codeturtle/` with chmod 600

Tokens and API keys live only in the local store, written 0600 by
[`config.ts`](./engine-reference.md#configts). **Never** log tokens or keys, **never** write them
anywhere else, **never** echo them in errors or the TUI. Env vars may override the store, but the
store remains the only on-disk location.

## 4. `~/.codeturtle` file shapes are a compatibility contract

`credentials.json` and `config.json` share their shape with the original Python implementation so
existing setups keep working. **Additive changes only** — never rename or remove an existing
field. See [Configuration › file shapes](./configuration.md#the-local-store-codeturtle).

## 5. GitHub MCP has no comment-edit tool

On the default GitHub (MCP) backend there is **no** sticky status note, and the summary goes out
as **one** review via the pending-review flow:

```
create  →  add_comment_to_pending_review (per finding)  →  submit_pending (with summary)
```

Do **not** "fix" the missing status note by posting per-finding reviews. **One review per run.**
See [`forgeMcp.ts`](./engine-reference.md#forgemcpts) and
[Architecture › why MCP](./architecture.md#why-github-goes-through-mcp).

## 6. Reviewer output is hostile input

Models return wrong enums, word confidences ("high"), and fenced JSON.
[`reviewer.ts`](./engine-reference.md#reviewerts) validates **every** finding and silently drops
the invalid ones. Keep validation strict; coerce only what is unambiguous (the existing
confidence-word mapping). Never trust a field straight from the model.

## 7. One review at a time per PR

[`state.ts`](./engine-reference.md#statets) enforces a lock (in-process map + on-disk lock file)
and supersedes an in-flight review when a newer head SHA arrives. **Anything that triggers a
review must go through [`pipeline.runReview`](./engine-reference.md#pipelinets)**, which enforces
both. The lock is always released in a `finally`, and one PR's failure must never kill the
watcher.

---

## Quick "is this a violation?" checklist

Before you ship an engine change, ask:

- [ ] Did I post any comment/review/status without its marker, or change a marker format?
- [ ] Can a repo's `.codeturtle.yml` now influence the model, endpoint, key, or a command?
- [ ] Does a token/key get logged, surfaced in an error, or written outside `~/.codeturtle`?
- [ ] Did I rename/remove a field in `credentials.json` or `config.json`?
- [ ] Did I add a second GitHub review per run, or a status note on the MCP path?
- [ ] Did I relax finding validation or trust a model field directly?
- [ ] Can a review be triggered without going through `runReview` (bypassing the lock)?

Any "yes" means stop and rethink.

---

[← Docs index](./README.md) · Next: [Contributing](../CONTRIBUTING.md) · [Glossary](./glossary.md)
