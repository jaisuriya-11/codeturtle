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

How to read the diff — this matters:
- Lines prefixed '-' are OLD code being REMOVED by this change. They no longer exist.
- Lines prefixed '+' are NEW code being ADDED. Only this code ships.
- Before judging a '+' line, compare it with the '-' lines it replaces. If the old
  code was buggy and the new code is correct, the change is a FIX — do not flag it.
  Flag only problems that exist in the NEW code.
- Never report an issue that lives only on a '-' line or only in unchanged context.

Hard rules:
- Only comment on lines ADDED in the diff (prefixed '+').
- Use the new-file line number from the hunk header (@@ -a,b +c,d @@).
- In "evidence", copy the flagged '+' line VERBATIM from the diff (without the '+').
  A finding whose evidence does not appear in the diff is discarded as fabricated —
  never paraphrase or reconstruct code from memory.
- Set confidence honestly (0.0-1.0); low-confidence guesses are dropped.
- One finding per issue. Be concrete, short, and kind.
- If the diff is clean, return an empty findings list.

Security checklist — scan every '+' line for these; when present, report with
category "security", severity "critical", confidence ≥ 0.9:
- secrets, tokens, passwords, keys, or decrypted payloads written to logs/stdout
- weakened cryptography: ECB mode, static/hardcoded/empty IV or key, MD5/SHA-1
  for passwords, disabled TLS/certificate verification, reduced key sizes
- injection: SQL/command/path/HTML built by concatenating unvalidated input
- authentication or authorization checks removed, weakened, or bypassed

Respond with ONLY a JSON object — no prose, no markdown fences:
{"findings": [{"file","line","evidence","severity","category","confidence","title","comment","suggestion","suggested_code"}],
 "summary": "one-line overview"}
severity ∈ critical|warning|info ; category ∈ security|bug|perf|style|maintainability
"suggestion" is a short prose recommendation. "suggested_code" is the EXACT replacement
for the flagged line only — raw code, same indentation, no fences, no commentary.
Omit "suggested_code" unless you are sure it is a drop-in replacement for that one line.`;

/** Extra passes for small models: one lens per pass — checklist verification
 * recalls far more than one free-form sweep over a multi-file diff. */
const FOCUS_PROMPTS: Record<string, string> = {
  security: `THIS PASS REVIEWS SECURITY ONLY — ignore style, perf, naming.
Walk this checklist over EVERY '+' line in EVERY file, one file at a time:
- secrets, tokens, passwords, or decrypted payloads written to logs/stdout
- crypto downgrades: ECB mode, static/hardcoded/empty IV or key, MD5/SHA-1,
  reduced key sizes, disabled TLS/certificate checks
- weak randomness where security matters: java.util.Random / Math.random / rand()
  used for tokens, session ids, keys, or IVs instead of a CSPRNG (SecureRandom etc.)
- validation weakened or bypassed: size/bounds checks removed or inverted
  (e.g. a limit check turned into '< 0'), input sanitisation deleted
- authentication/authorization checks removed, weakened, or bypassed
- injection: SQL/command/path/HTML built from concatenated input
Report every hit. If unsure, still report it with lower confidence.`,
  logic: `THIS PASS REVIEWS LOGIC AND CORRECTNESS ONLY — ignore style, naming.
Walk EVERY '+' line in EVERY file, one file at a time, hunting for:
- inverted or neutered conditions (comparisons that are now always true/false)
- emptied or gutted method bodies — cleanup/eviction/purge/close that no longer
  does anything (resource and memory leaks)
