import { Box, Text, useApp, useInput } from "ink";
import React, { useState } from "react";

import {
  hasForgeCredentials,
  resetLogin,
  reviewerConfigured,
  reviewerSettings,
  reviewTokenLimit,
  updateConfig,
} from "../engine/config.js";
import { Dashboard } from "./Dashboard.js";
import { SettingsOverlay, type SettingsView } from "./dashboard/SettingsOverlay.js";
import { Login } from "./Login.js";
import { ModelPicker } from "./ModelPicker.js";
import { RepoPicker } from "./RepoPicker.js";
import { RepoScreen, type RepoRef } from "./RepoScreen.js";
import { DIM, Header } from "./theme.js";

type Screen = "login" | "model" | "repo" | "dashboard";

type Settings = "none" | SettingsView | "model" | "repos";

// login when no forge connected; model picker once after first sign-in;
// otherwise straight to repo choice. Model updates live in settings.
const initialScreen = (): Screen =>
  !hasForgeCredentials() ? "login" : !reviewerConfigured() ? "model" : "repo";

export function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [repo, setRepo] = useState<RepoRef | null>(null);
  // app-level settings overlay — reachable from every screen via ctrl+s.
  // The dashboard keeps its own richer overlay (per-repo state), opened with s.
  const [settings, setSettings] = useState<Settings>("none");
  const [model, setModel] = useState(reviewerSettings().model);
  const [passes, setPasses] = useState(reviewerSettings().passes);
  const [tokenLimit, setTokenLimit] = useState(reviewTokenLimit());

  useInput((input, key) => {
    if (screen === "dashboard" && repo) return; // dashboard owns its overlay
    if (key.ctrl && input === "s" && settings === "none") {
      // re-read on open — config may have changed since mount
      setModel(reviewerSettings().model);
      setPasses(reviewerSettings().passes);
      setTokenLimit(reviewTokenLimit());
      setSettings("settings");
    } else if (key.escape && settings !== "none") {
      setSettings(
        settings === "general" ? "settings" : settings === "tokenLimit" ? "general" : "none",
      );
    }
  });

  if (settings !== "none" && !(screen === "dashboard" && repo)) {
    if (settings === "model") {
      return (
        <Box flexDirection="column">
          <Header subtitle="Change review model" />
          <ModelPicker
            onDone={(c) => {
              updateConfig("reviewer", {
                provider: c.provider,
                api_key: c.apiKey,
                base_url: c.baseUrl,
                model: c.model,
                token_limit: c.tokenLimit,
              });
              setModel(c.model);
              setTokenLimit(c.tokenLimit);
              setSettings("general");
            }}
          />
        </Box>
      );
    }
    if (settings === "repos") {
      return (
        <Box flexDirection="column">
          <Header subtitle="Auto-review settings" />
          <RepoPicker onDone={() => setSettings("general")} />
        </Box>
      );
    }
    return (
      <SettingsOverlay
        view={settings}
        model={model}
        passes={passes}
        tokenLimit={tokenLimit}
        onNavigate={(view) => setSettings(view)}
        onCyclePasses={() => {
          // 1 → 2 → 3 → 1: extra passes re-scan with security/logic checklists
          const next = passes >= 3 ? 1 : passes + 1;
          updateConfig("reviewer", { passes: next });
          setPasses(next);
        }}
        onSetTokenLimit={(limit) => {
          updateConfig("reviewer", { token_limit: limit });
          setTokenLimit(limit);
        }}
        onQuit={() => exit()}
        onConfirmReset={() => {
          resetLogin();
          setSettings("none");
          setRepo(null);
          setScreen("login");
        }}
      />
    );
  }

  // every non-dashboard screen gets the settings hint (dashboard shows its own)
  const withSettingsHint = (node: React.ReactNode) => (
    <Box flexDirection="column">
      {node}
      <Text color={DIM}>ctrl+s settings</Text>
    </Box>
  );

  if (screen === "login") {
    return withSettingsHint(
      <Login onDone={() => setScreen(reviewerConfigured() ? "repo" : "model")} />,
    );
  }
  if (screen === "model") {
    return withSettingsHint(
      <Box flexDirection="column">
        <Header subtitle="Pick a review model — you can change it later in settings" />
        <ModelPicker
          onDone={(c) => {
            updateConfig("reviewer", {
              provider: c.provider,
              api_key: c.apiKey,
              base_url: c.baseUrl,
              model: c.model,
              token_limit: c.tokenLimit,
            });
            setScreen("repo");
          }}
        />
      </Box>,
    );
  }
  if (screen === "repo" || !repo) {
    return withSettingsHint(
      <RepoScreen
        onSelect={(sel) => {
          setRepo(sel);
          setScreen("dashboard");
        }}
      />,
    );
  }
  return (
    <Dashboard
      repo={repo}
      onChangeRepo={() => setScreen("repo")}
      onReset={() => {
        setRepo(null);
        setScreen("login");
      }}
    />
  );
}
