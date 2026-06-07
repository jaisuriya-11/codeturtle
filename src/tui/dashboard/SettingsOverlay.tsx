/** Settings overlays for the dashboard: root menu, general settings, reset confirm.
 * Pure presentation — all state and side effects stay in Dashboard. */

import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import React from "react";

import { loadConfig } from "../../engine/config.js";
import { ACCENT, Header } from "../theme.js";

export type SettingsView = "settings" | "general" | "confirmReset";

export function SettingsOverlay({
  view,
  model,
  passes,
  onNavigate,
  onCyclePasses,
  onQuit,
  onConfirmReset,
}: {
  view: SettingsView;
  model: string;
  passes: number;
  onNavigate: (view: SettingsView | "none" | "model" | "repos") => void;
  onCyclePasses: () => void;
  onQuit: () => void;
  onConfirmReset: () => void;
}) {
  if (view === "confirmReset") {
    return (
      <Box flexDirection="column">
        <Header />
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="red" bold>
            Reset login, repos & model?
          </Text>
          <Text>
            Signs out (deletes forge tokens), clears watched repos and the review model/API key.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Cancel", value: "cancel" },
                { label: "Yes — sign out", value: "wipe" },
              ]}
              onSelect={(item) => {
                if (item.value === "wipe") onConfirmReset();
                else onNavigate("settings");
              }}
            />
          </Box>
        </Box>
      </Box>
    );
  }

  if (view === "general") {
    const targets = loadConfig().watch?.targets ?? [];
    return (
      <Box flexDirection="column">
        <Header subtitle="General settings" />
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
          <SelectInput
            items={[
              { label: "← Back", value: "back" },
              { label: `Change model  (${model})`, value: "model" },
              {
                label: `Review passes  (${passes} — ${passes === 1 ? "fast" : "thorough"})`,
                value: "passes",
              },
              { label: `Auto-review repos  (${targets.length} watched)`, value: "repos" },
            ]}
            onSelect={(item) => {
              if (item.value === "back") onNavigate("settings");
              else if (item.value === "model") onNavigate("model");
              else if (item.value === "passes") onCyclePasses();
              else onNavigate("repos");
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header subtitle="Settings" />
      <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
        <SelectInput
          items={[
            { label: "← Back", value: "back" },
            { label: "General settings", value: "general" },
            { label: "Reset config", value: "reset" },
            { label: "Quit code turtle", value: "quit" },
          ]}
          onSelect={(item) => {
            if (item.value === "back") onNavigate("none");
            else if (item.value === "general") onNavigate("general");
            else if (item.value === "reset") onNavigate("confirmReset");
            else onQuit();
          }}
        />
      </Box>
    </Box>
  );
}
