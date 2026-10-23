/**
 * Secrets in config sections (security.md D417): values a section's JSON
 * Schema marks `writeOnly` (config-ui.md D83) never leave the node through
 * `host.config.get`; a change that carries the marker back keeps what is
 * stored. The marker is T3 Code's `SECRET_REDACTED`
 * (apps/server/src/settingsSecrets.ts).
 */

import { SECRET_REDACTED, isRedactedSecret } from "@jhin/host-api";
import { isConfigSecretReference } from "@jhin/secrets-api";

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Follows a local `$ref` (`#…`) against the section's own schema: the kernel
 * converts each section on its own (`config.jsonSchema()`), so its `$defs`
 * stay inside it.
 */
function deref(schema: unknown, root: Schema, depth = 0): Schema {
  if (!isObject(schema)) return {};
  const ref = schema["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#") || depth > 32) return schema;
  let target: unknown = root;
  for (const part of ref.slice(1).split("/").filter(Boolean)) {
    target = isObject(target)
      ? target[decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))]
      : undefined;
  }
  // Keywords beside `$ref` apply too (2020-12): `{ $ref, writeOnly: true }` is a secret.
  const { $ref: _ref, ...siblings } = schema;
  return { ...deref(target, root, depth + 1), ...siblings };
}

/** Schemas a value at this level must also match: unions, intersections, conditional branches. */
function branchesOf(schema: Schema): unknown[] {
  const branches = ["anyOf", "oneOf", "allOf", "then", "else"].flatMap((key) => {
    const value = schema[key];
    return Array.isArray(value) ? value : isObject(value) ? [value] : [];
  });
  // Schemas that apply when a key is present describe the same object.
  const dependent = schema["dependentSchemas"];
  return isObject(dependent) ? [...branches, ...Object.values(dependent)] : branches;
}

/** A secret here: marked itself, or on a branch (the non-null branch of a nullable field). */
function isSecret(schema: Schema, root: Schema): boolean {
  if (schema["writeOnly"] === true) return true;
  return branchesOf(schema).some((branch) => deref(branch, root)["writeOnly"] === true);
}

/** The schemas that describe `key` of an object: its property, matching patterns, else additional ones. */
function schemasOfKey(schema: Schema, key: string): unknown[] {
  const found: unknown[] = [];
  const properties = schema["properties"];
  if (isObject(properties) && Object.hasOwn(properties, key)) found.push(properties[key]);
  const patterns = schema["patternProperties"];
  if (isObject(patterns)) {
    for (const [pattern, item] of Object.entries(patterns)) {
      try {
        if (new RegExp(pattern, "u").test(key)) found.push(item);
      } catch {
        // A pattern this engine cannot read names no key.
      }
    }
  }
  if (found.length === 0) {
    for (const rest of ["additionalProperties", "unevaluatedProperties"]) {
      if (isObject(schema[rest])) found.push(schema[rest]);
    }
  }
  return found;
}

/** The schemas that describe item `index` of a list: a tuple's own, else `items`. */
function schemasOfItem(schema: Schema, index: number): unknown[] {
  const found: unknown[] = [];
  const prefix = schema["prefixItems"];
  if (Array.isArray(prefix) && index < prefix.length) found.push(prefix[index]);
  else if (isObject(schema["items"])) found.push(schema["items"]);
  // Some item matches `contains`; any may be the one, so each is read by it too.
  if (isObject(schema["contains"])) found.push(schema["contains"]);
  return found;
}

/**
 * A key or item no schema describes (a typo in a file, a list without
 * `items`) is unknown: it is treated as a secret, not shown in clear.
 */
const described = (schemas: unknown[]): unknown[] | undefined =>
  schemas.length === 0 ? undefined : schemas;

/** Keywords that say nothing of a value's shape. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "$comment",
  "$schema",
  "$id",
  "$defs",
  "definitions",
]);

/** `{}` or `true`, as for `z.unknown()`: any value, with no secret inside it. */
const opaque = (schema: Schema) => Object.keys(schema).every((key) => ANNOTATIONS.has(key));

/** What `visit` learns of a secret: where it is, and whether it sits inside a list. */
type Visit = (value: unknown, path: readonly string[], inList: boolean) => unknown;

/**
 * Calls `visit` for every value a secret (and returns what it gives), walking
 * `value` along every schema that describes it, so a union hides what any of
 * its branches would: hiding too much is safe, hiding too little is not. An
 * unknown schema (`undefined`: no plugin defines the section) makes every
 * scalar a secret.
 */
