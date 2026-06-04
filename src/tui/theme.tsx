import { Box, Text } from "ink";
import React from "react";

export const ACCENT = "#3498db";
export const DIM = "gray";

const LOGO = [
  " _________  __  __   ______   _________  __       ______      ",
  "/________/\\/_/\\/_/\\ /_____/\\ /________/\\/_/\\     /_____/\\     ",
  "\\__.::.__\\/\\:\\ \\:\\ \\\\:::_ \\ \\\\__.::.__\\/\\:\\ \\    \\::::_\\/_    ",
  "   \\::\\ \\   \\:\\ \\:\\ \\\\:(_) ) )_ \\::\\ \\   \\:\\ \\    \\:\\/___/\\   ",
  "    \\::\\ \\   \\:\\ \\:\\ \\\\: __ `\\ \\ \\::\\ \\   \\:\\ \\____\\::___\\/_  ",
  "     \\::\\ \\   \\:\\_\\:\\ \\\\ \\ `\\ \\ \\ \\::\\ \\   \\:\\/___/\\\\:\\____/\\ ",
  "      \\__\\/    \\_____\\/ \\_\\/ \\_\\/  \\__\\/    \\_____\\/ \\_____\\/"
];

export function Header({ subtitle }: { subtitle?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {LOGO.map((line, i) => (
        <Text key={i} color={ACCENT}>
          {line}
        </Text>
      ))}
      <Text color={DIM}>  local AI code reviewer — any model, no cloud</Text>
      {subtitle ? <Text color={DIM}>{subtitle}</Text> : null}
    </Box>
  );
}

export function KeyHint({ keys }: { keys: [string, string][] }) {
  return (
    <Box>
      {keys.map(([k, label], i) => (
        <Text key={k} color={DIM}>
          {i > 0 ? "  ·  " : ""}
          <Text color={ACCENT} bold>
            {k}
          </Text>{" "}
          {label}
        </Text>
      ))}
    </Box>
  );
}
