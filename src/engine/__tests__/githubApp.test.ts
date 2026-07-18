/** GitHub App auth: JWT signing, app inspection, installation-token mint +
 * refresh-before-use. Network is mocked; keys are throwaway test pairs. */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GITHUB_APP_KEY_PATH, loadCredentials, setForge } from "../config.js";
import {
  connectGithubApp,
  ensureFreshAppToken,
  inspectApp,
  readPrivateKey,
  signAppJwt,
} from "../githubApp.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signAppJwt", () => {
  it("produces a verifiable RS256 JWT with backdated iat and 9-min expiry", () => {
    const now = 1_750_000_000_000;
    const jwt = signAppJwt("12345", PEM, now);
    const [h, p, s] = jwt.split(".");

    expect(JSON.parse(fromB64url(h).toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(fromB64url(p).toString());
    expect(payload).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "12345" });

    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, fromB64url(s));
    expect(ok).toBe(true);
  });
});

describe("readPrivateKey", () => {
  it("rejects files that aren't PEM keys", () => {
    const bogus = join(process.env.CODETURTLE_HOME!, "not-a-key.txt");
    writeFileSync(bogus, "hello");
    expect(() => readPrivateKey(bogus)).toThrow(/doesn't look like a PEM key/);
  });

  it("throws a friendly error for missing files", () => {
    expect(() => readPrivateKey("/nope/missing.pem")).toThrow(/couldn't read key file/);
  });
});

describe("inspectApp", () => {
  it("returns slug and installations from the app API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/app")) return jsonResponse({ slug: "code-turtle", name: "Code Turtle" });
      if (u.endsWith("/app/installations"))
        return jsonResponse([{ id: 7, account: { login: "jaisuriya-11" } }]);
      throw new Error(`unexpected url ${u}`);
    });

    const info = await inspectApp("12345", PEM);
    expect(info).toEqual({
      slug: "code-turtle",
      name: "Code Turtle",
      installations: [{ id: 7, account: "jaisuriya-11" }],
    });
    // both calls authenticated with a Bearer JWT
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer ey/);
    }
  });

  it("surfaces API failures as errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 401));
    await expect(inspectApp("12345", PEM)).rejects.toThrow(/401/);
  });
});

describe("connectGithubApp", () => {
  it("stores the key (0600), mints a token and persists the app credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ token: "ghs_abc", expires_at: "2099-01-01T00:00:00Z" }, 201),
    );

    await connectGithubApp("12345", PEM, { id: 7, account: "jaisuriya-11" }, "code-turtle");

    expect(existsSync(GITHUB_APP_KEY_PATH)).toBe(true);
    expect(readFileSync(GITHUB_APP_KEY_PATH, "utf8")).toBe(PEM);

    // POSIX: chmodSync(0o600) sets owner-rw-only and the bits are observable.
    // Windows (NTFS) has no POSIX mode bits — chmodSync is a no-op and
    // statSync always reports 0o666. The key is still protected by NTFS ACLs
    // and lives under the user's home directory.
    if (process.platform !== "win32") {
      expect(statSync(GITHUB_APP_KEY_PATH).mode & 0o777).toBe(0o600);
    } else {
      // On Windows we verify the chmod call is a safe no-op: it doesn't throw,
      // the file stays writable (so re-mint works), and the default NTFS
      // 0o666 mode is reported. Protection here is by the home dir's ACLs.
      expect(() => statSync(GITHUB_APP_KEY_PATH)).not.toThrow();
      expect(statSync(GITHUB_APP_KEY_PATH).mode & 0o777).toBe(0o666);
    }

    const cred = loadCredentials().github!;
    expect(cred.method).toBe("app");
    expect(cred.app_id).toBe("12345");
    expect(cred.installation_id).toBe(7);
    expect(cred.user).toBe("code-turtle[bot]");
    expect(cred.token).toBe("ghs_abc");
    expect(cred.expires_at).toBe(Date.parse("2099-01-01T00:00:00Z"));
  });

  // Windows-only: confirm chmodSync doesn't throw and leaves the file writable
  // so the refresh-before-use path can re-write the key if needed.
  it.runIf(process.platform === "win32")(
    "windows: chmodSync is a no-op but the key file stays accessible",
    async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ token: "ghs_win", expires_at: "2099-01-01T00:00:00Z" }, 201),
      );
      await connectGithubApp("12345", PEM, { id: 7, account: "jaisuriya-11" }, "code-turtle");
      const st = statSync(GITHUB_APP_KEY_PATH);
      expect(st.mode & 0o777).toBe(0o666);
      expect(readFileSync(GITHUB_APP_KEY_PATH, "utf8")).toBe(PEM);
    },
  );
});

describe("ensureFreshAppToken", () => {
  beforeEach(() => {
    writeFileSync(GITHUB_APP_KEY_PATH, PEM);
  });

  it("returns the stored token while it's outside the skew window", async () => {
    setForge("github", {
      method: "app",
      app_id: "12345",
      installation_id: 7,
      token: "ghs_live",
      expires_at: Date.now() + 30 * 60_000,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(ensureFreshAppToken()).resolves.toBe("ghs_live");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-mints and persists when the token is near expiry", async () => {
    setForge("github", {
      method: "app",
      app_id: "12345",
      installation_id: 7,
      token: "ghs_stale",
      expires_at: Date.now() + 60_000, // inside the 5-min skew
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ token: "ghs_fresh", expires_at: "2099-01-01T00:00:00Z" }, 201),
    );

    await expect(ensureFreshAppToken()).resolves.toBe("ghs_fresh");
    expect(loadCredentials().github!.token).toBe("ghs_fresh");
  });

  it("soft-fails to the stale token when minting errors", async () => {
    setForge("github", {
      method: "app",
      app_id: "12345",
      installation_id: 7,
      token: "ghs_stale",
      expires_at: Date.now() - 1,
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(ensureFreshAppToken()).resolves.toBe("ghs_stale");
  });

  it("ignores non-app credentials", async () => {
    setForge("github", { method: "pat", token: "ghp_x" });
    await expect(ensureFreshAppToken()).resolves.toBeUndefined();
  });
});
