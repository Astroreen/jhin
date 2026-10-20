/**
 * Secrets in config sections (security.md D417): values a section's JSON
 * Schema marks `writeOnly` (config-ui.md D83) never leave the node through
 * `host.config.get`; a change that carries the marker back keeps what is
 * stored. The marker is T3 Code's `SECRET_REDACTED`
 * (apps/server/src/settingsSecrets.ts).
 */

import { SECRET_REDACTED, isRedactedSecret } from "@jhin/host-api";

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
  return deref(target, root, depth + 1);
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
    // Inside a list, the marker names its secret's place, so a reorder keeps it.
    (_value, path) =>
      path.some((part) => /^\d+$/.test(part))
        ? `${SECRET_REDACTED}#${toPointer(path)}`
        : SECRET_REDACTED,
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
 * (`stored`) holds at the same place, by key or by position in a list. The
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
  const restored = mapSecrets(
    schema === undefined ? undefined : [schema],
    incoming,
    rootOf(schema),
    [],
    (value, path) => {
      if (!isRedactedSecret(value)) return value;
      // An addressed marker is the secret at that place, wherever it was moved to.
      const address =
        value === SECRET_REDACTED ? path : fromPointer(value.slice(SECRET_REDACTED.length + 1));
      // An address names a secret of the layer, nothing else.
      if (
        address === undefined ||
        (value !== SECRET_REDACTED &&
          !secretPaths(schema, stored).some((secret) => toPointer(secret) === toPointer(address)))
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
      // Short values ("1", "on") would scrub ordinary words too.
      if (text.length >= 4) found.push(text);
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
  return [...secrets]
    .toSorted((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join(SECRET_REDACTED), text);
}
