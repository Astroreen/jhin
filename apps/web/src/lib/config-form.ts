// A config section's form, generated from the JSON Schema its plugin declares
// (docs/plans/config-ui.md, D80–D84). Field models follow T3 Code's settings
// forms (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/ProviderSettingsForm.tsx.

import { isRedactedSecret } from "@jhin/client-api";

/** A JSON Schema as `host.config.schema` serves it (Zod's `z.toJSONSchema`). */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Text typed into a field that is no value yet (`1e` in a number field,
 * invalid JSON): kept so the field shows it, and reported as an error so it
 * is never saved.
 */
export class Unparsed {
  readonly text: string;
  readonly message: string;
  constructor(text: string, message: string) {
    this.text = text;
    this.message = message;
  }
}

export interface ConfigComment {
  readonly path: readonly string[];
  readonly text: string;
}

export interface Option {
  readonly value: string | number | boolean;
  readonly label: string;
}

type Control =
  | { readonly kind: "text"; readonly secret: boolean }
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "switch" }
  | { readonly kind: "select"; readonly options: readonly Option[] }
  /** A nested object: a sub-section with its own header. */
  | { readonly kind: "group"; readonly fields: readonly Field[] }
  /** An array of values the form renders: an editable list. */
  | { readonly kind: "list"; readonly item: Field }
  /** A record: an editable list of keys and values. */
  | { readonly kind: "map"; readonly value: Field }
  /** Anything else (unions of objects, unknown): edited as JSON in place. */
  | { readonly kind: "json" };

export interface Field {
  readonly key: string;
  /** Inside the section. */
  readonly path: readonly string[];
  readonly title: string;
  /** From the schema, else the comment above the key in a config file (D81). */
  readonly description?: string;
  readonly control: Control;
  /** The field's schema; for a nullable field, its other branch. */
  readonly schema: JsonSchema;
  readonly hasDefault: boolean;
  readonly default?: unknown;
  /** `null` is a value of its own ("none", "never"). */
  readonly nullable: boolean;
  /** `.meta({ advanced: true })`: folded until asked for (D82). */
  readonly advanced: boolean;
  readonly deprecated: boolean;
  /** `.meta({ writeOnly: true })`: a secret, never shown in clear (D83). */
  readonly secret: boolean;
  /** The schema's first example, shown while the field is empty. */
  readonly example?: string;
}

export interface SectionForm {
  readonly section: string;
  readonly title: string;
  readonly description?: string;
  /** Empty when the section is no object with keys: only JSON can edit it. */
  readonly fields: readonly Field[];
}

