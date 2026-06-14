import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireLock, isLatest, recordLatest, releaseLock, seenEvent } from "../state.js";

// unique keys per test so the module-scoped in-process maps don't collide
let n = 0;
const pid = () => `owner/repo-${n}`;
beforeEach(() => {
  n++;
});
afterEach(() => {
  releaseLock(pid(), 1);
  vi.useRealTimers();
});

describe("acquireLock / releaseLock", () => {
  it("blocks a second acquire and frees on release", () => {
    expect(acquireLock(pid(), 1)).toBe(true);
    expect(acquireLock(pid(), 1)).toBe(false);
    releaseLock(pid(), 1);
    expect(acquireLock(pid(), 1)).toBe(true);
  });
});

describe("isLatest / recordLatest", () => {
  it("treats a null head sha as latest", () => {
    expect(isLatest(pid(), 1, null)).toBe(true);
  });
  it("supersedes an older sha once a newer one is recorded", () => {
    recordLatest(pid(), 1, "sha1");
    expect(isLatest(pid(), 1, "sha1")).toBe(true);
    recordLatest(pid(), 1, "sha2");
    expect(isLatest(pid(), 1, "sha1")).toBe(false);
    expect(isLatest(pid(), 1, "sha2")).toBe(true);
  });
});

describe("seenEvent", () => {
  it("returns false the first time and true thereafter", () => {
    const id = `evt-${n}`;
    expect(seenEvent(id)).toBe(false);
    expect(seenEvent(id)).toBe(true);
  });
  it("ignores null/undefined ids", () => {
    expect(seenEvent(null)).toBe(false);
    expect(seenEvent(undefined)).toBe(false);
  });
});
