import { defineConfig } from "vite";

/**
 * The preload as one CommonJS file: a sandboxed preload can be neither an ES
 * module nor require anything but `electron` (docs/plans/desktop.md, D511).
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "node24",
    ssr: "src/preload.ts",
    rollupOptions: { output: { entryFileNames: "preload.cjs", format: "cjs" } },
  },
  ssr: { noExternal: true, external: ["electron"] },
});
