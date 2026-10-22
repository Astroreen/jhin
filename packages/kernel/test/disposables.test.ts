import { DisposableStore, definePlugin, toDisposable, z, type Disposable } from "@jhin/sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import { createTestKernel, testManifest } from "../../testing/src/index.ts"; // relative: a package dependency would be a cycle

describe("DisposableStore", () => {
  it("forgets a deleted item: disposing the store no longer disposes it", () => {
    const store = new DisposableStore();
    const disposed: string[] = [];
    store.add(toDisposable(() => disposed.push("kept")));
    const gone = store.add(toDisposable(() => disposed.push("gone")));
    store.delete(gone);
    store.delete(gone);
    store.dispose();
    expect(disposed).toEqual(["kept"]);
  });

  it("disposes in reverse order of addition, an item added twice once", () => {
    const store = new DisposableStore();
    const disposed: string[] = [];
    const first = { dispose: () => disposed.push("first") };
    store.add(first);
    store.add({ dispose: () => disposed.push("second") });
    store.add(first);
    store.dispose();
    expect(disposed).toEqual(["second", "first"]);
  });
});

describe("a plugin's registrations", () => {
  it("leave the plugin's store once disposed, instead of staying until it is deactivated", async () => {
    let registration: Disposable | undefined;
    const kernel = await createTestKernel({
      plugins: [
        {
          manifest: testManifest("app.pinger"),
          definition: definePlugin({
            activate(context) {
              registration = context.commands.register({
                name: "app.ping",
                description: "Answers",
                input: z.object({}),
                output: z.object({}),
                handler: () => ({}),
              });
            },
          }),
        },
      ],
    });
    const names = () => kernel.inspect().commands.map((command) => command.name);
    expect(names()).toContain("app.ping");
    const forget = vi.spyOn(DisposableStore.prototype, "delete");
    try {
      registration!.dispose();
      // The registry let it go, and so did the plugin's store.
      expect(names()).not.toContain("app.ping");
      expect(forget).toHaveBeenCalledTimes(1);
      expect(forget).toHaveBeenCalledWith(registration);
    } finally {
      forget.mockRestore();
    }
    await kernel.stop();
  });
});
