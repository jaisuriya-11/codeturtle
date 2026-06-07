/** GitHub App auth — reviews post as "<app-slug>[bot]" instead of the user.
 * Local-first fit: no webhooks. The CLI signs a short-lived RS256 JWT with the
 * app's private key, exchanges it for an installation token (~1h lifetime), and
 * re-mints before expiry. The private key is copied into ~/.codeturtle
 * (chmod 600, like every other secret) and never logged. */

import { createSign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { GITHUB_APP_KEY_PATH, HOME, loadCredentials, setForge } from "./config.js";

const API = "https://api.github.com";
// installation tokens live ~1h; re-mint this long before expiry
const REFRESH_SKEW_MS = 5 * 60_000;

export interface AppInstallation {
  id: number;
  /** org or user the app is installed on */
  account: string;
}

export interface AppIdentity {
  slug: string;
  name: string;
  installations: AppInstallation[];
}

const b64url = (s: Buffer | string): string =>
  Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RS256 app JWT. GitHub caps lifetime at 10 min; iat is backdated 60s to
 * absorb clock skew. `nowMs` is injectable for tests. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function appApi(path: string, jwt: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`github app api ${path} ${res.status}`);
  return res.json();
}

/** Read a private key from a user-supplied path (~ expanded). Throws with a
 * friendly message — shown in the TUI — when the file is missing/unreadable. */
export function readPrivateKey(path: string): string {
  const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  let pem: string;
  try {
    pem = readFileSync(expanded, "utf8");
  } catch {
    throw new Error(`couldn't read key file: ${expanded}`);
  }
  if (!pem.includes("PRIVATE KEY")) throw new Error("that file doesn't look like a PEM key");
  return pem;
}

/** Validate app id + key against the API and list where the app is installed.
 * Pure inspection — persists nothing. */
export async function inspectApp(appId: string, privateKeyPem: string): Promise<AppIdentity> {
  const jwt = signAppJwt(appId, privateKeyPem);
  const app = await appApi("/app", jwt);
  const installs = await appApi("/app/installations", jwt);
  return {
    slug: app.slug as string,
    name: (app.name as string) ?? (app.slug as string),
    installations: (installs as any[]).map((i) => ({
      id: i.id as number,
      account: (i.account?.login as string) ?? "?",
    })),
  };
}

async function mintInstallationToken(
  jwt: string,
  installationId: number,
): Promise<{ token: string; expiresAt: number }> {
  const r = await appApi(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
  });
  return { token: r.token as string, expiresAt: Date.parse(r.expires_at as string) };
}

/** Finish app sign-in: store the key in ~/.codeturtle (0600), mint the first
 * installation token, persist the credential. Reviews then post as `slug[bot]`. */
export async function connectGithubApp(
  appId: string,
  privateKeyPem: string,
  installation: AppInstallation,
  slug: string,
): Promise<void> {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(GITHUB_APP_KEY_PATH, privateKeyPem);
  chmodSync(GITHUB_APP_KEY_PATH, 0o600);
  const jwt = signAppJwt(appId, privateKeyPem);
  const t = await mintInstallationToken(jwt, installation.id);
  const cur = loadCredentials().github ?? {};
  setForge("github", {
    method: "app",
    app_id: appId,
    installation_id: installation.id,
    user: `${slug}[bot]`,
    token: t.token,
    expires_at: t.expiresAt,
    backend: cur.backend ?? "mcp",
  });
}

/** Refresh-before-use for app credentials: returns a valid installation token,
 * re-minting when within the skew window. Soft-fails to the stored token —
 * a stale token's clear 401 beats an opaque crash here. */
export async function ensureFreshAppToken(): Promise<string | undefined> {
  const cred = loadCredentials().github;
  if (cred?.method !== "app" || !cred.app_id || !cred.installation_id) return undefined;
  const fresh =
    cred.token && cred.expires_at != null && cred.expires_at - Date.now() > REFRESH_SKEW_MS;
  if (fresh) return cred.token;
  try {
    const pem = readFileSync(GITHUB_APP_KEY_PATH, "utf8");
    const jwt = signAppJwt(String(cred.app_id), pem);
    const t = await mintInstallationToken(jwt, cred.installation_id);
    setForge("github", { token: t.token, expires_at: t.expiresAt });
    return t.token;
  } catch {
    return cred.token;
  }
}
