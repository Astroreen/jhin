import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { sharedModules } from "./shared-modules.ts";

// `vp dev` proxies the RPC endpoint to a running node (`jhin serve`).
const node = process.env["JHIN_NODE_URL"] ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [react(), tailwindcss(), sharedModules()],
  server: {
    proxy: { "/rpc": { target: node, ws: true } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
