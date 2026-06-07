import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadCredentials, resetAll, setForge } from "../config.js";
import {
  completeDeviceFlow,
  DEFAULT_GITHUB_CLIENT_ID,
  ensureFreshGithubToken,
  getGithubClientId,
  pollForToken,
  startDeviceFlow,
} from "../githubAuth.js";
import { installFetch } from "./helpers/fetchMock.js";

beforeEach(() => resetAll());
afterEach(() => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_TOKEN;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAll();
});

describe("getGithubClientId", () => {
  it("prefers the env var, then the stored client_id, then the default", () => {
    setForge("github", { client_id: "stored" });
    process.env.GITHUB_CLIENT_ID = "fromenv";
    expect(getGithubClientId()).toBe("fromenv");
    delete process.env.GITHUB_CLIENT_ID;
    expect(getGithubClientId()).toBe("stored");
    resetAll();
    expect(getGithubClientId()).toBe(DEFAULT_GITHUB_CLIENT_ID);
  });
});

describe("startDeviceFlow", () => {
  it("maps the device-code response", async () => {
    installFetch(() => ({
      json: {
        device_code: "dev",
        user_code: "WXYZ-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      },
    }));
    const r = await startDeviceFlow("cid");
    expect(r).toEqual({
      deviceCode: "dev",
      userCode: "WXYZ-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
  });

  it("throws when GitHub returns an error", async () => {
    installFetch(() => ({
      json: { error: "unauthorized_client", error_description: "bad client" },
    }));
    await expect(startDeviceFlow("cid")).rejects.toThrow(/bad client/);
  });
});

describe("completeDeviceFlow", () => {
  it("polls, fetches the username, and persists an oauth credential", async () => {
    vi.useFakeTimers();
    installFetch(
      (url) =>
        url.includes("/login/oauth/access_token")
          ? { json: { access_token: "ghu_tok", refresh_token: "ghr_tok", expires_in: 3600 } }
          : { json: { login: "octocat" } }, // api.github.com/user
    );
    const p = completeDeviceFlow("cid", "dev", 1);
    await vi.advanceTimersByTimeAsync(1000); // poll → token
    const user = await p;
    expect(user).toBe("octocat");
    const stored = loadCredentials().github;
    expect(stored).toMatchObject({
      token: "ghu_tok",
      method: "oauth",
      user: "octocat",
      client_id: "cid",
    });
  });
});

describe("pollForToken", () => {
  it("waits through authorization_pending then returns the token set", async () => {
    vi.useFakeTimers();
    let n = 0;
    installFetch(() => {
      n++;
      return n === 1
        ? { json: { error: "authorization_pending" } }
        : { json: { access_token: "ghu_x", refresh_token: "ghr_y", expires_in: 3600 } };
    });
    const p = pollForToken("cid", "dev", 1);
    await vi.advanceTimersByTimeAsync(1000); // first poll → pending
    await vi.advanceTimersByTimeAsync(1000); // second poll → token
    const tokens = await p;
    expect(tokens.accessToken).toBe("ghu_x");
    expect(tokens.refreshToken).toBe("ghr_y");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws on expired_token", async () => {
    vi.useFakeTimers();
    installFetch(() => ({ json: { error: "expired_token" } }));
    const p = pollForToken("cid", "dev", 1);
    const assertion = expect(p).rejects.toThrow(/expired/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("ensureFreshGithubToken", () => {
  it("returns the stored token for non-oauth creds without any network", async () => {
    setForge("github", { token: "pat-token", method: "pat" });
    const fetchMock = installFetch(() => ({ json: {} }));
    expect(await ensureFreshGithubToken()).toBe("pat-token");
    expect(fetchMock.fn).not.toHaveBeenCalled();
  });

  it("does not refresh an oauth token that is not near expiry", async () => {
    setForge("github", {
      token: "fresh",
      method: "oauth",
      refresh_token: "r",
      client_id: "c",
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    const fetchMock = installFetch(() => ({ json: {} }));
    expect(await ensureFreshGithubToken()).toBe("fresh");
    expect(fetchMock.fn).not.toHaveBeenCalled();
  });

  it("refreshes and persists when the oauth token is expiring", async () => {
    setForge("github", {
      token: "old",
      method: "oauth",
      refresh_token: "r",
      client_id: "c",
      expires_at: Date.now() - 1000, // already past
    });
    installFetch(() => ({
      json: { access_token: "new-token", refresh_token: "r2", expires_in: 3600 },
    }));
    expect(await ensureFreshGithubToken()).toBe("new-token");
    const stored = loadCredentials().github;
    expect(stored?.token).toBe("new-token");
    expect(stored?.refresh_token).toBe("r2");
  });

  it("falls back to the old token when refresh fails", async () => {
    setForge("github", {
      token: "old",
      method: "oauth",
      refresh_token: "r",
      client_id: "c",
      expires_at: Date.now() - 1000,
    });
    installFetch(() => ({ status: 401, json: { error: "bad_refresh" } }));
    expect(await ensureFreshGithubToken()).toBe("old");
  });
});
