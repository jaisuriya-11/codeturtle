/** Dashboard: paste a PR/MR link OR auto-review watched repos. Live events +
 * review statuses. ESC opens settings (repos / model / reset / quit). */

import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { loadConfig, loadCredentials, resetAll, reviewerSettings, updateConfig } from "../engine/config.js";
import { runReview } from "../engine/pipeline.js";
import { parsePrLink } from "../engine/prLink.js";
import { watch } from "../engine/watch.js";
import { ModelPicker } from "./ModelPicker.js";
import { RepoPicker } from "./RepoPicker.js";
import { ACCENT, DIM, Header, KeyHint } from "./theme.js";

interface ReviewItem {
  key: string;
  label: string;
  prNumber: number;
  status: "running" | "done" | "failed";
  detail: string;
}

type Overlay = "none" | "settings" | "model" | "repos" | "confirmReset";

const ts = () => new Date().toLocaleTimeString();

export function Dashboard({ onReset }: { onReset: () => void }) {
  const { exit } = useApp();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [model, setModel] = useState(reviewerSettings().model);
  const [targets, setTargets] = useState<string[]>(loadConfig().watch?.targets ?? []);
  const [watching, setWatching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [sessionRepoSelected, setSessionRepoSelected] = useState(false);
  const [activeSessionTargets, setActiveSessionTargets] = useState<string[]>([]);

  const creds = loadCredentials();
  const interval = loadConfig().watch?.interval ?? 30;

  const addEvent = useCallback((msg: string) => {
    setEvents((prev) => [...prev.slice(-49), `${ts()}  ${msg}`]);
  }, []);

  const patchByPr = useCallback((prNumber: number, fields: Partial<ReviewItem>) => {
    setReviews((prev) => {
      // update the most recent running item for that PR number
      const idx = [...prev].reverse().findIndex((r) => r.prNumber === prNumber && r.status === "running");
      if (idx === -1) return prev;
      const real = prev.length - 1 - idx;
      return prev.map((r, i) => (i === real ? { ...r, ...fields } : r));
    });
  }, []);

  // shared log: feeds the event stream AND review statuses
  const watchLog = useCallback(
    (msg: string) => {
      addEvent(msg);
      const found = msg.match(/pr=(\d+) found=\d+ kept=(\d+)/);
      if (found) patchByPr(Number(found[1]), { status: "done", detail: `${found[2]} findings` });
      const failed = msg.match(/review failed pr=(\d+)/);
      if (failed) patchByPr(Number(failed[1]), { status: "failed", detail: msg.slice(0, 60) });
    },
    [addEvent, patchByPr],
  );

  const startWatch = useCallback(
    (currentTargets: string[]) => {
      abortRef.current?.abort();
      if (!currentTargets.length) {
        setWatching(false);
        return;
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setWatching(true);
      void watch(currentTargets, {
        intervalSec: interval,
        log: watchLog,
        signal: ctrl.signal,
        onJob: (job) => {
          setReviews((prev) => [
            ...prev,
            {
              key: `auto:${job.projectId}#${job.prNumber}:${Date.now()}`,
              label: `${job.projectId}#${job.prNumber}`,
              prNumber: job.prNumber,
              status: "running",
              detail: "auto · reviewing…",
            },
          ]);
        },
      }).finally(() => setWatching(false));
    },
    [interval, watchLog],
  );

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const startPastedReview = useCallback(
    (raw: string) => {
      const ref = parsePrLink(raw);
      if (!ref) {
        setError("Couldn't parse that link. Paste a GitHub PR or GitLab MR URL.");
        return;
      }
      setError(null);
      const key = `paste:${ref.label}:${Date.now()}`;
      setReviews((prev) => [
        ...prev,
        { key, label: ref.label, prNumber: ref.prNumber, status: "running", detail: "fetching…" },
      ]);
      addEvent(`manual review ${ref.label}`);

      void (async () => {
        try {
          const { getForgeClient } = await import("../engine/forge.js");
          const gl = await getForgeClient(ref.forge);
          let headSha: string;
          try {
            headSha = (await gl.getMr(ref.projectId, ref.prNumber)).headSha;
          } finally {
            await gl.close();
          }
          await runReview(
            { forge: ref.forge, projectId: ref.projectId, prNumber: ref.prNumber, headSha },
            watchLog,
          );
        } catch (e) {
          patchByPr(ref.prNumber, {
            status: "failed",
            detail: e instanceof Error ? e.message.slice(0, 60) : "error",
          });
        }
      })();
    },
    [addEvent, patchByPr, watchLog],
  );

  useInput((_input, key) => {
    if (overlay === "none" && key.escape) setOverlay("settings");
    else if (overlay === "settings" && key.escape) setOverlay("none");
  });

  // ---- overlays ----------------------------------------------------------------

  if (overlay === "model") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Change review model" />
        <ModelPicker
          onDone={(c) => {
            updateConfig("reviewer", {
              provider: c.provider, api_key: c.apiKey, base_url: c.baseUrl, model: c.model,
            });
            setModel(c.model);
            setOverlay("none");
          }}
        />
      </Box>
    );
  }

  if (overlay === "repos") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Auto-review settings" />
        <RepoPicker
          onDone={() => {
            const next = loadConfig().watch?.targets ?? [];
            setTargets(next);
            setOverlay("none");
            if (!sessionRepoSelected) {
              const newlyAdded = next[next.length - 1];
              if (newlyAdded) {
                setActiveSessionTargets([newlyAdded]);
                startWatch([newlyAdded]);
              }
              setSessionRepoSelected(true);
            } else {
              setActiveSessionTargets(next);
              startWatch(next);
            }
          }}
        />
      </Box>
    );
  }

  if (overlay === "confirmReset") {
    return (
      <Box flexDirection="column">
        <Header />
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="red" bold>Reset ALL config?</Text>
          <Text>Deletes tokens, model config, watched repos, and logs from ~/.codeturtle. Cannot be undone.</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Cancel", value: "cancel" },
                { label: "Yes — wipe everything", value: "wipe" },
              ]}
              onSelect={(item) => {
                if (item.value === "wipe") {
                  abortRef.current?.abort();
                  resetAll();
                  onReset();
                } else setOverlay("none");
              }}
            />
          </Box>
        </Box>
      </Box>
    );
  }

  if (overlay === "settings") {
    return (
      <Box flexDirection="column">
        <Header subtitle="Settings" />
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
          <SelectInput
            items={[
              { label: "← Back", value: "back" },
              { label: `Auto-review repos  (${targets.length} watched)`, value: "repos" },
              { label: `Change model  (${model})`, value: "model" },
              { label: "Reset all config", value: "reset" },
              { label: "Quit", value: "quit" },
            ]}
            onSelect={(item) => {
              if (item.value === "back") setOverlay("none");
              else if (item.value === "repos") setOverlay("repos");
              else if (item.value === "model") setOverlay("model");
              else if (item.value === "reset") setOverlay("confirmReset");
              else {
                abortRef.current?.abort();
                exit();
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ---- startup session selection -----------------------------------------------
  if (!sessionRepoSelected) {
    const items = [
      ...targets.map((t) => ({ label: `Monitor: ${t}`, value: t })),
      ...(targets.length > 1 ? [{ label: "Monitor all configured repos", value: "__all__" }] : []),
      { label: "✎  watch a new repo", value: "__manual__" },
      { label: "Skip (just open dashboard)", value: "__skip__" },
    ];
    return (
      <Box flexDirection="column">
        <Header subtitle="Start Session" />
        <Text bold>Which repo would you like to monitor and review for this session?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__skip__") {
                setActiveSessionTargets([]);
                setSessionRepoSelected(true);
              } else if (item.value === "__all__") {
                setActiveSessionTargets(targets);
                setSessionRepoSelected(true);
                startWatch(targets);
              } else if (item.value === "__manual__") {
                setOverlay("repos");
              } else {
                const selected = [item.value];
                setActiveSessionTargets(selected);
                setSessionRepoSelected(true);
                startWatch(selected);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // ---- main --------------------------------------------------------------------

  const running = reviews.filter((r) => r.status === "running").length;
  const forgeBits = ["github", "gitlab"]
    .map((f) => (creds[f]?.user ? `${f} ✓ ${creds[f].user}` : null))
    .filter(Boolean)
    .join("   ");

  return (
    <Box flexDirection="column">
      <Header />
      <Text color={DIM}>
        {forgeBits || "no forge connected"} · model <Text color={ACCENT}>{model}</Text>
      </Text>
      <Text color={DIM}>
        {watching ? (
          <>
            <Text color={ACCENT}><Spinner type="dots" /></Text>
            {" auto-review: "}{activeSessionTargets.join("  ")}{` · every ${interval}s`}
          </>
        ) : (
          "auto-review off — esc → Auto-review repos to enable"
        )}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          Reviews{running ? <Text color="yellow"> · {running} running</Text> : null}
        </Text>
        {reviews.length === 0 ? (
          <Text color={DIM}>None yet — paste a PR link below, or add repos to auto-review.</Text>
        ) : (
          reviews.slice(-8).map((r) => (
            <Text key={r.key}>
              {r.status === "running" ? (
                <Text color="yellow"><Spinner type="dots" /></Text>
              ) : r.status === "done" ? (
                <Text color={ACCENT}>✓</Text>
              ) : (
                <Text color="red">✗</Text>
              )}{" "}
              {r.label} <Text color={DIM}>{r.detail}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Events</Text>
        {events.length === 0 ? (
          <Text color={DIM}>quiet…</Text>
        ) : (
          events.slice(-6).map((e, i) => (
            <Text key={i} color={e.includes("failed") ? "red" : DIM} wrap="truncate">
              {e}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={2} flexDirection="column">
        {error ? <Text color="red">{error}</Text> : null}
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text color={ACCENT}>{"❯ "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            placeholder="paste a GitHub PR / GitLab MR link and press enter"
            onSubmit={(v) => {
              if (!v.trim()) return;
              startPastedReview(v.trim());
              setInput("");
            }}
          />
        </Box>
        <Box marginTop={1} borderStyle="round" borderColor={DIM} paddingX={1}>
          <KeyHint keys={[["enter", "review pasted link"], ["esc", "settings"]]} />
        </Box>
      </Box>
    </Box>
  );
}
