import { afterEach, describe, expect, it } from "vitest";

import { findingMarker, getForgeClient, REVIEW_MARKER, STATUS_MARKER } from "../forge.js";

afterEach(() => {
  delete process.env.GITHUB_BACKEND;
});

describe("markers", () => {
  it("formats the inline finding marker with file and line", () => {
    expect(findingMarker("src/a.ts", 42)).toBe("<!-- ct:f:src/a.ts:42 -->");
  });
  it("exposes stable status/review markers", () => {
    expect(STATUS_MARKER).toBe("<!-- ct:status -->");
    expect(REVIEW_MARKER).toBe("<!-- ct:review -->");
  });
});

describe("getForgeClient factory", () => {
  it("defaults GitHub to the MCP client", async () => {
    const c = await getForgeClient("github");
    expect(c.constructor.name).toBe("GitHubMcpClient");
    await c.close();
  });
  it("uses the REST client when GITHUB_BACKEND=rest", async () => {
    process.env.GITHUB_BACKEND = "rest";
    const c = await getForgeClient("github");
    expect(c.constructor.name).toBe("GitHubRestClient");
    await c.close();
  });
  it("returns the GitLab client for gitlab", async () => {
    const c = await getForgeClient("gitlab");
    expect(c.constructor.name).toBe("GitLabClient");
    await c.close();
  });
  it("throws for an unsupported forge", async () => {
    await expect(getForgeClient("bitbucket")).rejects.toThrow();
  });
});
