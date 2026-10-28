import { toDisposable, z, type Disposable, type Logger } from "@jhin/sdk";
import { parse, printParseErrorCode, visit, type ParseError } from "jsonc-parser";

import { KernelError } from "./errors.ts";

/** Default layer order, lowest precedence first (D19). */
export const DEFAULT_CONFIG_LAYERS = ["distribution", "node", "project"] as const;

type Values = Record<string, unknown>;

interface Section {
  readonly plugin: string;
  readonly schema: z.ZodType;
  /** Its JSON Schema, converted once: converting is most of a config read (config-ui.md D1621). */
  json?: unknown;
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
// Layers come from user files; these keys would reach Object.prototype through assignment.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function merge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override))
    return override === undefined ? base : override;
  const result: Values = {};
  for (const [key, value] of Object.entries(base)) if (!UNSAFE_KEYS.has(key)) result[key] = value;
  for (const [key, value] of Object.entries(override)) {
    if (!UNSAFE_KEYS.has(key)) result[key] = merge(base[key], value);
  }
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

/** `value` and everything in it frozen: a shared JSON Schema cannot be changed by one reader. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** A comment written directly above a key of a config file. */
export interface ConfigComment {
  /** The key's path inside its section; `[]` for the section's own key. */
  readonly path: readonly string[];
  readonly text: string;
}

/** The words of a `//` or `/* *\/` comment: markers and JSDoc stars gone, lines of a paragraph joined. */
function commentText(raw: string): string {
  const lines = raw.startsWith("//")
    ? [raw.slice(2)]
    : raw
        .slice(2, -2)
        .split("\n")
        .map((line) => line.replace(/^\s*\*(?!\/)/, ""));
  return lines.map((line) => line.trim()).join("\n");
}

/**
 * The comments directly above the keys of `section` in a JSONC config file
 * (D81): a run of comments that ends on the line before the key, with nothing
 * but the key after it. A comment after a value on the same line belongs to
 * that value and describes nothing; keys inside arrays are skipped. Lines of a
 * paragraph are joined with spaces; an empty comment line starts a new
 * paragraph. A file that does not parse gives what was read before the error.
 */
export function configComments(text: string, section: string): ConfigComment[] {
  return configCommentsBySection(text).get(section) ?? [];
}

/** {@link configComments} of every section of the file, read in one pass (config-ui.md D1624). */
export function configCommentsBySection(text: string): Map<string, ConfigComment[]> {
  const found = new Map<string, ConfigComment[]>();
  /** Comment lines read since the last token, with the line each ends on. */
  let pending: { text: string; endLine: number }[] = [];
  let lastTokenLine = -1;
  const token = (line: number) => {
    pending = [];
    lastTokenLine = line;
  };
  visit(
    text,
    {
      onObjectBegin: (_offset, _length, line) => token(line),
      onObjectEnd: (_offset, _length, line) => token(line),
      onArrayBegin: (_offset, _length, line) => token(line),
      onArrayEnd: (_offset, _length, line) => token(line),
      onLiteralValue: (_value, _offset, _length, line) => token(line),
      onSeparator: (_character, _offset, _length, line) => token(line),
      onComment: (offset, length, line) => {
        const raw = text.slice(offset, offset + length);
        // After a token on its line: it belongs to that token.
        if (line === lastTokenLine) return;
        const endLine = line + (raw.match(/\n/g)?.length ?? 0);
        // A blank line between two comments: only the later run is "above".
        const previous = pending.at(-1);
        if (previous !== undefined && previous.endLine < line - 1) pending = [];
        pending.push({ text: commentText(raw), endLine });
      },
      onObjectProperty: (property, _offset, _length, line, _character, pathSupplier) => {
        const above = pending.at(-1)?.endLine === line - 1 ? pending : [];
        token(line);
        const path = [...pathSupplier(), property];
        const section = path[0];
        if (typeof section !== "string" || path.some((part) => typeof part !== "string")) return;
        const words = above
          .map((comment) => comment.text)
          .join("\n")
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.split("\n").join(" ").replaceAll(/\s+/g, " ").trim())
          .filter((paragraph) => paragraph !== "")
          .join("\n\n");
        if (words === "") return;
        const comments = found.get(section);
        const comment = { path: path.slice(1) as string[], text: words };
        if (comments === undefined) found.set(section, [comment]);
        else comments.push(comment);
      },
    },
    { allowTrailingComma: true, disallowComments: false },
  );
  return found;
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

  /**
   * JSON Schema of the whole config, assembled from every defined section.
   * Each section's schema is converted once and shared between calls, frozen.
   */
  jsonSchema(): unknown {
    const properties: Values = {};
    for (const [section, entry] of [...this.#sections.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      entry.json ??= deepFreeze(
        z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" }),
      );
      properties[section] = entry.json;
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
