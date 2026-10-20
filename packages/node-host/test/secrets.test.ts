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

  it("puts stored values back where the marker is, by key and by position", () => {
    expect(
      restoreSecrets(
        { a: SECRET_REDACTED, list: ["new", SECRET_REDACTED], plain: "x" },
        { a: "old-a", list: ["one", "two"] },
      ),
    ).toEqual({ a: "old-a", list: ["new", "two"], plain: "x" });
  });

  it("refuses a marker where nothing is stored, naming where", () => {
    expect(() => restoreSecrets({ env: { B: SECRET_REDACTED } }, { env: {} }, ["s"])).toThrow(
      expect.objectContaining({ code: "CONFIG_SECRET_MISSING", details: { path: "s.env.B" } }),
    );
  });
});
