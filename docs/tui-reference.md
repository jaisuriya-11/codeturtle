# TUI Reference

[← Docs index](./README.md) · [Architecture](./architecture.md)

The TUI is built with **React + [Ink](https://github.com/vadimdemedes/ink)**. It is presentation
only: **no component talks to a forge or LLM directly — they call engine functions.** All color
comes from `theme.tsx` (`ACCENT` / `DIM`); user-facing text is short, lowercase-ish, no
exclamation marks; no emoji in the header (the logo is ASCII).

The bare `codeturtle` command renders `<App />` (see [`cli/index.ts`](../src/cli/index.ts)).

## Component tree

```
App                         setup-on-start router
├── Setup                   first-run wizard (model → GitHub → GitLab)
│   └── ModelPicker         provider → model → key
└── Dashboard               paste box + reviews list + events feed
    ├── ModelPicker         (overlay: change model)
    └── RepoPicker          (overlay: manage watched repos)
```

## `App.tsx`

The router. On mount it computes `needsSetup` = no forge configured **or** no reviewer key
(and not a localhost endpoint). If so it shows `<Setup>`, otherwise `<Dashboard>`.

> Setup runs **on start only** — first run or after a reset. There's no mid-session re-entry into
> the wizard; the Dashboard handles in-session changes via overlays.

## `Setup.tsx`

The first-run wizard. Steps: `model → github → githubKey → githubRepo → githubRepoManual →
gitlab → gitlabKey → done`.

- **Model** — delegates to `<ModelPicker>`, writes the `reviewer` config section.
- **GitHub** — three choices: reuse the `gh auth token` CLI session (`ghCliToken()` shells out
  to `gh`), paste a PAT, or skip. Tokens are validated against `GET /user` and stored with
  `backend: "mcp"`.
- **Repo** — fetches your GitHub repos (`/user/repos?sort=pushed`) and lets you pick one (or type
  it) to seed `watch.targets` as `github:owner/repo`.
- **GitLab** — optional PAT, validated against `{url}/api/v4/user`, stored with `backend: "rest"`.

`isConfigured()` (exported) is the predicate `App` uses: true if any forge token exists in the
store or env.

## `ModelPicker.tsx`

opencode-style model selection. Steps: `provider → detecting → model → customModel → customUrl →
key`. Reads the registry from [`providers.ts`](./engine-reference.md#providersts).

- Picking a **local** provider (Ollama / LM Studio) runs `detectLocalModels()` and lists what's
  live; if none are detected you can still type a model id. Local providers need no API key.
- "Custom endpoint" prompts for a base URL, then a model id, then a key.
- Calls back with `{ provider, baseUrl, model, apiKey }`.

## `RepoPicker.tsx`

Manage the auto-review target list. Steps: `forge → loading → pick → manual → remove`.

- Lists your GitHub (`/user/repos`) or GitLab (`/projects?membership=true`) repos.
- Adds targets as `forge:repo` into `watch.targets` (deduped), preserving the `watch.interval`
  (default 30s). Also supports removing a watched repo.

## `Dashboard.tsx`

The main screen. Responsibilities:

- **Paste box** — `startPastedReview()` parses the link ([`prLink`](./engine-reference.md#prlinkts)),
  fetches the head SHA, and calls [`runReview`](./engine-reference.md#pipelinets). Reviews show
  as rows (running → done / failed).
- **Auto-review** — `startWatch(targets)` drives the [`watch`](./engine-reference.md#watchts) loop
  with an `AbortController`; `onJob` adds a "reviewing…" row. A shared `watchLog` callback feeds
  both the events feed and the per-PR status (it pattern-matches the pipeline's
  `pr=… found=… kept=…` / `review failed pr=…` log lines).
- **Session selection** — on open, asks which configured repo to monitor for this session (or all,
  or a new one, or skip).
- **Overlays** (`Esc` opens settings): change model (`<ModelPicker>`), manage repos
  (`<RepoPicker>`), reset all config (with a red confirm), or quit. All abort the watcher on exit.

## `theme.tsx`

The shared look:

- `ACCENT` (`#3498db`) and `DIM` (`gray`) — **the only colors components may use.**
- `Header` — the ASCII "TURTLE" logo block + tagline + optional subtitle. **No emoji here.**
- `KeyHint` — renders `[key, label]` pairs as a footer hint bar.

---

[← Docs index](./README.md) · Next: [Configuration](./configuration.md)
