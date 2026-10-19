import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { readBack, useLoadedSection } from "../src/plugins/settings/node-config.tsx";

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
    expect(JSON.parse(editor.loaded!.text)).toEqual({ from: "b" });
    act(() => root.unmount());
  });
});

describe("reading a section back after a save", () => {
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
  const saving = {
    section: "a",
    read: { value: { x: 1 }, layers: { node: { x: 1 } } },
    original: pretty({ x: 1 }),
    text: pretty({ x: 2 }),
  };
  const saved = { value: { x: 2 }, layers: { node: { x: 2 } } };

  it("shows the file as saved when nothing was typed meanwhile", () => {
    expect(readBack(saving, "a", saving.text, saved)).toEqual({
      section: "a",
      read: saved,
      original: pretty({ x: 2 }),
      text: pretty({ x: 2 }),
    });
  });

  it("keeps what was typed while saving, as an edit of the saved file", () => {
    const typed = { ...saving, text: pretty({ x: 3 }) };
    expect(readBack(typed, "a", saving.text, saved)).toEqual({
      ...typed,
      read: saved,
      original: pretty({ x: 2 }),
    });
  });

  it("leaves another section alone", () => {
    const other = { ...saving, section: "b" };
    expect(readBack(other, "a", saving.text, saved)).toBe(other);
  });
});
