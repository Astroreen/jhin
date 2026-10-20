import {
  DOTTED_ID,
  missingPermissions,
  toDisposable,
  z,
  type CommandDefinition,
  type CommandInfo,
  type Disposable,
  type Invocation,
} from "@jhin/sdk";

import { KernelError } from "./errors.ts";

interface Entry {
  readonly plugin: string;
  readonly definition: CommandDefinition<z.ZodType, z.ZodType>;
  readonly info: CommandInfo;
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" });
}

function issues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/** Holds every command. Validation and permission checks happen here, once, for every surface. */
export class CommandRegistry {
  readonly #entries = new Map<string, Entry>();

  register(plugin: string, definition: CommandDefinition<z.ZodType, z.ZodType>): Disposable {
    const { name } = definition;
    if (!DOTTED_ID.test(name) || !name.includes(".")) {
      throw new KernelError(
        "COMMAND_NAME_INVALID",
        `Command name ${name} must be a namespaced lowercase dotted id`,
        {
          command: name,
        },
      );
    }
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      throw new KernelError(
        "COMMAND_DUPLICATE",
        `Command ${name} is already registered by ${existing.plugin}`,
        {
          command: name,
          plugin: existing.plugin,
        },
      );
    }
    const info: CommandInfo = {
      name,
      description: definition.description,
      ...(definition.title === undefined ? {} : { title: definition.title }),
      plugin,
      permissions: [...(definition.permissions ?? [])],
      inputSchema: jsonSchema(definition.input, "input"),
      outputSchema: jsonSchema(definition.output, "output"),
    };
    const entry: Entry = { plugin, definition, info };
    this.#entries.set(name, entry);
    return toDisposable(() => {
      if (this.#entries.get(name) === entry) this.#entries.delete(name);
    });
  }

  async execute(name: string, input: unknown, invocation: Invocation = {}): Promise<unknown> {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new KernelError("COMMAND_NOT_FOUND", `Command ${name} is not registered`, {
        command: name,
      });
    }
    const { definition } = entry;
    const caller = invocation.caller;
    if (caller !== undefined) {
      // A grant may be a pattern (`git.*`) or `*` (security.md D410).
      const missing = missingPermissions(caller.permissions, definition.permissions ?? []);
      if (missing.length > 0) {
        throw new KernelError(
          "PERMISSION_DENIED",
          `Caller ${caller.id} lacks ${missing.join(", ")} for ${name}`,
          {
            command: name,
            caller: caller.id,
            missing,
          },
        );
      }
    }
    const parsedInput = definition.input.safeParse(input);
    if (!parsedInput.success) {
      throw new KernelError("COMMAND_INPUT_INVALID", `Invalid input for ${name}`, {
        command: name,
        issues: issues(parsedInput.error),
      });
    }
    const result = await definition.handler(parsedInput.data, invocation);
    const parsedOutput = definition.output.safeParse(result);
    if (!parsedOutput.success) {
      throw new KernelError("COMMAND_OUTPUT_INVALID", `Command ${name} returned invalid output`, {
        command: name,
        plugin: entry.plugin,
        issues: issues(parsedOutput.error),
      });
    }
    return parsedOutput.data;
  }

  list(): CommandInfo[] {
    return [...this.#entries.values()]
      .map((entry) => entry.info)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