function mapSecrets(
  schemas: readonly unknown[] | undefined,
  value: unknown,
  root: Schema,
  path: readonly string[],
  visit: Visit,
  inList = false,
  markedOnly = false,
): unknown {
  if (value === undefined || value === null) return value;
  // Only what a schema marks: what no schema describes stays as it is.
  if (schemas === undefined && markedOnly) return value;
  if (schemas === undefined) {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        mapSecrets(undefined, item, root, [...path, String(index)], visit, true),
      );
    }
    if (isObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          mapSecrets(undefined, item, root, [...path, key], visit, inList),
        ]),
      );
    }
    return visit(value, path, inList);
  }
  // Every schema that applies here, its branches included. Seen by the schema
  // as written (and by its `$ref`), since `deref` builds a new object each time:
  // a union that refers back to itself is read once.
  const all: Schema[] = [];
  const seen = new Set<unknown>();
  const add = (raw: unknown) => {
    const ref = isObject(raw) ? raw["$ref"] : undefined;
    if (seen.has(raw) || (typeof ref === "string" && seen.has(ref))) return;
    seen.add(raw);
    if (typeof ref === "string") seen.add(ref);
    const schema = deref(raw, root);
    all.push(schema);
    for (const branch of branchesOf(schema)) add(branch);
  };
  for (const schema of schemas) add(schema);
  if (all.some((schema) => isSecret(schema, root))) return visit(value, path, inList);
  // A field that takes anything (`z.unknown()`) holds data, not secrets.
  if (all.every(opaque)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      mapSecrets(
        described(all.flatMap((schema) => schemasOfItem(schema, index))),
        item,
        root,
        [...path, String(index)],
        visit,
        true,
        markedOnly,
      ),
    );
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapSecrets(
          described(all.flatMap((schema) => schemasOfKey(schema, key))),
          item,
          root,
          [...path, key],
          visit,
          inList,
          markedOnly,
        ),
      ]),
    );
  }
  return value;
}

const rootOf = (schema: unknown): Schema => (isObject(schema) ? schema : {});

/**
 * `value` with every value under a `writeOnly` schema replaced by the marker.
 * `schema` undefined: the section's schema is unknown, so every scalar is.
 */
export function redactSecrets(schema: unknown, value: unknown): unknown {
  return mapSecrets(
    schema === undefined ? undefined : [schema],
    value,
    rootOf(schema),
    [],
    // Inside a list, the marker names its secret's place, so a reorder keeps it.
    (_value, path, inList) => (inList ? `${SECRET_REDACTED}#${toPointer(path)}` : SECRET_REDACTED),
  );
}

