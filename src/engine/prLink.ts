/** Parse a pasted PR/MR link into a reviewable target. Accepts:
 *  https://github.com/owner/repo/pull/123
 *  https://gitlab.com/group/sub/proj/-/merge_requests/45  (any GitLab host)
 *  owner/repo#123  (GitHub shorthand)
 */

import type { Forge } from "./types.js";

export interface PrRef {
  forge: Forge;
  projectId: string;
  prNumber: number;
  label: string;
}

export function parsePrLink(input: string): PrRef | null {
  const raw = input.trim();

  const gh = raw.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (gh) {
    const projectId = `${gh[1]}/${gh[2]}`;
    return { forge: "github", projectId, prNumber: Number(gh[3]), label: `${projectId}#${gh[3]}` };
  }

  const gl = raw.match(/https?:\/\/[^/\s]+\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (gl) {
    const projectId = gl[1];
    return { forge: "gitlab", projectId, prNumber: Number(gl[2]), label: `${projectId}!${gl[2]}` };
  }

  const short = raw.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) {
    return { forge: "github", projectId: short[1], prNumber: Number(short[2]), label: raw };
  }

  return null;
}
