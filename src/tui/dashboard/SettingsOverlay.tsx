/** Settings overlays for the dashboard: root menu, general settings, reset confirm.
 * Pure presentation — all state and side effects stay in Dashboard. */

import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import React, { useState } from "react";

import { loadConfig } from "../../engine/config.js";
import { ACCENT, DIM, Header } from "../theme.js";

export type SettingsView = "settings" | "general" | "tokenLimit" | "confirmReset";

export function SettingsOverlay({
  view,
  model,
  passes,
  tokenLimit,
  onNavigate,
  onCyclePasses,
  onSetTokenLimit,
  onQuit,
  onConfirmReset,
}: {
  view: SettingsView;
  model: string;
  passes: number;
  tokenLimit: number;
  onNavigate: (view: SettingsView | "none" | "model" | "repos") => void;
  onCyclePasses: () => void;
  onSetTokenLimit: (limit: number) => void;
  onQuit: () => void;
  onConfirmReset: () => void;
}) {
  const [tokenInput, setTokenInput] = useState("");
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

  if (view === "tokenLimit") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Token limit" />
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
          <Text bold>Token limit per review</Text>
          <Text color={DIM}>
            max input tokens (diff + codebase context) per review — current{" "}
            {tokenLimit === 0 ? "no limit" : tokenLimit}, press enter to keep, {'"none"'} for no
            limit
          </Text>
          <Box>
            <Text color={ACCENT}>{"❯ "}</Text>
            <TextInput
              value={tokenInput}
              onChange={setTokenInput}
              onSubmit={(v) => {
                const t = v.trim().toLowerCase();
                const n = Number(t);
                if (t === "none" || t === "0") onSetTokenLimit(0);
                else if (t && Number.isFinite(n) && n > 0) onSetTokenLimit(Math.trunc(n));
                setTokenInput("");
                onNavigate("general");
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
              {
                label: `Token limit  (${tokenLimit === 0 ? "no limit" : `${tokenLimit} tokens/review`})`,
                value: "tokenLimit",
              },
              { label: `Auto-review repos  (${targets.length} watched)`, value: "repos" },
            ]}
            onSelect={(item) => {
              if (item.value === "back") onNavigate("settings");
              else if (item.value === "model") onNavigate("model");
              else if (item.value === "passes") onCyclePasses();
              else if (item.value === "tokenLimit") onNavigate("tokenLimit");
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
