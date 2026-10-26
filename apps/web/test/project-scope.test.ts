import { projectSettingsRecord } from "@jhin/agent-api";
import { z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { sectionForm, type JsonSchema } from "../src/lib/config-form.ts";
import {
  inheritanceLayers,
  overridesOf,
  projectEntrySchema,
  projectFormSchema,
  projectKeys,
  t3FileFields,
} from "../src/plugins/settings/project-scope.tsx";

const Mode = z.union([
  z.literal("recursive").meta({ title: "Recursive" }),
  z.literal("none").meta({ title: "Skip" }),
]);
const Section = z.object({
  watch: z.boolean().default(true),
  mode: Mode.optional(),
  prefix: z.string().default("jhin"),
  projects: projectSettingsRecord({
    mode: Mode.optional().meta({ t3File: "worktreeSubmodules", builtIn: "recursive" }),
    prefix: z.string().optional(),
  }),
});
const schema = z.toJSONSchema(Section, { io: "input", unrepresentable: "any" }) as JsonSchema;

describe("the settings page's project scope (config-ui.md D1463)", () => {
  it("finds a section's project settings, and the t3.json fields that back them", () => {
    const entry = projectEntrySchema(schema)!;
    expect(projectKeys(entry)).toEqual(["mode", "prefix"]);
    expect([...t3FileFields(entry)]).toEqual([["mode", "worktreeSubmodules"]]);
    // A record without the marker is no project settings record.
    const plain = z.toJSONSchema(z.object({ projects: z.record(z.string(), z.string()) }), {
      io: "input",
    }) as JsonSchema;
    expect(projectEntrySchema(plain)).toBeUndefined();
  });

  it("gives a project's field what it inherits as its default", () => {
    const entry = projectEntrySchema(schema)!;
    const form = sectionForm(
      "acme",
      projectFormSchema(schema, entry, (key) => ({ mode: "none", prefix: "team" })[key]),
    );
    expect(form.fields.map((field) => [field.key, field.default])).toEqual([
      ["mode", "none"],
      ["prefix", "team"],
    ]);
  });

  it("lists the layers in T3's order and checks the one in effect", () => {
    const layers = (input: Partial<Parameters<typeof inheritanceLayers>[0]>) =>
      inheritanceLayers({
        field: undefined,
        nodeLabel: "laptop",
        project: undefined,
        node: undefined,
        fallback: "recursive",
        ...input,
      }).map((layer) => `${layer.label}=${layer.value}${layer.effective ? "*" : ""}`);
    expect(layers({ project: "none", node: "recursive", t3File: { value: "none" } })).toEqual([
      "Project=none*",
      "laptop=recursive",
      "t3.json=none",
      "Default=recursive",
    ]);
    expect(layers({ t3File: { value: "none" } })).toEqual([
      "Project=Inherits",
      "laptop=Inherits",
      "t3.json=none*",
      "Default=recursive",
    ]);
    expect(layers({ node: true })).toEqual(["Project=Inherits", "laptop=On*", "Default=recursive"]);
  });

  it("counts the overrides of the node's projects only", () => {
    const file = { projects: { a: { mode: "none" }, b: { prefix: "x" }, gone: { mode: "none" } } };
    expect(overridesOf(file, "mode", ["a", "b"])).toBe(1);
    expect(overridesOf({}, "mode", ["a"])).toBe(0);
  });
});
