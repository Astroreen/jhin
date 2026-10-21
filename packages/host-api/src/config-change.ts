// How a change to a config file travels to a node (docs/plans/config-ui.md,
// D84, D475–D477): as edits of leaf paths for a node that has
// `host.config.edit`, as whole top-level keys for one that does not.

/** One edit of a config file: the value at `path` inside the section; without `value` the key goes. */
export interface ConfigEdit {
  readonly path: readonly string[];
  readonly value?: unknown;
}

/** A change to one section of one layer's file, in both forms a node may take. */
export interface ConfigChange {
  readonly layer: "node" | "project";
  readonly section: string;
  /** Every top-level key whose value changed, whole: what `host.config.patch` takes. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Top-level keys removed (D84). */
  readonly unset?: readonly string[];
  /** The same change as edits of the paths that changed, so comments elsewhere stay (D476). */
  readonly edits?: readonly ConfigEdit[];
  /** When the change was made (ms); later changes win (D50). */
  readonly at?: number;
}

/** What a node answers to a config change. */
export interface ConfigChangeResult {
  readonly applied: boolean;
  readonly at: number;
  readonly conflict?: { readonly localAt: number };
}

/** A plain object: what a JSON object parses to, not an instance of a class. */
const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => same(item, b[index]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}

/**
 * The edits that turn `before` into `after` (D476): objects on both sides are
 * compared key by key, down to the deepest path that changed; anything else
 * (a value, an array, an object replacing a value) is set whole at its path.
 * Removed keys come first, so a key renamed in place keeps no stale twin.
 */
export function configEdits(before: unknown, after: unknown, path: string[] = []): ConfigEdit[] {
  if (same(before, after)) return [];
  if (!isObject(before) || !isObject(after) || path.length > 32) {
    return [after === undefined ? { path } : { path, value: after }];
  }
  const removed = Object.keys(before)
    .filter((key) => !Object.hasOwn(after, key))
    .map((key) => ({ path: [...path, key] }));
  const changed = Object.keys(after).flatMap((key) =>
    configEdits(before[key], after[key], [...path, key]),
  );
  return [...removed, ...changed];
}

/**
 * The change that turns the file's part of a section, `before`, into
 * `after`, in both forms: top-level keys for older nodes, edits for newer ones.
 */
export function configChange(
  layer: ConfigChange["layer"],
  section: string,
  before: unknown,
  after: Readonly<Record<string, unknown>>,
): ConfigChange {
  const previous = isObject(before) ? before : {};
  const values: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(after)) {
    if (!same(item, previous[key])) values[key] = item;
  }
  const unset = Object.keys(previous).filter((key) => !Object.hasOwn(after, key));
  return {
    layer,
    section,
    values,
    ...(unset.length === 0 ? {} : { unset }),
    edits: configEdits(previous, after),
  };
}

/** Calls a command of the node a change goes to (directly, or through `mesh.call`). */
export type ConfigCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const notFound = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "COMMAND_NOT_FOUND" || code === "METHOD_NOT_FOUND";
};

/** Thrown when a node is too old for a change: it would answer `applied` and drop part of it. */
export class ConfigChangeUnsupported extends Error {
  readonly code = "CONFIG_CHANGE_UNSUPPORTED";
}

/**
 * Sends `change` to a node (D475): `host.config.edit` where the node has it;
 * else `host.config.patch` with the whole top-level keys, and `unset` only
 * where the node's `host.config.patch` declares it. A removal the node cannot
 * do is refused before anything is written, never reported as applied.
 */
export async function sendConfigChange(
  call: ConfigCall,
  change: ConfigChange,
): Promise<ConfigChangeResult> {
  const at = change.at === undefined ? {} : { at: change.at };
  const target = { layer: change.layer, section: change.section };
  if (change.edits !== undefined) {
    try {
      return (await call("host.config.edit", {
        ...target,
        edits: change.edits,
        values: change.values,
        ...at,
      })) as ConfigChangeResult;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  const unset = change.unset ?? [];
  if (unset.length > 0 && !(await takesUnset(call))) {
    throw new ConfigChangeUnsupported(
      "This node is too old to remove keys from its config file; update it, or edit the file by hand",
    );
  }
  return (await call("host.config.patch", {
    ...target,
    values: change.values,
    ...(unset.length === 0 ? {} : { unset }),
    ...at,
  })) as ConfigChangeResult;
}

/** Whether the node's `host.config.patch` declares `unset` (D84) in its input schema. */
async function takesUnset(call: ConfigCall): Promise<boolean> {
  let commands: unknown;
  try {
    commands = await call("host.commands.list", {});
  } catch (error) {
    // Unable to tell is unable to remove safely.
    throw new ConfigChangeUnsupported(
      `Cannot tell whether this node can remove keys from its config file: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(commands)) return false;
  const patch = commands.find(
    (command: unknown) => isObject(command) && command["name"] === "host.config.patch",
  ) as Record<string, unknown> | undefined;
  const input = patch?.["inputSchema"];
  const properties = isObject(input) ? input["properties"] : undefined;
  return isObject(properties) && Object.hasOwn(properties, "unset");
}
