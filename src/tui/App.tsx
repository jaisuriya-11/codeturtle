import { Box } from "ink";
import React, { useState } from "react";

import { hasForgeCredentials, reviewerConfigured, updateConfig } from "../engine/config.js";
import { Dashboard } from "./Dashboard.js";
import { Login } from "./Login.js";
import { ModelPicker } from "./ModelPicker.js";
import { RepoScreen, type RepoRef } from "./RepoScreen.js";
import { Header } from "./theme.js";

type Screen = "login" | "model" | "repo" | "dashboard";

// login when no forge connected; model picker once after first sign-in;
// otherwise straight to repo choice. Model updates live in settings.
const initialScreen = (): Screen =>
  !hasForgeCredentials() ? "login" : !reviewerConfigured() ? "model" : "repo";

export function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [repo, setRepo] = useState<RepoRef | null>(null);

  if (screen === "login") {
    return <Login onDone={() => setScreen(reviewerConfigured() ? "repo" : "model")} />;
  }
  if (screen === "model") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Pick a review model — you can change it later in settings" />
        <ModelPicker
          onDone={(c) => {
            updateConfig("reviewer", {
              provider: c.provider,
              api_key: c.apiKey,
              base_url: c.baseUrl,
              model: c.model,
            });
            setScreen("repo");
          }}
        />
      </Box>
    );
  }
  if (screen === "repo" || !repo) {
    return (
      <RepoScreen
        onSelect={(sel) => {
          setRepo(sel);
          setScreen("dashboard");
        }}
      />
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
