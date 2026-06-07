import { Box, Text } from "ink";
import React from "react";

export const ACCENT = "#1abc9c";
export const DIM = "gray";

const LOGO = [
  "",
  "",
  "████████╗██╗   ██╗██████╗ ████████╗██╗     ███████╗",
  "╚══██╔══╝██║   ██║██╔══██╗╚══██╔══╝██║     ██╔════╝",
  "   ██║   ██║   ██║██████╔╝   ██║   ██║     █████╗  ",
  "   ██║   ██║   ██║██╔══██╗   ██║   ██║     ██╔══╝  ",
  "   ██║   ╚██████╔╝██║  ██║   ██║   ███████╗███████╗",
  "   ╚═╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚══════╝",
];

const LOGO_COLORS = [
  "#2ecc71", // emerald green
  "#27ae60", // nephrite green
  "#1abc9c", // turquoise
  "#16a085", // dark turquoise
  "#3498db", // peter river blue
  "#2980b9", // belize hole blue
];

export function Header({ subtitle }: { subtitle?: string }) {
  let logoLineIdx = 0;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {LOGO.map((line, i) => {
        let color = ACCENT;
        if (line.trim() !== "") {
          color = LOGO_COLORS[logoLineIdx] || ACCENT;
          logoLineIdx++;
        }
        return (
          <Text key={i} color={color}>
            {line}
          </Text>
        );
      })}
      <Text color={DIM}> local AI code reviewer — any model, no cloud</Text>
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
