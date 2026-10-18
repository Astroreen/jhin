import * as Fs from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { discoverPlugins } from "../src/index.ts";
import { tempDir, writePlugin } from "./support/harness.ts";

describe("plugin discovery", () => {
  it("lets later layers shadow earlier ones by id: distribution < user < workspace < dev", () => {
    const root = tempDir("discover");
    const dist = writePlugin(Path.join(root, "dist", "a"), { id: "acme.a" }, {});
    const user = writePlugin(Path.join(root, "user", "a"), { id: "acme.a" }, {});
    const userOnly = writePlugin(Path.join(root, "user", "b"), { id: "acme.b" }, {});
    const workspace = writePlugin(Path.join(root, "workspace", "a"), { id: "acme.a" }, {});
    const dev = writePlugin(Path.join(root, "dev", "b"), { id: "acme.b" }, {});

    const discovery = discoverPlugins({
      distribution: [dist],
      user: Path.join(root, "user"),
      workspace: Path.join(root, "workspace"),
      dev: [dev],
    });

    expect(discovery.plugins.map((plugin) => [plugin.layer, plugin.location])).toEqual([
      ["workspace", workspace],
      ["dev", dev],
    ]);
    expect(discovery.shadowed).toEqual([
      { id: "acme.a", location: dist, layer: "distribution", shadowedBy: user },
      { id: "acme.a", location: user, layer: "user", shadowedBy: workspace },
      { id: "acme.b", location: userOnly, layer: "user", shadowedBy: dev },
    ]);
  });

  it("passes unreadable manifests to the kernel instead of hiding them", () => {
    const root = tempDir("discover");
    Fs.mkdirSync(Path.join(root, "broken"), { recursive: true });
    Fs.writeFileSync(Path.join(root, "broken", "package.json"), "{ not json");

    const discovery = discoverPlugins({ user: root });

    expect(discovery.plugins).toEqual([
      {
        location: Path.join(root, "broken"),
        root: Fs.realpathSync(Path.join(root, "broken")),
        manifest: undefined,
        layer: "user",
      },
    ]);
  });
});
