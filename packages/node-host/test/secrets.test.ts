import { z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { SECRET_REDACTED } from "@jhin/host-api";

import { redactSecrets, restoreSecrets, scrub, secretTexts } from "../src/secrets.ts";

const schemaOf = (type: z.ZodType) => z.toJSONSchema(type, { io: "input", unrepresentable: "any" });

describe("config secrets (security.md D417)", () => {
  it("hides writeOnly values wherever they are: nested, nullable, listed, in records and in shared definitions", () => {
    const Credential = z.object({
      user: z.string(),
      password: z.string().meta({ writeOnly: true }),
    });
    const schema = schemaOf(
      z.object({
        name: z.string(),
        token: z.string().nullable().optional().meta({ writeOnly: true }),
        keys: z.array(z.string()).meta({ writeOnly: true }).optional(),
        hosts: z.record(z.string(), Credential).optional(),
        backup: Credential.optional(),
        either: z.union([z.string(), z.object({ secret: z.string().meta({ writeOnly: true }) })]),
      }),
    );
    expect(
      redactSecrets(schema, {
        name: "n",
        token: null,
        keys: ["a", "b"],
        hosts: { gh: { user: "u", password: "p" } },
        backup: { user: "v", password: "q" },
        either: { secret: "x" },
      }),
    ).toEqual({
      name: "n",
      token: null,
      keys: SECRET_REDACTED,
      hosts: { gh: { user: "u", password: SECRET_REDACTED } },
      backup: { user: "v", password: SECRET_REDACTED },
      either: { secret: SECRET_REDACTED },
    });
  });

  it("puts stored values back where a secret's marker is, by key and by position", () => {
    const schema = schemaOf(
      z.object({
        a: z.string().meta({ writeOnly: true }),
        list: z.array(z.string().meta({ writeOnly: true })),
        plain: z.string(),
      }),
    );
    expect(
      restoreSecrets(
        schema,
        { a: SECRET_REDACTED, list: ["new", SECRET_REDACTED], plain: "x" },
        { a: "old-a", list: ["one", "two"] },
        undefined,
      ),
    ).toEqual({ a: "old-a", list: ["new", "two"], plain: "x" });
  });

  it("keeps the marker as a value where no secret is", () => {
    const schema = schemaOf(z.object({ shown: z.string() }));
    expect(restoreSecrets(schema, { shown: SECRET_REDACTED }, { shown: "old" }, undefined)).toEqual(
      {
        shown: SECRET_REDACTED,
      },
    );
  });

  it("refuses a marker where nothing is stored, naming where", () => {
    const schema = schemaOf(
      z.object({ env: z.record(z.string(), z.string().meta({ writeOnly: true })) }),
    );
    expect(() =>
      restoreSecrets(schema, { env: { B: SECRET_REDACTED } }, { env: {} }, undefined, ["s"]),
    ).toThrow(
      expect.objectContaining({ code: "CONFIG_SECRET_MISSING", details: { path: "s.env.B" } }),
    );
  });

  it("follows tuples, key patterns and conditional branches", () => {
    const schema = {
      type: "object",
      properties: {
        pair: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "string", writeOnly: true }],
        },
        vars: {
          type: "object",
          patternProperties: { "^SECRET_": { type: "string", writeOnly: true } },
        },
        mode: {
          if: { properties: { kind: { const: "key" } } },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's own keyword
          then: { properties: { key: { type: "string", writeOnly: true } } },
        },
      },
    };
    expect(
      redactSecrets(schema, {
        pair: ["user", "pw"],
        vars: { SECRET_A: "s", PLAIN: "p" },
        mode: { kind: "key", key: "k" },
      }),
    ).toEqual({
      pair: ["user", `${SECRET_REDACTED}#/pair/1`],
      vars: { SECRET_A: SECRET_REDACTED, PLAIN: "p" },
      mode: { kind: "key", key: SECRET_REDACTED },
    });
  });

  it("hides every scalar of a section whose schema is unknown, and restores them", () => {
    const value = { a: "x", n: 1, list: ["y"], nested: { b: true } };
    const hidden = redactSecrets(undefined, value);
    expect(hidden).toEqual({
      a: SECRET_REDACTED,
      n: SECRET_REDACTED,
      list: [`${SECRET_REDACTED}#/list/0`],
      nested: { b: SECRET_REDACTED },
    });
    expect(restoreSecrets(undefined, hidden as Record<string, unknown>, value, undefined)).toEqual(
      value,
    );
  });

  it("leaves out a secret only another layer holds, never copying it into this one", () => {
    const schema = schemaOf(
      z.object({
        key: z.string().meta({ writeOnly: true }),
        env: z.record(z.string(), z.string().meta({ writeOnly: true })),
        keys: z.array(z.string().meta({ writeOnly: true })),
      }),
    );
    const effective = { key: "project-key", env: { A: "project-a" }, keys: ["project-k"] };
    expect(
      restoreSecrets(
        schema,
        { key: SECRET_REDACTED, env: { A: SECRET_REDACTED, B: "new" } },
        {},
        effective,
      ),
    ).toEqual({ env: { B: "new" } });
    // A list cannot leave one item out.
    expect(() => restoreSecrets(schema, { keys: [SECRET_REDACTED] }, {}, effective, ["s"])).toThrow(
      expect.objectContaining({ code: "CONFIG_SECRET_MISSING", details: { path: "s.keys.0" } }),
    );
  });

  it("finds the text of secrets and scrubs it from messages", () => {
    const schema = schemaOf(
      z.object({ key: z.string().meta({ writeOnly: true }), name: z.string() }),
    );
    const secrets = secretTexts(schema, { key: "hunter22", name: "visible" });
    expect(secrets).toEqual(["hunter22"]);
    expect(scrub("hunter22 is not a valid key for visible", secrets)).toBe(
      `${SECRET_REDACTED} is not a valid key for visible`,
    );
  });

  it("keeps the right secret when a list is reordered or shortened", () => {
    const schema = schemaOf(z.object({ keys: z.array(z.string().meta({ writeOnly: true })) }));
    const stored = { keys: ["first", "second", "third"] };
    const shown = redactSecrets(schema, stored) as { keys: string[] };
    expect(shown.keys).toEqual([
      `${SECRET_REDACTED}#/keys/0`,
      `${SECRET_REDACTED}#/keys/1`,
      `${SECRET_REDACTED}#/keys/2`,
    ]);
    // The first removed and the last moved up front.
    expect(
      restoreSecrets(schema, { keys: [shown.keys[2], shown.keys[1]] }, stored, undefined),
    ).toEqual({ keys: ["third", "second"] });
  });

  it("refuses an addressed marker that names no secret", () => {
    const schema = schemaOf(
      z.object({ keys: z.array(z.string().meta({ writeOnly: true })), name: z.string() }),
    );
    expect(() =>
      restoreSecrets(
        schema,
        { keys: [`${SECRET_REDACTED}#/name`] },
        { keys: [], name: "n" },
        undefined,
      ),
    ).toThrow(expect.objectContaining({ code: "CONFIG_SECRET_MISSING" }));
  });

  it("follows dependent schemas, unevaluated properties and contains", () => {
    const schema = {
      type: "object",
      properties: {
        a: {
          type: "object",
          dependentSchemas: { kind: { properties: { key: { writeOnly: true } } } },
        },
        b: { type: "object", unevaluatedProperties: { type: "string", writeOnly: true } },
        c: { type: "array", contains: { type: "string", writeOnly: true } },
      },
    };
    expect(redactSecrets(schema, { a: { kind: 1, key: "k" }, b: { x: "y" }, c: ["z"] })).toEqual({
      a: { kind: 1, key: SECRET_REDACTED },
      b: { x: SECRET_REDACTED },
      c: [`${SECRET_REDACTED}#/c/0`],
    });
  });

  it("addresses list secrets under keys with dots and slashes", () => {
    const schema = schemaOf(
      z.object({
        hosts: z.record(
          z.string(),
          z.object({ keys: z.array(z.string().meta({ writeOnly: true })) }),
        ),
      }),
    );
    const stored = { hosts: { "a.example.com/x": { keys: ["k"] } } };
    const shown = redactSecrets(schema, stored) as typeof stored;
    expect(shown.hosts["a.example.com/x"].keys).toEqual([
      `${SECRET_REDACTED}#/hosts/a.example.com~1x/keys/0`,
    ]);
    expect(restoreSecrets(schema, shown, stored, undefined)).toEqual(stored);
  });

  it("never takes an inherited property for a stored secret", () => {
    const schema = schemaOf(
      z.object({ env: z.record(z.string(), z.string().meta({ writeOnly: true })) }),
    );
    expect(() =>
      restoreSecrets(schema, { env: { constructor: SECRET_REDACTED } }, { env: {} }, undefined),
    ).toThrow(expect.objectContaining({ code: "CONFIG_SECRET_MISSING" }));
  });
});
