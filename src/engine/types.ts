export type Forge = "github" | "gitlab" | "bitbucket";

export interface Job {
  forge: Forge;
  projectId: string;
  prNumber: number;
  headSha: string;
}

export type Severity = "critical" | "warning" | "info";
export type Category = "security" | "bug" | "perf" | "style" | "maintainability";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  confidence: number;
  title: string;
  comment: string;
  suggestion?: string;
  /** exact replacement for the flagged line — rendered as a committable ```suggestion block */
  suggestedCode?: string;
}

export interface ReviewResult {
  findings: Finding[];
  summary: string;
}

export interface FileDiff {
  newPath: string;
  oldPath: string;
  diff: string;
  newFile: boolean;
  deletedFile: boolean;
}

export interface ContextFile {
  path: string;
  reason: "changed" | "import" | "caller" | "test";
  content: string;
}

export interface ContextBundle {
  files: ContextFile[];
  notes: string[];
}

export interface Norms {
  confidenceThreshold: number;
  maxFindings: number;
  exclude: string[];
  categories: Record<string, boolean>;
  guidelines: string;
  examples: { bad?: string; why?: string }[];
}

export interface DiffRefs {
  head_sha: string;
  base_sha: string;
  start_sha: string;
}

export interface MrInfo {
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  diffRefs: DiffRefs;
}

export function renderContext(ctx: ContextBundle): string {
  const parts: string[] = [];
  if (ctx.notes.length) {
    parts.push("### Context Notes:");
    for (const n of ctx.notes) parts.push(`- ${n}`);
    parts.push("");
  }
  for (const f of ctx.files) {
    parts.push(`### FILE: ${f.path} (reason: ${f.reason})`);
    parts.push(f.content);
    parts.push("");
  }
  return parts.join("\n");
}
