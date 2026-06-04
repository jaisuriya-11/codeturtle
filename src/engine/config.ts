/** ~/.codeturtle store — same files/shapes as the Python version, so existing
 * setups keep working: credentials.json (forge tokens) + config.json (reviewer,
 * watch targets). */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.CODETURTLE_HOME ?? join(homedir(), ".codeturtle");
const CRED_PATH = join(HOME, "credentials.json");
const CONFIG_PATH = join(HOME, "config.json");
export const LOG_FILE = join(HOME, "watcher.log");
export const PID_FILE = join(HOME, "watcher.pid");

export interface ForgeCred {
  token?: string;
  method?: string;
  user?: string;
  url?: string;
  backend?: "mcp" | "rest";
}

export interface ReviewerConfig {
  provider?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  bot_name?: string;
}

export interface WatchConfig {
  targets?: string[];
  interval?: number;
}

export interface AppConfig {
  reviewer?: ReviewerConfig;
  watch?: WatchConfig;
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return {} as T;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
  chmodSync(path, 0o600);
}

export function loadCredentials(): Record<string, ForgeCred> {
  return readJson(CRED_PATH);
}

export function setForge(forge: string, fields: ForgeCred): void {
  const data = loadCredentials();
  data[forge] = { ...data[forge], ...fields };
  writeJson(CRED_PATH, data);
}

const ENV_TOKEN: Record<string, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  bitbucket: "BITBUCKET_TOKEN",
};

export function resolveToken(forge: string): string | undefined {
  return loadCredentials()[forge]?.token ?? process.env[ENV_TOKEN[forge] ?? ""];
}

export function loadConfig(): AppConfig {
  return readJson(CONFIG_PATH);
}

export function updateConfig<K extends keyof AppConfig>(section: K, fields: AppConfig[K]): void {
  const data = loadConfig();
  data[section] = { ...data[section], ...fields };
  writeJson(CONFIG_PATH, data);
}

export interface ReviewerSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  botName: string;
}

export function getBotName(model: string, customBotName?: string): string {
  if (customBotName) return customBotName;
  const m = model.toLowerCase();
  if (m.includes("claude")) return "Claude review";
  if (m.includes("gemini")) return "Gemini review";
  if (m.includes("gpt")) return "GPT review";
  if (m.includes("llama")) return "Llama review";
  if (m.includes("deepseek")) return "DeepSeek review";
  if (m.includes("qwen")) return "Qwen review";
  return "Code Turtle review";
}

export function reviewerSettings(): ReviewerSettings {
  const cfg = loadConfig().reviewer ?? {};
  const apiKey = process.env.REVIEWER_API_KEY ?? process.env.GEMINI_API_KEY ?? cfg.api_key ?? "";
  const model = process.env.REVIEWER_MODEL ?? cfg.model ?? "gemini-2.5-flash";
  const botName = process.env.REVIEWER_BOT_NAME ?? cfg.bot_name ?? getBotName(model);
  return {
    apiKey,
    baseUrl:
      process.env.REVIEWER_BASE_URL ??
      cfg.base_url ??
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    model,
    botName,
  };
}

/** Wipe all local config: credentials, settings, logs, pid, locks. */
export function resetAll(): void {
  for (const f of [CRED_PATH, CONFIG_PATH, LOG_FILE, PID_FILE]) {
    rmSync(f, { force: true });
  }
  rmSync(join(HOME, "locks"), { recursive: true, force: true });
}

export const limits = {
  maxDiffChars: Number(process.env.MAX_DIFF_CHARS ?? 40000),
  maxContextFiles: Number(process.env.MAX_CONTEXT_FILES ?? 12),
  maxContextChars: Number(process.env.MAX_CONTEXT_CHARS ?? 40000),
};
