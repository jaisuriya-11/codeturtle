import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TOKEN_LIMIT,
  getBotName,
  hasForgeCredentials,
  loadConfig,
  loadCredentials,
  resetAll,
  resetLogin,
  resolveToken,
  reviewerConfigured,
  reviewerSettings,
  reviewLimits,
  reviewTokenLimit,
  setForge,
  updateConfig,
} from "../config.js";

const HOME = process.env.CODETURTLE_HOME as string;
const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "REVIEWER_API_KEY",
  "GEMINI_API_KEY",
  "REVIEWER_MODEL",
  "REVIEWER_BASE_URL",
  "REVIEWER_BOT_NAME",
  "REVIEWER_TOKEN_LIMIT",
  "MAX_DIFF_CHARS",
  "MAX_CONTEXT_FILES",
  "MAX_CONTEXT_CHARS",
];

beforeEach(() => resetAll());
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetAll();
});

describe("credential store", () => {
  it("round-trips and merges forge credentials", () => {
    setForge("github", { token: "t1", user: "u", method: "pat", backend: "mcp" });
    setForge("github", { user: "u2" }); // merge, not replace
    const c = loadCredentials().github;
    expect(c).toMatchObject({ token: "t1", user: "u2", method: "pat", backend: "mcp" });
  });

  it("writes credentials.json under CODETURTLE_HOME", () => {
    setForge("github", { token: "t" });
    expect(existsSync(join(HOME, "credentials.json"))).toBe(true);
  });

  it("resetAll wipes the store", () => {
    setForge("github", { token: "t" });
    resetAll();
    expect(loadCredentials().github).toBeUndefined();
  });
});

describe("resolveToken", () => {
  it("prefers the stored token", () => {
    setForge("github", { token: "stored" });
    process.env.GITHUB_TOKEN = "fromenv";
    expect(resolveToken("github")).toBe("stored");
  });
  it("falls back to the env var when no stored token", () => {
    process.env.GITHUB_TOKEN = "fromenv";
    expect(resolveToken("github")).toBe("fromenv");
  });
  it("returns undefined when neither exists", () => {
    expect(resolveToken("github")).toBeUndefined();
  });
});

describe("reviewerSettings", () => {
  it("uses defaults when nothing is configured", () => {
    const s = reviewerSettings();
    expect(s.model).toBe("gemini-2.5-flash");
    expect(s.baseUrl).toContain("generativelanguage");
    expect(s.apiKey).toBe("");
  });
  it("reads stored config", () => {
    updateConfig("reviewer", { api_key: "k", model: "m", base_url: "https://x" });
    const s = reviewerSettings();
    expect(s).toMatchObject({ apiKey: "k", model: "m", baseUrl: "https://x" });
  });
  it("lets env override the store", () => {
    updateConfig("reviewer", { api_key: "k", model: "m" });
    process.env.REVIEWER_MODEL = "envmodel";
    process.env.REVIEWER_API_KEY = "envkey";
    const s = reviewerSettings();
    expect(s.model).toBe("envmodel");
    expect(s.apiKey).toBe("envkey");
  });
});

describe("getBotName", () => {
  it("derives a name from the model family", () => {
    expect(getBotName("claude-opus-4-8")).toBe("Claude review");
    expect(getBotName("gemini-2.5-flash")).toBe("Gemini review");
    expect(getBotName("gpt-5.2")).toBe("GPT review");
    expect(getBotName("something-else")).toBe("Code Turtle review");
  });
  it("honors an explicit custom name", () => {
    expect(getBotName("claude", "My Bot")).toBe("My Bot");
  });
});

describe("app config", () => {
  it("round-trips watch config", () => {
    updateConfig("watch", { targets: ["github:o/r"], interval: 45 });
    expect(loadConfig().watch).toEqual({ targets: ["github:o/r"], interval: 45 });
  });
});

describe("reviewerConfigured", () => {
  it("is false with no key and a cloud base url", () => {
    expect(reviewerConfigured()).toBe(false);
  });
  it("is true with an api key", () => {
    updateConfig("reviewer", { api_key: "k" });
    expect(reviewerConfigured()).toBe(true);
  });
  it("is true with a local base url and no key", () => {
    updateConfig("reviewer", { base_url: "http://localhost:11434/v1" });
    expect(reviewerConfigured()).toBe(true);
  });
});

describe("resetLogin", () => {
  it("drops tokens, watch targets and reviewer config, keeps the client id", () => {
    setForge("github", { token: "t", user: "u", client_id: "cid" });
    setForge("gitlab", { token: "t2" });
    updateConfig("reviewer", { model: "m", api_key: "k" });
    updateConfig("watch", { targets: ["github:o/r"], interval: 45 });

    resetLogin();

    expect(loadCredentials().github).toEqual({ client_id: "cid" });
    expect(loadCredentials().gitlab).toBeUndefined();
    expect(loadConfig().reviewer).toBeUndefined(); // next sign-in re-runs model setup
    expect(loadConfig().watch).toEqual({ targets: [], interval: 45 });
    expect(hasForgeCredentials()).toBe(false);
    expect(reviewerConfigured()).toBe(false);
  });
});

describe("review token limit & limits", () => {
  it("defaults to DEFAULT_TOKEN_LIMIT and the previous char caps", () => {
    expect(reviewTokenLimit()).toBe(DEFAULT_TOKEN_LIMIT);
    expect(reviewLimits()).toEqual({
      maxDiffChars: 40000,
      maxContextFiles: 12,
      maxContextChars: 40000,
    });
  });
  it("derives char budgets from the stored token_limit", () => {
    updateConfig("reviewer", { token_limit: 10000 });
    expect(reviewTokenLimit()).toBe(10000);
    const l = reviewLimits();
    expect(l.maxDiffChars).toBe(20000); // tokens*4 split between diff and context
    expect(l.maxContextChars).toBe(20000);
  });
  it("lets env override the store, and char env vars override the derivation", () => {
    updateConfig("reviewer", { token_limit: 10000 });
    process.env.REVIEWER_TOKEN_LIMIT = "30000";
    expect(reviewTokenLimit()).toBe(30000);
    process.env.MAX_DIFF_CHARS = "1234";
    expect(reviewLimits().maxDiffChars).toBe(1234);
    expect(reviewLimits().maxContextChars).toBe(60000);
  });
  it("falls back to the default on junk values", () => {
    updateConfig("reviewer", { token_limit: -5 });
    expect(reviewTokenLimit()).toBe(DEFAULT_TOKEN_LIMIT);
    process.env.REVIEWER_TOKEN_LIMIT = "not-a-number";
    expect(reviewTokenLimit()).toBe(DEFAULT_TOKEN_LIMIT);
  });
  it("treats 0 as no limit: char caps disabled, file cap kept", () => {
    updateConfig("reviewer", { token_limit: 0 });
    expect(reviewTokenLimit()).toBe(0);
    const l = reviewLimits();
    expect(l.maxDiffChars).toBe(Number.POSITIVE_INFINITY);
    expect(l.maxContextChars).toBe(Number.POSITIVE_INFINITY);
    expect(l.maxContextFiles).toBe(12);
  });
});

describe("hasForgeCredentials", () => {
  it("is false with no stored or env tokens", () => {
    expect(hasForgeCredentials()).toBe(false);
  });
  it("is true with a stored token", () => {
    setForge("gitlab", { token: "t" });
    expect(hasForgeCredentials()).toBe(true);
  });
  it("is true with an env token", () => {
    process.env.GITHUB_TOKEN = "t";
    expect(hasForgeCredentials()).toBe(true);
  });
});