/** `trustProxy` → "Trust proxy": a key as a title, in sentence case. */
export function humanize(key: string): string {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follows a local `$ref` (`#/$defs/Name`) against the section's schema. */
function resolve(schema: unknown, root: JsonSchema): JsonSchema {
  if (!isObject(schema)) return {};
  const ref = schema["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let target: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    target = isObject(target) ? target[part.replaceAll("~1", "/").replaceAll("~0", "~")] : {};
  }
  // The reference's own keywords (title, default) win over the target's.
  const { $ref: _ref, ...own } = schema;
  return { ...(isObject(target) ? target : {}), ...own };
}

const branchesOf = (schema: JsonSchema): unknown[] | undefined =>
  (Array.isArray(schema["anyOf"]) ? schema["anyOf"] : undefined) ??
  (Array.isArray(schema["oneOf"]) ? schema["oneOf"] : undefined);

const isNullSchema = (schema: JsonSchema) => schema["type"] === "null" || schema["const"] === null;

/** Splits `null` off a schema: `T | null` is a `T` field that can also be none. */
function withoutNull(
  schema: JsonSchema,
  root: JsonSchema,
): { schema: JsonSchema; nullable: boolean } {
  const type = schema["type"];
  if (Array.isArray(type) && type.includes("null")) {
    const rest = type.filter((item) => item !== "null");
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  const branches = branchesOf(schema)?.map((branch) => resolve(branch, root));
  if (branches === undefined || !branches.some(isNullSchema)) return { schema, nullable: false };
  const rest = branches.filter((branch) => !isNullSchema(branch));
  const { anyOf: _anyOf, oneOf: _oneOf, ...outer } = schema;
  return {
    schema: rest.length === 1 ? { ...rest[0], ...outer } : { ...outer, anyOf: rest },
    nullable: true,
  };
}

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The choices of an enum or a union of literals; `undefined` when it is neither. */
function optionsOf(schema: JsonSchema, root: JsonSchema): Option[] | undefined {
  const values = schema["enum"];
  if (Array.isArray(values) && values.every(isPrimitive)) {
    return values.map((value) => ({ value, label: String(value) }));
  }
  if ("const" in schema && isPrimitive(schema["const"])) {
    const value = schema["const"];
    return [
      { value, label: typeof schema["title"] === "string" ? schema["title"] : String(value) },
    ];
  }
  const branches = branchesOf(schema);
  if (branches === undefined) return undefined;
  const options: Option[] = [];
  for (const branch of branches) {
    const choices = optionsOf(resolve(branch, root), root);
    if (choices === undefined) return undefined;
    options.push(...choices);
  }
  return options;
}

const typesOf = (schema: JsonSchema): string[] => {
  const type = schema["type"];
  return typeof type === "string"
    ? [type]
    : Array.isArray(type)
      ? type.filter((item) => typeof item === "string")
      : [];
};

/** Deeper than this a schema is recursive in practice: edited as JSON. */
const MAX_DEPTH = 8;

function controlOf(
  schema: JsonSchema,
  path: readonly string[],
  root: JsonSchema,
  comments: ReadonlyMap<string, string>,
  /** Inside a secret: everything below is one too (D83). */
  secret = false,
): Control {
  if (path.length > MAX_DEPTH) return { kind: "json" };
  const options = optionsOf(schema, root);
  if (options !== undefined && options.length > 0) return { kind: "select", options };
  const types = typesOf(schema);
  if (types.length !== 1 || branchesOf(schema) !== undefined) return { kind: "json" };
  switch (types[0]) {
    case "string":
      return { kind: "text", secret };
    case "number":
    case "integer":
      return { kind: "number", integer: types[0] === "integer" };
    case "boolean":
      return { kind: "switch" };
    case "object": {
      const properties = schema["properties"];
      if (isObject(properties) && Object.keys(properties).length > 0) {
        return {
          kind: "group",
          fields: Object.entries(properties).map(([key, property]) =>
            fieldOf(key, [...path, key], property, root, comments, secret),
          ),
        };
      }
      const values = schema["additionalProperties"];
      if (isObject(values)) {
        const value = fieldOf("", [...path, "*"], values, root, comments, secret);
        if (value.control.kind !== "json") return { kind: "map", value };
      }
      return { kind: "json" };
    }
    case "array": {
      const items = schema["items"];
      if (!isObject(items)) return { kind: "json" };
      const item = fieldOf("", [...path, "*"], items, root, comments, secret);
      const kind = item.control.kind;
      return kind === "text" || kind === "number" || kind === "switch" || kind === "select"
        ? { kind: "list", item }
        : { kind: "json" };
    }
    default:
      return { kind: "json" };
  }
}

const commentKey = (path: readonly string[]) => JSON.stringify(path);

function fieldOf(
  key: string,
  path: readonly string[],
  raw: unknown,
  root: JsonSchema,
  comments: ReadonlyMap<string, string>,
  inSecret = false,
): Field {
  const outer = resolve(raw, root);
  const { schema, nullable } = withoutNull(outer, root);
  // Marked on the field, on its non-null branch (`.meta()` before `.nullable()`), or above it.
  const secret = inSecret || outer["writeOnly"] === true || schema["writeOnly"] === true;
  const title = typeof outer["title"] === "string" ? outer["title"] : humanize(key);
  const description =
    typeof outer["description"] === "string"
      ? outer["description"]
      : comments.get(commentKey(path));
  const examples = outer["examples"];
  const example =
    Array.isArray(examples) && isPrimitive(examples[0]) ? String(examples[0]) : undefined;
  return {
    key,
    path,
    title,
    ...(description === undefined ? {} : { description }),
    control: controlOf(schema, path, root, comments, secret),
    schema,
    hasDefault: "default" in outer,
    ...("default" in outer ? { default: outer["default"] } : {}),
    nullable,
    advanced: outer["advanced"] === true,
    deprecated: outer["deprecated"] === true,
    secret,
    ...(example === undefined ? {} : { example }),
  };
}

/**
 * The form of a section (D80): one field per key of its schema, in the
 * schema's order; titles and descriptions from the schema, else from the
 * comments above the keys in the config files (D81).
 */
export function sectionForm(
  section: string,
  schema: unknown,
  comments: readonly ConfigComment[] = [],
): SectionForm {
  const root = isObject(schema) ? schema : {};
  const byPath = new Map(comments.map((comment) => [commentKey(comment.path), comment.text]));
  const description =
    typeof root["description"] === "string" ? root["description"] : byPath.get(commentKey([]));
  const resolved = resolve(root, root);
  const control = typesOf(resolved).includes("object")
    ? controlOf(resolved, [], root, byPath)
    : undefined;
  return {
    section,
    title: typeof root["title"] === "string" ? root["title"] : section,
    ...(description === undefined ? {} : { description }),
    fields: control?.kind === "group" ? control.fields : [],
  };
}

// Values ---------------------------------------------------------------------

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Unparsed || b instanceof Unparsed) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => equal(item, b[index]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}

/** The value at `path`; a list's items are addressed by their index ("0", "1", …). */
export function getAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (isObject(current) && Object.hasOwn(current, part)) current = current[part];
    else return undefined;
  }
  return current;
}