function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    // Own entries only: `constructor` or `toString` is no stored secret.
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isObject(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

/** A JSON Pointer (RFC 6901) for a path, so keys with dots or slashes stay whole. */
const toPointer = (path: readonly string[]) =>
  path.map((part) => `/${part.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");

const fromPointer = (pointer: string): string[] | undefined =>
  pointer.startsWith("/")
    ? pointer
        .slice(1)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    : undefined;

/** A marker for a secret only another layer holds: its key is left out of the change. */
const UNCHANGED = Symbol("unchanged");

/** Drops `UNCHANGED` keys; one in a list cannot be left out, so it is refused. */
function prune(value: unknown, label: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === UNCHANGED) {
        const where = [...label, String(index)].join(".");
        throw Object.assign(
          new Error(`No secret is stored at ${where} in this layer; enter it again`),
          { code: "CONFIG_SECRET_MISSING", details: { path: where } },
        );
      }
      return prune(item, [...label, String(index)]);
    });
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== UNCHANGED)
        .map(([key, item]) => [key, prune(item, [...label, key])]),
    );
  }
  return value;
}

/**
 * `incoming` (some top-level keys of a section) with the marker replaced,
 * wherever its schema says a secret is, by what the layer being changed
 * (`stored`) holds: a plain marker takes the secret at its own key; inside a
 * list only an addressed marker (`••••••#/keys/1`) is taken, at its address,
 * and a plain one is refused, since a position may have moved. The
 * marker anywhere else is a value like any other. A secret only another
 * layer holds (`elsewhere`, the effective value) is never copied into this
 * one: its key is left out, so the other layer keeps providing it. A marker
 * no layer has a value for fails with `CONFIG_SECRET_MISSING`; `label`
 * prefixes its path.
 */
export function restoreSecrets(
  schema: unknown,
  incoming: Record<string, unknown>,
  stored: unknown,
  elsewhere: unknown,
  label: readonly string[] = [],
): Record<string, unknown> {
  // The stored secrets' addresses, read once, the first time a marker names one.
  let storedSecrets: Set<string> | undefined;
  const restored = mapSecrets(
    schema === undefined ? undefined : [schema],
    incoming,
    rootOf(schema),
    [],
    (value, path, inList) => {
      if (!isRedactedSecret(value)) return value;
      // An addressed marker is the secret at that place, wherever it was moved to.
      // Inside a list only an addressed marker says which secret it is: the node
      // never sends a plain one there, and a position may have moved.
      if (value === SECRET_REDACTED && inList) {
        throw Object.assign(
          new Error(`A secret in a list needs its addressed marker; enter it again`),
          { code: "CONFIG_SECRET_MISSING", details: { path: [...label, ...path].join(".") } },
        );
      }
      const address =
        value === SECRET_REDACTED ? path : fromPointer(value.slice(SECRET_REDACTED.length + 1));
      // An address names a secret of the layer, nothing else.
      if (
        address === undefined ||
        (value !== SECRET_REDACTED &&
          !(storedSecrets ??= new Set(secretPaths(schema, stored).map(toPointer))).has(
            toPointer(address),
          ))
      ) {
        throw Object.assign(new Error(`${value} names no secret of this section`), {
          code: "CONFIG_SECRET_MISSING",
          details: { path: [...label, ...path].join(".") },
        });
      }
      const kept = at(stored, address);
      if (kept !== undefined && kept !== null) return kept;
      const other = at(elsewhere, address);
      if (other !== undefined && other !== null) return UNCHANGED;
      const where = [...label, ...path].join(".");
      throw Object.assign(new Error(`No secret is stored at ${where} to keep; enter it again`), {
        code: "CONFIG_SECRET_MISSING",
        details: { path: where },
      });
    },
  );
  return prune(restored, label) as Record<string, unknown>;
}

/** The scalar values under a secret, as text, to scrub them from messages. */
export function secretTexts(schema: unknown, value: unknown): string[] {
  const found: string[] = [];
  mapSecrets(schema === undefined ? undefined : [schema], value, rootOf(schema), [], (secret) => {
    if (typeof secret === "string" || typeof secret === "number" || typeof secret === "boolean") {
      const text = String(secret);
      if (text !== "") found.push(text);
    } else if (secret !== null && typeof secret === "object") {
      found.push(...secretTexts(undefined, secret));
    }
    return secret;
  });
  return found;
}

/** Where secrets are in `value`, as dotted paths (`env.A`, `keys.0`). */
export function secretPaths(schema: unknown, value: unknown): string[][] {
  const found: string[][] = [];
  mapSecrets(
    schema === undefined ? undefined : [schema],
    value,
    rootOf(schema),
    [],
    (secret, path) => {
      found.push([...path]);
      return secret;
    },
  );
  return found;
}

/** `text` with every one of `secrets` replaced by the marker. */
export function scrub(text: string, secrets: readonly string[]): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...secrets]
    .toSorted((a, b) => b.length - a.length)
    .reduce(
      (current, secret) =>
        // A short secret ("123") is replaced where it stands as a word; hiding a
        // few extra digits of a message is safe, quoting a secret is not.
        secret.length >= 4
          ? current.split(secret).join(SECRET_REDACTED)
          : current.replace(
              new RegExp(`(?<![\\p{L}\\p{N}])${escape(secret)}(?![\\p{L}\\p{N}])`, "gu"),
              SECRET_REDACTED,
            ),
      text,
    );
}

/** A place inside a section: keys, and list positions as numbers (D1025). */
type Place = readonly (string | number)[];

/**
 * How the store keeps a number or a boolean (security.md D1373): its JSON
 * text behind this tag. A string that starts with the tag is kept the same
 * way, so it reads back as itself.
 */
const TYPED_TAG = "\u0000json:";

/** The text the store keeps for a secret `value`, or undefined for a value that is no scalar. */
export function storedText(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") {
    return `${TYPED_TAG}${JSON.stringify(value)}`;
  }
  if (typeof value !== "string") return undefined;
  return value.startsWith(TYPED_TAG) ? `${TYPED_TAG}${JSON.stringify(value)}` : value;
}

