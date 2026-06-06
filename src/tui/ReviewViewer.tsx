import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchCodeSnippet, fetchPRReview, type ParsedFinding, type PRReviewData } from "../engine/viewer.js";
import type { Forge } from "../engine/types.js";
import { ACCENT, DIM, Header } from "./theme.js";

interface ReviewViewerProps {
  forge: Forge;
  projectId: string;
  prNumber: number;
  onBack: () => void;
}

export function ReviewViewer({ forge, projectId, prNumber, onBack }: ReviewViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PRReviewData | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [codeSnippet, setCodeSnippet] = useState<{ lines: string[]; startLine: number } | null>(null);
  const [loadingSnippet, setLoadingSnippet] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [fileFilter, setFileFilter] = useState<string | null>(null);

  const files = useMemo(
    () => [...new Set((data?.findings ?? []).map((f) => f.file))],
    [data],
  );
  const findings = useMemo(
    () =>
      fileFilter
        ? (data?.findings ?? []).filter((f) => f.file === fileFilter)
        : data?.findings ?? [],
    [data, fileFilter],
  );

  const [refreshTick, setRefreshTick] = useState(0);
  const hasData = useRef(false);

  useEffect(() => {
    let active = true;
    async function load() {
      // background refreshes keep the current view — spinner only before first data
      if (!hasData.current) setLoading(true);
      setError(null);
      try {
        const res = await fetchPRReview(forge, projectId, prNumber);
        if (!active) return;
        hasData.current = true;
        setData(res);
        // the review may have changed under us — drop a stale filter, clamp the cursor
        setFileFilter((prev) =>
          prev && !res.findings.some((f) => f.file === prev) ? null : prev,
        );
        setActiveIndex((i) => Math.min(i, Math.max(0, res.findings.length - 1)));
        if (res.findings.length === 0) {
          setShowSummary(true);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to fetch review");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [forge, projectId, prNumber, refreshTick]);

  // new pushes re-review while this screen is open — poll for fresh comments
  useEffect(() => {
    const t = setInterval(() => setRefreshTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (findings.length === 0 || showSummary) {
      setCodeSnippet(null);
      return;
    }
    const finding = findings[activeIndex];
    if (!finding) return;

    let active = true;
    async function loadSnippet() {
      setLoadingSnippet(true);
      try {
        const res = await fetchCodeSnippet(forge, projectId, prNumber, finding.file, finding.line);
        if (!active) return;
        setCodeSnippet(res);
      } catch (err) {
        if (!active) return;
        setCodeSnippet(null);
      } finally {
        if (active) setLoadingSnippet(false);
      }
    }
    loadSnippet();
    return () => {
      active = false;
    };
  }, [findings, activeIndex, showSummary, forge, projectId, prNumber]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (input === "r") {
      setRefreshTick((x) => x + 1);
      return;
    }
    if (!data) return;

    if (input === "s") {
      if (data.findings.length > 0) {
        setShowSummary((prev) => !prev);
      }
      return;
    }

    // cycle the file filter: all → file1 → file2 → … → all
    if (input === "f" && files.length > 1) {
      const idx = fileFilter ? files.indexOf(fileFilter) : -1;
      setFileFilter(idx + 1 >= files.length ? null : files[idx + 1]);
      setActiveIndex(0);
      return;
    }

    if (findings.length > 0 && !showSummary) {
      if (input === "j" || key.downArrow) {
        setActiveIndex((prev) => (prev + 1) % findings.length);
      } else if (input === "k" || key.upArrow) {
        setActiveIndex((prev) => (prev - 1 + findings.length) % findings.length);
      }
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header subtitle={`Loading Review for ${projectId}#${prNumber}`} />
        <Box marginTop={1}>
          <Text color={ACCENT}>
            <Spinner type="dots" />
          </Text>
          <Text> Fetching review comments from {forge}...</Text>
        </Box>
        <Box marginTop={2} borderStyle="round" borderColor={DIM} paddingX={1}>
          <Text color={DIM}>
            Press <Text color={ACCENT} bold>q/esc</Text> to cancel and go back
          </Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header subtitle={`Review fetch error for ${projectId}#${prNumber}`} />
        <Box marginTop={1}>
          <Text color="red" bold>Error: {error}</Text>
        </Box>
        <Box marginTop={2} borderStyle="round" borderColor={DIM} paddingX={1}>
          <Text color={DIM}>
            Press <Text color={ACCENT} bold>r</Text> to retry ·{" "}
            <Text color={ACCENT} bold>q/esc</Text> to go back
          </Text>
        </Box>
      </Box>
    );
  }

  if (!data || (data.findings.length === 0 && !data.summary)) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header subtitle={`${projectId}#${prNumber}`} />
        <Box marginTop={1}>
          <Text color="yellow">No Code Turtle reviews or findings found on this PR/MR.</Text>
        </Box>
        <Box marginTop={2} borderStyle="round" borderColor={DIM} paddingX={1}>
          <Text color={DIM}>
            Press <Text color={ACCENT} bold>r</Text> to refresh ·{" "}
            <Text color={ACCENT} bold>q/esc</Text> to go back
          </Text>
        </Box>
      </Box>
    );
  }

  const activeFinding = findings.length > 0 ? findings[activeIndex] : null;

  return (
    <Box flexDirection="column" padding={1}>
      <Header subtitle={`Viewing Review: ${projectId}#${prNumber}`} />

      {/* TOP PANE: Overall Summary OR Code Snippet + Finding Detail */}
      {showSummary || !activeFinding ? (
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column" minHeight={12}>
          <Text bold color={ACCENT}>Overall Review Summary</Text>
          <Box marginTop={1} flexDirection="column">
            {data.summary ? (
              <Text>{data.summary}</Text>
            ) : (
              <Text color={DIM}>No review summary text available. View individual findings instead.</Text>
            )}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* Code Context */}
          <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column" minHeight={8}>
            <Text bold color={ACCENT}>Code Context: {activeFinding.file}:{activeFinding.line}</Text>
            {loadingSnippet ? (
              <Box marginTop={1}>
                <Text color={ACCENT}>
                  <Spinner type="dots" />
                </Text>
                <Text> Loading code snippet...</Text>
              </Box>
            ) : codeSnippet ? (
              <Box flexDirection="column" marginTop={1}>
                {codeSnippet.lines.map((lineText, idx) => {
                  const currentLineNum = codeSnippet.startLine + idx;
                  const isTarget = currentLineNum === activeFinding.line;
                  const linePrefix = isTarget ? "❯❯" : "  ";
                  let lineColor = DIM;
                  if (isTarget) {
                    lineColor =
                      activeFinding.severity === "critical"
                        ? "red"
                        : activeFinding.severity === "warning"
                        ? "yellow"
                        : "cyan";
                  }
                  return (
                    <Text key={idx} color={lineColor} bold={isTarget}>
                      {linePrefix} {String(currentLineNum).padStart(4)} | {lineText}
                    </Text>
                  );
                })}
              </Box>
            ) : (
              <Box marginTop={1}>
                <Text color={DIM}>
                  Could not load code context (head ref file modified or unavailable).
                </Text>
              </Box>
            )}
          </Box>

          {/* Finding Detail */}
          <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
            <Box flexDirection="row">
              <Text
                bold
                color={
                  activeFinding.severity === "critical"
                    ? "red"
                    : activeFinding.severity === "warning"
                    ? "yellow"
                    : "cyan"
                }
              >
                [{activeFinding.severity.toUpperCase()}] {activeFinding.title}
              </Text>
              <Text color={DIM}>
                {" · "}
                {activeFinding.category}
                {" · confidence "}
                {activeFinding.confidence.toFixed(2)}
              </Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text>{activeFinding.comment}</Text>
              {activeFinding.suggestedCode && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="green" bold>Suggested Replacement:</Text>
                  <Box borderStyle="single" borderColor="green" paddingX={1} marginTop={1}>
                    <Text color="green">{activeFinding.suggestedCode}</Text>
                  </Box>
                </Box>
              )}
              {activeFinding.suggestion && !activeFinding.suggestedCode && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="yellow" bold>Suggestion:</Text>
                  <Text>{activeFinding.suggestion}</Text>
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      )}

      {/* BOTTOM PANE: Scrollable Findings List (Quickfix style) */}
      {findings.length > 0 && (
        <Box borderStyle="round" borderColor={DIM} paddingX={1} flexDirection="column">
          <Text bold color={DIM}>
            Findings List ({activeIndex + 1}/{findings.length})
            {fileFilter ? (
              <Text color={ACCENT}> · file: {fileFilter}</Text>
            ) : null}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {(() => {
              const maxVisible = 5;
              let start = Math.max(0, activeIndex - Math.floor(maxVisible / 2));
              let end = Math.min(findings.length, start + maxVisible);
              if (end - start < maxVisible) {
                start = Math.max(0, end - maxVisible);
              }
              return findings.slice(start, end).map((f, idx) => {
                const actualIdx = start + idx;
                const isActive = actualIdx === activeIndex;
                const prefix = isActive ? "❯ " : "  ";
                const color = isActive ? ACCENT : DIM;
                const severityEmoji = f.severity === "critical" ? "🛑" : f.severity === "warning" ? "⚠️" : "💡";

                return (
                  <Text key={actualIdx} color={color} bold={isActive}>
                    {prefix} {severityEmoji} {f.file}:{f.line} · {f.title}
                  </Text>
                );
              });
            })()}
          </Box>
        </Box>
      )}

      {/* Keyboard hints */}
      <Box marginTop={1} borderStyle="round" borderColor={DIM} paddingX={1}>
        <Text color={DIM}>
          <Text color={ACCENT} bold>j/k or ↓/↑</Text> navigate findings
          {data.findings.length > 0 ? (
            <>
              {"  ·  "}
              <Text color={ACCENT} bold>s</Text> toggle summary
            </>
          ) : null}
          {files.length > 1 ? (
            <>
              {"  ·  "}
              <Text color={ACCENT} bold>f</Text> filter by file
            </>
          ) : null}
          {"  ·  "}
          <Text color={ACCENT} bold>r</Text> refresh
          {"  ·  "}
          <Text color={ACCENT} bold>q/esc</Text> go back
        </Text>
      </Box>
    </Box>
  );
}
