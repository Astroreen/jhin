import { describe, expect, it } from "vite-plus/test";

import {
  parseWorkflow,
  runWorkflow,
  WorkflowError,
  type AgentOptions,
  type WorkflowHost,
} from "../src/workflow.ts";

const limits = { concurrency: 4, maxAgents: 1000, maxItems: 4096 };

function host(answer: (prompt: string, options: AgentOptions) => unknown = (p) => `done: ${p}`) {
  const calls: { prompt: string; options: AgentOptions }[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const value: WorkflowHost = {
    agent: async (prompt, options) => {
      calls.push({ prompt, options });
      return answer(prompt, options);
    },
    log: (message) => logs.push(message),
    phase: (title) => phases.push(title),
  };
  return { host: value, calls, logs, phases };
}

const run = (
  script: string,
  h: WorkflowHost,
  args?: unknown,
  signal = new AbortController().signal,
) => runWorkflow(parseWorkflow(script).body, args, h, limits, signal);

describe("parseWorkflow", () => {
  it("reads the pure-literal meta header", () => {
    const { meta, body } = parseWorkflow(`// a comment
export const meta = {
  name: 'review', // trailing comment with a } brace
  description: "Review \\"changes\\"",
  phases: [{ title: 'Find' }, { title: 'Verify', detail: 'x' }],
}
phase('Find')`);
    expect(meta).toEqual({
      name: "review",
      description: 'Review "changes"',
      phases: [{ title: "Find" }, { title: "Verify", detail: "x" }],
    });
    expect(body.trim()).toBe("phase('Find')");
  });

  it.each([
    ["no header", "agent('x')"],
    ["a variable", "export const meta = { name: NAME, description: 'd' }"],
    ["a call", "export const meta = { name: f(), description: 'd' }"],
    ["an interpolation", "export const meta = { name: `a${1}`, description: 'd' }"],
    ["no description", "export const meta = { name: 'a' }"],
    ["bad phases", "export const meta = { name: 'a', description: 'd', phases: ['x'] }"],
  ])("refuses %s", (_case, script) => {
    expect(() => parseWorkflow(script)).toThrow(WorkflowError);
  });
});

describe("runWorkflow", () => {
  it("runs agents, phases and logs and returns the body's value", async () => {
    const h = host();
    const result = await run(
      `export const meta = { name: 'n', description: 'd' }
phase('Scan')
log('starting ' + args.target)
const a = await agent('look at ' + args.target, { label: 'scan', schema: { type: 'object', properties: { x: { type: 'string' } } } })
return { a }`,
      h.host,
      { target: "src" },
    );
    expect(result).toEqual({ a: "done: look at src" });
    expect(h.phases).toEqual(["Scan"]);
    expect(h.logs).toEqual(["starting src"]);
    expect(h.calls[0]?.options).toMatchObject({ label: "scan", index: 0 });
  });

  it("parallel() turns a failed thunk into null and pipeline() runs stages per item", async () => {
    const h = host((prompt) => {
      if (prompt === "boom") throw new Error("no");
      return prompt.toUpperCase();
    });
    const result = await run(
      `export const meta = { name: 'n', description: 'd' }
const p = await parallel([() => agent('a'), () => agent('boom'), () => agent('c')])
const q = await pipeline(['x', 'y'], (item) => agent(item), (prev, item, index) => prev + item + index)
return { p, q }`,
      h.host,
    );
    expect(result).toEqual({ p: ["A", null, "C"], q: ["Xx0", "Yy1"] });
  });

  it("runs at most `concurrency` agents at once", async () => {
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    let arrived: (() => void) | undefined;
    const h = host();
    const counting: WorkflowHost = {
      ...h.host,
      agent: async () => {
        running++;
        peak = Math.max(peak, running);
        const gate = new Promise<void>((resolve) => gates.push(resolve));
        arrived?.();
        await gate;
        running--;
        return "ok";
      },
    };
    const done = runWorkflow(
      "return parallel([1,2,3,4,5].map(i => () => agent('a' + i)))",
      undefined,
      counting,
      { ...limits, concurrency: 2 },
      new AbortController().signal,
    );
    // Release agents one by one as they arrive: the cap keeps two in flight.
    for (let released = 0; released < 5; released++) {
      if (gates.length === 0) await new Promise<void>((resolve) => (arrived = resolve));
      gates.shift()!();
    }
    expect(await done).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(peak).toBe(2);
  });

  it("refuses clocks and randomness, bad schemas and too many items", async () => {
    const h = host();
    for (const body of ["Date.now()", "new Date()", "Math.random()"]) {
      await expect(
        runWorkflow(body, undefined, h.host, limits, new AbortController().signal),
      ).rejects.toThrow(/not available in a workflow script/);
    }
    await expect(
      runWorkflow(
        "new Date(0).toISOString()",
        undefined,
        h.host,
        limits,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
    await expect(
      runWorkflow(
        "return agent('x', { schema: { type: 'object', properties: {}, required: ['y'] } })",
        undefined,
        h.host,
        limits,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/requires properties it does not define: y/);
    await expect(
      runWorkflow(
        "return parallel([1, 2, 3].map(() => () => 1))",
        undefined,
        h.host,
        { ...limits, maxItems: 2 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/at most 2 items/);
    await expect(
      runWorkflow(
        "return agent('a').then(() => agent('b'))",
        undefined,
        h.host,
        { ...limits, maxAgents: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/at most 1 agents/);
  });

  it("stops: hooks called after the signal throw", async () => {
    const controller = new AbortController();
    const h = host();
    const stopping: WorkflowHost = {
      ...h.host,
      agent: async () => {
        controller.abort();
        return "first";
      },
    };
    await expect(
      runWorkflow(
        "await agent('a'); return agent('b')",
        undefined,
        stopping,
        limits,
        controller.signal,
      ),
    ).rejects.toThrow(/stopped/);
  });

  it("reports a syntax error as an invalid workflow", async () => {
    await expect(
      runWorkflow("const = 1", undefined, host().host, limits, new AbortController().signal),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
  });
});
