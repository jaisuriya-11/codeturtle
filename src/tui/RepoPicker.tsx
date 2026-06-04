/** Choose repos to auto-review: lists your forge repos, pick to add. */

import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";

import { loadConfig, loadCredentials, resolveToken, updateConfig } from "../engine/config.js";
import { ACCENT, DIM } from "./theme.js";

async function fetchGithubRepos(token: string): Promise<string[]> {
  const r = await fetch("https://api.github.com/user/repos?per_page=50&sort=pushed", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return [];
  return ((await r.json()) as any[]).map((x) => x.full_name);
}

async function fetchGitlabRepos(url: string, token: string): Promise<string[]> {
  const r = await fetch(`${url}/api/v4/projects?membership=true&per_page=50&order_by=last_activity_at`, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return [];
  return ((await r.json()) as any[]).map((x) => String(x.path_with_namespace ?? x.id));
}

type Step = "forge" | "loading" | "pick" | "manual" | "remove";

export function RepoPicker({ onDone }: { onDone: () => void }) {
  const creds = loadCredentials();
  const targets = loadConfig().watch?.targets ?? [];
  const hasGithub = !!resolveToken("github");
  const hasGitlab = !!resolveToken("gitlab");

  const [step, setStep] = useState<Step>("forge");
  const [forge, setForge] = useState<"github" | "gitlab">("github");
  const [repos, setRepos] = useState<string[]>([]);
  const [manual, setManual] = useState("");

  const addTarget = (t: string) => {
    const next = [...new Set([...targets, t])];
    updateConfig("watch", { targets: next, interval: loadConfig().watch?.interval ?? 30 });
    onDone();
  };

  useEffect(() => {
    if (step !== "loading") return;
    void (async () => {
      const found =
        forge === "github"
          ? await fetchGithubRepos(resolveToken("github") ?? "")
          : await fetchGitlabRepos(creds.gitlab?.url ?? "https://gitlab.com", resolveToken("gitlab") ?? "");
      setRepos(found);
      setStep("pick");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (step === "forge") {
    const items = [
      ...(hasGithub ? [{ label: "Add a GitHub repo", value: "github" }] : []),
      ...(hasGitlab ? [{ label: "Add a GitLab repo", value: "gitlab" }] : []),
      ...(targets.length ? [{ label: "Remove a watched repo", value: "remove" }] : []),
      { label: "← Back", value: "back" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Auto-review repos</Text>
        <Text color={DIM}>
          {targets.length ? `Watching: ${targets.join("  ")}` : "Not watching any repos yet."}
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "back") onDone();
              else if (item.value === "remove") setStep("remove");
              else {
                setForge(item.value as "github" | "gitlab");
                setStep("loading");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "loading") {
    return (
      <Text>
        <Spinner type="dots" /> Loading your {forge} repos…
      </Text>
    );
  }

  if (step === "pick") {
    const items = [
      ...repos
        .filter((r) => !targets.includes(`${forge}:${r}`))
        .slice(0, 30)
        .map((r) => ({ label: r, value: r })),
      { label: "✎  type repo manually", value: "__manual__" },
      { label: "← Back", value: "__back__" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Pick a {forge} repo to auto-review</Text>
        <Box marginTop={1}>
          <SelectInput
            limit={12}
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") setStep("forge");
              else if (item.value === "__manual__") setStep("manual");
              else addTarget(`${forge}:${item.value}`);
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "manual") {
    return (
      <Box flexDirection="column">
        <Text bold>Repo ({forge === "github" ? "owner/repo" : "group/project or ID"})</Text>
        <Box>
          <Text color={ACCENT}>{"❯ "}</Text>
          <TextInput
            value={manual}
            onChange={setManual}
            onSubmit={(v) => v.trim() && addTarget(`${forge}:${v.trim()}`)}
          />
        </Box>
      </Box>
    );
  }

  // remove
  return (
    <Box flexDirection="column">
      <Text bold>Remove from auto-review</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[...targets.map((t) => ({ label: t, value: t })), { label: "← Back", value: "__back__" }]}
          onSelect={(item) => {
            if (item.value === "__back__") return setStep("forge");
            updateConfig("watch", { targets: targets.filter((t) => t !== item.value) });
            onDone();
          }}
        />
      </Box>
    </Box>
  );
}
