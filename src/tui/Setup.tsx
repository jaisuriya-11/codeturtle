/** First-run wizard: model → GitHub → GitLab (optional). */

import { execFileSync } from "node:child_process";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useState } from "react";

import { loadCredentials, setForge, updateConfig } from "../engine/config.js";
import { ModelPicker, type ModelChoice } from "./ModelPicker.js";
import { ACCENT, DIM, Header } from "./theme.js";

type Step =
  | "model"
  | "github"
  | "githubKey"
  | "githubRepo"
  | "githubRepoManual"
  | "gitlab"
  | "gitlabKey"
  | "done";

function ghCliToken(): string | null {
  try {
    const out = execFileSync("gh", ["auth", "token"], { timeout: 10000 }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

async function validateGithub(token: string): Promise<string | null> {
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? ((await r.json()) as any).login : null;
  } catch {
    return null;
  }
}

async function validateGitlab(url: string, token: string): Promise<string | null> {
  try {
    const r = await fetch(`${url}/api/v4/user`, {
      headers: { "PRIVATE-TOKEN": token },
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? ((await r.json()) as any).username : null;
  } catch {
    return null;
  }
}

async function fetchGithubRepos(token: string): Promise<string[]> {
  try {
    const r = await fetch("https://api.github.com/user/repos?per_page=50&sort=pushed", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((x) => x.full_name);
  } catch {
    return [];
  }
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("model");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [gitlabUrl, setGitlabUrl] = useState("https://gitlab.com");
  const [githubRepos, setGithubRepos] = useState<string[]>([]);

  const onModel = (c: ModelChoice) => {
    updateConfig("reviewer", {
      provider: c.provider, api_key: c.apiKey, base_url: c.baseUrl, model: c.model,
    });
    setStep("github");
  };

  const connectGithubToken = async (token: string) => {
    setBusy("Validating GitHub token…");
    const user = await validateGithub(token);
    if (!user) {
      setBusy(null);
      setError("Token rejected by GitHub. Try again.");
      return;
    }
    setForge("github", { token, method: "pat", user, backend: "mcp" });
    setBusy("Loading your GitHub repos…");
    const repos = await fetchGithubRepos(token);
    setGithubRepos(repos);
    setBusy(null);
    setError(null);
    setInput("");
    setStep("githubRepo");
  };

  if (busy) {
    return (
      <Box flexDirection="column">
        <Header />
        <Text>
          <Spinner type="dots" /> {busy}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header subtitle="Setup — everything stays on your machine (~/.codeturtle)" />
      {error ? <Text color="red">{error}</Text> : null}

      {step === "model" && <ModelPicker onDone={onModel} />}

      {step === "github" && (
        <Box flexDirection="column">
          <Text bold>Connect GitHub</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Use GitHub CLI session (gh auth token)", value: "gh" },
                { label: "Paste a personal access token", value: "pat" },
                { label: "Skip", value: "skip" },
              ]}
              onSelect={(item) => {
                if (item.value === "skip") setStep("gitlab");
                else if (item.value === "gh") {
                  const token = ghCliToken();
                  if (token) void connectGithubToken(token);
                  else setError("No gh session found. Run `gh auth login` first, or paste a PAT.");
                } else setStep("githubKey");
              }}
            />
          </Box>
        </Box>
      )}

      {step === "githubKey" && (
        <Box flexDirection="column">
          <Text bold>GitHub token</Text>
          <Text color={DIM}>Create: https://github.com/settings/tokens (scope: repo)</Text>
          <Box>
            <Text color={ACCENT}>{"❯ "}</Text>
            <TextInput value={input} onChange={setInput} mask="•"
              onSubmit={(v) => v.trim() && void connectGithubToken(v.trim())} />
          </Box>
        </Box>
      )}

      {step === "githubRepo" && (
        <Box flexDirection="column">
          <Text bold>Select a GitHub repo to monitor / review</Text>
          <Box marginTop={1}>
            <SelectInput
              limit={12}
              items={[
                ...githubRepos.slice(0, 30).map((r) => ({ label: r, value: r })),
                { label: "✎  type repo manually", value: "__manual__" },
                { label: "Skip", value: "__skip__" },
              ]}
              onSelect={(item) => {
                if (item.value === "__skip__") {
                  setStep("gitlab");
                } else if (item.value === "__manual__") {
                  setStep("githubRepoManual");
                } else {
                  updateConfig("watch", { targets: [`github:${item.value}`] });
                  setStep("gitlab");
                }
              }}
            />
          </Box>
        </Box>
      )}

      {step === "githubRepoManual" && (
        <Box flexDirection="column">
          <Text bold>Type GitHub repo (owner/repo)</Text>
          <Box>
            <Text color={ACCENT}>{"❯ "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(v) => {
                const repo = v.trim();
                if (repo) {
                  updateConfig("watch", { targets: [`github:${repo}`] });
                }
                setInput("");
                setStep("gitlab");
              }}
            />
          </Box>
        </Box>
      )}

      {step === "gitlab" && (
        <Box flexDirection="column">
          <Text bold>Connect GitLab?</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Yes — paste a personal access token", value: "yes" },
                { label: "Skip", value: "skip" },
              ]}
              onSelect={(item) => {
                if (item.value === "yes") setStep("gitlabKey");
                else {
                  setStep("done");
                  setTimeout(onDone, 600);
                }
              }}
            />
          </Box>
        </Box>
      )}

      {step === "gitlabKey" && (
        <Box flexDirection="column">
          <Text bold>GitLab token</Text>
          <Text color={DIM}>
            URL: {gitlabUrl} (set GITLAB_URL env for self-hosted) · create: {gitlabUrl}
            /-/user_settings/personal_access_tokens (scope: api)
          </Text>
          <Box>
            <Text color={ACCENT}>{"❯ "}</Text>
            <TextInput
              value={input} onChange={setInput} mask="•"
              onSubmit={(v) => {
                const token = v.trim();
                if (!token) return;
                setBusy("Validating GitLab token…");
                void validateGitlab(gitlabUrl, token).then((user) => {
                  setBusy(null);
                  if (!user) return setError("Token rejected by GitLab.");
                  setForge("gitlab", { token, method: "pat", user, url: gitlabUrl, backend: "rest" });
                  setError(null);
                  setInput("");
                  setStep("done");
                  setTimeout(onDone, 600);
                });
              }}
            />
          </Box>
        </Box>
      )}

      {step === "done" && <Text color={ACCENT}>✓ Setup complete — paste a PR link to review</Text>}
    </Box>
  );
}

export function isConfigured(): boolean {
  const creds = loadCredentials();
  const hasForge = !!(creds.github?.token ?? creds.gitlab?.token ?? process.env.GITHUB_TOKEN ?? process.env.GITLAB_TOKEN);
  return hasForge;
}
