import { describe, expect, it } from "vitest";

import { parseTarget } from "../watch.js";

describe("parseTarget", () => {
  it("parses forge:repo", () => {
    expect(parseTarget("github:owner/repo")).toEqual({ forge: "github", repo: "owner/repo" });
    expect(parseTarget("gitlab:group/sub/proj")).toEqual({
      forge: "gitlab",
      repo: "group/sub/proj",
    });
  });

  it("lowercases the forge", () => {
    expect(parseTarget("GitHub:o/r").forge).toBe("github");
  });

  it("throws on missing colon, unknown forge, or empty repo", () => {
    expect(() => parseTarget("github")).toThrow();
    expect(() => parseTarget("bitbucket:o/r")).toThrow();
    expect(() => parseTarget("github:")).toThrow();
  });
});
