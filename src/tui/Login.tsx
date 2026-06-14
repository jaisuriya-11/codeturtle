/** Login screen: connect ONE forge (GitHub OAuth / GitHub CLI / GitHub token /
 * GitLab token). Model setup lives in settings — first review prompts if missing. */

import { execFileSync, spawn } from "node:child_process";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";

import { resolveToken, setForge } from "../engine/config.js";
import {
  connectGithubApp,
  inspectApp,
  readPrivateKey,
  type AppIdentity,
} from "../engine/githubApp.js";
import {
  completeDeviceFlow,
  getGithubClientId,
  GITHUB_APP_INSTALL_URL,
  startDeviceFlow,
  userHasAppInstallation,
  type DeviceFlowStart,
} from "../engine/githubAuth.js";
import { ACCENT, DIM, Header } from "./theme.js";

type Step =
  | "pick"
  | "githubKey"
  | "githubInstall"
  | "githubDevice"
  | "gitlabKey"
  | "appId"
  | "appKey"
  | "appPick";

/** Best-effort browser open, per platform (darwin/win32/linux). Sign-in never
 * depends on it — every URL is also printed in the TUI. */
function openUrl(url: string): void {
  let safeUrl: string;
  try {
    const parsed = new URL(url);
    // Only allow the expected GitHub device verification page over HTTPS.
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.pathname !== "/login/device"
    ) {
      return;
    }
    safeUrl = parsed.toString();
  } catch {
    return;
  }

  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", safeUrl] : [safeUrl];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // opening is convenience only
  }
}

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
  const [appId, setAppId] = useState("");
  const [appPem, setAppPem] = useState("");
  const [appInfo, setAppInfo] = useState<AppIdentity | null>(null);
  // OAuth finished but the app isn't installed anywhere yet — finish from the install step
  const [signedIn, setSignedIn] = useState(false);

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
        openUrl(info.verificationUri);
        const user = await completeDeviceFlow(
          clientId,
          info.deviceCode,
          info.interval,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setDevice(null);
        // the app's OAuth token only reaches repos the app is installed on —
        // a sign-in without an installation can't review anything
        const installed = await userHasAppInstallation(resolveToken("github") ?? "");
        if (ctrl.signal.aborted) return;
        if (installed === false) {
          setSignedIn(true);
          setError("signed in, but the code turtle app isn't installed on any repo or org yet");
          setStep("githubInstall");
          return;
        }
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

  // install step → continue: already signed in means re-check the installation,
  // otherwise move on to the device flow
  const continueFromInstall = async () => {
    if (!signedIn) {
      setError(null);
      setStep("githubDevice");
      return;
    }
    setBusy("Checking app installation…");
    const installed = await userHasAppInstallation(resolveToken("github") ?? "");
    setBusy(null);
    if (installed === false) {
      setError(`still not installed — open ${GITHUB_APP_INSTALL_URL}, install, then continue`);
      return;
    }
    setError(null);
    onDone();
  };

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

  // app sign-in, step 2: validate key + app id, list installations
  const connectApp = async (keyPath: string) => {
    setBusy("Validating GitHub App…");
    try {
      const pem = readPrivateKey(keyPath);
      const info = await inspectApp(appId.trim(), pem);
      setBusy(null);
      if (info.installations.length === 0) {
        setError(`app "${info.slug}" has no installations — install it on a repo/org first`);
        setStep("pick");
        return;
      }
      setAppPem(pem);
      setError(null);
      setInput("");
      if (info.installations.length === 1) {
        await finishApp(pem, info, info.installations[0]);
        return;
      }
      setAppInfo(info);
      setStep("appPick");
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "app sign-in failed");
      setStep("pick");
    }
  };

  // app sign-in, final step: store key, mint installation token
  const finishApp = async (
    pem: string,
    info: AppIdentity,
    inst: AppIdentity["installations"][0],
  ) => {
    setBusy("Minting installation token…");
    try {
      await connectGithubApp(appId.trim(), pem, inst, info.slug);
      setBusy(null);
      onDone();
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "app sign-in failed");
      setStep("pick");
    }
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
                {
                  label: "Sign in as a GitHub App (reviews post as a bot)",
                  value: "app",
                },
                { label: "Connect GitLab (paste a token)", value: "gitlab" },
              ]}
              onSelect={(item) => {
                if (item.value === "oauth") {
                  setError(null);
                  setStep("githubInstall");
                } else if (item.value === "app") {
                  setError(null);
                  setStep("appId");
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

      {step === "githubInstall" && (
        <Box flexDirection="column">
          <Text bold>Install the code turtle app first</Text>
          <Text color={DIM}>
            reviews only reach repos the app is installed on — install it, then continue:
          </Text>
          <Text color={ACCENT}>{GITHUB_APP_INSTALL_URL}</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Open the install page in my browser", value: "open" },
                {
                  label: signedIn
                    ? "I've installed it — finish sign-in"
                    : "I've installed it — continue to sign in",
                  value: "continue",
                },
                { label: "← Back", value: "back" },
              ]}
              onSelect={(item) => {
                if (item.value === "open") openUrl(GITHUB_APP_INSTALL_URL);
                else if (item.value === "continue") void continueFromInstall();
                else {
                  setError(null);
                  setStep("pick");
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

      {step === "appId" && (
        <Box flexDirection="column">
          <Text bold>GitHub App id</Text>
          <Text color={DIM}>
            create an app under github.com/settings/apps — permissions: pull requests rw, contents
            ro, issues rw · then install it on your repos
          </Text>
          <Box>
            <Text color={ACCENT}>{"❯ "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(v) => {
                if (!v.trim()) return;
                setAppId(v.trim());
                setInput("");
                setStep("appKey");
              }}
            />
          </Box>
        </Box>
      )}

      {step === "appKey" && (
        <Box flexDirection="column">
          <Text bold>Private key path (.pem)</Text>
          <Text color={DIM}>
            app settings → private keys → generate — the key is copied into ~/.codeturtle
          </Text>
          <Box>
            <Text color={ACCENT}>{"❯ "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(v) => v.trim() && void connectApp(v.trim())}
            />
          </Box>
        </Box>
      )}

      {step === "appPick" && appInfo && (
        <Box flexDirection="column">
          <Text bold>Where should {appInfo.name} review?</Text>
          <Box marginTop={1}>
            <SelectInput
              items={appInfo.installations.map((i) => ({
                label: i.account,
                value: String(i.id),
              }))}
              onSelect={(item) => {
                const inst = appInfo.installations.find((i) => String(i.id) === item.value);
                if (inst) void finishApp(appPem, appInfo, inst);
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
