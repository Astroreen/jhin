import { z } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { Config } from "../src/index.ts";

describe("the jhin.agent-claude section on the settings page (config-ui.md)", () => {
  const schema = z.toJSONSchema(Config, { io: "input", unrepresentable: "any" }) as {
    title?: string;
    description?: string;
    properties: Record<string, { title?: string; description?: string; writeOnly?: boolean }>;
  };

  it("titles and describes the section and every field", () => {
    expect(schema).toMatchObject({ title: "Claude Code", description: expect.any(String) });
    for (const [key, field] of Object.entries(schema.properties)) {
      expect({ key, title: field.title, description: field.description }).toEqual({
        key,
        title: expect.any(String),
        description: expect.any(String),
      });
    }
  });

  it("marks the environment a secret, so the page hides its values (D83)", () => {
    expect(schema.properties["env"]?.writeOnly).toBe(true);
  });
});
