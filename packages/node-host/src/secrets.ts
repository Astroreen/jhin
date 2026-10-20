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

function branchesOf(schema: Schema): unknown[] {
  return ["anyOf", "oneOf", "allOf"].flatMap((key) =>
    Array.isArray(schema[key]) ? (schema[key] as unknown[]) : [],
  );
}

/** A secret here: marked itself, or on a branch (the non-null branch of a nullable field). */
function isSecret(schema: Schema, root: Schema): boolean {
  if (schema["writeOnly"] === true) return true;
  return branchesOf(schema).some((branch) => deref(branch, root)["writeOnly"] === true);
}

/**
 * `value` with every value under a `writeOnly` schema replaced by the
 * marker. A union redacts what any of its branches would: hiding too much
 * is safe, hiding too little is not.
 */
export function redactSecrets(schemaRef: unknown, value: unknown, root?: Schema): unknown {
  if (value === undefined || value === null) return value;
  const top = root ?? (isObject(schemaRef) ? schemaRef : {});
  const schema = deref(schemaRef, top);
  if (isSecret(schema, top)) return SECRET_REDACTED;
  let result: unknown = value;
  for (const branch of branchesOf(schema)) result = redactSecrets(branch, result, top);
  if (Array.isArray(result)) {
    return schema["items"] === undefined
      ? result
      : result.map((item) => redactSecrets(schema["items"], item, top));
  }
  if (isObject(result)) {
    const properties = isObject(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    return Object.fromEntries(
      Object.entries(result).map(([key, item]) => [
        key,
        Object.hasOwn(properties, key)
          ? redactSecrets(properties[key], item, top)
          : isObject(additional)
            ? redactSecrets(additional, item, top)
            : item,
      ]),
    );
  }
  return result;
}

/**
 * `incoming` with every marker replaced by what `stored` holds at the same
 * place (by key, by position in a list). A marker where nothing is stored
 * fails with `CONFIG_SECRET_MISSING`.
 */
export function restoreSecrets(
  incoming: unknown,
  stored: unknown,
  path: readonly string[] = [],
): unknown {
  if (incoming === SECRET_REDACTED) {
    if (stored === undefined || stored === null) {
      throw Object.assign(
        new Error(`No secret is stored at ${path.join(".")} to keep; enter it again`),
        { code: "CONFIG_SECRET_MISSING", details: { path: path.join(".") } },
      );
    }
    return stored;
  }
  if (Array.isArray(incoming)) {
    return incoming.map((item, index) =>
      restoreSecrets(item, Array.isArray(stored) ? stored[index] : undefined, [
        ...path,
        String(index),
      ]),
    );
  }
  if (isObject(incoming)) {
    return Object.fromEntries(
      Object.entries(incoming).map(([key, item]) => [
        key,
        restoreSecrets(item, isObject(stored) ? stored[key] : undefined, [...path, key]),
      ]),
    );
  }
  return incoming;
}
