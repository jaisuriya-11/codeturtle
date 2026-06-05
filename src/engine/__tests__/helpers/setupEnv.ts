/** Runs before each test file (vitest setupFiles). config.ts reads
 * CODETURTLE_HOME once at import, so it MUST be set before any test module
 * imports the engine — hence a setup file, not a beforeEach. Each test file
 * gets its own throwaway home. Also clears forge/reviewer env so token
 * resolution is deterministic regardless of the developer's shell. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODETURTLE_HOME = mkdtempSync(join(tmpdir(), "ct-test-"));

for (const k of [
  "GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "GITHUB_CLIENT_ID", "GITHUB_BACKEND",
  "REVIEWER_API_KEY", "GEMINI_API_KEY", "REVIEWER_BASE_URL", "REVIEWER_MODEL", "REVIEWER_BOT_NAME",
]) {
  delete process.env[k];
}
