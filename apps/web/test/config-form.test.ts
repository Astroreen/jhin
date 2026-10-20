import { SECRET_REDACTED } from "@jhin/client-api";
import { z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  changesOf,
  getAt,
  hasUnparsed,
  HIDDEN,
  humanize,
  redact,
  restore,
  sectionForm,
  setAt,
  Unparsed,
  validate,
  type Field,
} from "../src/lib/config-form.ts";

/** What `host.config.schema` serves for a section declared with `schema`. */
const served = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

const Http = z
  .object({
    host: z.string().default("127.0.0.1").meta({ title: "Host", description: "Interface." }),
    port: z.number().int().min(0).max(65_535).default(7777).describe("0 picks a free port."),
    open: z.boolean().default(false),
    forwardedHeader: z.enum(["x-forwarded-for", "forwarded"]).default("x-forwarded-for"),
    history: z.union([z.literal("on-open").meta({ title: "On open" }), z.literal("eager")]),
    trustProxy: z.array(z.string()).default([]).meta({ advanced: true }),
    hide: z.record(z.string(), z.array(z.string())).default({}),
    tls: z
      .object({ cert: z.string().optional(), key: z.string().optional().meta({ writeOnly: true }) })
      .meta({ title: "TLS", description: "Certificates." })
      .optional(),
    expiryHours: z.number().positive().nullable().default(720),
    rules: z.array(z.object({ key: z.string() })).default([]),
    shape: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]).optional(),
    anything: z.unknown(),
  })
  .meta({ title: "HTTP server", description: "Where the node listens." });

const byKey = (fields: readonly Field[]) => new Map(fields.map((field) => [field.key, field]));

describe("a section's schema as a form (D80)", () => {
  const form = sectionForm("jhin.http", served(Http));
  const fields = byKey(form.fields);

  it("takes the section's title and description from the schema", () => {
    expect(form).toMatchObject({
      section: "jhin.http",
      title: "HTTP server",
      description: "Where the node listens.",
    });
  });

  it("keeps the schema's key order", () => {
    expect(form.fields.map((field) => field.key)).toEqual(Object.keys(Http.shape));
  });

  it("maps each kind of value to its control", () => {
    expect(fields.get("host")?.control).toEqual({ kind: "text", secret: false });
    expect(fields.get("port")?.control).toEqual({ kind: "number", integer: true });
    expect(fields.get("open")?.control).toEqual({ kind: "switch" });
    expect(fields.get("forwardedHeader")?.control).toEqual({
      kind: "select",
      options: [
        { value: "x-forwarded-for", label: "x-forwarded-for" },
        { value: "forwarded", label: "forwarded" },
      ],
    });
    // A union of literals is a choice too, labelled by their titles.
    expect(fields.get("history")?.control).toEqual({
      kind: "select",
      options: [
        { value: "on-open", label: "On open" },
        { value: "eager", label: "eager" },
      ],
    });
    expect(fields.get("trustProxy")?.control).toMatchObject({
      kind: "list",
      item: { control: { kind: "text" } },
    });
    expect(fields.get("hide")?.control).toMatchObject({
      kind: "map",
      value: { control: { kind: "list", item: { control: { kind: "text" } } } },
    });
  });

  it("turns a nested object into a group with its own header and fields", () => {
    const tls = fields.get("tls")!;
    expect(tls).toMatchObject({ title: "TLS", description: "Certificates." });
    expect(tls.control.kind).toBe("group");
    const inner = tls.control.kind === "group" ? byKey(tls.control.fields) : new Map();
    expect(inner.get("cert")).toMatchObject({ path: ["tls", "cert"], title: "Cert" });
    // A secret is marked by JSON Schema's writeOnly (D83).
    expect(inner.get("key")).toMatchObject({
      secret: true,
      control: { kind: "text", secret: true },
    });
  });

  it("renders a nullable value as its other branch that can also be none", () => {
    expect(fields.get("expiryHours")).toMatchObject({
      nullable: true,
      default: 720,
      control: { kind: "number", integer: false },
    });
  });

  it("edits what the form cannot render as JSON in place, not failing the form", () => {
    expect(fields.get("rules")?.control).toEqual({ kind: "json" });
    expect(fields.get("shape")?.control).toEqual({ kind: "json" });
    expect(fields.get("anything")?.control).toEqual({ kind: "json" });
  });

  it("shows defaults, hints and titles made from keys", () => {
    expect(fields.get("host")).toMatchObject({
      title: "Host",
      description: "Interface.",
      hasDefault: true,
      default: "127.0.0.1",
    });
    expect(fields.get("port")).toMatchObject({
      title: "Port",
      description: "0 picks a free port.",
    });
    expect(fields.get("forwardedHeader")?.title).toBe("Forwarded header");
    expect(fields.get("trustProxy")?.advanced).toBe(true);
    expect(fields.get("history")?.hasDefault).toBe(false);
  });

  it("gives no fields for a section that is no object with keys", () => {
    expect(sectionForm("s", served(z.record(z.string(), z.string()))).fields).toEqual([]);
    expect(sectionForm("s", served(z.unknown())).fields).toEqual([]);
    expect(sectionForm("s", {})).toMatchObject({ title: "s", fields: [] });
  });

  it("follows a local $ref", () => {
    const Rule = z.object({ on: z.boolean() }).meta({ id: "Rule" });
    const schema = served(z.object({ first: Rule, second: Rule }));
    expect(JSON.stringify(schema)).toContain('"$ref"');
    const refs = byKey(sectionForm("s", schema).fields);
    expect(refs.get("second")?.control).toMatchObject({
      kind: "group",
      fields: [{ key: "on", control: { kind: "switch" } }],
    });
  });
});

