/** In-memory ForgeClient for engine tests (norms, poster, bundler, …). It
 * implements the real interface so it stays type-checked against the contract,
 * and records every write so tests can assert what got posted. */
import { vi } from "vitest";

import type { ForgeClient, Note } from "../../forge.js";
import type { FileDiff, MrInfo } from "../../types.js";

export interface FakeForgeOptions {
  /** path -> file contents at the head ref */
  files?: Record<string, string>;
  /** symbol/query -> blob hits returned by searchBlobs */
  blobs?: Record<string, { path: string }[]>;
  /** seed existing notes (e.g. to test marker dedup) */
  notes?: Note[];
  diffs?: FileDiff[];
  mr?: Partial<MrInfo>;
  /** make postInlineNote return false to exercise the plain-note fallback */
  inlineFails?: boolean;
  /** submitReview return value (GitLab returns false → sticky-note path) */
  reviewSupported?: boolean;
}

export interface FakeForge extends ForgeClient {
  /** records of side effects, for assertions */
  inline: { filePath: string; newLine: number; body: string }[];
  created: string[];
  edited: { noteId: number | string; body: string }[];
  labels: string[];
  removedLabels: string[];
  submitted: string[];
}

export function makeFakeForge(opts: FakeForgeOptions = {}): FakeForge {
  const files = opts.files ?? {};
  const blobs = opts.blobs ?? {};
  const notes: Note[] = [...(opts.notes ?? [])];
  let nextId = 1000;

  const fake: FakeForge = {
    inline: [],
    created: [],
    edited: [],
    labels: [],
    removedLabels: [],
    submitted: [],

    close: vi.fn(async () => {}),

    getMr: vi.fn(
      async (): Promise<MrInfo> => ({
        sourceBranch: "feature",
        targetBranch: "main",
        headSha: "headsha",
        diffRefs: { head_sha: "headsha", base_sha: "basesha", start_sha: "startsha" },
        ...opts.mr,
      }),
    ),

    getDiffs: vi.fn(async () => opts.diffs ?? []),

    getFile: vi.fn(async (_p: string, path: string) => files[path] ?? null),

    searchBlobs: vi.fn(async (_p: string, query: string) => blobs[query] ?? []),

    createNote: vi.fn(async (_p: string, _n: number, body: string) => {
      fake.created.push(body);
      const id = nextId++;
      notes.push({ id, body });
      return id;
    }),

    editNote: vi.fn(async (_p: string, _n: number, noteId: number | string, body: string) => {
      fake.edited.push({ noteId, body });
      const existing = notes.find((x) => x.id === noteId);
      if (existing) existing.body = body;
    }),

    listNotes: vi.fn(async () => notes.map((n) => ({ ...n }))),

    postStatus: vi.fn(async (_p: string, _n: number, body: string) => {
      const id = nextId++;
      notes.push({ id, body });
      return id;
    }),

    postInlineNote: vi.fn(
      async (_p: string, _n: number, filePath: string, newLine: number, body: string) => {
        if (opts.inlineFails) return false;
        fake.inline.push({ filePath, newLine, body });
        notes.push({ id: nextId++, body });
        return true;
      },
    ),

    addLabels: vi.fn(async (_p: string, _n: number, labels: string[]) => {
      fake.labels.push(...labels);
    }),

    removeLabels: vi.fn(async (_p: string, _n: number, labels: string[]) => {
      fake.removedLabels.push(...labels);
    }),

    submitReview: vi.fn(async (_p: string, _n: number, body: string) => {
      if (opts.reviewSupported === false) return false;
      fake.submitted.push(body);
      notes.push({ id: nextId++, body });
      return true;
    }),

    listOpenPrs: vi.fn(async () => []),
  };
  return fake;
}
