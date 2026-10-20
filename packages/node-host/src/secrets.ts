/**
 * Secrets in config sections (security.md D417): values a section's JSON
 * Schema marks `writeOnly` (config-ui.md D83) never leave the node through
 * `host.config.get`; a change that carries the marker back keeps what is
 * stored. The marker is T3 Code's `SECRET_REDACTED`
 * (apps/server/src/settingsSecrets.ts).
 */

import { SECRET_REDACTED } from "@jhin/host-api";

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follows a local `$ref` (`#`, `#/$defs/x`, `#/definitions/x`); anything else stays as it is. */
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
  return deref(target, root, depth + 1);
}

/** Schemas a value at this level must also match: unions, intersections, conditional branches. */
function branchesOf(schema: Schema): unknown[] {
  return ["anyOf", "oneOf", "allOf", "then", "else"].flatMap((key) => {
    const value = schema[key];
    return Array.isArray(value) ? value : isObject(value) ? [value] : [];
  });
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
  if (found.length === 0 && isObject(schema["additionalProperties"])) {
    found.push(schema["additionalProperties"]);
  }
  return found;
}

/** The schemas that describe item `index` of a list: a tuple's own, else `items`. */
function schemasOfItem(schema: Schema, index: number): unknown[] {
  const prefix = schema["prefixItems"];
  if (Array.isArray(prefix) && index < prefix.length) return [prefix[index]];
  return schema["items"] === undefined || typeof schema["items"] === "boolean"
    ? []
    : [schema["items"]];
}

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
  visit: (value: unknown, path: readonly string[]) => unknown,
): unknown {
  if (value === undefined || value === null) return value;
  const known = schemas?.map((schema) => deref(schema, root));
  if (known === undefined) {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        mapSecrets(undefined, item, root, [...path, String(index)], visit),
      );
    }
    if (isObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          mapSecrets(undefined, item, root, [...path, key], visit),
        ]),
      );
    }
    return visit(value, path);
  }
  // Every schema that applies here, its branches included.
  const all: Schema[] = [];
  const add = (schema: Schema) => {
    if (all.includes(schema)) return;
    all.push(schema);
    for (const branch of branchesOf(schema)) add(deref(branch, root));
  };
  for (const schema of known) add(schema);
  if (all.some((schema) => isSecret(schema, root))) return visit(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      mapSecrets(
        all.flatMap((schema) => schemasOfItem(schema, index)),
        item,
        root,
        [...path, String(index)],
        visit,
      ),
    );
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapSecrets(
          all.flatMap((schema) => schemasOfKey(schema, key)),
          item,
          root,
          [...path, key],
          visit,
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
    () => SECRET_REDACTED,
  );
}

function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isObject(current)) current = current[key];
    else return undefined;
  }
  return current;
}

/**
 * `incoming` with the marker replaced, wherever its schema says a secret is,
 * by what `stored` holds at the same place (by key, by position in a list).
 * The marker anywhere else is a value like any other. A marker where nothing
 * is stored fails with `CONFIG_SECRET_MISSING`; `label` prefixes its path.
 */
export function restoreSecrets(
  schema: unknown,
  incoming: unknown,
  stored: unknown,
  label: readonly string[] = [],
): unknown {
  return mapSecrets(
    schema === undefined ? undefined : [schema],
    incoming,
    rootOf(schema),
    [],
    (value, path) => {
      if (value !== SECRET_REDACTED) return value;
      const kept = at(stored, path);
      if (kept === undefined || kept === null) {
        const where = [...label, ...path].join(".");
        throw Object.assign(new Error(`No secret is stored at ${where} to keep; enter it again`), {
          code: "CONFIG_SECRET_MISSING",
          details: { path: where },
        });
      }
      return kept;
    },
  );
}
