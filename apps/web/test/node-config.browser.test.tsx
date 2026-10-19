import { z } from "@jhin/sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { changesOf, sectionForm, setAt } from "../src/lib/config-form.ts";
import { Fields } from "../src/plugins/settings/config-fields.tsx";
import {
  errorsOf,
  readBack,
  useLoadedSection,
  type Loaded,
} from "../src/plugins/settings/node-config.tsx";

/** A node whose `host.config.get` answers wait until the test gives them. */
function slowNode() {
  const waiting = new Map<string, (read: unknown) => void>();
  return {
    client: {
      call: <T,>(method: string, params?: unknown) => {
        const { section } = params as { section: string };
        expect(method).toBe("host.config.get");
        return new Promise<T>((resolve) => waiting.set(section, (read) => resolve(read as T)));
      },
    },
    /** The node's file holds `values` for the section. */
    answer: (section: string, values: unknown) =>
      act(async () => waiting.get(section)!({ value: values, layers: { node: values } })),
  };
}

describe("the node config editor", () => {
  it("edits the section chosen last, whatever order the node answers in", async () => {
    const node = slowNode();
    const editor: {
      loaded?: ReturnType<typeof useLoadedSection>[0];
      choose?: (section: string) => void;
    } = {};
    function Editor() {
      const [section, setSection] = useState("a");
      editor.choose = setSection;
      [editor.loaded] = useLoadedSection(node.client, section);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Editor />));
    act(() => editor.choose!("b"));

    await node.answer("b", { from: "b" });
    await node.answer("a", { from: "a" });
    expect(editor.loaded?.section).toBe("b");
    expect(editor.loaded?.value).toEqual({ from: "b" });
    act(() => root.unmount());
  });
});

describe("reading a section back after a save", () => {
  const saving: Loaded = {
    section: "a",
    read: { value: { x: 1 }, layers: { node: { x: 1 } } },
    original: { x: 1 },
    value: { x: 2 },
  };
  const saved = { value: { x: 2 }, layers: { node: { x: 2 } } };

  it("shows the file as saved when nothing was changed meanwhile", () => {
    expect(readBack(saving, "a", saving.value, saved)).toEqual({
      section: "a",
      read: saved,
      original: { x: 2 },
      value: { x: 2 },
    });
  });

  it("keeps what was changed while saving, as an edit of the saved file", () => {
    const typed = { ...saving, value: { x: 3 } };
    expect(readBack(typed, "a", saving.value, saved)).toEqual({
      ...typed,
      read: saved,
      original: { x: 2 },
    });
  });

  it("leaves another section alone", () => {
    const other = { ...saving, section: "b" };
    expect(readBack(other, "a", saving.value, saved)).toBe(other);
  });
});

const Server = z
  .object({
    open: z.boolean().default(false).meta({ title: "Open to the network" }),
    name: z.string().min(1).optional(),
    port: z.number().int().min(0).max(65_535).default(7777),
    header: z.enum(["x-forwarded-for", "forwarded"]).default("x-forwarded-for"),
    proxies: z.array(z.string()).default([]),
    tls: z.object({ cert: z.string().optional() }).meta({ title: "TLS" }).optional(),
    shape: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]).optional(),
  })
  .meta({ title: "Server" });
const schema = z.toJSONSchema(Server, { io: "input", unrepresentable: "any" });

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

/** The form of the section over a node file holding `original`, as the settings page shows it. */
function mountForm(original: Record<string, unknown>, issues: Loaded["read"]["issues"] = []) {
  const form = sectionForm("acme.server", schema, [{ path: ["name"], text: "How others see it." }]);
  const state: { value: unknown } = { value: original };
  function Form() {
    const [value, setValue] = useState<unknown>(original);
    state.value = value;
    const loaded: Loaded = {
      section: "acme.server",
      read: { layers: { node: original }, issues },
      original,
      value,
    };
    return (
      <Fields
        context={{
          value,
          project: undefined,
          errors: errorsOf(schema, loaded),
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
  act(() => root.render(<Form />));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { state };
}

describe("a config section as a form (D80)", () => {
  it("edits a switch, a text field and a choice, and saves only what changed", async () => {
    const view = mountForm({ port: 8080, proxies: ["10.0.0.1"] });

    // Unstyled here, the switch has no size to click: it is toggled from the keyboard.
    (page.getByRole("switch", { name: "Open to the network" }).element() as HTMLElement).focus();
    await userEvent.keyboard(" ");
    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "edge");
    await userEvent.click(page.getByRole("combobox", { name: "Header" }));
    await userEvent.click(page.getByRole("option", { name: "forwarded", exact: true }));

    expect(view.state.value).toEqual({
      port: 8080,
      proxies: ["10.0.0.1"],
      open: true,
      name: "edge",
      header: "forwarded",
    });
    expect(changesOf({ port: 8080, proxies: ["10.0.0.1"] }, view.state.value as never)).toEqual({
      values: { open: true, name: "edge", header: "forwarded" },
      unset: [],
    });
  });

  it("shows descriptions from comments, defaults, groups and lists", async () => {
    const view = mountForm({ proxies: ["10.0.0.1"] });

    expect(page.getByText("How others see it.").element()).toBeTruthy();
    // The default shows while the key is unset.
    expect(page.getByRole("textbox", { name: "Port" }).element()).toHaveProperty(
      "placeholder",
      "7777",
    );
    expect(page.getByRole("group", { name: "TLS" }).element()).toBeTruthy();
    // A list of values: one field per item, items added and removed.
    await userEvent.click(page.getByRole("button", { name: "Add" }).first());
    await userEvent.fill(page.getByRole("textbox", { name: "Proxies 2" }), "10.0.0.2");
    await userEvent.click(page.getByRole("button", { name: "Remove Proxies 1" }));
    expect(view.state.value).toEqual({ proxies: ["10.0.0.2"] });
  });

  it("reports a wrong value next to its field, and resets a key to its default", async () => {
    const view = mountForm({ port: 8080 });
    const port = page.getByRole("textbox", { name: "Port" });

    await userEvent.fill(port, "70000");
    expect(port.element().getAttribute("aria-invalid")).toBe("true");
    expect(page.getByRole("alert").element().textContent).toBe("Must be at most 65535");

    await userEvent.fill(port, "80a");
    expect(page.getByRole("alert").element().textContent).toBe("Enter a whole number");

    await userEvent.click(page.getByRole("button", { name: "Reset Port to default" }));
    expect(view.state.value).toEqual({});
    expect(port.element().getAttribute("aria-invalid")).toBeNull();
  });

  it("edits what it cannot render as JSON in place", async () => {
    const view = mountForm({});
    const shape = page.getByRole("textbox", { name: "Shape" });

    await userEvent.fill(shape, '{ "a": ');
    expect(page.getByRole("alert").element().textContent).toMatch(/^Invalid JSON/);
    await userEvent.fill(shape, '{ "b": 1 }');
    expect(view.state.value).toEqual({ shape: { b: 1 } });
  });

  it("shows the node's own complaint at its field until the value changes", async () => {
    mountForm({ name: "x" }, [{ path: "name", message: "Taken by another node" }]);
    expect(page.getByRole("alert").element().textContent).toBe("Taken by another node");

    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "y");
    expect(page.getByRole("alert").elements()).toEqual([]);
  });
});
