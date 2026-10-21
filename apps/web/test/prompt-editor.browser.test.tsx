import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { PromptEditor, type PromptEditorHandle } from "../src/plugins/chat/prompt-editor.tsx";

interface Mounted {
  readonly handle: PromptEditorHandle;
  readonly submits: string[];
  readonly changes: (readonly [string, number])[];
  /** The prompt as the parent holds it. */
  value(): string;
  /** Sets the prompt from outside, as clearing after a send or a history recall does. */
  setFromParent(value: string): void;
  /** Resolves once the editor reports `expected` (and `cursor`, when given), or already has. */
  reported(expected: string, cursor?: number): Promise<void>;
  editable(): HTMLElement;
}

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function mount(
  initial: string,
  options: {
    sendShortcut?: "enter" | "mod-enter";
    onKeyDown?: (event: KeyboardEvent) => boolean;
  } = {},
): Mounted {
  const handleRef = createRef<PromptEditorHandle>();
  const submits: string[] = [];
  const changes: (readonly [string, number])[] = [];
  const waiters: { matches: (value: string, cursor: number) => boolean; resolve: () => void }[] =
    [];
  let current = initial;
  let setOutside: ((value: string) => void) | undefined;

  function Harness() {
    const [value, setValue] = useState(initial);
    setOutside = setValue;
    return (
      <PromptEditor
        value={value}
        onChange={(next, cursor) => {
          current = next;
          changes.push([next, cursor]);
          setValue(next);
          for (const waiter of waiters.filter((item) => item.matches(next, cursor))) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }}
        onSubmit={() => submits.push(current)}
        onKeyDown={options.onKeyDown}
        placeholder="Ask anything"
        sendShortcut={options.sendShortcut ?? "enter"}
        handleRef={handleRef}
      />
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return {
    handle: handleRef.current!,
    submits,
    changes,
    value: () => current,
    setFromParent: (value) => {
      current = value;
      act(() => setOutside!(value));
    },
    reported: (expected, cursor) => {
      const matches = (value: string, at: number) =>
        value === expected && (cursor === undefined || at === cursor);
      const last = changes.at(-1);
      if (matches(current, last?.[1] ?? current.length)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ matches, resolve }));
    },
    editable: () => page.getByRole("textbox", { name: "Message" }).element() as HTMLElement,
  };
}

