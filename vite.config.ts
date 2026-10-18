import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

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
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/**/*.test.ts",
            "plugins/**/*.test.ts",
            "apps/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.{ts,tsx}"],
        },
      },
      {
        // Anything that needs a real browser is named *.browser.test.{ts,tsx} and
        // runs in headless Chromium.
        extends: true,
        optimizeDeps: { include: ["vite-plus/test/browser"] },
        test: {
          name: "browser",
          include: [
            "packages/**/*.browser.test.{ts,tsx}",
            "plugins/**/*.browser.test.{ts,tsx}",
            "apps/**/*.browser.test.{ts,tsx}",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
          // A fixed port collides when two checkouts run browser tests at once.
          api: { port: 0, strictPort: false },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            screenshotFailures: false,
          },
        },
      },
    ],
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
      // Plugin lifecycles and hook pipelines are sequential on purpose.
      "eslint/no-await-in-loop": "off",
      "oxc/no-map-spread": "off",
    },
    overrides: [
      {
        // AGENTS.md rule 2: the kernel, the SDK and the test kit run unchanged in
        // Node and in the browser. tsconfig `types: []` enforces the same at typecheck.
        files: [
          "packages/kernel/src/**",
          "packages/sdk/src/**",
          "packages/testing/src/**",
          "packages/rpc/src/**",
          "packages/storage-api/src/**",
          "packages/host-api/src/**",
        ],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["node:*"],
                  message: "The kernel is isomorphic: inject host APIs instead.",
                },
              ],
            },
          ],
          "eslint/no-restricted-globals": [
            "error",
            { name: "process", message: "The kernel is isomorphic: inject host APIs instead." },
            { name: "window", message: "The kernel is isomorphic: inject host APIs instead." },
            { name: "document", message: "The kernel is isomorphic: inject host APIs instead." },
            { name: "Buffer", message: "The kernel is isomorphic: inject host APIs instead." },
          ],
        },
      },
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
