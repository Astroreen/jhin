import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { sharedModules } from "./shared-modules.ts";

// `vp dev` proxies to a running node: the RPC endpoint (`jhin serve`) and, from
// `jhin serve --ui`, the user client plugins, their config and change events (D16).
const node = process.env["JHIN_NODE_URL"] ?? "http://127.0.0.1:7777";

export default defineConfig({
  // The React Compiler memoizes components, as in T3 Code; the code leaves memoization to it.
  // So a render reads a store only through a hook that returns the value (useSyncExternalStore):
  // a store read during render without one is memoized and never sees the store change.
  plugins: [react({ compiler: true }), tailwindcss(), sharedModules()],
  server: {
    proxy: {
      "/rpc": { target: node, ws: true },
      "/client/": { target: node },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
