import { z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { SECRET_REDACTED } from "@jhin/host-api";

import { redactSecrets, restoreSecrets } from "../src/secrets.ts";

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
      restoreSecrets(schema, { a: SECRET_REDACTED, list: ["new", SECRET_REDACTED], plain: "x" }, [
        { a: "old-a", list: ["one", "two"] },
      ]),
    ).toEqual({ a: "old-a", list: ["new", "two"], plain: "x" });
  });

  it("keeps the marker as a value where no secret is", () => {
    const schema = schemaOf(z.object({ shown: z.string() }));
    expect(restoreSecrets(schema, { shown: SECRET_REDACTED }, [{ shown: "old" }])).toEqual({
      shown: SECRET_REDACTED,
    });
  });

  it("refuses a marker where nothing is stored, naming where", () => {
    const schema = schemaOf(
      z.object({ env: z.record(z.string(), z.string().meta({ writeOnly: true })) }),
    );
    expect(() =>
      restoreSecrets(schema, { env: { B: SECRET_REDACTED } }, [{ env: {} }], ["s"]),
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
      pair: ["user", SECRET_REDACTED],
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
      list: [SECRET_REDACTED],
      nested: { b: SECRET_REDACTED },
    });
    expect(restoreSecrets(undefined, hidden, [value])).toEqual(value);
  });

  it("keeps a secret from the next source when the first has none", () => {
    const schema = schemaOf(z.object({ key: z.string().meta({ writeOnly: true }) }));
    expect(restoreSecrets(schema, { key: SECRET_REDACTED }, [{}, { key: "effective" }])).toEqual({
      key: "effective",
    });
  });
});
