import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getBotName, hasForgeCredentials, loadConfig, loadCredentials, resetAll,
  resetLogin, resolveToken, reviewerConfigured, reviewerSettings, setForge,
  updateConfig,
} from "../config.js";

const HOME = process.env.CODETURTLE_HOME as string;
const ENV_KEYS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "REVIEWER_API_KEY", "GEMINI_API_KEY", "REVIEWER_MODEL", "REVIEWER_BASE_URL", "REVIEWER_BOT_NAME"];

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
  it("drops tokens and watch targets, keeps client id and reviewer config", () => {
    setForge("github", { token: "t", user: "u", client_id: "cid" });
    setForge("gitlab", { token: "t2" });
    updateConfig("reviewer", { model: "m", api_key: "k" });
    updateConfig("watch", { targets: ["github:o/r"], interval: 45 });

    resetLogin();

    expect(loadCredentials().github).toEqual({ client_id: "cid" });
    expect(loadCredentials().gitlab).toBeUndefined();
    expect(loadConfig().reviewer).toMatchObject({ model: "m", api_key: "k" });
    expect(loadConfig().watch).toEqual({ targets: [], interval: 45 });
    expect(hasForgeCredentials()).toBe(false);
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