- data stored but never removed; timers/listeners never cancelled
- off-by-one errors, wrong operator, swapped arguments, dropped error handling
- return values ignored or constants returned where computation is required
Report every hit. If unsure, still report it with lower confidence.`,
};

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
    evidence: f.evidence ? String(f.evidence) : undefined,
  };
}

const stripWs = (s: string) => s.replace(/\s+/g, "");

/** Anti-hallucination gate: a finding that quotes code is kept only if that
 * code actually appears in the diff (whitespace-insensitive). Findings without
 * evidence pass — older/weaker models may omit the field. */
function evidenceInDiff(f: Finding, diffNorm: string): boolean {
  if (!f.evidence) return true;
  const ev = stripWs(f.evidence);
  return ev.length === 0 || diffNorm.includes(ev);
}

/** Union findings from multiple passes: same file, same category, within ±3
 * lines = the same issue seen twice — keep the higher-confidence copy. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const dup = out.findIndex(
      (o) => o.file === f.file && o.category === f.category && Math.abs(o.line - f.line) <= 3,
    );
    if (dup === -1) out.push(f);
    else if (f.confidence > out[dup].confidence) out[dup] = f;
  }
  return out;
}

/** Retry transient model errors (rate limits, server hiccups) with backoff.
 * Honors Retry-After when the provider sends one. */
async function createWithRetry(
  client: OpenAI, params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  log: (msg: string) => void,
): Promise<OpenAI.Chat.ChatCompletion> {
  let delay = Number(process.env.REVIEWER_RETRY_BASE_MS ?? 5000);
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create(params);
    } catch (e: any) {
      const status = e?.status;
      if (![429, 500, 502, 503].includes(status) || attempt >= 2) throw e;
      const retryAfter = Number(e?.headers?.["retry-after"]);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : delay;
      log(`model returned ${status}${status === 429 ? " (rate limited)" : ""} — retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      delay *= 3;
    }
  }
}

async function runPass(
  client: OpenAI, model: string, system: string, user: string,
  log: (msg: string) => void,
): Promise<ReviewResult> {
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];

  let raw: string;
  try {
    const resp = await createWithRetry(client, {
      model, messages, temperature: 0.2, response_format: { type: "json_object" },
    }, log);
    raw = resp.choices[0]?.message?.content ?? "{}";
  } catch (e: any) {
    // some compat servers reject response_format — only then strip it and retry;
    // rate limits and server errors above already retried and should surface
    if (![400, 404, 422].includes(e?.status)) throw e;
    const resp = await createWithRetry(client, { model, messages, temperature: 0.2 }, log);
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

export async function review(
  diffText: string, context: ContextBundle, norms: Norms,
  log: (msg: string) => void = () => {},
): Promise<ReviewResult> {
  const s = reviewerSettings();
  if (!s.apiKey && !s.baseUrl.includes("localhost")) {
    throw new Error("No reviewer API key configured. Run: codeturtle (setup)");
  }
  const client = new OpenAI({ apiKey: s.apiKey || "local", baseURL: s.baseUrl });
  const system = systemPrompt(norms);
  const user = `## Surrounding codebase context\n${renderContext(context)}\n\n## Diff to review\n${diffText}`;
  const foci = ["security", "logic"].slice(0, s.passes - 1);
  log(`reviewing model=${s.model} passes=${s.passes} diff=${diffText.length} ctx_files=${context.files.length}`);

  // general pass failure is fatal (existing behaviour); focus passes are best-effort
  const [general, ...extras] = await Promise.all([
    runPass(client, s.model, system, user, log),
    ...foci.map((f) =>
      runPass(client, s.model, `${system}\n\n${FOCUS_PROMPTS[f]}`, user, log).catch((e) => {
        log(`${f} pass failed: ${e instanceof Error ? e.message : e}`);
        return { findings: [], summary: "" } as ReviewResult;
      }),
    ),
  ]);

  const diffNorm = stripWs(diffText);
  const findings = dedupeFindings(
    [...general.findings, ...extras.flatMap((r) => r.findings)].filter((f) => {
      const ok = evidenceInDiff(f, diffNorm);
      if (!ok) log(`dropped fabricated finding ${f.file}:${f.line} — evidence not in diff`);
      return ok;
    }),
  );
  return { findings, summary: general.summary };
}
