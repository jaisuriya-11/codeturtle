/** Repo screen: pick the repo this session's dashboard works on. */

import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";

import { loadCredentials, resolveToken } from "../engine/config.js";
import type { Forge } from "../engine/types.js";
import { listRepos } from "../engine/viewer.js";
import { ACCENT, DIM, Header } from "./theme.js";

export interface RepoRef {
  forge: Forge;
  projectId: string;
}

type Step = "forge" | "loading" | "pick" | "manual";

export function RepoScreen({ onSelect }: { onSelect: (repo: RepoRef) => void }) {
  const creds = loadCredentials();
  const hasGithub = !!resolveToken("github");
  const hasGitlab = !!resolveToken("gitlab");

  const [forge, setForgeChoice] = useState<Forge>(hasGithub ? "github" : "gitlab");
  // single forge connected → skip the forge question
  const [step, setStep] = useState<Step>(hasGithub && hasGitlab ? "forge" : "loading");
  const [repos, setRepos] = useState<string[]>([]);
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (step !== "loading") return;
    void (async () => {
      setRepos(await listRepos(forge));
      setStep("pick");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (step === "forge") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Choose a repo to review" />
        <Text bold>Which forge?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: `GitHub${creds.github?.user ? `  (${creds.github.user})` : ""}`, value: "github" },
              { label: `GitLab${creds.gitlab?.user ? `  (${creds.gitlab.user})` : ""}`, value: "gitlab" },
            ]}
            onSelect={(item) => {
              setForgeChoice(item.value as Forge);
              setStep("loading");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "loading") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Choose a repo to review" />
        <Text>
          <Spinner type="dots" /> Loading your {forge} repos…
        </Text>
      </Box>
    );
  }

  if (step === "manual") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Choose a repo to review" />
        <Text bold>Repo ({forge === "github" ? "owner/repo" : "group/project or ID"})</Text>
        <Box>
          <Text color={ACCENT}>{"❯ "}</Text>
          <TextInput
            value={manual}
            onChange={setManual}
            onSubmit={(v) => v.trim() && onSelect({ forge, projectId: v.trim() })}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header subtitle="Choose a repo to review" />
      <Text bold>Pick a {forge} repo</Text>
      {repos.length === 0 ? (
        <Text color={DIM}>Couldn't load your repos — type one manually below.</Text>
      ) : null}
      <Box marginTop={1}>
        <SelectInput
          limit={12}
          items={[
            ...repos.slice(0, 30).map((r) => ({ label: r, value: r })),
            { label: "✎  type repo manually", value: "__manual__" },
            ...(hasGithub && hasGitlab
              ? [{ label: "← Switch forge", value: "__forge__" }]
              : []),
          ]}
          onSelect={(item) => {
            if (item.value === "__manual__") setStep("manual");
            else if (item.value === "__forge__") setStep("forge");
            else onSelect({ forge, projectId: item.value });
          }}
        />
      </Box>
    </Box>
  );
}
