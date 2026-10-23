import { describe, expect, it } from "vite-plus/test";

import { askAgents, hasAgents } from "../src/lib/agents-presence.ts";

const answering = (answer: () => Promise<unknown>) => ({
  call: <T>() => answer() as Promise<T>,
});
const failing = (code: string) =>
  answering(() => Promise.reject(Object.assign(new Error(code), { code })));

describe("hasAgents (D747)", () => {
  it("tells a node with a defined agent from one without", async () => {
    expect(await hasAgents(answering(async () => ({ head: 1, agents: [{ id: "lead" }] })))).toBe(
      true,
    );
    expect(await hasAgents(answering(async () => ({ head: 0, agents: [] })))).toBe(false);
  });

  it("reads a missing agents plugin as no agents, and any other failure as not known", async () => {
    expect(await hasAgents(failing("COMMAND_NOT_FOUND"))).toBe(false);
    expect(await hasAgents(failing("PERMISSION_DENIED"))).toBe(false);
    expect(await hasAgents(failing("TIMEOUT"))).toBeUndefined();
  });
});

describe("askAgents (D1398)", () => {
  it("tells a missing plugin and a denied token apart, as final or not, with the head", async () => {
    expect(await askAgents(answering(async () => ({ head: 3, agents: [{ id: "lead" }] })))).toEqual(
      { answer: "some", head: 3 },
    );
    expect(await askAgents(answering(async () => ({ head: 0, agents: [] })))).toEqual({
      answer: "none",
      head: 0,
    });
    expect(await askAgents(failing("COMMAND_NOT_FOUND"))).toEqual({ answer: "missing" });
    expect(await askAgents(failing("METHOD_NOT_FOUND"))).toEqual({ answer: "missing" });
    expect(await askAgents(failing("PERMISSION_DENIED"))).toEqual({ answer: "denied" });
    expect(await askAgents(failing("TIMEOUT"))).toEqual({ answer: "unknown" });
  });
});
