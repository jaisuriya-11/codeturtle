import { afterEach, describe, expect, it, vi } from "vitest";

import { detectLocalModels, PROVIDERS } from "../providers.js";
import { installFetch } from "./helpers/fetchMock.js";

afterEach(() => vi.unstubAllGlobals());

describe("PROVIDERS registry", () => {
  it("includes the expected providers with required fields", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gemini", "anthropic", "openai", "openrouter", "groq", "ollama", "lmstudio", "custom"]),
    );
    for (const p of PROVIDERS) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(Array.isArray(p.models)).toBe(true);
    }
  });
  it("marks local providers and gives them no key url", () => {
    const ollama = PROVIDERS.find((p) => p.id === "ollama")!;
    expect(ollama.local).toBe(true);
    expect(ollama.keyUrl).toBeUndefined();
  });
});

describe("detectLocalModels", () => {
  it("returns model ids from a local /models endpoint", async () => {
    installFetch((url) =>
      url.endsWith("/models") ? { json: { data: [{ id: "m1" }, { id: "m2" }] } } : { status: 404 },
    );
    expect(await detectLocalModels("http://localhost:1234/v1")).toEqual(["m1", "m2"]);
  });

  it("strips a trailing slash before appending /models", async () => {
    const { calls } = installFetch(() => ({ json: { data: [] } }));
    await detectLocalModels("http://localhost:11434/v1/");
    expect(calls[0].url).toBe("http://localhost:11434/v1/models");
  });

  it("returns [] on a non-ok response", async () => {
    installFetch(() => ({ status: 500 }));
    expect(await detectLocalModels("http://localhost:1234/v1")).toEqual([]);
  });

  it("returns [] when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await detectLocalModels("http://localhost:9/v1")).toEqual([]);
  });
});
