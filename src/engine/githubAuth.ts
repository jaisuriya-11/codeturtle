/** GitHub OAuth Device Flow — the only OAuth grant that fits a local-first CLI
 * (no callback server). The user opens github.com/login/device, types a code,
 * and we poll for the token. Access tokens may expire; we keep the refresh
 * token and renew before use. Secrets live only in ~/.codeturtle (via setForge)
 * and are never logged. */

import { loadCredentials, resolveToken, setForge } from "./config.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
// repo: read/write PR comments & reviews; read:org/read:user: identity + org repos.
const SCOPE = "repo read:org read:user";
// refresh this many ms before the stated expiry to absorb clock skew / latency.
const REFRESH_SKEW_MS = 60_000;

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number; // seconds between polls, per GitHub
  expiresIn: number; // seconds until the device code expires
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // ms epoch; undefined for non-expiring tokens
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** The OAuth app/GitHub app client id (public, not a secret). Env wins, then
 * the value stored alongside the github credential. No baked-in default. */
export function getGithubClientId(): string | undefined {
  return process.env.GITHUB_CLIENT_ID ?? loadCredentials().github?.client_id ?? undefined;
}

async function postForm(url: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`github oauth ${res.status}`);
  return res.json();
}

/** Step 1: ask GitHub for a device + user code. */
export async function startDeviceFlow(clientId: string): Promise<DeviceFlowStart> {
  const d = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE });
  if (d.error || !d.device_code) {
    throw new Error(d.error_description || d.error || "device code request failed");
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    interval: Number(d.interval ?? 5),
    expiresIn: Number(d.expires_in ?? 900),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function toTokenSet(r: TokenResponse): TokenSet {
  return {
    accessToken: r.access_token as string,
    refreshToken: r.refresh_token,
    expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : undefined,
  };
}

/** Step 2: poll until the user authorizes, the code expires, or `signal` aborts.
 * Honours GitHub's `authorization_pending` / `slow_down` backoff protocol. */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSec: number,
  signal?: AbortSignal,
): Promise<TokenSet> {
  let waitMs = Math.max(1, intervalSec) * 1000;
  for (;;) {
    await sleep(waitMs, signal);
    const r: TokenResponse = await postForm(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (r.access_token) return toTokenSet(r);
    switch (r.error) {
      case "authorization_pending":
        continue; // user hasn't finished yet
      case "slow_down":
        waitMs += 5000; // GitHub asks us to back off
        continue;
      case "expired_token":
        throw new Error("the device code expired — please try again");
      case "access_denied":
        throw new Error("authorization was denied");
      default:
        throw new Error(r.error_description || r.error || "device flow failed");
    }
  }
}

/** Persist a token set as an oauth credential. Merges, so existing user/backend
 * are preserved; rotates the refresh token when GitHub issues a new one. */
function persist(clientId: string, tokens: TokenSet, extra?: { user?: string }): void {
  const cur = loadCredentials().github ?? {};
  setForge("github", {
    token: tokens.accessToken,
    refresh_token: tokens.refreshToken ?? cur.refresh_token,
    expires_at: tokens.expiresAt,
    client_id: clientId,
    method: "oauth",
    backend: cur.backend ?? "mcp",
    ...(extra?.user ? { user: extra.user } : {}),
  });
}

/** Complete a device-flow login and store the result. Returns the username. */
export async function completeDeviceFlow(
  clientId: string,
  deviceCode: string,
  intervalSec: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const tokens = await pollForToken(clientId, deviceCode, intervalSec, signal);
  const user = await fetchLogin(tokens.accessToken);
  persist(clientId, tokens, { user: user ?? undefined });
  return user;
}

async function fetchLogin(token: string): Promise<string | null> {
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? ((await r.json()) as any).login : null;
  } catch {
    return null;
  }
}

/** Exchange the stored refresh token for a fresh access token and persist it.
 * Returns the new token, or undefined if refresh isn't possible/failed. */
export async function refreshGithubToken(): Promise<string | undefined> {
  const cred = loadCredentials().github;
  const clientId = cred?.client_id ?? getGithubClientId();
  if (!cred?.refresh_token || !clientId) return undefined;
  try {
    const r: TokenResponse = await postForm(ACCESS_TOKEN_URL, {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
    });
    if (!r.access_token) return undefined;
    persist(clientId, toTokenSet(r));
    return r.access_token;
  } catch {
    return undefined;
  }
}

/** Refresh-before-use entry point for the forge clients. Non-oauth creds fall
 * straight through to the normal sync resolution. */
export async function ensureFreshGithubToken(): Promise<string | undefined> {
  const cred = loadCredentials().github;
  if (!cred || cred.method !== "oauth") return resolveToken("github");
  const expiring =
    cred.expires_at != null && cred.refresh_token && cred.expires_at - Date.now() < REFRESH_SKEW_MS;
  if (expiring) {
    const fresh = await refreshGithubToken();
    if (fresh) return fresh;
  }
  return cred.token ?? resolveToken("github");
}
