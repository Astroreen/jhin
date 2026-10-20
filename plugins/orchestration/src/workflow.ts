// The script contract of a workflow (`export const meta`, `agent`, `parallel`,
// `pipeline`, `phase`, `log`, `args`) follows the Workflow tool T3 Code's Claude
// sessions use (D53; see docs/plans/orchestration.md, D372–D375).
import * as Vm from "node:vm";

/** The pure-literal header every script starts with. */
export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly phases?: readonly { readonly title: string; readonly detail?: string }[];
}

/** What a script passes as `agent(prompt, options)`. */
export interface AgentOptions {
  readonly label?: string;
  readonly phase?: string;
  /** A JSON Schema with `type: "object"` at its root: the agent answers with such an object. */
  readonly schema?: Record<string, unknown>;
  /** A model of the agent runtime; the inherited one when absent. */
  readonly model?: string;
  /** Jhin's own addition: the agent runtime (`agents.list`); the inherited one when absent. */
  readonly agentId?: string;
  readonly effort?: string;
  readonly isolation?: "worktree";
  readonly agentType?: string;
}

/** What runs a script's agents: one delegated task each (D373). */
export interface WorkflowHost {
  /**
   * Runs one agent to its end and returns its answer: its last message, or the
   * object it answered with when `schema` is set; `null` when it failed or was
   * cancelled. Throws only for a call the script got wrong.
   */
  agent(prompt: string, options: AgentOptions & { readonly index: number }): Promise<unknown>;
  log(message: string): void;
  phase(title: string): void;
}

export interface WorkflowLimits {
  /** Agents running at once; more wait for a free slot. */
  readonly concurrency: number;
  /** Agents over the whole run. */
  readonly maxAgents: number;
  /** Items of one `parallel()` or `pipeline()` call. */
  readonly maxItems: number;
  /**
   * How long the body may run before its first `await` (D374). Node's `vm`
   * bounds only that synchronous start: a loop after an `await` still blocks.
   */
  readonly syncTimeoutMs: number;
}

export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

const META_START = /^export\s+const\s+meta\s*=\s*/;

/** Skips whitespace and comments from `index`. */
function skipTrivia(source: string, index: number): number {
  let at = index;
  for (;;) {
    while (at < source.length && /\s/.test(source[at]!)) at++;
    if (source.startsWith("//", at)) {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end + 1;
    } else if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      if (end === -1) return source.length;
      at = end + 2;
    } else {
      return at;
    }
  }
}

/** The index just past the object literal that opens at `start` (a `{`). */
function literalEnd(source: string, start: number): number {
  let depth = 0;
  let at = start;
  while (at < source.length) {
    const char = source[at]!;
    if (char === '"' || char === "'" || char === "`") {
      at++;
      while (at < source.length && source[at] !== char) at += source[at] === "\\" ? 2 : 1;
    } else if (source.startsWith("//", at)) {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      at = end === -1 ? source.length : end + 1;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return at + 1;
    }
    at++;
  }
  throw new WorkflowError("WORKFLOW_INVALID", "The meta object is not closed");
}

/**
 * Splits a script into its `meta` header and its body. The header must be a
 * pure literal: it is evaluated in an empty context, so a variable, a call or
 * an interpolation in it fails.
 */
export function parseWorkflow(script: string): { meta: WorkflowMeta; body: string } {
  const start = skipTrivia(script, 0);
  const header = META_START.exec(script.slice(start));
  if (header === null) {
    throw new WorkflowError(
      "WORKFLOW_INVALID",
      "A workflow script must begin with `export const meta = {...}`",
    );
  }
  const open = start + header[0].length;
  if (script[open] !== "{") {
    throw new WorkflowError("WORKFLOW_INVALID", "`meta` must be an object literal");
  }
  const close = literalEnd(script, open);
  const literal = script.slice(open, close);
  if (/`[^`]*\$\{/.test(literal)) {
    throw new WorkflowError("WORKFLOW_INVALID", "`meta` must be a pure literal: no interpolation");
  }
  let value: unknown;
  try {
    value = Vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  } catch (error) {
    throw new WorkflowError(
      "WORKFLOW_INVALID",
      `\`meta\` must be a pure literal (no variables, calls or spreads): ${String(error)}`,
    );
  }
  const meta = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (typeof meta.name !== "string" || meta.name === "") {
    throw new WorkflowError("WORKFLOW_INVALID", "`meta.name` is required");
  }
  if (typeof meta.description !== "string" || meta.description === "") {
    throw new WorkflowError("WORKFLOW_INVALID", "`meta.description` is required");
  }
  if (
    meta.phases !== undefined &&
    (!Array.isArray(meta.phases) ||
      meta.phases.some(
        (phase: unknown) =>
          typeof phase !== "object" ||
          phase === null ||
          typeof (phase as { title?: unknown }).title !== "string",
      ))
  ) {
    throw new WorkflowError(
      "WORKFLOW_INVALID",
      "`meta.phases` must be a list of `{ title, detail? }`",
    );
  }
  let rest = skipTrivia(script, close);
  if (script[rest] === ";") rest++;
  return { meta: meta as unknown as WorkflowMeta, body: script.slice(rest) };
}

/** Counts free slots; `run` waits for one. */
function semaphore(size: number) {
  let free = size;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (free === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    else free--;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) free++;
      else next();
    }
  };
}

