/** opencode-style model selection: provider list → model list (live-detected
 * for local servers) → API key entry. Custom model/endpoint always available. */

import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";

import { detectLocalModels, PROVIDERS, type Provider } from "../engine/providers.js";
import { ACCENT, DIM } from "./theme.js";

export interface ModelChoice {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

type Step = "provider" | "detecting" | "model" | "customModel" | "customUrl" | "key";

export function ModelPicker({ onDone }: { onDone: (choice: ModelChoice) => void }) {
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [key, setKey] = useState("");

  useEffect(() => {
    if (step === "detecting" && provider) {
      void detectLocalModels(provider.baseUrl).then((found) => {
        setModels(found);
        setStep(found.length ? "model" : "customModel");
      });
    }
  }, [step, provider]);

  const finish = (apiKey: string) => {
    if (!provider) return;
    onDone({
      provider: provider.id,
      baseUrl: provider.id === "custom" ? customUrl : provider.baseUrl,
      model,
      apiKey,
    });
  };

  if (step === "provider") {
    return (
      <Box flexDirection="column">
        <Text bold>Choose your review model provider</Text>
        <Text color={DIM}>Any OpenAI-compatible API works — cloud or local.</Text>
        <Box marginTop={1}>
          <SelectInput
            items={PROVIDERS.map((p) => ({
              label: p.local ? `${p.label}  ⌂` : p.label,
              value: p.id,
            }))}
            onSelect={(item) => {
              const p = PROVIDERS.find((x) => x.id === item.value)!;
              setProvider(p);
              if (p.id === "custom") setStep("customUrl");
              else if (p.local) setStep("detecting");
              else {
                setModels(p.models);
                setStep("model");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "detecting") {
    return (
      <Text>
        <Spinner type="dots" /> Detecting local models at {provider?.baseUrl}…
      </Text>
    );
  }

  if (step === "model") {
    const items = [
      ...models.map((m) => ({ label: m, value: m })),
      { label: "✎  type a custom model id", value: "__custom__" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>
          Pick a model <Text color={DIM}>({provider?.label})</Text>
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__custom__") {
                setStep("customModel");
              } else {
                setModel(item.value);
                if (provider?.local) finishLocal(item.value);
                else setStep("key");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  function finishLocal(m: string) {
    if (!provider) return;
    onDone({ provider: provider.id, baseUrl: provider.baseUrl, model: m, apiKey: "" });
  }

  if (step === "customModel") {
    return (
      <Box flexDirection="column">
        <Text bold>Model id</Text>
        {provider?.local && models.length === 0 ? (
          <Text color="yellow">No local server detected at {provider.baseUrl} — enter the model anyway.</Text>
        ) : null}
        <Box>
          <Text color={ACCENT}>{"❯ "}</Text>
          <TextInput
            value={model}
            onChange={setModel}
            onSubmit={(v) => {
              if (!v.trim()) return;
              setModel(v.trim());
              if (provider?.local) finishLocal(v.trim());
              else setStep("key");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "customUrl") {
    return (
      <Box flexDirection="column">
        <Text bold>OpenAI-compatible base URL</Text>
        <Box>
          <Text color={ACCENT}>{"❯ "}</Text>
          <TextInput
            value={customUrl}
            onChange={setCustomUrl}
            onSubmit={(v) => {
              if (!v.trim()) return;
              setCustomUrl(v.trim());
              setStep("customModel");
            }}
          />
        </Box>
      </Box>
    );
  }

  // key entry
  return (
    <Box flexDirection="column">
      <Text bold>
        API key <Text color={DIM}>({provider?.label})</Text>
      </Text>
      {provider?.keyUrl ? <Text color={DIM}>Create one: {provider.keyUrl}</Text> : null}
      <Box>
        <Text color={ACCENT}>{"❯ "}</Text>
        <TextInput value={key} onChange={setKey} mask="•" onSubmit={(v) => finish(v.trim())} />
      </Box>
    </Box>
  );
}
