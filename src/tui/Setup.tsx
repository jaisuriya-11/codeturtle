/** First-run wizard: model → GitHub → GitLab (optional). */

import { execFileSync } from "node:child_process";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";

import { loadCredentials, resolveToken, setForge, updateConfig } from "../engine/config.js";
import {
  completeDeviceFlow, getGithubClientId, startDeviceFlow, type DeviceFlowStart,
} from "../engine/githubAuth.js";
import { ModelPicker, type ModelChoice } from "./ModelPicker.js";
import { ACCENT, DIM, Header } from "./theme.js";

type Step =
  | "model"
  | "github"
  | "githubKey"
  | "githubDevice"
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
  const [device, setDevice] = useState<DeviceFlowStart | null>(null);

  // OAuth device flow: request a code, poll until the user authorises, then
  // load repos and continue exactly like the token path.
  useEffect(() => {
    if (step !== "githubDevice") return;
    const clientId = getGithubClientId();
    if (!clientId) {
      setError("set GITHUB_CLIENT_ID to enable GitHub OAuth");
      setStep("github");
      return;
    }
    const ctrl = new AbortController();
    setDevice(null);
    void (async () => {
      try {
        const info = await startDeviceFlow(clientId);
        if (ctrl.signal.aborted) return;
        setDevice(info);
        const user = await completeDeviceFlow(clientId, info.deviceCode, info.interval, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setBusy("Loading your GitHub repos…");
        setGithubRepos(await fetchGithubRepos(resolveToken("github") ?? ""));
        setBusy(null);
        setDevice(null);
        setError(user ? null : "Signed in, but couldn't read your username.");
        setStep("githubRepo");
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setBusy(null);
        setDevice(null);
        setError(e instanceof Error ? e.message : "GitHub sign-in failed");
        setStep("github");
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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
                { label: "Sign in with GitHub (OAuth)", value: "oauth" },
                { label: "Use GitHub CLI session (gh auth token)", value: "gh" },
                { label: "Paste a personal access token", value: "pat" },
                { label: "Skip", value: "skip" },
              ]}
              onSelect={(item) => {
                if (item.value === "skip") setStep("gitlab");
                else if (item.value === "oauth") {
                  if (getGithubClientId()) {
                    setError(null);
                    setStep("githubDevice");
                  } else {
                    setError("GitHub OAuth needs a client id — set GITHUB_CLIENT_ID and retry.");
                  }
                } else if (item.value === "gh") {
                  const token = ghCliToken();
                  if (token) void connectGithubToken(token);
                  else setError("No gh session found. Run `gh auth login` first, or paste a PAT.");
                } else setStep("githubKey");
              }}
            />
          </Box>
          {!getGithubClientId() ? (
            <Text color={DIM}>OAuth requires GITHUB_CLIENT_ID (a GitHub OAuth/App client id).</Text>
          ) : null}
        </Box>
      )}

      {step === "githubDevice" && (
        <Box flexDirection="column">
          <Text bold>Sign in with GitHub</Text>
          {device ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                1. open <Text color={ACCENT}>{device.verificationUri}</Text>
              </Text>
              <Text>
                2. enter code <Text color={ACCENT} bold>{device.userCode}</Text>
              </Text>
              <Box marginTop={1}>
                <Text color={DIM}>
                  <Spinner type="dots" /> waiting for authorization…
                </Text>
              </Box>
            </Box>
          ) : (
            <Text color={DIM}>
              <Spinner type="dots" /> requesting a device code…
            </Text>
          )}
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
