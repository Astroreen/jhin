import { defineConfig } from "vite";

/**
 * A browser runs this client plugin, so it is built (docs/plans/desktop.md,
 * D514): one ES module whose imports of the packages the web client shares
 * through its import map (D16) stay imports; the rest is bundled in.
 */
const SHARED = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@jhin/sdk",
  "@jhin/ui",
  "@jhin/client-api",
];

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "index.js" },
    rollupOptions: {
      external: SHARED,
      // lucide-react marks its modules "use client", which means nothing in a bundle.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
});