// Run in the script's context before its body: what would make a run depend
// on when it ran is refused, as in the Workflow tool (it keeps runs resumable).
const PRELUDE = `
(() => {
  const refuse = (name) => () => { throw new Error(name + " is not available in a workflow script: pass times in through args"); };
  const RealDate = Date;
  Math.random = refuse("Math.random()");
  const SafeDate = new Proxy(RealDate, {
    construct(target, list, newTarget) {
      if (list.length === 0) refuse("new Date()")();
      return Reflect.construct(target, list, newTarget);
    },
    apply() { return refuse("Date()")(); },
  });
  SafeDate.now = refuse("Date.now()");
  globalThis.Date = SafeDate;
})();
`;

/**
 * Runs a workflow script's body with its hooks and returns what the body
 * returns. The body is plain JavaScript in an async function of its own
 * context. That context is no security boundary (the hooks are functions of
 * the node), so running a script takes the same rights as running agents
 * (D375). `signal` stops the run: hooks called afterwards throw.
 */
export async function runWorkflow(
  body: string,
  args: unknown,
  host: WorkflowHost,
  limits: WorkflowLimits,
  signal: AbortSignal,
): Promise<unknown> {
  const slot = semaphore(Math.max(1, limits.concurrency));
  let started = 0;
  const stopped = () => {
    if (signal.aborted) throw new WorkflowError("WORKFLOW_STOPPED", "The workflow was stopped");
  };
  const checkItems = (items: unknown, what: string): readonly unknown[] => {
    if (!Array.isArray(items)) throw new WorkflowError("WORKFLOW_SCRIPT", `${what} takes an array`);
    if (items.length > limits.maxItems) {
      throw new WorkflowError(
        "WORKFLOW_SCRIPT",
        `${what} takes at most ${limits.maxItems} items, not ${items.length}`,
      );
    }
    return items;
  };

  const agent = async (prompt: unknown, options: unknown = {}): Promise<unknown> => {
    stopped();
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new WorkflowError("WORKFLOW_SCRIPT", "agent() takes a prompt string");
    }
    const chosen = (options ?? {}) as AgentOptions;
    if (chosen.schema !== undefined) {
      const schema = chosen.schema as { type?: unknown; properties?: unknown; required?: unknown };
      if (schema.type !== "object" || typeof schema.properties !== "object") {
        throw new WorkflowError(
          "WORKFLOW_SCRIPT",
          "agent() schema needs {type: 'object', properties: {...}} at its root",
        );
      }
      const properties = Object.keys(schema.properties ?? {});
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
      const unknown = required.filter(
        (name) => typeof name !== "string" || !properties.includes(name),
      );
      if (unknown.length > 0) {
        throw new WorkflowError(
          "WORKFLOW_SCRIPT",
          `agent() schema requires properties it does not define: ${unknown.join(", ")}`,
        );
      }
    }
    if (started >= limits.maxAgents) {
      throw new WorkflowError(
        "WORKFLOW_SCRIPT",
        `A workflow runs at most ${limits.maxAgents} agents`,
      );
    }
    const index = started++;
    // Copied: the script's objects belong to its own context.
    const copied = JSON.parse(JSON.stringify(chosen)) as AgentOptions;
    return slot(async () => {
      stopped();
      return host.agent(prompt, { ...copied, index });
    });
  };

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    stopped();
    const list = checkItems(thunks, "parallel()");
    return Promise.all(
      list.map(async (thunk) => {
        try {
          if (typeof thunk !== "function") return null;
          return await (thunk as () => unknown)();
        } catch (error) {
          if (signal.aborted) throw error;
          return null;
        }
      }),
    );
  };

  const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    stopped();
    const list = checkItems(items, "pipeline()");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new WorkflowError("WORKFLOW_SCRIPT", "pipeline() stages must be functions");
    }
    return Promise.all(
      list.map(async (item, index) => {
        let value: unknown = item;
        try {
          for (const stage of stages) {
            value = await (stage as (previous: unknown, item: unknown, index: number) => unknown)(
              value,
              item,
              index,
            );
          }
          return value;
        } catch (error) {
          if (signal.aborted) throw error;
          return null;
        }
      }),
    );
  };

  const sandbox = Vm.createContext({
    agent,
    parallel,
    pipeline,
    phase: (title: unknown) => {
      stopped();
      host.phase(String(title));
    },
    log: (message: unknown) => host.log(String(message)),
    args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)),
    console: { log: (...parts: unknown[]) => host.log(parts.map(String).join(" ")) },
  });
  Vm.runInContext(PRELUDE, sandbox);
  let script: Vm.Script;
  try {
    script = new Vm.Script(`(async () => {\n${body}\n})()`, { filename: "workflow.js" });
  } catch (error) {
    throw new WorkflowError("WORKFLOW_INVALID", `The script does not parse: ${String(error)}`);
  }
  let running: Promise<unknown>;
  try {
    running = script.runInContext(sandbox, { timeout: limits.syncTimeoutMs }) as Promise<unknown>;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new WorkflowError(
        "WORKFLOW_SCRIPT",
        `The script ran for more than ${limits.syncTimeoutMs} ms without waiting on anything`,
      );
    }
    throw error;
  }
  const result = await running;
  stopped();
  return result === undefined ? null : JSON.parse(JSON.stringify(result));
}
