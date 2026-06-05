import { describe, expect, it } from "vitest";

import { parsePrLink } from "../prLink.js";

describe("parsePrLink", () => {
  it("parses a GitHub PR URL", () => {
    expect(parsePrLink("https://github.com/owner/repo/pull/123")).toEqual({
      forge: "github",
      projectId: "owner/repo",
      prNumber: 123,
      label: "owner/repo#123",
    });
  });

  it("parses a GitHub PR URL with trailing path/query", () => {
    const r = parsePrLink("https://github.com/o/r/pull/7/files?w=1");
    expect(r).toMatchObject({ forge: "github", projectId: "o/r", prNumber: 7 });
  });

  it("parses a GitLab MR URL with nested groups (any host)", () => {
    expect(parsePrLink("https://gitlab.example.com/group/sub/proj/-/merge_requests/45")).toEqual({
      forge: "gitlab",
      projectId: "group/sub/proj",
      prNumber: 45,
      label: "group/sub/proj!45",
    });
  });

  it("parses GitHub shorthand owner/repo#n", () => {
    expect(parsePrLink("owner/repo#42")).toEqual({
      forge: "github",
      projectId: "owner/repo",
      prNumber: 42,
      label: "owner/repo#42",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parsePrLink("  owner/repo#1  ")?.prNumber).toBe(1);
  });

  it("returns null for unparseable input", () => {
    for (const bad of ["", "not a link", "https://github.com/owner/repo", "https://example.com/x/y/z"]) {
      expect(parsePrLink(bad)).toBeNull();
    }
  });
});