describe("comments in the config files as descriptions (D81)", () => {
  const schema = served(
    z.object({
      greeting: z.string().default("Hello"),
      described: z.string().optional().describe("From the schema."),
      group: z.object({ inner: z.boolean().optional() }).optional(),
    }),
  );
  const form = sectionForm("jhin.example", schema, [
    { path: [], text: "The example section." },
    { path: ["greeting"], text: "The first word." },
    { path: ["described"], text: "Not shown: the schema says it." },
    { path: ["group", "inner"], text: "Deep inside." },
  ]);
  const fields = byKey(form.fields);

  it("describes a field without a schema description by the comment above its key", () => {
    expect(fields.get("greeting")?.description).toBe("The first word.");
    const group = fields.get("group")!.control;
    expect(group.kind === "group" ? group.fields[0]?.description : undefined).toBe("Deep inside.");
  });

  it("prefers the schema's description", () => {
    expect(fields.get("described")?.description).toBe("From the schema.");
  });

  it("describes the section by the comment above its key", () => {
    expect(form.description).toBe("The example section.");
  });
});

describe("checking a section as edited (D84)", () => {
  const schema = served(Http);

  it("accepts a partial node file: what it leaves out comes from elsewhere", () => {
    expect(validate(schema, {})).toEqual([]);
    expect(validate(schema, { port: 8080, tls: { cert: "a.pem" }, expiryHours: null })).toEqual([]);
  });

  it("reports each wrong value at its path", () => {
    expect(
      validate(schema, {
        port: 70_000,
        host: 1,
        forwardedHeader: "via",
        trustProxy: ["ok", 2],
        expiryHours: 0,
        hide: { sidebar: [1] },
      }),
    ).toEqual([
      { path: "port", message: "Must be at most 65535" },
      { path: "host", message: "Expected text" },
      { path: "forwardedHeader", message: 'Must be one of "x-forwarded-for", "forwarded"' },
      { path: "trustProxy.1", message: "Expected text" },
      { path: "expiryHours", message: "Must be greater than 0" },
      { path: "hide.sidebar.0", message: "Expected text" },
    ]);
    expect(validate(schema, { port: 1.5 })).toEqual([
      { path: "port", message: "Expected a whole number" },
    ]);
  });

  it("checks required keys inside arrays, which replace rather than merge", () => {
    expect(validate(schema, { rules: [{}] })).toEqual([
      { path: "rules.0.key", message: "Required" },
    ]);
  });

  it("reports text that is no value yet, and never lets it be saved", () => {
    const value = { port: new Unparsed("80a", "Enter a number") };
    expect(validate(schema, value)).toEqual([{ path: "port", message: "Enter a number" }]);
    expect(hasUnparsed(value)).toBe(true);
    expect(hasUnparsed({ port: 80 })).toBe(false);
  });
});

