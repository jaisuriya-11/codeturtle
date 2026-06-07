/** PR list box for the dashboard: 10-row viewport centred on the selection,
 * with per-PR review status badges. Pure presentation. */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";

import type { PrSummary } from "../../engine/viewer.js";
import { ACCENT, DIM } from "../theme.js";

export interface PrStatus {
  status: "running" | "done" | "failed";
  detail: string;
}

const VIEWPORT_ROWS = 10;

export function PrList({
  list,
  tab,
  activeIndex,
  statuses,
  listError,
}: {
  list: PrSummary[] | null;
  tab: "open" | "closed";
  activeIndex: number;
  statuses: Record<number, PrStatus>;
  listError: string | null;
}) {
  const visible = (() => {
    if (!list) return [];
    let start = Math.max(0, activeIndex - Math.floor(VIEWPORT_ROWS / 2));
    const end = Math.min(list.length, start + VIEWPORT_ROWS);
    if (end - start < VIEWPORT_ROWS) start = Math.max(0, end - VIEWPORT_ROWS);
    return list.slice(start, end).map((pr, i) => ({ pr, idx: start + i }));
  })();

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={DIM}
      paddingX={1}
      minHeight={6}
    >
      {listError ? (
        <Text color="red">{listError}</Text>
      ) : list === null ? (
        <Text color={DIM}>
          <Spinner type="dots" /> loading {tab} PRs…
        </Text>
      ) : list.length === 0 ? (
        <Text color={DIM}>no {tab} PRs in this repo</Text>
      ) : (
        visible.map(({ pr, idx }) => {
          const isActive = idx === activeIndex;
          const st = statuses[pr.iid];
          return (
            <Text
              key={pr.iid}
              color={isActive ? ACCENT : undefined}
              bold={isActive}
              wrap="truncate"
            >
              {isActive ? "❯ " : "  "}#{pr.iid} {pr.title}
              <Text color={DIM}> · {pr.author}</Text>
              {st ? (
                <Text
                  color={st.status === "failed" ? "red" : st.status === "done" ? ACCENT : "yellow"}
                >
                  {"  "}
                  {st.status === "running" ? "● " : st.status === "done" ? "✓ " : "✗ "}
                  {st.detail}
                </Text>
              ) : null}
            </Text>
          );
        })
      )}
    </Box>
  );
}
