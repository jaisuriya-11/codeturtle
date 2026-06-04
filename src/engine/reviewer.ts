/** OpenAI-compatible reviewer — one client for every provider in the registry
 * (Gemini, OpenAI, Anthropic compat, OpenRouter, Groq, Ollama, LM Studio, custom). */

import OpenAI from "openai";

import { reviewerSettings } from "./config.js";
import {
  renderContext, type Category, type ContextBundle, type Finding, type Norms,
  type ReviewResult, type Severity,
} from "./types.js";

const BASE_PROMPT = `You are a senior engineer reviewing a merge-request diff.

You are given: (a) the surrounding codebase context (the changed files, their
imports, callers, and tests), and (b) the diff itself. Use the context to judge
whether each change is actually correct — e.g. if a function's return shape
changed, check the callers shown.

Hard rules:
- Only comment on lines ADDED in the diff (prefixed '+').
- Use the new-file line number from the hunk header (@@ -a,b +c,d @@).
- Set confidence honestly (0.0-1.0); low-confidence guesses are dropped.
- One finding per issue. Be concrete, short, and kind.
- If the diff is clean, return an empty findings list.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"findings": [{"file","line","severity","category","confidence","title","comment","suggestion","suggested_code"}],
 "summary": "one-line overview"}
severity ∈ critical|warning|info ; category ∈ security|bug|perf|style|maintainability
"suggestion" is a short prose recommendation. "suggested_code" is the EXACT replacement
for the flagged line only — raw code, same indentation, no fences, no commentary.
Omit "suggested_code" unless you are sure it is a drop-in replacement for that one line.`;

const SEVERITIES = new Set(["critical", "warning", "info"]);
const CATEGORIES = new Set(["security", "bug", "perf", "style", "maintainability"]);

function systemPrompt(norms: Norms): string {
  const parts = [BASE_PROMPT];
  if (norms.guidelines) parts.push(`TEAM GUIDELINES (follow these):\n${norms.guidelines}`);
  if (norms.examples.length) {
    const ex = norms.examples.map((e) => `- BAD: ${e.bad ?? ""}\n  WHY: ${e.why ?? ""}`).join("\n");
    parts.push(`EXAMPLES OF ISSUES THIS TEAM CARES ABOUT:\n${ex}`);
  }
  const enabled = Object.entries(norms.categories).filter(([, on]) => on).map(([c]) => c);
  if (enabled.length) parts.push(`Only report these categories: ${enabled.join(", ")}.`);
  return parts.join("\n\n");
}

function coerceConfidence(v: unknown): number {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  // some models answer with words despite the prompt
  const word = String(v ?? "").toLowerCase();
  if (word.startsWith("high")) return 0.9;
  if (word.startsWith("med")) return 0.6;
  if (word.startsWith("low")) return 0.3;
  return 0;
}

function parseFinding(f: any): Finding | null {
  const severity = String(f?.severity ?? "").trim().toLowerCase();
  const category = String(f?.category ?? "").trim().toLowerCase();
  const line = Number(f?.line);
  if (!f?.file || !Number.isFinite(line) || !SEVERITIES.has(severity) || !CATEGORIES.has(category)) {
    return null;
  }
  return {
    file: String(f.file),
    line: Math.trunc(line),
    severity: severity as Severity,
    category: category as Category,
    confidence: coerceConfidence(f.confidence),
    title: String(f.title ?? ""),
    comment: String(f.comment ?? ""),
    suggestion: f.suggestion ? String(f.suggestion) : undefined,
    suggestedCode: f.suggested_code ? String(f.suggested_code) : undefined,
  };
}

export async function review(
  diffText: string, context: ContextBundle, norms: Norms,
  log: (msg: string) => void = () => {},
): Promise<ReviewResult> {
  const s = reviewerSettings();
  if (!s.apiKey && !s.baseUrl.includes("localhost")) {
    throw new Error("No reviewer API key configured. Run: codeturtle (setup)");
  }
  const client = new OpenAI({ apiKey: s.apiKey || "local", baseURL: s.baseUrl });
  const messages = [
    { role: "system" as const, content: systemPrompt(norms) },
    {
      role: "user" as const,
      content: `## Surrounding codebase context\n${renderContext(context)}\n\n## Diff to review\n${diffText}`,
    },
  ];
  log(`reviewing model=${s.model} diff=${diffText.length} ctx_files=${context.files.length}`);

  let raw: string;
  try {
    const resp = await client.chat.completions.create({
      model: s.model, messages, temperature: 0.2, response_format: { type: "json_object" },
    });
    raw = resp.choices[0]?.message?.content ?? "{}";
  } catch {
    const resp = await client.chat.completions.create({ model: s.model, messages, temperature: 0.2 });
    raw = resp.choices[0]?.message?.content ?? "{}";
  }

  raw = raw.trim();
  if (raw.startsWith("```")) raw = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (process.env.CT_DEBUG) log(`raw response: ${raw.slice(0, 800)}`);

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    log(`reviewer returned non-JSON: ${raw.slice(0, 200)}`);
    return { findings: [], summary: "Reviewer output could not be parsed." };
  }

  const findings = ((data.findings ?? []) as any[])
    .map(parseFinding)
    .filter((f): f is Finding => f !== null);
  return { findings, summary: String(data.summary ?? "") };
}
