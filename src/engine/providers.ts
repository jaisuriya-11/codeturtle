/** Provider registry — opencode-style model selection. Every provider speaks
 * the OpenAI chat-completions dialect (native or via compat endpoint), so one
 * reviewer client covers all of them, including local servers. */

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl?: string; // where to create an API key; undefined = no key needed
  local?: boolean;
  models: string[]; // suggestions; user can always type a custom model
}

export const PROVIDERS: Provider[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1/",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-5.2", "gpt-5.2-mini", "gpt-4.1"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (any model)",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    models: ["anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash", "deepseek/deepseek-v3.2"],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: ["llama-4-maverick", "qwen-3-72b"],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    local: true,
    models: [],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    models: [],
  },
  {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "",
    models: [],
  },
];

/** Live-detect models on a local OpenAI-compatible server (Ollama, LM Studio). */
export async function detectLocalModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}
