import { configChange, sendConfigChange } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";
import { connectInMemory, createTestKernel, testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

/**
 * A node from before D475 over a real RPC session: `host.config.edit` is
 * unknown there and its `host.config.patch` may not declare `unset` (D84).
 */
async function oldNode(withUnset: boolean) {
  const patches: unknown[] = [];
  const kernel = await createTestKernel({
    plugins: [
      {
        manifest: testManifest("acme.old-host", { side: "server" }),
        definition: definePlugin({
          activate(context) {
            context.commands.register({
              name: "host.config.patch",
              description: "An old node's patch",
              input: z.object({
                layer: z.enum(["node", "project"]),
                section: z.string(),
                values: z.record(z.string(), z.unknown()),
                ...(withUnset ? { unset: z.array(z.string()).optional() } : {}),
              }),
              output: z.object({ applied: z.boolean(), at: z.number() }),
              handler: (input) => {
                patches.push(input);
                return { applied: true, at: 1 };
              },
            });
            context.commands.register({
              name: "host.commands.list",
              description: "Every command",
              input: z.object({}),
              output: z.unknown(),
              handler: () => context.commands.list(),
            });
          },
        }),
      },
    ],
  });
  const { client } = connectInMemory(kernel);
  return { client, patches, stop: () => kernel.stop() };
}

describe("a config change for an older node, over RPC (D475)", () => {
  const reset = configChange("node", "acme", { a: 1, b: 2 }, { b: 3 });

  it("falls back to host.config.patch with unset where the node declares it", async () => {
    const node = await oldNode(true);
    expect(
      await sendConfigChange((method, params) => node.client.call(method, params), reset),
    ).toMatchObject({ applied: true });
    expect(node.patches).toEqual([
      { layer: "node", section: "acme", values: { b: 3 }, unset: ["a"] },
    ]);
    await node.stop();
  });

  it("refuses a removal the node would drop, writing nothing", async () => {
    const node = await oldNode(false);
    await expect(
      sendConfigChange((method, params) => node.client.call(method, params), reset),
    ).rejects.toMatchObject({ code: "CONFIG_CHANGE_UNSUPPORTED" });
    expect(node.patches).toEqual([]);
    await node.stop();
  });
});
