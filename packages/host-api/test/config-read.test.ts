import { describe, expect, it } from "vite-plus/test";

import type { ConfigCall } from "../src/config-change.ts";
import { readConfigSections, type ConfigRead } from "../src/config-read.ts";

const readOf = (section: string): ConfigRead => ({
  value: { name: section },
  layers: { node: { name: section } },
  comments: [],
});
const notFound = () => Object.assign(new Error("not here"), { code: "COMMAND_NOT_FOUND" });

describe("readConfigSections (config-ui.md D1624)", () => {
  it("reads every section in one host.config.sections call", async () => {
    const calls: [string, unknown][] = [];
    const call: ConfigCall = async (method, params) => {
      calls.push([method, params]);
      return { sections: { a: readOf("a"), b: readOf("b") } };
    };
    const landed: string[] = [];
    const read = await readConfigSections(call, ["a", "b"], (section) => landed.push(section));
    expect(calls).toEqual([["host.config.sections", { sections: ["a", "b"] }]]);
    expect(landed).toEqual(["a", "b"]);
    expect(read.get("b")).toEqual(readOf("b"));
  });

  it("asks an older node for each section, all in flight together, each landing as it answers", async () => {
    const asked: string[] = [];
    const answers = new Map<string, (read: ConfigRead) => void>();
    let allAsked: () => void = () => undefined;
    const everyAsked = new Promise<void>((resolve) => {
      allAsked = resolve;
    });
    const call: ConfigCall = (method, params) => {
      if (method === "host.config.sections") return Promise.reject(notFound());
      const section = params["section"] as string;
      asked.push(section);
      if (asked.length === 3) allAsked();
      if (section === "c") return Promise.reject(new Error("no access"));
      return new Promise((resolve) => answers.set(section, resolve));
    };
    const landed: string[] = [];
    const reading = readConfigSections(call, ["a", "b", "c"], (section) => landed.push(section));
    // Every get is sent before any answers.
    await everyAsked;
    expect(asked).toEqual(["a", "b", "c"]);
    answers.get("b")?.(readOf("b"));
    answers.get("a")?.(readOf("a"));
    const read = await reading;
    expect(landed).toEqual(["c", "b", "a"]);
    expect(read.get("c")).toEqual({ error: "no access", layers: {} });
  });

  it("lands every section with the error when the node refuses the read", async () => {
    const call: ConfigCall = () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }));
    const read = await readConfigSections(call, ["a", "b"]);
    expect([...read.values()]).toEqual([
      { error: "denied", layers: {} },
      { error: "denied", layers: {} },
    ]);
  });
});