/**
 * `value` with `path` set to `next`; `undefined` removes the key (in a list,
 * the item). A key keeps its place, so the file's order is the form's.
 */
export function setAt(value: unknown, path: readonly string[], next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(value)) {
    const index = Number(head);
    const child = setAt(value[index], rest, next);
    return child === undefined
      ? value.filter((_item, at) => at !== index)
      : value.map((item, at) => (at === index ? child : item));
  }
  const base = isObject(value) ? value : {};
  const child = setAt(base[head], rest, next);
  if (child === undefined) {
    const { [head]: _old, ...others } = base;
    return others;
  }
  return Object.hasOwn(base, head)
    ? Object.fromEntries(
        Object.entries(base).map(([key, item]) => [key, key === head ? child : item]),
      )
    : { ...base, [head]: child };
}

/** Whether an edited value holds text that is no value yet. */
export function hasUnparsed(value: unknown): boolean {
  if (value instanceof Unparsed) return true;
  if (Array.isArray(value)) return value.some(hasUnparsed);
  return isObject(value) && Object.values(value).some(hasUnparsed);
}

// Validation -----------------------------------------------------------------

export interface Issue {
  /** Inside the section, joined with dots as `host.config.get` reports them. */
  readonly path: string;
  readonly message: string;
}

const join = (path: readonly (string | number)[]) => path.join(".");

const describeType = (type: string) =>
  ({
    string: "text",
    number: "a number",
    integer: "a whole number",
    boolean: "true or false",
    object: "an object",
    array: "a list",
    null: "null",
  })[type] ?? type;

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return true;
  }
}

/**
 * Checks a value against the JSON Schema keywords Zod writes: types, enums,
 * bounds, lengths, patterns, items and keys. `merged`: the value is merged
 * key by key with the other layers, so a key it leaves out may come from
 * them (outside arrays, which replace).
 */
function check(
  raw: unknown,
  value: unknown,
  path: readonly (string | number)[],
  root: JsonSchema,
  merged: boolean,
  out: Issue[],
): void {
  if (value instanceof Unparsed) {
    out.push({ path: join(path), message: value.message });
    return;
  }
  if (value === HIDDEN) {
    out.push({ path: join(path), message: "Enter the secret: there is no stored one here" });
    return;
  }
  // A secret the node keeps (security.md D417): saved back as it came, it stays. The
  // node decides where a secret is (it follows every schema keyword), so the marker
  // passes here wherever it is; where the node has none, it is checked as a value there.
  if (isRedactedSecret(value)) return;
  if (raw === false) {
    out.push({ path: join(path), message: "Not allowed here" });
    return;
  }
  const schema = resolve(raw, root);
  const at = (message: string) => out.push({ path: join(path), message });

  const branches = branchesOf(schema);
  if (branches !== undefined) {
    const results = branches.map((branch) => {
      const issues: Issue[] = [];
      check(branch, value, path, root, merged, issues);
      return { schema: resolve(branch, root), issues };
    });
    if (!results.some((result) => result.issues.length === 0)) {
      // The branch of the value's own type says best what is wrong.
      const closest = results.find((result) =>
        typesOf(result.schema).some((type) => hasType(type, value)),
      );
      if (closest !== undefined) out.push(...closest.issues);
      else at("Does not match any allowed value");
    }
    return;
  }
  if (Array.isArray(schema["allOf"])) {
    for (const part of schema["allOf"]) check(part, value, path, root, merged, out);
  }
  if ("const" in schema && !equal(schema["const"], value)) {
    at(`Must be ${JSON.stringify(schema["const"])}`);
    return;
  }
  const choices = schema["enum"];
  if (Array.isArray(choices) && !choices.some((choice) => equal(choice, value))) {
    at(`Must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`);
    return;
  }
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((type) => hasType(type, value))) {
    at(`Expected ${types.map(describeType).join(" or ")}`);
    return;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    const min = schema["minLength"];
    const max = schema["maxLength"];
    if (typeof min === "number" && length < min) {
      at(min === 1 ? "Must not be empty" : `Must be at least ${min} characters`);
    }
    if (typeof max === "number" && length > max) at(`Must be at most ${max} characters`);
    const pattern = schema["pattern"];
    if (typeof pattern === "string") {
      try {
        if (!new RegExp(pattern, "u").test(value)) at(`Must match ${pattern}`);
      } catch {
        // A pattern this browser cannot read is the node's to check.
      }
    }
  }
  if (typeof value === "number") {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
    if (typeof minimum === "number" && value < minimum) at(`Must be at least ${minimum}`);
    if (typeof maximum === "number" && value > maximum) at(`Must be at most ${maximum}`);
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      at(`Must be greater than ${exclusiveMinimum}`);
    }
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      at(`Must be less than ${exclusiveMaximum}`);
    }
    if (typeof multipleOf === "number" && multipleOf > 0) {
      // Floating point: 0.3 / 0.1 is 2.9999999999999996, yet 0.3 is a multiple of 0.1.
      const quotient = value / multipleOf;
      const off = Math.abs(quotient - Math.round(quotient));
      if (off > 1e-9 * Math.max(1, Math.abs(quotient))) at(`Must be a multiple of ${multipleOf}`);
    }
  }
  if (Array.isArray(value)) {
    const { minItems, maxItems, items } = schema;
    if (typeof minItems === "number" && value.length < minItems) {
      at(`Needs at least ${minItems} ${minItems === 1 ? "item" : "items"}`);
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      at(`Takes at most ${maxItems} ${maxItems === 1 ? "item" : "items"}`);
    }
    if (items !== undefined) {
      value.forEach((item, index) => check(items, item, [...path, index], root, false, out));
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key))
        check(properties[key], item, [...path, key], root, merged, out);
      else if (additional === false)
        out.push({ path: join([...path, key]), message: "Unknown key" });
      else if (additional !== undefined && additional !== true) {
        check(additional, item, [...path, key], root, merged, out);
      }
    }
    if (!merged && Array.isArray(schema["required"])) {
      for (const key of schema["required"]) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          out.push({ path: join([...path, key]), message: "Required" });
        }
      }
    }
  }
}

