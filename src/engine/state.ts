import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HOME } from "./config.js";

const seenEvents = new Map<string, number>();
const latestCommit = new Map<string, string>();
const locks = new Map<string, number>();

const EVENT_TTL_MS = 60 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;

const key = (projectId: string, prNumber: number) => `${projectId}#${prNumber}`;

function getLockPath(k: string): string {
  const dir = join(HOME, "locks");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, encodeURIComponent(k) + ".lock");
}

export function seenEvent(uuid: string | null | undefined): boolean {
  if (!uuid) return false;
  const now = Date.now();
  for (const [k, t] of seenEvents) if (now - t > EVENT_TTL_MS) seenEvents.delete(k);
  if (seenEvents.has(uuid)) return true;
  seenEvents.set(uuid, now);
  return false;
}

export function recordLatest(projectId: string, prNumber: number, headSha: string | null): void {
  if (headSha) latestCommit.set(key(projectId, prNumber), headSha);
}

export function isLatest(projectId: string, prNumber: number, headSha: string | null): boolean {
  if (!headSha) return true;
  const latest = latestCommit.get(key(projectId, prNumber));
  return latest == null || latest === headSha;
}

export function acquireLock(projectId: string, prNumber: number): boolean {
  const k = key(projectId, prNumber);
  const now = Date.now();

  // 1. In-process check
  const expiry = locks.get(k);
  if (expiry != null && expiry > now) return false;

  // 2. Cross-process check via lock file
  const path = getLockPath(k);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf8");
      const fileExpiry = Number(content);
      if (!isNaN(fileExpiry) && fileExpiry > now) {
        return false;
      }
    } catch {
      // ignore read error and try to overwrite/claim lock
    }
  }

  // 3. Acquire both locks
  try {
    locks.set(k, now + LOCK_TTL_MS);
    writeFileSync(path, String(now + LOCK_TTL_MS), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(projectId: string, prNumber: number): void {
  const k = key(projectId, prNumber);
  locks.delete(k);
  const path = getLockPath(k);
  try {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  } catch {}
}

