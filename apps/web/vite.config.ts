import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { precompress } from "./precompress.ts";
import { sharedModules } from "./shared-modules.ts";

// `vp dev` proxies to a running node: the RPC endpoint (`jhin serve`) and, from
// `jhin serve --ui`, the user client plugins, their config and change events (D16).
const node = process.env["JHIN_NODE_URL"] ?? "http://127.0.0.1:7777";

export default defineConfig({
  // The React Compiler memoizes components, as in T3 Code; the code leaves memoization to it.
  // So a render reads a store only through a hook that returns the value (useSyncExternalStore):
  // a store read during render without one is memoized and never sees the store change.
  // `precompress` writes the .br and .gz siblings jhin.web-ui sends (docs/plans/loading.md D1582).
  plugins: [react({ compiler: true }), tailwindcss(), sharedModules(), precompress()],
  server: {
    // Tailscale names, so `tailscale serve` can share the dev server with the tailnet while
    // it still listens on 127.0.0.1 only; Vite rejects any other Host header.
    allowedHosts: [".ts.net"],
    proxy: {
      "/rpc": { target: node, ws: true },
      "/client/": { target: node },
      // Pairing and the page's session cookie (security.md D421).
      "/auth/": { target: node },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
