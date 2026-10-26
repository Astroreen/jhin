import { defineConfig } from "vite";

/**
 * A preload as one CommonJS file: a sandboxed preload can be neither an ES
 * module nor require anything but `electron` (docs/plans/desktop.md, D511),
 * nor load a shared chunk, so each preload is built whole by a config of its
 * own: the window's here, the preview's guests' (D1491) and its pop-out
 * window's (D1493) beside it.
 */
export function preloadConfig(entry: string) {
  return defineConfig({
    build: {
      outDir: "dist",
      emptyOutDir: false,
      target: "node24",
      ssr: `src/${entry}.ts`,
      rollupOptions: { output: { entryFileNames: `${entry}.cjs`, format: "cjs" } },
    },
    ssr: { noExternal: true, external: ["electron"] },
  });
}

export default preloadConfig("preload");
