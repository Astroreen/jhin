import { describe, expect, it } from "vite-plus/test";

import {
  emptyIds,
  extractIds,
  forbiddenRemovals,
  isSource,
  parseDeprecations,
  type Deprecation,
  type Ids,
} from "./public-ids.ts";

const ids = (entries: Partial<Record<keyof Ids, string[]>>): Ids => {
  const all = emptyIds();
  for (const [kind, list] of Object.entries(entries)) {
    for (const id of list) all[kind as keyof Ids].add(id);
  }
  return all;
};

describe("extractIds", () => {
  it("reads each kind of public id where it is declared", () => {
    const found = extractIds([
      {
        path: "plugins/x/package.json",
        text: JSON.stringify({ jhin: { id: "jhin.x", provides: { "x.store": "1.0.0" } } }),
      },
      {
        path: "plugins/x/src/index.ts",
        text: `
          export const X_CAPABILITY = "x.client";
          export const XEvents = {
            /** \`{ id, by? }\`: an x was made. */
            made: "x.made",
            gone: "x.gone",
          } as const;
          context.commands.register({
            name: "x.make",
          });
          const definition: CommandDefinition = { name: "x.defined", description: "…" };
          context.events.emit("x.emitted", {});
          export const X_PANEL_SLOT = "x.panel";
          slots.contribute(X_PANEL_SLOT, { id: "jhin.x.panel", component });
          slots.contribute<Props>("x.actions", {
            id: "jhin.x.action",
          });
          const filled = useSlot("x.used");
          const rendered = <Slot name="x.rendered" />;
          const section = { slot: "x.section", sidebarSlot: "x.sidebar" };
          context.commands.register({ name: \`x.\${built}\` });
          context.commands.register({ name: \`x.plain\` });
        `,
      },
    ]);
    expect(found).toEqual(
      ids({
        capability: ["x.store", "x.client"],
        command: ["x.defined", "x.make", "x.*", "x.plain"],
        slot: ["x.panel", "x.actions", "x.used", "x.rendered", "x.section", "x.sidebar"],
        contribution: ["jhin.x.panel", "jhin.x.action"],
        event: ["x.made", "x.gone", "x.emitted"],
      }),
    );
  });

  it("reads a template literal as a pattern, each ${…} as *", () => {
    const found = extractIds([
      {
        path: "apps/web/src/x.tsx",
        text: `
          slots.contribute("node.actions", { id: \`jhin.x.node.\${id}\`, order });
          slots.contribute("node.actions", { id: \`jhin.x.\${a}.\${b}.tail\` });
          const definition: CommandDefinition = { name: \`x.\${n}\`, description: "…" };
          context.events.emit(\`x.\${what}.done\`, {});
          const label = \`not an id \${here}\`;
        `,
      },
    ]);
    expect(found).toEqual(
      ids({
        command: ["x.*"],
        slot: ["node.actions"],
        contribution: ["jhin.x.node.*", "jhin.x.*.*.tail"],
        event: ["x.*.done"],
      }),
    );
  });

  it("leaves tests, fixtures and other JSON out", () => {
    expect(isSource("plugins/x/src/index.ts")).toBe(true);
    expect(isSource("apps/web/src/app.tsx")).toBe(true);
    expect(isSource("plugins/x/package.json")).toBe(true);
    expect(isSource("plugins/x/test/x.test.ts")).toBe(false);
    expect(isSource("plugins/x/src/x.test.ts")).toBe(false);
    expect(isSource("plugins/teams/test/fixtures/workshop/package.json")).toBe(false);
    expect(isSource("plugins/x/tsconfig.json")).toBe(false);
    expect(isSource("e2e/tests/x.spec.ts")).toBe(false);
  });
});

describe("forbiddenRemovals", () => {
  const base = ids({ command: ["x.make", "x.old"], slot: ["x.panel"] });
  const deprecation: Deprecation = {
    kind: "command",
    id: "x.old",
    replacedBy: "x.make",
    since: "2026-10-01",
    removeAfter: "2026-11-01",
  };

  it("passes what is kept or added, and a rename that keeps the old id", () => {
    const head = ids({ command: ["x.make", "x.old", "x.new"], slot: ["x.panel"] });
    expect(forbiddenRemovals(base, head, [], [], "2026-10-23")).toEqual([]);
  });

  it("refuses a removal main did not deprecate, or deprecated too recently", () => {
    const head = ids({ command: ["x.make"] });
    expect(forbiddenRemovals(base, head, [], [deprecation], "2026-10-23")).toEqual([
      { kind: "command", id: "x.old", reason: "deprecated-here" },
      { kind: "slot", id: "x.panel", reason: "not-deprecated" },
    ]);
    expect(forbiddenRemovals(base, head, [deprecation], [], "2026-11-01")).toContainEqual({
      kind: "command",
      id: "x.old",
      reason: "too-early",
      removeAfter: "2026-11-01",
    });
    expect(
      forbiddenRemovals(
        base,
        ids({ command: ["x.make"], slot: ["x.panel"] }),
        [deprecation],
        [],
        "2026-11-02",
      ),
    ).toEqual([]);
  });
});

describe("forbiddenRemovals for patterns (D1294)", () => {
  const base = ids({ command: ["x.jump.*"] });
  const deprecation: Deprecation = {
    kind: "command",
    id: "x.jump.*",
    since: "2026-10-01",
    removeAfter: "2026-11-01",
  };

  it("refuses a removed pattern, as it does an id", () => {
    expect(forbiddenRemovals(base, ids({}), [], [], "2026-10-23")).toEqual([
      { kind: "command", id: "x.jump.*", reason: "not-deprecated" },
    ]);
    expect(forbiddenRemovals(base, ids({ command: ["x.jump.*"] }), [], [], "2026-10-23")).toEqual(
      [],
    );
  });

  it("passes a pattern deprecated on main once its removeAfter has passed", () => {
    expect(forbiddenRemovals(base, ids({}), [deprecation], [], "2026-11-02")).toEqual([]);
    expect(forbiddenRemovals(base, ids({}), [deprecation], [], "2026-10-23")).toEqual([
      { kind: "command", id: "x.jump.*", reason: "too-early", removeAfter: "2026-11-01" },
    ]);
  });
});

describe("parseDeprecations", () => {
  it("reads the list and names a malformed entry", () => {
    expect(parseDeprecations(undefined)).toEqual([]);
    expect(parseDeprecations('{ "deprecations": [] }')).toEqual([]);
    expect(() =>
      parseDeprecations(
        '{ "deprecations": [{ "kind": "slot", "id": "x", "since": "2026-10-01" }] }',
      ),
    ).toThrow("deprecations[0]: removeAfter must be a date");
    expect(() => parseDeprecations('{ "deprecations": [{ "kind": "hook", "id": "x" }] }')).toThrow(
      "kind must be one of",
    );
  });
});
