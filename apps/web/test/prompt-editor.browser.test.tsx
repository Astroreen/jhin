import type { Editor } from "@tiptap/core";
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
  /** Disables the editor from outside, as a busy composer does. */
  setDisabled(disabled: boolean): void;
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
  let setDisabledOutside: ((disabled: boolean) => void) | undefined;

  function Harness() {
    const [value, setValue] = useState(initial);
    const [disabled, setDisabled] = useState(false);
    setOutside = setValue;
    setDisabledOutside = setDisabled;
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
        disabled={disabled}
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
    setDisabled: (disabled) => act(() => setDisabledOutside!(disabled)),
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
    // A code block is a React node view, which mounts after the editor.
    await expect
      .element(page.getByRole("combobox", { name: "Code language: TypeScript" }))
      .toBeVisible();
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

describe("code blocks in the prompt (D841–D843)", () => {
  it("colours a code block's tokens in both themes", async () => {
    const editor = mount("```ts\nconst a = 1;\n```");
    const token = page.getByText("const", { exact: true });
    await expect.element(token).toHaveClass("composer-code-token");
    const style = (token.element() as HTMLElement).getAttribute("style") ?? "";
    expect(style).toContain("--shiki-light:");
    expect(style).toContain("--shiki-dark:");
    editor.handle.setValue(editor.value());
    expect(editor.value()).toBe("```ts\nconst a = 1;\n```");
  });

  it("keeps a block's colours while its edited text is tokenized again", async () => {
    const editor = mount("```ts\nconst a = 1;\n```");
    await expect
      .element(page.getByText("const", { exact: true }))
      .toHaveClass("composer-code-token");
    // A transaction dispatches synchronously; the new text's tokens cannot have arrived yet.
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    tiptap.commands.insertContentAt(tiptap.state.doc.child(0).nodeSize - 1, " ");
    expect(editor.value()).toBe("```ts\nconst a = 1; \n```");
    expect(page.getByText("const", { exact: true }).element()).toHaveClass("composer-code-token");

    // A new language drops the old one's colours until its own arrive.
    tiptap.commands.updateAttributes("codeBlock", { language: "python" });
    expect(editor.editable().querySelector(".composer-code-token[style]")).toBeNull();
  });

  it("indents with Tab and outdents with Shift+Tab, in a code block only", async () => {
    const editor = mount("```\na\nb\n```");
    editor.handle.focus();
    editor.handle.replaceRange(4, 4, "");
    await userEvent.keyboard("{Tab}");
    await editor.reported("```\n  a\nb\n```");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await editor.reported("```\na\nb\n```");
    expect(document.activeElement).toBe(editor.editable());
  });

  it("moves every line a selection touches, and not the line it ends at the start of", async () => {
    const editor = mount("```\na\n b\n\tc\nd\n```");
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    // The block's text starts at position 1; offset 5 is the start of the "\tc" line.
    tiptap.commands.setTextSelection({ from: 1, to: 6 });
    tiptap.commands.focus();
    await userEvent.keyboard("{Tab}");
    await editor.reported("```\n  a\n   b\n\tc\nd\n```");
    // The selection followed its lines, so Shift+Tab takes back what Tab added.
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await editor.reported("```\na\n b\n\tc\nd\n```");

    // Two spaces, one space and a tab come off; a line with none stays.
    tiptap.commands.setTextSelection({ from: 1, to: 9 });
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await editor.reported("```\na\nb\nc\nd\n```");
    const changes = editor.changes.length;
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(editor.changes.length).toBe(changes);
    expect(editor.value()).toBe("```\na\nb\nc\nd\n```");
  });

  it("keeps a selection's end on its line when Shift+Tab takes the indent it sat in", async () => {
    const editor = mount("```\n  a\n  b\n```");
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    // From the block's start to between the second line's two spaces.
    tiptap.commands.setTextSelection({ from: 1, to: 6 });
    tiptap.commands.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await editor.reported("```\na\nb\n```");
    // The second line's start, not the end of the first.
    expect(tiptap.state.selection.to).toBe(3);
  });

  it("leaves a selection from a code block into the text below to Tab's default", async () => {
    const editor = mount("```\na\n```\ntext");
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    tiptap.commands.setTextSelection({ from: 1, to: tiptap.state.doc.content.size - 1 });
    tiptap.commands.focus();
    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(editor.value()).toBe("```\na\n```\ntext");
  });

  it("outdents an empty first line, not the line below it", async () => {
    const editor = mount("```\n\n  x\n```");
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    tiptap.commands.setTextSelection(1);
    tiptap.commands.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(editor.changes.map(([value]) => value)).not.toContain("```\n\nx\n```");
    expect(editor.value()).toBe("```\n\n  x\n```");
  });

  it("leaves Tab alone outside a code block", async () => {
    const editor = mount("text");
    editor.handle.focus();
    await userEvent.keyboard("{Tab}");
    expect(editor.value()).toBe("text");
    expect(editor.changes).toEqual([]);
  });

  it("changes the fence's language from the header and keeps what follows it", async () => {
    const editor = mount("```ts title=x\nconst a = 1;\n```");
    await userEvent.click(page.getByRole("combobox", { name: "Code language: TypeScript" }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search languages" }), "pyth");
    await userEvent.click(page.getByRole("option", { name: "Python" }));
    await editor.reported("```python title=x\nconst a = 1;\n```");
    // The caret is back at the block's end.
    await userEvent.keyboard("2");
    await editor.reported("```python title=x\nconst a = 1;2\n```");
    expect(page.getByRole("combobox", { name: "Code language: Python" }).query()).toBeTruthy();

    editor.setDisabled(true);
    await expect
      .element(page.getByRole("combobox", { name: "Code language: Python" }))
      .toBeDisabled();
    editor.setDisabled(false);
    await expect
      .element(page.getByRole("combobox", { name: "Code language: Python" }))
      .toBeEnabled();
  });
});
