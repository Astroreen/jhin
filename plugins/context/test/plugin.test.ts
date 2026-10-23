import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { definePlugin, z } from "@jhin/sdk";
import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import {
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  testManifest,
  type TestKernel,
} from "@jhin/testing";
import * as Jsonc from "jsonc-parser";
import { afterEach, describe, expect, it } from "vite-plus/test";

import context, { LORE_BRIEF_HOOK } from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function project(files: Record<string, string>): string {
  const dir = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-context-")));
  cleanups.push(() => Fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    Fs.mkdirSync(Path.dirname(Path.join(dir, file)), { recursive: true });
    Fs.writeFileSync(Path.join(dir, file), content);
  }
  return dir;
}

const LIBRARY = {
  "AGENTS.md":
    "# Trailhead\n\n## Find your way\n\n1. `docs/map.md` — the map.\n2. [`docs/`](docs/README.md)\n",
  "docs/README.md":
    "# Library\n\n- [map](map.md#shape)\n- [lore](lore/README.md)\n- [gone](plans/gone.md)\n- [bad anchor](map.md#nope)\n- `planned.md` comes later.\n",
  "docs/map.md":
    "# Map\n\n## Shape\n\n- **Kernel** → `plans/core.md#D3`\n\n## Plugins\n\n- `jhin.context`\n",
  "docs/plans/core.md":
    "---\nmaturity: canon\nmaturity.deferred: note\n---\n# Core\n\n## Decisions\n\n- **D3. Small kernel.** Nothing\n  product-shaped.\n- **D4. Next.**\n\n## Deferred\n\n- Later.\n",
  "docs/orphan.md": "# Nobody links here\n",
  "docs/lore/README.md":
    "# Lore\n\n| Name | Lesson |\n| --- | --- |\n| [moonbase](doghouse.md) | walk back up to the intent |\n",
  "docs/lore/doghouse.md": "# Doghouse → moonbase\n\nThe dog is still outside.\n",
  "docs/lore/wheel.md": "---\nname: wheel\nlesson: read the map first\n---\n# Reinvent the wheel\n",
  ".jhin/agents/builder/lore/tests.md": "# Green tests\n\nThey proved nothing.\n",
};

async function start(
  root: string,
  config: Record<string, unknown> = {},
  extra: Parameters<typeof definePlugin>[0]["activate"] = () => {},
): Promise<TestKernel> {
  const projects = definePlugin({
    activate(ctx) {
      ctx.commands.register({
        name: "projects.list",
        description: "Projects",
        input: z.object({}),
        output: z.array(z.object({ id: z.string(), path: z.string() })),
        handler: () => [{ id: "other", path: root }],
      });
    },
  });
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", { home: root, cwd: root, dataDir: () => root }, "1.1.0"),
      { manifest: testManifest("test.projects", { side: "server" }), definition: projects },
      { manifest, definition: context },
      {
        manifest: testManifest("test.extra", { side: "server" }),
        definition: definePlugin({ activate: extra }),
      },
    ],
    config: { node: { "jhin.context": config } },
  });
  cleanups.push(() => kernel.stop());
  expect(kernel.inspect().plugins.filter((plugin) => plugin.status !== "active")).toEqual([]);
  return kernel;
}