describe("the prompt editor (D303)", () => {
  it("is a multiline textbox named Message that Playwright can fill", async () => {
    const editor = mount("");
    const textbox = editor.editable();
    expect(textbox.getAttribute("aria-multiline")).toBe("true");
    expect(textbox.isContentEditable).toBe(true);
    expect(page.getByText("Ask anything").element()).toBeTruthy();

    await userEvent.fill(page.getByRole("textbox", { name: "Message" }), "text");
    await editor.reported("text");
    expect(editor.changes.at(-1)).toEqual(["text", 4]);
    expect(page.getByText("Ask anything").query()).toBeNull();
  });

  it("reports typing with the caret, sends on Enter and breaks a line on Shift+Enter", async () => {
    const editor = mount("");
    editor.handle.focus();
    await userEvent.keyboard("hi");
    await editor.reported("hi");
    expect(editor.changes.at(-1)).toEqual(["hi", 2]);

    await userEvent.keyboard("{Shift>}{Enter}{/Shift}there");
    await editor.reported("hi\nthere");
    expect(editor.submits).toEqual([]);

    await userEvent.keyboard("{Alt>}{Enter}{/Alt}!");
    await editor.reported("hi\nthere\n!");
    expect(editor.submits).toEqual([]);

    await userEvent.keyboard("{Enter}");
    expect(editor.submits).toEqual(["hi\nthere\n!"]);
    expect(editor.value()).toBe("hi\nthere\n!");
  });

  it("sends on Mod+Enter only, and breaks a line on Enter, with the mod-enter shortcut", async () => {
    const editor = mount("a", { sendShortcut: "mod-enter" });
    editor.handle.focus();
    await userEvent.keyboard("{Enter}b");
    await editor.reported("a\nb");
    expect(editor.submits).toEqual([]);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(editor.submits).toEqual(["a\nb"]);
  });

  it("lets the parent take a key first, which then neither sends nor edits", async () => {
    const seen: string[] = [];
    const editor = mount("pick", {
      onKeyDown: (event) => {
        seen.push(event.key);
        return event.key === "Enter" || event.key === "ArrowUp";
      },
    });
    editor.handle.focus();
    await userEvent.keyboard("{Enter}{ArrowUp}x");
    await editor.reported("pickx");
    expect(seen).toEqual(["Enter", "ArrowUp", "x"]);
    expect(editor.submits).toEqual([]);
  });

  it("shows a file link as a chip and writes it back unchanged", async () => {
    const prompt = "read [a.ts](src/a.ts) please";
    const editor = mount(prompt);
    const chip = editor.editable().querySelector("[data-mention]")!;
    expect(chip.getAttribute("data-mention")).toBe("src/a.ts");
    expect(chip.getAttribute("title")).toBe("src/a.ts");
    expect(chip.textContent).toBe("a.ts");
    expect(editor.handle.cursor()).toBe(prompt.length);

    editor.handle.focus();
    await userEvent.keyboard("!");
    await editor.reported(`${prompt}!`);
  });

  it("shows a legacy @path and a skill as chips that write back their exact text", async () => {
    const prompt = "use $review on @./lib/b.ts and €deploy";
    const editor = mount(prompt);
    const root = editor.editable();
    expect(root.querySelector("[data-skill='review']")?.textContent).toBe("review");
    expect(root.querySelector("[data-skill='deploy']")?.getAttribute("title")).toBe("€deploy");
    expect(root.querySelector("[data-mention='./lib/b.ts']")?.textContent).toBe("b.ts");

    editor.handle.focus();
    await userEvent.keyboard(" ok");
    await editor.reported(`${prompt} ok`);
  });

  it("keeps markdown styling and blocks round-trip", async () => {
    const prompt =
      "**bold** and *it* ~~gone~~ `code`\n- one\n- two\n> quote\n\n```ts\nconst a = 1;\n```";
    const editor = mount(prompt);
    const root = editor.editable();
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("it");
    expect(root.querySelector("s")?.textContent).toBe("gone");
    expect(root.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root.querySelector("blockquote")?.textContent).toBe("quote");
    expect(root.querySelector("pre")?.textContent).toBe("const a = 1;");

    editor.handle.setValue(editor.value());
    expect(editor.value()).toBe(prompt);
  });

  it("continues a list on a line break, leaves it from an empty item, and styles typed markdown", async () => {
    const editor = mount("- one");
    editor.handle.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}two");
    await editor.reported("- one\n- two");
    expect(editor.editable().querySelectorAll("li")).toHaveLength(2);

    await userEvent.keyboard("{Shift>}{Enter}{Enter}{/Shift}**b**");
    await editor.reported("- one\n- two\n**b**");
    expect(editor.editable().querySelectorAll("li")).toHaveLength(2);
    expect(editor.editable().querySelector("strong")?.textContent).toBe("b");
    expect(editor.submits).toEqual([]);
  });

  it("replaces a range of the markdown and puts the caret after it, as a menu pick does", async () => {
    const editor = mount("look at @sr");
    editor.handle.replaceRange(8, 11, "[a.ts](src/a.ts) ");
    expect(editor.changes.at(-1)).toEqual(["look at [a.ts](src/a.ts) ", 25]);
    expect(editor.value()).toBe("look at [a.ts](src/a.ts) ");
    expect(editor.editable().querySelector("[data-mention='src/a.ts']")).toBeTruthy();
    expect(editor.handle.cursor()).toBe(25);

    editor.handle.focus();
    await userEvent.keyboard("ok");
    await editor.reported("look at [a.ts](src/a.ts) ok");
  });

  it("rebuilds when the parent sets the prompt, with the caret at the end", async () => {
    const editor = mount("draft");
    editor.setFromParent("$skill again");
    expect(editor.editable().querySelector("[data-skill='skill']")).toBeTruthy();
    expect(editor.handle.cursor()).toBe("$skill again".length);
    editor.setFromParent("");
    expect(editor.editable().textContent).toBe("");
    expect(page.getByText("Ask anything").element()).toBeTruthy();
  });

  it("knows whether the caret is on the first or the last line", async () => {
    const editor = mount("one\ntwo");
    editor.handle.focus();
    expect(editor.handle.caretOnLastLine()).toBe(true);
    expect(editor.handle.caretOnFirstLine()).toBe(false);
    await userEvent.keyboard("{ArrowUp}");
    await editor.reported("one\ntwo", 3);
    expect(editor.handle.caretOnFirstLine()).toBe(true);
    expect(editor.handle.caretOnLastLine()).toBe(false);
  });
});
