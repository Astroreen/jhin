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
        `,
      },
    ]);
    expect(found).toEqual(
      ids({
        capability: ["x.store", "x.client"],
        command: ["x.defined", "x.make"],
        slot: ["x.panel", "x.actions", "x.used", "x.rendered", "x.section", "x.sidebar"],
        contribution: ["jhin.x.panel", "jhin.x.action"],
        event: ["x.made", "x.gone", "x.emitted"],
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
