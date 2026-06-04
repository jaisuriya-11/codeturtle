/** codeturtle — bare command opens the TUI; subcommands for scripting. */

import { Command } from "commander";

import { HOME, loadCredentials, resetAll, reviewerSettings } from "../engine/config.js";
import { runReview } from "../engine/pipeline.js";
import { parsePrLink } from "../engine/prLink.js";
import type { Forge } from "../engine/types.js";

const program = new Command();
program.name("codeturtle").description("🐢 Local AI code reviewer — any model, no cloud").version("2.0.0");

program
  .command("review")
  .description("Review a PR/MR — paste a link or pass --forge/--repo/--pr")
  .argument("[link]", "PR/MR URL, e.g. https://github.com/owner/repo/pull/42")
  .option("--forge <forge>", "github | gitlab")
  .option("--repo <repo>", "'owner/repo' or GitLab project path/ID")
  .option("--pr <number>", "PR / MR number")
  .action(async (link: string | undefined, opts) => {
    let forge: Forge, projectId: string, prNumber: number;
    if (link) {
      const ref = parsePrLink(link);
      if (!ref) {
        console.error("Couldn't parse that link. Expected a GitHub PR or GitLab MR URL.");
        process.exit(1);
      }
      ({ forge, projectId, prNumber } = ref);
    } else if (opts.forge && opts.repo && opts.pr) {
      forge = opts.forge;
      projectId = opts.repo;
      prNumber = Number(opts.pr);
    } else {
      console.error("Pass a PR link or all of --forge --repo --pr.");
      process.exit(1);
    }
    const { getForgeClient } = await import("../engine/forge.js");
    const gl = await getForgeClient(forge);
    let headSha: string;
    try {
      const mr = await gl.getMr(projectId, prNumber);
      headSha = mr.headSha;
      console.log(`head: ${headSha}`);
    } finally {
      await gl.close();
    }
    await runReview({ forge, projectId, prNumber, headSha }, console.log);
    console.log("done.");
  });

program
  .command("status")
  .description("Connections + model")
  .action(() => {
    const creds = loadCredentials();
    for (const forge of ["github", "gitlab"]) {
      const c = creds[forge];
      if (c?.user) console.log(`${forge.padEnd(10)} ✓ ${c.user} (${c.method}, ${c.backend})`);
      else if (process.env[`${forge.toUpperCase()}_TOKEN`]) console.log(`${forge.padEnd(10)} ✓ token from env`);
      else console.log(`${forge.padEnd(10)} ✗ not connected`);
    }
    const rs = reviewerSettings();
    console.log(`${"reviewer".padEnd(10)} ${rs.apiKey || rs.baseUrl.includes("localhost") ? `✓ ${rs.model}` : "✗ not configured"}`);
  });

program
  .command("reset")
  .description("Reset ALL config: tokens, model, logs")
  .option("-y, --yes", "skip confirmation")
  .action(async (opts) => {
    if (!opts.yes) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `This deletes everything in ${HOME} (tokens, model config, logs). Type "reset" to confirm: `,
      );
      rl.close();
      if (answer.trim().toLowerCase() !== "reset") {
        console.log("Aborted.");
        return;
      }
    }
    resetAll();
    console.log("✓ All config wiped. Run `codeturtle` to set up again.");
  });

// default: TUI
program.action(async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../tui/App.js");
  render(React.createElement(App));
});

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