describe("context.read", () => {
  it("returns one section by address, with its maturity", async () => {
    const kernel = await start(project(LIBRARY));
    const section = (await kernel.commands.execute("context.read", {
      path: "docs/plans/core.md#deferred",
    })) as Record<string, unknown>;
    expect(section).toMatchObject({
      address: "docs/plans/core.md#deferred",
      heading: "Deferred",
      maturity: "note",
      rank: 2,
      content: "## Deferred\n\n- Later.",
    });
    expect(section.headings).toEqual([
      { depth: 1, text: "Core", anchor: "core" },
      { depth: 2, text: "Decisions", anchor: "decisions" },
      { depth: 2, text: "Deferred", anchor: "deferred" },
    ]);
  });

  it("reads a decision by id, and a whole page without a heading", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(
      kernel.commands.execute("context.read", { path: "docs/plans/core.md", heading: "D3" }),
    ).resolves.toMatchObject({
      address: "docs/plans/core.md#D3",
      maturity: "canon",
      content: "- **D3. Small kernel.** Nothing\n  product-shaped.",
    });
    await expect(
      kernel.commands.execute("context.read", { path: "docs/orphan.md" }),
    ).resolves.toMatchObject({
      address: "docs/orphan.md",
      content: "# Nobody links here\n",
      rank: 0,
    });
  });

  it("takes maturity by path prefix from config when the page has none", async () => {
    const kernel = await start(project(LIBRARY), {
      maturity: { "docs/": "observation", "docs/map.md": "canon", "docs/orphan": "note" },
    });
    const read = (path: string) =>
      kernel.commands.execute("context.read", { path }) as Promise<{ maturity?: string }>;
    expect((await read("docs/map.md")).maturity).toBe("canon");
    expect((await read("docs/orphan.md")).maturity).toBe("observation"); // "docs/orphan" names a directory, not a prefix of the file.
    // Front matter wins over config.
    expect((await read("docs/plans/core.md")).maturity).toBe("canon");
  });

  it("refuses symlinks out of the project but takes names that start with dots", async () => {
    const outside = project({ "secret.md": "# Secret\n" });
    const root = project({ ...LIBRARY, "..notes/a.md": "# Dots\n" });
    Fs.symlinkSync(Path.join(outside, "secret.md"), Path.join(root, "docs/leak.md"));
    const kernel = await start(root);
    await expect(
      kernel.commands.execute("context.read", { path: "docs/leak.md" }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
    await expect(
      kernel.commands.execute("context.read", { path: "..notes/a.md" }),
    ).resolves.toMatchObject({ address: "..notes/a.md" });
    const report = (await kernel.commands.execute("context.map", {})) as { unreachable: string[] };
    expect(report.unreachable).not.toContain("docs/leak.md");
  });

  it("reads only Markdown pages", async () => {
    const kernel = await start(project({ ...LIBRARY, ".env": "TOKEN=secret\n" }));
    await expect(kernel.commands.execute("context.read", { path: ".env" })).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
  });

  it("reads a page again after it is rewritten with the same size", async () => {
    const root = project(LIBRARY);
    const kernel = await start(root);
    const read = () =>
      kernel.commands.execute("context.read", { path: "docs/orphan.md" }) as Promise<{
        content: string;
      }>;
    expect((await read()).content).toBe("# Nobody links here\n");
    const file = Path.join(root, "docs/orphan.md");
    const { atime, mtime } = Fs.statSync(file);
    Fs.writeFileSync(file, "# Everybody links here\n".slice(0, "# Nobody links here\n".length));
    // Even with the old mtime put back, the page is read again.
    Fs.utimesSync(file, atime, mtime);
    expect((await read()).content).not.toBe("# Nobody links here\n");
  });

  it("names a missing project when the node keeps no projects", async () => {
    const root = project(LIBRARY);
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("host.paths", { home: root, cwd: root, dataDir: () => root }, "1.1.0"),
        { manifest, definition: context },
      ],
    });
    cleanups.push(() => kernel.stop());
    await expect(
      kernel.commands.execute("context.read", { path: "docs/map.md", projectId: "any" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("walks past a directory named like a page and names a missing project directory", async () => {
    const root = project({
      ...LIBRARY,
      "AGENTS.md": `${LIBRARY["AGENTS.md"]}\n[dir](odd.md#top)\n`,
    });
    Fs.mkdirSync(Path.join(root, "odd.md"));
    const kernel = await start(root);
    const report = (await kernel.commands.execute("context.map", {})) as { reached: unknown[] };
    expect(report.reached.length).toBeGreaterThan(0);

    const gone = project(LIBRARY);
    const stale = await start(gone);
    Fs.rmSync(gone, { recursive: true, force: true });
    await expect(
      stale.commands.execute("context.read", { path: "docs/map.md", projectId: "other" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("reads a decision whatever the case of its id", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(
      kernel.commands.execute("context.read", { path: "docs/plans/core.md#d3" }),
    ).resolves.toMatchObject({ address: "docs/plans/core.md#D3", heading: "D3" });
  });

  it("reads #D11 from the heading input and skips decisions inside code blocks", async () => {
    const page =
      "# P\n\n```md\n- **D9. Example.** Not this one.\n```\n\n- **D9. Real.** This one.\n";
    const kernel = await start(project({ ...LIBRARY, "docs/p.md": page }));
    await expect(
      kernel.commands.execute("context.read", { path: "docs/p.md", heading: "#D9" }),
    ).resolves.toMatchObject({ content: "- **D9. Real.** This one." });
  });

  it("keeps plain mentions of missing pages unresolved and section mentions broken", async () => {
    const extra = "\nSee `other-repo/docs/x.md` and `docs/gone.md#part`.\n";
    const kernel = await start(
      project({ ...LIBRARY, "AGENTS.md": `${LIBRARY["AGENTS.md"]}${extra}` }),
    );
    const report = (await kernel.commands.execute("context.map", {})) as {
      broken: { target: string }[];
      unresolved: { target: string }[];
    };
    expect(report.broken.map((entry) => entry.target)).toContain("docs/gone.md");
    expect(report.unresolved.map((entry) => entry.target)).toContain("other-repo/docs/x.md");
  });

  it("reads a link starting with / from the project root", async () => {
    const page = "# P\n\n[orphan](/docs/orphan.md)\n";
    const kernel = await start(
      project({
        ...LIBRARY,
        "docs/plans/p.md": page,
        "docs/map.md": `${LIBRARY["docs/map.md"]}\n[p](plans/p.md)\n`,
      }),
    );
    const report = (await kernel.commands.execute("context.map", {})) as {
      unreachable: string[];
      broken: unknown[];
    };
    expect(report.unreachable).not.toContain("docs/orphan.md");
    expect(report.broken).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ target: "/docs/orphan.md" })]),
    );
  });

  it("reports a link with a malformed escape as broken instead of failing", async () => {
    const kernel = await start(
      project({ ...LIBRARY, "AGENTS.md": `${LIBRARY["AGENTS.md"]}\n[odd](100%.md)\n` }),
    );
    const report = (await kernel.commands.execute("context.map", {})) as {
      broken: { target: string }[];
    };
    expect(report.broken.map((entry) => entry.target)).toContain("100%.md");
  });

  it("names a project the node does not have", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(
      kernel.commands.execute("context.read", { path: "docs/map.md", projectId: "nope" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("does not install a skill through a symlink out of the project", async () => {
    const outside = project({});
    const root = project(LIBRARY);
    Fs.symlinkSync(outside, Path.join(root, ".claude"));
    const kernel = await start(root);
    await expect(kernel.commands.execute("context.skill.install", {})).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    expect(Fs.readdirSync(outside)).toEqual([]);
  });

  it("installs into no directory when one of them leads out of the project", async () => {
    const outside = project({});
    const root = project(LIBRARY);
    Fs.symlinkSync(outside, Path.join(root, "link-out"));
    const kernel = await start(root, { skill: { dirs: [".claude/skills", "link-out/skills"] } });
    await expect(kernel.commands.execute("context.skill.install", {})).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    expect(Fs.existsSync(Path.join(root, ".claude"))).toBe(false);
    expect(Fs.readdirSync(outside)).toEqual([]);
  });

  it("lets a reader read and preview, but not install", async () => {
    const root = project(LIBRARY);
    const kernel = await start(root);
    const reader = { caller: { id: "reader", permissions: ["context.read"] } };
    await expect(
      kernel.commands.execute("context.read", { path: "docs/map.md#shape" }, reader),
    ).resolves.toMatchObject({ heading: "Shape" });
    await expect(kernel.commands.execute("context.skill", {}, reader)).resolves.toMatchObject({
      name: expect.any(String),
    });
    await expect(
      kernel.commands.execute("context.skill.install", {}, reader),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(Fs.existsSync(Path.join(root, ".claude"))).toBe(false);
    await expect(
      kernel.commands.execute(
        "context.skill.install",
        {},
        {
          caller: { id: "writer", permissions: ["context.write"] },
        },
      ),
    ).resolves.toMatchObject({ installed: [expect.stringMatching(/SKILL\.md$/)] });
  });

  it("refuses agent ids and skill names that would leave their directory", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(
      kernel.commands.execute("lore.list", { agent: "../../docs" }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    const root = project(LIBRARY);
    const bad = await start(root, { skill: { name: "../../src/x" } });
    await expect(bad.commands.execute("context.skill.install", {})).rejects.toThrow();
    expect(Fs.existsSync(Path.join(root, "src"))).toBe(false);
  });

  it("refuses paths outside the project and names missing headings", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(
      kernel.commands.execute("context.read", { path: "../etc/passwd" }),
    ).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    await expect(
      kernel.commands.execute("context.read", { path: "docs/map.md#nope" }),
    ).rejects.toMatchObject({
      code: "HEADING_NOT_FOUND",
      details: { headings: ["map", "shape", "plugins"] },
    });
  });

  it("reads another project of the node by id", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(
      kernel.commands.execute("context.read", { path: "docs/map.md#shape", projectId: "other" }),
    ).resolves.toMatchObject({ heading: "Shape" });
  });
});

describe("context.view", () => {
  it("composes sections of several pages in order", async () => {
    const kernel = await start(project(LIBRARY));
    const view = (await kernel.commands.execute("context.view", {
      title: "Brief",
      sections: ["docs/map.md#shape", "docs/plans/core.md#D3"],
    })) as { markdown: string; sections: { address: string }[] };
    expect(view.markdown).toBe(
      [
        "# Brief",
        "",
        "<!-- docs/map.md#shape -->",
        "## Shape",
        "",
        "- **Kernel** → `plans/core.md#D3`",
        "",
        "<!-- docs/plans/core.md#D3 (canon) -->",
        "- **D3. Small kernel.** Nothing",
        "  product-shaped.",
        "",
      ].join("\n"),
    );
    expect(view.sections.map((section) => section.address)).toEqual([
      "docs/map.md#shape",
      "docs/plans/core.md#D3",
    ]);
  });
});

describe("context.map", () => {
  it("reports unreachable pages, broken routes and unresolved names", async () => {
    const kernel = await start(project(LIBRARY));
    const report = (await kernel.commands.execute("context.map", { content: true })) as Record<
      string,
      unknown
    >;
    expect(report.map).toBe("docs/map.md");
    expect(report.content).toContain("## Shape");
    expect(report.reached).toEqual([
      { path: "AGENTS.md", depth: 0 },
      { path: "docs/map.md", depth: 1, via: "AGENTS.md" },
      { path: "docs/README.md", depth: 1, via: "AGENTS.md" },
      { path: "docs/plans/core.md", depth: 2, via: "docs/map.md" },
      { path: "docs/lore/README.md", depth: 2, via: "docs/README.md" },
      { path: "docs/lore/doghouse.md", depth: 3, via: "docs/lore/README.md" },
    ]);
    expect(report.unreachable).toEqual(["docs/lore/wheel.md", "docs/orphan.md"]);
    expect(report.broken).toEqual([
      { from: "docs/README.md", line: 5, kind: "link", target: "plans/gone.md", reason: "missing" },
      { from: "docs/README.md", line: 6, kind: "link", target: "map.md#nope", reason: "anchor" },
    ]);
    expect(report.unresolved).toEqual([
      { from: "docs/README.md", line: 7, kind: "mention", target: "planned.md" },
    ]);
  });

  it("reaches a page only through a reference link or an HTML link (D1386)", async () => {
    const kernel = await start(
      project({
        "AGENTS.md":
          '# Trailhead\n\nRead the [map][m] and <a href="docs/html.md">html</a>.\n\n[m]: docs/ref.md\n',
        "docs/ref.md": "# Reached by reference\n",
        "docs/html.md": "# Reached by HTML\n",
        "docs/lonely.md": "# Linked by nobody\n",
      }),
    );
    const report = (await kernel.commands.execute("context.map", {})) as {
      unreachable: string[];
      broken: unknown[];
    };
    expect(report.unreachable).toEqual(["docs/lonely.md"]);
    expect(report.broken).toEqual([]);
  });

  it("keeps Jhin's own library whole and its router skill current", async () => {
    const root = Path.resolve(import.meta.dirname, "../../..");
    // The repository's own project layer, as `jhin` reads it.
    const layer = Jsonc.parse(
      Fs.readFileSync(Path.join(root, ".jhin/config.jsonc"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    const kernel = await start(root, layer["jhin.context"]);
    const report = (await kernel.commands.execute("context.map", {})) as {
      unreachable: unknown[];
      broken: unknown[];
    };
    expect({ unreachable: report.unreachable, broken: report.broken }).toEqual({
      unreachable: [],
      broken: [],
    });
    // A changed trailhead, map or lore needs `jhin context.skill.install`.
    const skill = (await kernel.commands.execute("context.skill", {})) as { content: string };
    expect(Fs.readFileSync(Path.join(root, ".claude/skills/jhin-map/SKILL.md"), "utf8")).toBe(
      skill.content,
    );
  });
});

describe("lore", () => {
  it("lists stories with names and lessons from the index or front matter", async () => {
    const kernel = await start(project(LIBRARY));
    await expect(kernel.commands.execute("lore.list", {})).resolves.toEqual([
      {
        name: "moonbase",
        title: "Doghouse → moonbase",
        lesson: "walk back up to the intent",
        address: "docs/lore/doghouse.md",
        scope: "project",
      },
      {
        name: "wheel",
        title: "Reinvent the wheel",
        lesson: "read the map first",
        address: "docs/lore/wheel.md",
        scope: "project",
      },
    ]);
    const withAgent = (await kernel.commands.execute("lore.list", { agent: "builder" })) as {
      name: string;
      scope: string;
    }[];
    expect(withAgent.at(-1)).toMatchObject({ name: "tests", scope: "agent" });
  });

  it("lists the good stories past a directory or a symlink out of the project", async () => {
    const outside = project({ "x.md": "# Outside\n" });
    const root = project(LIBRARY);
    Fs.mkdirSync(Path.join(root, "docs/lore/folder.md"));
    Fs.symlinkSync(Path.join(outside, "x.md"), Path.join(root, "docs/lore/leak.md"));
    const kernel = await start(root);
    const stories = (await kernel.commands.execute("lore.list", {})) as { name: string }[];
    expect(stories.map((story) => story.name)).toEqual(["moonbase", "wheel"]);
  });

  it("names every story a row of the index links", async () => {
    const index =
      "# Lore\n\n- [moonbase](doghouse.md) and [wheel](wheel.md): two at once\n\n| [x](x.md) | its lesson | 2026 |\n";
    const kernel = await start(
      project({ ...LIBRARY, "docs/lore/README.md": index, "docs/lore/x.md": "# X\n" }),
    );
    const stories = (await kernel.commands.execute("lore.list", {})) as {
      name: string;
      lesson?: string;
    }[];
    expect(stories.map(({ name, lesson }) => [name, lesson])).toEqual([
      ["moonbase", "two at once"],
      ["wheel", "two at once"],
      ["x", "its lesson"],
    ]);
  });

  it("lists stories by their own names when the index is a symlink out of the project", async () => {
    const outside = project({ "README.md": "# Elsewhere\n" });
    const root = project(LIBRARY);
    Fs.rmSync(Path.join(root, "docs/lore/README.md"));
    Fs.symlinkSync(Path.join(outside, "README.md"), Path.join(root, "docs/lore/README.md"));
    const kernel = await start(root);
    const stories = (await kernel.commands.execute("lore.list", {})) as { name: string }[];
    expect(stories.map((story) => story.name)).toEqual(["doghouse", "wheel"]);
  });

  it("gets a story by name, title or file", async () => {
    const kernel = await start(project(LIBRARY));
    for (const name of ["moonbase", "Doghouse → moonbase", "doghouse"]) {
      await expect(kernel.commands.execute("lore.get", { name })).resolves.toMatchObject({
        address: "docs/lore/doghouse.md",
        content: "# Doghouse → moonbase\n\nThe dog is still outside.\n",
      });
    }
    await expect(kernel.commands.execute("lore.get", { name: "nope" })).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
  });

  it("briefs an agent after a compaction, through a hook others can change", async () => {
    const kernel = await start(project(LIBRARY));
    const brief = (await kernel.commands.execute("lore.brief", {
      reason: "compaction",
      full: true,
    })) as { markdown: string; stories: string[] };
    expect(brief.stories).toEqual(["moonbase", "wheel"]);
    expect(brief.markdown).toContain("Your context was compacted.");
    expect(brief.markdown).toContain(
      "- **moonbase** (`docs/lore/doghouse.md`): walk back up to the intent",
    );
    expect(brief.markdown).toContain("The dog is still outside.");
  });

  it("lets other plugins change the brief through the lore.brief hook", async () => {
    const kernel = await start(project(LIBRARY), {}, (ctx) => {
      ctx.hooks.after<unknown, { markdown: string; stories: string[] }>(
        LORE_BRIEF_HOOK,
        (output) => ({
          ...output,
          markdown: `${output.markdown}\nTeam culture: ask before you build.\n`,
        }),
      );
    });
    const changed = (await kernel.commands.execute("lore.brief", {})) as { markdown: string };
    expect(changed.markdown).toContain("Team culture: ask before you build.");
  });
});

describe("context.skill", () => {
  it("copies the trailhead's route section as written, code blocks included", async () => {
    const trailhead = "# T\n\n## Find your way\n\n```sh\na\n\n\n\nb\n```\n";
    const kernel = await start(project({ ...LIBRARY, "AGENTS.md": trailhead }));
    const skill = (await kernel.commands.execute("context.skill", {})) as { content: string };
    expect(skill.content).toContain("From `AGENTS.md#find-your-way`:\n\n```sh\na\n\n\n\nb\n```");
  });

  it("generates the skill without writing it, for any reader", async () => {
    const root = project(LIBRARY);
    const kernel = await start(root);
    const skill = (await kernel.commands.execute("context.skill", {})) as { content: string };
    expect(skill.content).toContain("## The map");
    expect(Fs.existsSync(Path.join(root, ".claude"))).toBe(false);
    const info = kernel.commands.list().find((command) => command.name === "context.skill")!;
    expect(info.permissions).toEqual(["context.read"]);
  });

  it("generates the router skill from the trailhead and the map, and installs it on request", async () => {
    const root = project(LIBRARY);
    const kernel = await start(root, {
      skill: { name: "demo-map", description: "Open me first: # it routes [everything]." },
    });
    const skill = (await kernel.commands.execute("context.skill.install", {})) as {
      content: string;
      installed: string[];
    };
    expect(skill.content).toMatch(
      /^---\nname: "demo-map"\ndescription: "Open me first: # it routes \[everything\]\."\n---\n/,
    );
    expect(skill.content).toContain("From `AGENTS.md#find-your-way`:");
    expect(skill.content).toContain("- `docs/map.md#plugins` — Plugins");
    expect(skill.content).toContain(
      "- **moonbase** (`docs/lore/doghouse.md`): walk back up to the intent",
    );
    expect(skill.installed).toEqual([".claude/skills/demo-map/SKILL.md"]);
    expect(Fs.readFileSync(Path.join(root, skill.installed[0]!), "utf8")).toBe(skill.content);
    // Written beside the target and renamed: nothing else is left in the directory.
    expect(Fs.readdirSync(Path.join(root, ".claude/skills/demo-map"))).toEqual(["SKILL.md"]);
  });
});

describe("a removed project's cached library (D1385)", () => {
  async function node() {
    const dir = project({ "docs/a.md": "# A\n" });
    const cwd = project({ "docs/b.md": "# B\n" });
    const storage = memoryStoragePlugin();
    const projects = definePlugin({
      activate(ctx) {
        ctx.commands.register({
          name: "projects.list",
          description: "Projects",
          input: z.object({}),
          output: z.array(z.object({ id: z.string(), path: z.string() })),
          // The listing is stale on purpose: only the event tells that the project is gone.
          handler: () => [{ id: "p1", path: dir }],
        });
      },
    });
    const kernel = await createTestKernel({
      plugins: [
        storage,
        mockCapability("host.paths", { home: cwd, cwd, dataDir: () => cwd }, "1.1.0"),
        { manifest: testManifest("test.projects", { side: "server" }), definition: projects },
        { manifest, definition: context },
      ],
    });
    cleanups.push(() => kernel.stop());
    const read = () =>
      kernel.commands.execute("context.read", { path: "docs/a.md", projectId: "p1" });
    return { dir, storage, read };
  }

  it("is dropped when the project-deleted event arrives, not before", async () => {
    const { dir, storage, read } = await node();
    await read();
    Fs.rmSync(dir, { recursive: true, force: true });
    // Still cached: the library answers from its own state, not by opening the directory again.
    const cached = await read().catch((error: unknown) => error);
    expect((cached as { message?: string }).message ?? "").not.toMatch(/does not exist/);
    await storage.storage.log.append(THREADS_STREAM, [
      { type: ThreadEvents.projectDeleted, payload: { id: "p1" } },
    ]);
    // Dropped: reading asks for the library again, and its directory is gone.
    await expect(read()).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      message: expect.stringMatching(/does not exist/),
    });
  });

  it("keeps the library of another project", async () => {
    const { dir, storage, read } = await node();
    await read();
    Fs.rmSync(dir, { recursive: true, force: true });
    await storage.storage.log.append(THREADS_STREAM, [
      { type: ThreadEvents.projectDeleted, payload: { id: "other" } },
    ]);
    const kept = await read().catch((error: unknown) => error);
    expect((kept as { message?: string }).message ?? "").not.toMatch(/does not exist/);
  });
});
