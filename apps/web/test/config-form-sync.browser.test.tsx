import { configControlSlot, type ConfigControlProps } from "@jhin/client-api";
import { z } from "@jhin/sdk";
import { createSlotRegistry, SlotsProvider } from "@jhin/ui";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { sectionForm, setAt } from "../src/lib/config-form.ts";
import { Fields, type FieldsContext } from "../src/plugins/settings/config-fields.tsx";
import { errorsOf, type Loaded } from "../src/plugins/settings/node-config.tsx";

// The form features of W16 (docs/plans/config-ui.md, D478–D482).
const Rule = z.object({
  key: z.string().meta({ title: "Key", clearWhenEmpty: "persist" }),
  command: z.string().min(1).meta({ title: "Command" }),
  when: z.string().optional().meta({ title: "When" }),
});
const Section = z
  .object({
    label: z.string().default("demo").meta({ title: "Label" }),
    rules: z.array(Rule).default([]).meta({ title: "Rules" }),
    env: z.record(z.string(), z.string()).optional().meta({ title: "Environment" }),
    mode: z.enum(["auto", "custom"]).default("auto").meta({ title: "Mode" }),
    instructions: z
      .string()
      .optional()
      .meta({ title: "Instructions", when: { mode: "custom" } }),
    accent: z.string().optional().meta({ title: "Accent", control: "color" }),
  })
  .meta({ title: "Sync demo" });
const schema = z.toJSONSchema(Section, { io: "input", unrepresentable: "any" });

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

function mountForm(
  original: Record<string, unknown>,
  options: { other?: FieldsContext["other"]; slots?: ReturnType<typeof createSlotRegistry> } = {},
) {
  const form = sectionForm("acme.sync", schema);
  const state: { value: unknown } = { value: original };
  function Form() {
    const [value, setValue] = useState<unknown>(original);
    state.value = value;
    const loaded: Loaded = {
      section: "acme.sync",
      layer: "node",
      read: { layers: { node: original } },
      original,
      value,
    };
    return (
      <Fields
        context={{
          value,
          other: options.other ?? { layer: "project", value: undefined },
          errors: errorsOf(schema, loaded),
          root: schema,
          set: (path, next) => setValue((current: unknown) => setAt(current, path, next)),
        }}
        fields={form.fields}
        path={[]}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      options.slots === undefined ? (
        <Form />
      ) : (
        <SlotsProvider registry={options.slots}>
          <Form />
        </SlotsProvider>
      ),
    ),
  );
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { state };
}

describe("the config form's W16 fields", () => {
  it("keeps an emptied text field as an empty value where the schema says so (D478)", async () => {
    const view = mountForm({ label: "x", rules: [{ key: "mod+k", command: "palette.open" }] });
    await userEvent.clear(page.getByRole("textbox", { name: "Key" }));
    expect(view.state.value).toMatchObject({ rules: [{ key: "", command: "palette.open" }] });
    await expect
      .element(page.getByRole("textbox", { name: "Key" }))
      .toHaveAttribute("placeholder", "Empty");
    // Without the hint, an emptied field leaves the file.
    await userEvent.clear(page.getByRole("textbox", { name: "Label" }));
    expect(view.state.value).not.toHaveProperty("label");
  });

  it("edits an array of objects as a list of groups (D479)", async () => {
    const view = mountForm({
      rules: [
        { key: "a", command: "one" },
        { key: "b", command: "two" },
      ],
    });
    await expect.element(page.getByRole("group", { name: "Rules 2" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Move Rules 2 up" }));
    expect(view.state.value).toEqual({
      rules: [
        { key: "b", command: "two" },
        { key: "a", command: "one" },
      ],
    });
    await userEvent.click(page.getByRole("button", { name: "Remove Rules 1" }));
    await userEvent.click(page.getByRole("button", { name: "Add" }).first());
    expect(view.state.value).toEqual({ rules: [{ key: "a", command: "one" }, {}] });
    // Required keys inside items are checked, next to their field.
    const command = page.getByRole("group", { name: "Rules 2" }).getByRole("textbox", {
      name: "Command",
    });
    await expect.element(command).toHaveAttribute("aria-invalid", "true");
    await userEvent.fill(command, "palette.open");
    await expect.element(command).not.toHaveAttribute("aria-invalid");
  });

  it("renames a record's key in place, refusing an empty or taken one (D480)", async () => {
    const view = mountForm({ env: { A: "1", B: "2" } });
    const key = page.getByRole("textbox", { name: "Key A of Environment" });
    await userEvent.fill(key, "B");
    await expect.element(page.getByText("That key is there already")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(view.state.value).toEqual({ env: { A: "1", B: "2" } });
    await userEvent.fill(key, "");
    await expect.element(page.getByText("A key cannot be empty")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(key).toHaveValue("A");
    await userEvent.fill(key, "C");
    await userEvent.keyboard("{Enter}");
    // Same value, same place.
    expect(Object.entries((view.state.value as { env: object }).env)).toEqual([
      ["C", "1"],
      ["B", "2"],
    ]);
  });

  it("shows a field only while its sibling has the value it names (D481)", async () => {
    mountForm({});
    await expect.element(page.getByRole("textbox", { name: "Label" })).toBeInTheDocument();
    expect(page.getByRole("textbox", { name: "Instructions" }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("combobox", { name: "Mode" }));
    await userEvent.click(page.getByRole("option", { name: "custom" }));
    await expect.element(page.getByRole("textbox", { name: "Instructions" })).toBeInTheDocument();
  });

  it("follows the file that wins, and keeps a hidden field that is set (D481)", async () => {
    // The project file wins over the node file being edited: its mode counts.
    mountForm(
      { mode: "auto", instructions: "kept" },
      { other: { layer: "project", value: { mode: "custom" } } },
    );
    await expect.element(page.getByRole("textbox", { name: "Instructions" })).toHaveValue("kept");
    for (const cleanup of mounted.splice(0)) cleanup();
    // Hidden by its sibling, but set: still shown.
    mountForm({ instructions: "set" });
    await expect.element(page.getByRole("textbox", { name: "Instructions" })).toHaveValue("set");
  });

  it("renders the control a plugin contributes, else the built-in one (D482)", async () => {
    mountForm({});
    await expect.element(page.getByRole("textbox", { name: "Accent" })).toBeInTheDocument();
    for (const cleanup of mounted.splice(0)) cleanup();

    const slots = createSlotRegistry();
    const seen: ConfigControlProps[] = [];
    function Swatch(props: ConfigControlProps) {
      seen.push(props);
      return (
        <button
          aria-label={`${props.label} swatch`}
          onClick={() => props.onChange("#ff0000")}
          type="button"
        >
          {String(props.value ?? "none")}
        </button>
      );
    }
    slots.contribute<ConfigControlProps>(configControlSlot("color"), {
      id: "acme.swatch",
      component: Swatch,
    });
    const view = mountForm({}, { slots });
    await userEvent.click(page.getByRole("button", { name: "Accent swatch" }));
    expect(view.state.value).toEqual({ accent: "#ff0000" });
    await expect
      .element(page.getByRole("button", { name: "Accent swatch" }))
      .toHaveTextContent("#ff0000");
    expect(seen.at(-1)?.field).toMatchObject({ key: "accent", path: ["accent"], title: "Accent" });
  });
});
