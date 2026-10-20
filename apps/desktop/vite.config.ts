import { builtinModules } from "node:module";

import { defineConfig } from "vite";

/**
 * The main process as one ES module (docs/plans/desktop.md, D511): workspace
 * packages are bundled in; Electron, electron-updater and Node's modules are
 * what the app loads at run time. `vite.preload.config.ts` builds the preload.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "node24",
    ssr: "src/main.ts",
    rollupOptions: { output: { entryFileNames: "main.js", format: "es" } },
  },
  ssr: {
    noExternal: true,
    external: [
      "electron",
      "electron-updater",
      ...builtinModules,
      ...builtinModules.map((name) => `node:${name}`),
    ],
  },
});