/** A value the store kept, as the config reads it: tagged text back to its type. */
function fromStoredText(text: string): unknown {
  if (!text.startsWith(TYPED_TAG)) return text;
  try {
    const parsed: unknown = JSON.parse(text.slice(TYPED_TAG.length));
    return typeof parsed === "number" || typeof parsed === "boolean" || typeof parsed === "string"
      ? parsed
      : text;
  } catch {
    return text;
  }
}

/** Every scalar inside `value` (strings, numbers, booleans), with its place. */
function mapScalars(
  value: unknown,
  place: Place,
  change: (scalar: string | number | boolean, place: Place) => unknown,
): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return change(value, place);
  }
  if (Array.isArray(value))
    return value.map((item, index) => mapScalars(item, [...place, index], change));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapScalars(item, [...place, key], change)]),
    );
  }
  return value;
}

/** Every string inside `value` (itself, or in its lists and objects), with its place. */
function mapStrings(
  value: unknown,
  place: Place,
  change: (text: string, place: Place) => unknown,
): unknown {
  if (typeof value === "string") return change(value, place);
  if (Array.isArray(value))
    return value.map((item, index) => mapStrings(item, [...place, index], change));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, [...place, key], change)]),
    );
  }
  return value;
}

/** `path` (dotted, as the walk reports it) with list positions as numbers, read off `root`. */
function placeOf(root: unknown, path: readonly string[]): Place {
  const place: (string | number)[] = [];
  let current = root;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      place.push(Number(key));
      current = current[Number(key)];
    } else {
      place.push(key);
      current = isObject(current) ? current[key] : undefined;
    }
  }
  return place;
}

/**
 * `values` (top-level keys of a section) with every scalar a schema marks
 * `writeOnly` handed to `seal` as the text the store keeps (`storedText`:
 * numbers and booleans tagged, D1373), which keeps it and gives the
 * reference the file holds instead (security.md D1026). References and
 * markers stay as they are; what no schema describes is not touched, nor is
 * a section no plugin defines.
 */
export function sealSecrets(
  schema: unknown,
  values: Readonly<Record<string, unknown>>,
  seal: (text: string, place: Place) => string,
): Record<string, unknown> {
  if (schema === undefined) return { ...values };
  return mapSecrets(
    [schema],
    values,
    rootOf(schema),
    [],
    (secret, path) =>
      mapScalars(secret, placeOf(values, path), (scalar, place) => {
        if (
          scalar === "" ||
          (typeof scalar === "string" &&
            (isConfigSecretReference(scalar) || isRedactedSecret(scalar)))
        ) {
          return scalar;
        }
        // Always text for a scalar; narrowed rather than asserted.
        const text = storedText(scalar);
        return text === undefined ? scalar : seal(text, place);
      }),
    false,
    true,
  ) as Record<string, unknown>;
}

/** Every config secret reference inside `value` (D1026). */
export function secretReferences(value: unknown): string[] {
  const found: string[] = [];
  mapStrings(value, [], (text) => {
    if (isConfigSecretReference(text)) found.push(text);
    return text;
  });
  return found;
}

/** What `resolveSecretReferences` could not resolve: the key is left out (D1025). */
const UNRESOLVED = Symbol("unresolved");

function dropUnresolved(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== UNRESOLVED).map(dropUnresolved);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== UNRESOLVED)
        .map(([key, item]) => [key, dropUnresolved(item)]),
    );
  }
  return value;
}

/**
 * A layer (sections by name) with every config secret reference replaced by
 * its value (security.md D1025). `resolve` gets the reference and its place
 * (`[section, ...path]`); one it cannot resolve is left out, as if the key
 * were not there, and reported to `missing`.
 */
export function resolveSecretReferences(
  layer: Readonly<Record<string, unknown>>,
  resolve: ((reference: string, place: Place) => string | undefined) | undefined,
  missing: (place: Place) => void,
): Record<string, unknown> {
  let found = false;
  const mapped = mapStrings(layer, [], (text, place) => {
    if (!isConfigSecretReference(text)) return text;
    found = true;
    const value = resolve?.(text, place);
    // A number or boolean comes back as one (D1373).
    if (value !== undefined) return fromStoredText(value);
    missing(place);
    return UNRESOLVED;
  });
  return found ? (dropUnresolved(mapped) as Record<string, unknown>) : { ...layer };
}
