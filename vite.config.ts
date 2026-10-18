import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const GENERATED = [
  "node_modules",
  "dist",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
  "**/playwright-report/**",
  "**/test-results/**",
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "plugins/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [...GENERATED, "LICENSE"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: GENERATED,
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/consistent-function-scoping": "off",
    },
    overrides: [
      {
        // AGENTS.md: tests wait for a concrete event, never for time.
        files: ["**/*.test.ts", "**/*.test.tsx", "e2e/**/*.ts"],
        rules: {
          "eslint/no-restricted-globals": [
            "error",
            {
              name: "setTimeout",
              message: "Wait for a concrete event, a persisted record or a drain.",
            },
            {
              name: "setInterval",
              message: "Wait for a concrete event, a persisted record or a drain.",
            },
          ],
          "eslint/no-restricted-properties": [
            "error",
            {
              property: "waitForTimeout",
              message: "Wait for a concrete event, a persisted record or a drain.",
            },
          ],
        },
      },
    ],
  },
});