describe("editing and saving values", () => {
  it("sets and removes keys in place, keeping the file's order", () => {
    const value = { a: 1, b: { c: 2 }, d: 3 };
    expect(Object.keys(setAt(value, ["b", "c"], 5) as object)).toEqual(["a", "b", "d"]);
    expect(setAt(value, ["b", "c"], 5)).toEqual({ a: 1, b: { c: 5 }, d: 3 });
    expect(setAt(value, ["a"], undefined)).toEqual({ b: { c: 2 }, d: 3 });
    expect(setAt(undefined, ["x", "y"], true)).toEqual({ x: { y: true } });
    // A list's items by their index.
    expect(setAt({ l: ["a", "b"] }, ["l", "1"], "c")).toEqual({ l: ["a", "c"] });
    expect(setAt({ l: ["a", "b"] }, ["l", "0"], undefined)).toEqual({ l: ["b"] });
    expect(getAt({ l: ["a", { k: 1 }] }, ["l", "1", "k"])).toBe(1);
  });

  it("writes only the top-level keys that changed, and removes the ones reset", () => {
    expect(
      changesOf({ host: "0.0.0.0", port: 1, tls: { cert: "a" } }, { port: 2, tls: { cert: "a" } }),
    ).toEqual({ values: { port: 2 }, unset: ["host"] });
    expect(changesOf(undefined, { open: true })).toEqual({ values: { open: true }, unset: [] });
  });

  it("titles keys in sentence case", () => {
    expect(humanize("trustProxy")).toBe("Trust proxy");
    expect(humanize("queueExpiryHours")).toBe("Queue expiry hours");
    expect(humanize("default_agent")).toBe("Default agent");
  });
});

describe("multiples", () => {
  it("accepts a decimal that is a multiple of a fractional step", () => {
    const schema = served(z.object({ ratio: z.number().multipleOf(0.1) }));
    // 0.3 / 0.1 is 2.9999999999999996 in floating point.
    expect(validate(schema, { ratio: 0.3 })).toEqual([]);
    expect(validate(schema, { ratio: 0.7 })).toEqual([]);
    expect(validate(schema, { ratio: 0.35 })).toEqual([
      { path: "ratio", message: "Must be a multiple of 0.1" },
    ]);
  });
});

describe("secrets (D83)", () => {
  const Secret = z.object({
    token: z.string().optional().meta({ writeOnly: true }),
    // Marked before `.nullable()`: on the non-null branch.
    pin: z.string().meta({ writeOnly: true }).nullable().optional(),
    keys: z.array(z.string()).optional().meta({ writeOnly: true }),
    vault: z.record(z.string(), z.string().meta({ writeOnly: true })).optional(),
    auth: z
      .union([
        z.object({ password: z.string().meta({ writeOnly: true }) }),
        z.object({ none: z.boolean() }),
      ])
      .optional(),
    name: z.string().optional(),
  });
  const schema = served(Secret);
  const fields = byKey(sectionForm("s", schema).fields);

  it("marks a secret, and everything inside it, wherever it is written", () => {
    expect(fields.get("token")?.secret).toBe(true);
    expect(fields.get("pin")).toMatchObject({ secret: true, nullable: true });
    expect(fields.get("keys")?.control).toMatchObject({ kind: "list", item: { secret: true } });
    expect(fields.get("vault")?.control).toMatchObject({ kind: "map", value: { secret: true } });
    expect(fields.get("name")?.secret).toBe(false);
  });

  it("accepts the node's marker for a stored secret, of any type, and only there (security.md D417)", () => {
    const typed = served(
      z.object({
        count: z.number().meta({ writeOnly: true }).optional(),
        keys: z.array(z.string()).optional().meta({ writeOnly: true }),
        name: z.string().optional(),
        size: z.number().optional(),
      }),
    );
    expect(validate(typed, { count: SECRET_REDACTED, keys: SECRET_REDACTED })).toEqual([]);
    expect(validate(typed, { size: SECRET_REDACTED })).not.toEqual([]);
    // Shown in JSON as the placeholder, and sent back as the marker the node gave.
    expect(redact(typed, { count: SECRET_REDACTED }, typed)).toEqual({ count: HIDDEN });
    expect(restore({ count: HIDDEN }, { count: SECRET_REDACTED })).toEqual({
      count: SECRET_REDACTED,
    });
  });

  it("hides secrets in JSON and puts them back where the placeholder is left", () => {
    const value = {
      token: "t",
      pin: null,
      keys: ["k"],
      vault: { a: "v" },
      auth: { password: "pw" },
      name: "n",
    };
    const hidden = redact(schema, value, schema);
    expect(hidden).toEqual({
      token: HIDDEN,
      pin: null,
      keys: HIDDEN,
      vault: { a: HIDDEN },
      auth: { password: HIDDEN },
      name: "n",
    });
    expect(restore({ ...(hidden as object), name: "m" }, value)).toEqual({ ...value, name: "m" });
    // A placeholder where nothing was stored is refused, never saved.
    expect(validate(schema, restore({ token: HIDDEN }, {}))).toEqual([
      { path: "token", message: "Enter the secret: there is no stored one here" },
    ]);
  });
});
