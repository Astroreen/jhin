import { describe, expect, it } from "vite-plus/test";

import {
  configChange,
  configEdits,
  sendConfigChange,
  type ConfigCall,
} from "../src/config-change.ts";

class Unparsed {
  readonly text = "1e";
}

describe("configEdits (D476)", () => {
  it("goes down to the deepest path that changed", () => {
    expect(
      configEdits(
        { a: 1, nested: { keep: true, b: 2, gone: 1 }, list: [1, 2], kind: "x" },
        { a: 1, nested: { keep: true, b: 3 }, list: [1, 3], kind: { now: "object" }, added: "y" },
      ),
    ).toEqual([
      { path: ["nested", "gone"] },
      { path: ["nested", "b"], value: 3 },
      // Arrays are written whole: their items have no identity but their place.
      { path: ["list"], value: [1, 3] },
      { path: ["kind"], value: { now: "object" } },
      { path: ["added"], value: "y" },
    ]);
    expect(configEdits({ a: [1] }, { a: [1] })).toEqual([]);
  });

  it("writes a class instance whole, never its fields", () => {
    const typed = new Unparsed();
    expect(configEdits({ n: 1 }, { n: typed })).toEqual([{ path: ["n"], value: typed }]);
  });

  it("gives both forms of a change", () => {
    expect(
      configChange("node", "jhin.example", { a: 1, b: { c: 1, d: 2 } }, { b: { c: 1, d: 3 } }),
    ).toEqual({
      layer: "node",
      section: "jhin.example",
      values: { b: { c: 1, d: 3 } },
      unset: ["a"],
      edits: [{ path: ["a"] }, { path: ["b", "d"], value: 3 }],
    });
  });
});

/** A node that answers like one of a given age. */
function node(age: "edit" | "unset" | "old") {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const call: ConfigCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "host.config.edit" && age !== "edit") {
      throw Object.assign(new Error("Command host.config.edit is not registered"), {
        code: "COMMAND_NOT_FOUND",
      });
    }
    if (method === "host.commands.list") {
      return [
        {
          name: "host.config.patch",
          inputSchema: {
            type: "object",
            properties: {
              layer: {},
              section: {},
              values: {},
              ...(age === "unset" ? { unset: {} } : {}),
            },
          },
        },
      ];
    }
    return { applied: true, at: 5 };
  };
  return { call, calls };
}

describe("sendConfigChange (D475)", () => {
  const change = configChange("node", "jhin.example", { a: 1, b: 2 }, { b: 3 });

  it("sends edits to a node that takes them", async () => {
    const { call, calls } = node("edit");
    expect(await sendConfigChange(call, { ...change, at: 5 })).toEqual({ applied: true, at: 5 });
    expect(calls).toEqual([
      {
        method: "host.config.edit",
        params: {
          layer: "node",
          section: "jhin.example",
          edits: [{ path: ["a"] }, { path: ["b"], value: 3 }],
          values: { b: 3 },
          at: 5,
        },
      },
    ]);
  });

  it("sends whole keys and unset to a node from before host.config.edit", async () => {
    const { call, calls } = node("unset");
    await sendConfigChange(call, change);
    expect(calls.map((entry) => entry.method)).toEqual([
      "host.config.edit",
      "host.commands.list",
      "host.config.patch",
    ]);
    expect(calls.at(-1)?.params).toEqual({
      layer: "node",
      section: "jhin.example",
      values: { b: 3 },
      unset: ["a"],
    });
  });

  it("refuses a removal a node from before unset would drop, writing nothing", async () => {
    const { call, calls } = node("old");
    await expect(sendConfigChange(call, change)).rejects.toMatchObject({
      code: "CONFIG_CHANGE_UNSUPPORTED",
    });
    expect(calls.map((entry) => entry.method)).not.toContain("host.config.patch");
    // Without a removal the old node can take it.
    const set = configChange("node", "jhin.example", { b: 2 }, { b: 3 });
    expect(await sendConfigChange(call, set)).toMatchObject({ applied: true });
  });

  it("refuses a removal when the node cannot say what it takes", async () => {
    const denied: ConfigCall = async (method) => {
      throw Object.assign(new Error(`no ${method}`), {
        code: method === "host.config.edit" ? "COMMAND_NOT_FOUND" : "PERMISSION_DENIED",
      });
    };
    await expect(sendConfigChange(denied, change)).rejects.toMatchObject({
      code: "CONFIG_CHANGE_UNSUPPORTED",
    });
  });

  it("refuses a removal when the node's command list says nothing of its schemas", async () => {
    const bare: ConfigCall = async (method) => {
      if (method === "host.config.edit") {
        throw Object.assign(new Error("unknown"), { code: "COMMAND_NOT_FOUND" });
      }
      if (method === "host.commands.list") return [{ name: "host.config.patch" }];
      return { applied: true, at: 1 };
    };
    // Unable to tell is unable to remove safely.
    await expect(sendConfigChange(bare, change)).rejects.toMatchObject({
      code: "CONFIG_CHANGE_UNSUPPORTED",
    });
  });

  it("passes other failures on", async () => {
    const failing: ConfigCall = async () => {
      throw Object.assign(new Error("gone"), { code: "NODE_UNREACHABLE" });
    };
    await expect(sendConfigChange(failing, change)).rejects.toMatchObject({
      code: "NODE_UNREACHABLE",
    });
  });
});
