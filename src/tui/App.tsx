import React, { useState } from "react";

import { reviewerSettings } from "../engine/config.js";
import { Dashboard } from "./Dashboard.js";
import { isConfigured, Setup } from "./Setup.js";

export function App() {
  const needsSetup =
    !isConfigured() ||
    (!reviewerSettings().apiKey && !reviewerSettings().baseUrl.includes("localhost"));
  const [screen, setScreen] = useState<"setup" | "dashboard">(needsSetup ? "setup" : "dashboard");

  // Setup runs on start (first run / after reset) only — no mid-session re-entry.
  return screen === "setup" ? (
    <Setup onDone={() => setScreen("dashboard")} />
  ) : (
    <Dashboard onReset={() => setScreen("setup")} />
  );
}
