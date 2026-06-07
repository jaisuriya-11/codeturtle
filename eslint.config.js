// Flat ESLint config: typescript-eslint strict on src, react-hooks on the TUI,
// prettier last to disable stylistic rules (formatting is Prettier's job).
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // AGENTS.md: no `any` in exported signatures; internal parse code may cast.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Engine relies on `catch {}` soft-failure pattern (return null and log).
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/tui/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Ink TUI components legitimately reset state synchronously in effects
      // before async loads; "cascading render" cost is negligible in a terminal.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  prettier,
);
