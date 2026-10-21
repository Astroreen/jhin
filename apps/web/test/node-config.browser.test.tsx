import { z } from "@jhin/sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { configChange } from "@jhin/host-api";

import { HIDDEN, sectionForm, setAt } from "../src/lib/config-form.ts";
import { Fields, SectionJson, type FieldsContext } from "../src/plugins/settings/config-fields.tsx";
import {
  errorsOf,
  readBack,
  rebase,
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

describe("a section changed on the node while it is shown (D484)", () => {
  const shown: Loaded = {
    section: "a",
    layer: "node",
    read: { layers: { node: { x: 1, nested: { a: 1, b: 2 } } } },
    original: { x: 1, nested: { a: 1, b: 2 } },
    value: { x: 1, nested: { a: 1, b: 2 } },
  };
  const changed = { layers: { node: { x: 5, nested: { a: 1, b: 2 }, y: true } } };

  it("shows the new file when nothing was edited", () => {
    expect(rebase(shown, changed)).toMatchObject({
      original: changed.layers.node,
      value: changed.layers.node,
      rebased: false,
    });
  });

  it("says nothing for the echo of its own save", () => {
    const typed = { ...shown, value: { x: 2, nested: { a: 1, b: 2 } } };
    const echoed = rebase(typed, shown.read);
    expect(echoed.value).toEqual(typed.value);
    expect(echoed.rebased).toBeFalsy();
  });

  it("keeps the edits on top of the new file", () => {
    const edited = { ...shown, value: { nested: { a: 1, b: 3 } } };
    // x was removed here, b changed; the node changed x and added y.
    expect(rebase(edited, changed)).toMatchObject({
      original: changed.layers.node,
      value: { nested: { a: 1, b: 3 }, y: true },
      rebased: true,
    });
  });
});

describe("reading a section back after a save", () => {
  const saving: Loaded = {
    section: "a",
    layer: "node",
    read: { value: { x: 1 }, layers: { node: { x: 1 } } },
    original: { x: 1 },
    value: { x: 2 },
  };
  const saved = { value: { x: 2 }, layers: { node: { x: 2 } } };

  it("shows the file as saved when nothing was changed meanwhile", () => {
    expect(readBack(saving, "a", saving.value, saved)).toEqual({
      section: "a",
      layer: "node",
      read: saved,
      original: { x: 2 },
      value: { x: 2 },
      rebased: false,
    });
  });

  it("keeps what was changed while saving, as an edit of the saved file", () => {
    const typed = { ...saving, value: { x: 3 } };
    expect(readBack(typed, "a", saving.value, saved)).toEqual({
      ...typed,
      read: saved,
      original: { x: 2 },
      rebased: false,
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
    token: z.string().optional().meta({ writeOnly: true }),
    pin: z.number().meta({ writeOnly: true }).nullable().optional(),
    keys: z.array(z.string()).optional().meta({ writeOnly: true }),
    auth: z
      .union([
        z.object({ password: z.string().meta({ writeOnly: true }) }),
        z.object({ none: z.boolean() }),
      ])
      .optional(),
  })
  .meta({ title: "Server" });
const schema = z.toJSONSchema(Server, { io: "input", unrepresentable: "any" });

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

/** The form of the section over a node file holding `original`, as the settings page shows it. */
function mountForm(
  original: Record<string, unknown>,
  issues: Loaded["read"]["issues"] = [],
  other: FieldsContext["other"] = { layer: "project", value: undefined },
) {
  const form = sectionForm("acme.server", schema, [{ path: ["name"], text: "How others see it." }]);
  const state: { value: unknown } = { value: original };
  function Form() {
    const [value, setValue] = useState<unknown>(original);
    state.value = value;
    const loaded: Loaded = {
      section: "acme.server",
      layer: "node",
      read: { layers: { node: original }, issues },
      original,
      value,
    };
    return (
      <Fields
        context={{
          value,
          other,
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
  act(() => root.render(<Form />));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { state };
}

describe("a config section as a form (D80)", () => {
  it("says which file wins over the other (D477)", async () => {
    mountForm({}, [], { layer: "project", value: { port: 9000 } });
    await expect
      .element(page.getByText("The project file sets 9000, which wins."))
      .toBeInTheDocument();
    for (const cleanup of mounted.splice(0)) cleanup();
    mountForm({ port: 9000 }, [], { layer: "node", value: { port: 8080 } });
    await expect
      .element(page.getByText("The node file sets 8080; this file wins over it."))
      .toBeInTheDocument();
  });

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
    expect(
      configChange(
        "node",
        "acme.server",
        { port: 8080, proxies: ["10.0.0.1"] },
        view.state.value as never,
      ),
    ).toEqual({
      layer: "node",
      section: "acme.server",
      values: { open: true, name: "edge", header: "forwarded" },
      edits: [
        { path: ["open"], value: true },
        { path: ["name"], value: "edge" },
        { path: ["header"], value: "forwarded" },
      ],
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

  it("never shows a secret in clear, wherever it is (D83)", async () => {
    const view = mountForm({ token: "s3cret", pin: 1234, keys: ["k1"], auth: { password: "pw" } });
    const input = (label: string) => page.getByLabelText(label, { exact: true }).element();

    // A text field, a nullable number and a list item: password fields.
    expect(input("Token")).toHaveProperty("type", "password");
    expect(input("Pin")).toHaveProperty("type", "password");
    expect(input("Keys 1")).toHaveProperty("type", "password");
    // Inside an inline JSON field: hidden, and kept when the rest is edited.
    const auth = page.getByRole("textbox", { name: "Auth" });
    expect(auth.element()).toHaveProperty("value", expect.stringContaining(HIDDEN));
    expect(document.body.innerHTML).not.toContain("pw");
    await userEvent.fill(auth, `{ "password": "${HIDDEN}" }`);
    expect(view.state.value).toMatchObject({ auth: { password: "pw" } });
  });

  it("shows the node's marker in a number secret and saves it back untouched (security.md D417)", async () => {
    const view = mountForm({ pin: "••••••" });
    const pin = page.getByLabelText("Pin", { exact: true });
    expect(pin.element()).toHaveProperty("type", "password");
    expect(pin.element()).toHaveProperty("value", "••••••");
    // Untouched, the marker goes back as it came and is no error.
    expect(view.state.value).toEqual({ pin: "••••••" });
    expect(page.getByRole("alert").elements()).toEqual([]);
    // Typed over, it is a number again.
    await userEvent.fill(pin, "4321");
    expect(view.state.value).toEqual({ pin: 4321 });
  });

  it("hides secrets in the section's JSON and keeps them through an edit (D83)", async () => {
    const changes: unknown[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const value = { token: "s3cret", name: "a" };
    act(() =>
      root.render(
        <SectionJson
          messages={[]}
          onChange={(next) => changes.push(next)}
          schema={schema}
          label="acme.server in the node file"
          value={value}
        />,
      ),
    );
    mounted.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    const json = page.getByRole("textbox", { name: "acme.server in the node file" });
    expect(json.element()).toHaveProperty("value", expect.not.stringContaining("s3cret"));
    expect(json.element()).toHaveProperty("value", expect.stringContaining(HIDDEN));

    await userEvent.fill(json, `{ "token": "${HIDDEN}", "name": "b" }`);
    expect(changes.at(-1)).toEqual({ token: "s3cret", name: "b" });
  });
});
