import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { useLoadedSection } from "../src/plugins/settings/node-config.tsx";

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
