import { definePlugin, z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { createKernel, type ModuleLoader } from "../src/index.ts";

// The kernel is isomorphic: the same code activates plugins inside a real browser.
describe("kernel in the browser", () => {
  it("activates a client plugin and runs its command", async () => {
    const loader: ModuleLoader = {
      async load() {
        return {
          default: definePlugin({
            activate(context) {
              context.commands.register({
                name: "app.where",
                description: "Reports the runtime",
                input: z.object({}),
                output: z.object({ hasDocument: z.boolean() }),
                handler: () => ({
                  hasDocument: typeof globalThis === "object" && "document" in globalThis,
                }),
              });
            },
          }),
        };
      },
    };
    const kernel = createKernel({ side: "client", loader });

    await kernel.start([
      {
        location: "memory://app",
        manifest: {
          id: "app.where",
          version: "1.0.0",
          apiVersion: 1,
          side: "client",
          entry: "index.js",
        },
      },
    ]);

    expect(kernel.inspect().plugins[0]?.status).toBe("active");
    expect(await kernel.commands.execute("app.where", {})).toEqual({ hasDocument: true });
  });
});
