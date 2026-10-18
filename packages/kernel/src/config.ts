import { toDisposable, z, type Disposable, type Logger } from "@jhin/sdk";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { KernelError } from "./errors.ts";

/** Default layer order, lowest precedence first (D19). */
export const DEFAULT_CONFIG_LAYERS = ["distribution", "node", "project"] as const;

type Values = Record<string, unknown>;

interface Section {
  readonly plugin: string;
  readonly schema: z.ZodType;
}

interface Listener {
  readonly section: string;
  readonly listener: (value: unknown) => void;
  last: string;
}

function isPlainObject(value: unknown): value is Values {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; everything else (arrays included) is replaced by the higher layer. */
function merge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override))
    return override === undefined ? base : override;
  const result: Values = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
  return result;
}

/** Parses JSONC (comments, trailing commas) into a layer object. */
export function parseConfigText(text: string, source = "config"): Values {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new KernelError("CONFIG_INVALID", `Cannot parse ${source}`, {
      source,
      errors: errors.map((error) => ({
        offset: error.offset,
        error: printParseErrorCode(error.error),
      })),
    });
  }
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new KernelError("CONFIG_INVALID", `${source} must contain a JSON object`, { source });
  }
  return value;
}

/**
 * Layered config. Plugins declare sections with a Zod schema; hosts set the
 * layers. A section's value is the merge of every layer, validated and
 * defaulted by its schema; a missing section validates as `{}`.
 */
export class ConfigRegistry {
  readonly #layerNames: readonly string[];
  readonly #layers = new Map<string, Values>();
  readonly #sections = new Map<string, Section>();
  readonly #listeners = new Set<Listener>();
  readonly #log: Logger;

  constructor(layerNames: readonly string[], log: Logger) {
    this.#layerNames = layerNames;
    this.#log = log;
  }

  get layerNames(): readonly string[] {
    return this.#layerNames;
  }

  define(plugin: string, section: string, schema: z.ZodType): Disposable {
    const existing = this.#sections.get(section);
    if (existing !== undefined) {
      throw new KernelError(
        "CONFIG_SECTION_DUPLICATE",
        `Config section ${section} is already defined by ${existing.plugin}`,
        {
          section,
          plugin: existing.plugin,
        },
      );
    }
    const entry: Section = { plugin, schema };
    this.#sections.set(section, entry);
    return toDisposable(() => {
      if (this.#sections.get(section) === entry) this.#sections.delete(section);
    });
  }

  setLayer(name: string, values: Values): void {
    if (!this.#layerNames.includes(name)) {
      throw new KernelError("CONFIG_INVALID", `Unknown config layer ${name}`, {
        layer: name,
        layers: this.#layerNames,
      });
    }
    this.#layers.set(name, values);
    this.#notify();
  }

  /** The merged, unvalidated value of a section across all layers. */
  raw(section: string): unknown {
    let value: unknown = undefined;
    for (const name of this.#layerNames) {
      const layer = this.#layers.get(name);
      if (layer !== undefined) value = merge(value, layer[section]);
    }
    return value;
  }

  get(section: string): unknown {
    const entry = this.#sections.get(section);
    if (entry === undefined) {
      throw new KernelError("CONFIG_SECTION_UNKNOWN", `Config section ${section} is not defined`, {
        section,
      });
    }
    const parsed = entry.schema.safeParse(this.raw(section) ?? {});
    if (!parsed.success) {
      throw new KernelError("CONFIG_INVALID", `Config section ${section} is invalid`, {
        section,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  onDidChange(section: string, listener: (value: unknown) => void): Disposable {
    const entry: Listener = { section, listener, last: JSON.stringify(this.raw(section)) ?? "" };
    this.#listeners.add(entry);
    return toDisposable(() => this.#listeners.delete(entry));
  }

  /** JSON Schema of the whole config, assembled from every defined section. */
  jsonSchema(): unknown {
    const properties: Values = {};
    for (const [section, entry] of [...this.#sections.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      properties[section] = z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" });
    }
    return { type: "object", properties };
  }

  sections(): { section: string; plugin: string }[] {
    return [...this.#sections.entries()]
      .map(([section, entry]) => ({ section, plugin: entry.plugin }))
      .toSorted((a, b) => a.section.localeCompare(b.section));
  }

  #notify(): void {
    for (const entry of this.#listeners) {
      const next = JSON.stringify(this.raw(entry.section)) ?? "";
      if (next === entry.last) continue;
      entry.last = next;
      try {
        entry.listener(this.get(entry.section));
      } catch (error) {
        this.#log.error("config listener failed", { section: entry.section, error: String(error) });
      }
    }
  }
}