/**
 * What is wrong with the node file's part of a section as edited: checked
 * where it is typed, before it is saved (D84). Keys it leaves out are not
 * missing: they come from the defaults and the other layers.
 */
export function validate(schema: unknown, value: unknown): Issue[] {
  const root = isObject(schema) ? schema : {};
  const out: Issue[] = [];
  check(root, value, [], root, true, out);
  return out;
}

// Secrets ----------------------------------------------------------------------

/** What a secret shows as wherever the form writes JSON (D83). */
export const HIDDEN = "<hidden secret>";

const isSecret = (schema: JsonSchema, root: JsonSchema) =>
  schema["writeOnly"] === true || withoutNull(schema, root).schema["writeOnly"] === true;

/**
 * `value` with every value its schema marks `writeOnly` replaced by
 * `HIDDEN` (D83), for the JSON views. `secret`: the whole value is one.
 */
export function redact(raw: unknown, value: unknown, root: JsonSchema, secret = false): unknown {
  if (value === undefined || value === null || value instanceof Unparsed) return value;
  const schema = resolve(raw, root);
  if (secret || isSecret(schema, root)) return HIDDEN;
  const branches = branchesOf(schema);
  if (branches !== undefined) {
    // The branch the value is of; a value of none keeps whatever any branch hides.
    const fits = branches.find((branch) => {
      const issues: Issue[] = [];
      check(branch, value, [], root, true, issues);
      return issues.length === 0;
    });
    return branches.reduce<unknown>(
      (current, branch) =>
        fits === undefined || branch === fits ? redact(branch, current, root) : current,
      value,
    );
  }
  if (Array.isArray(value)) {
    return schema["items"] === undefined
      ? value
      : value.map((item) => redact(schema["items"], item, root));
  }
  if (isObject(value)) {
    const properties = isObject(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Object.hasOwn(properties, key)
          ? redact(properties[key], item, root)
          : isObject(additional)
            ? redact(additional, item, root)
            : item,
      ]),
    );
  }
  return value;
}

/**
 * An edit of a redacted value with the secrets put back: wherever `HIDDEN`
 * is left, the value `previous` held at that place (D83). One left where
 * there was none stays `HIDDEN`, which `validate` refuses.
 */
export function restore(edited: unknown, previous: unknown): unknown {
  if (edited === HIDDEN) return previous ?? HIDDEN;
  if (Array.isArray(edited)) {
    return edited.map((item, index) =>
      restore(item, Array.isArray(previous) ? previous[index] : undefined),
    );
  }
  if (isObject(edited)) {
    return Object.fromEntries(
      Object.entries(edited).map(([key, item]) => [
        key,
        restore(item, isObject(previous) ? previous[key] : undefined),
      ]),
    );
  }
  return edited;
}
