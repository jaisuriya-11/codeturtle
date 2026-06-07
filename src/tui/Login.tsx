/** Login screen: connect ONE forge (GitHub OAuth / GitHub CLI / GitHub token /
 * GitLab token). Model setup lives in settings — first review prompts if missing. */

import { execFileSync } from "node:child_process";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";

import { setForge } from "../engine/config.js";
import {
  completeDeviceFlow,
  getGithubClientId,
  startDeviceFlow,
  type DeviceFlowStart,
} from "../engine/githubAuth.js";
import { ACCENT, DIM, Header } from "./theme.js";

type Step = "pick" | "githubKey" | "githubDevice" | "gitlabKey";

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
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
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

export function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("pick");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [gitlabUrl] = useState(process.env.GITLAB_URL ?? "https://gitlab.com");
  const [device, setDevice] = useState<DeviceFlowStart | null>(null);

  // OAuth device flow: request a code, poll until the user authorises.
  useEffect(() => {
    if (step !== "githubDevice") return;
    const clientId = getGithubClientId();
    if (!clientId) {
      setError("set GITHUB_CLIENT_ID to enable GitHub OAuth");
      setStep("pick");
      return;
    }
    const ctrl = new AbortController();
    setDevice(null);
    void (async () => {
      try {
        const info = await startDeviceFlow(clientId);
        if (ctrl.signal.aborted) return;
        setDevice(info);
        const user = await completeDeviceFlow(
          clientId,
          info.deviceCode,
          info.interval,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setDevice(null);
        setError(user ? null : "Signed in, but couldn't read your username.");
        onDone();
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setDevice(null);
        setError(e instanceof Error ? e.message : "GitHub sign-in failed");
        setStep("pick");
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const connectGithubToken = async (token: string) => {
    setBusy("Validating GitHub token…");
    const user = await validateGithub(token);
    setBusy(null);
    if (!user) {
      setError("Token rejected by GitHub. Try again.");
      return;
    }
    setForge("github", { token, method: "pat", user, backend: "mcp" });
    onDone();
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
      <Header subtitle="Sign in — everything stays on your machine (~/.codeturtle)" />
      {error ? <Text color="red">{error}</Text> : null}

      {step === "pick" && (
        <Box flexDirection="column">
          <Text bold>Sign in to a forge</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Sign in with GitHub (OAuth)", value: "oauth" },
                {
                  label: "Use GitHub CLI session (gh auth token)",
                  value: "gh",
                },
                {
                  label: "Paste a GitHub personal access token",
                  value: "ghpat",
                },
                { label: "Connect GitLab (paste a token)", value: "gitlab" },
              ]}
              onSelect={(item) => {
                if (item.value === "oauth") {
                  setError(null);
                  setStep("githubDevice");
                } else if (item.value === "gh") {
                  const token = ghCliToken();
                  if (token) void connectGithubToken(token);
                  else setError("No gh session found. Run `gh auth login` first, or paste a PAT.");
                } else if (item.value === "ghpat") {
                  setStep("githubKey");
                } else if (item.value === "gitlab") {
                  setStep("gitlabKey");
                }
              }}
            />
          </Box>
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
                2. enter code{" "}
                <Text color={ACCENT} bold>
                  {device.userCode}
                </Text>
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
            <TextInput
              value={input}
              onChange={setInput}
              mask="•"
              onSubmit={(v) => v.trim() && void connectGithubToken(v.trim())}
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
              value={input}
              onChange={setInput}
              mask="•"
              onSubmit={(v) => {
                const token = v.trim();
                if (!token) return;
                setBusy("Validating GitLab token…");
                void validateGitlab(gitlabUrl, token).then((user) => {
                  setBusy(null);
                  if (!user) return setError("Token rejected by GitLab.");
                  setForge("gitlab", {
                    token,
                    method: "pat",
                    user,
                    url: gitlabUrl,
                    backend: "rest",
                  });
                  setError(null);
                  setInput("");
                  onDone();
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
