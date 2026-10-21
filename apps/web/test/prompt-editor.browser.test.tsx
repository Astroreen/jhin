import type { Editor } from "@tiptap/core";
import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import {
  type ComposerChipActions,
  ComposerChipsContext,
} from "../src/plugins/chat/composer-chips.tsx";
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
  /** Turns the rich text setting on or off from outside, as the settings page does. */
  setRichText(richText: boolean): void;
  /** Resolves once the editor reports `expected` (and `cursor`, when given), or already has. */
  reported(expected: string, cursor?: number): Promise<void>;
  editable(): HTMLElement;
}

let unmount: (() => void) | undefined;

/** A chip's text, once its view rendered: tiptap renders a React node view after the document. */
async function expectChipText(chip: Element | null | undefined, text: string): Promise<void> {
  expect(chip).toBeTruthy();
  await expect.element(page.getByText(text, { exact: true }).first()).toBeInTheDocument();
  expect(chip!.textContent).toBe(text);
}

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function mount(
  initial: string,
  options: {
    sendShortcut?: "enter" | "mod-enter";
    onKeyDown?: (event: KeyboardEvent) => boolean;
    richText?: boolean;
    literalText?: boolean;
    chips?: ComposerChipActions;
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
  let setRichTextOutside: ((richText: boolean | undefined) => void) | undefined;

  function Harness() {
    const [value, setValue] = useState(initial);
    const [disabled, setDisabled] = useState(false);
    const [richText, setRichText] = useState(options.richText);
    setRichTextOutside = setRichText;
    setOutside = setValue;
    setDisabledOutside = setDisabled;
    return (
      <ComposerChipsContext value={options.chips ?? { skills: [] }}>
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
          richText={richText}
          literalText={options.literalText}
          handleRef={handleRef}
        />
      </ComposerChipsContext>
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
    setRichText: (richText) => act(() => setRichTextOutside!(richText)),
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
    await expectChipText(chip, "a.ts");
    // T3's file icon, by the file's name (D1002).
    expect(chip.querySelector("svg[data-pierre-icon]")).not.toBeNull();
    expect(editor.handle.cursor()).toBe(prompt.length);

    editor.handle.focus();
    await userEvent.keyboard("!");
    await editor.reported(`${prompt}!`);
  });

  it("opens T3's chip details: a file's preview, a skill's description and instructions, a link", async () => {
    const opened: string[] = [];
    const skill = { name: "deploy", description: "Ship it to production", path: "/s/SKILL.md" };
    mount(
      "[a.ts](src/a.ts) $deploy $gone [#12](https://github.com/acme/app/pull/12) [Fix](jhin://n/threads/t)",
      {
        chips: {
          skills: [skill],
          previewFile: (path) => opened.push(`file ${path}`),
          viewInstructions: (picked) => opened.push(`skill ${picked.name}`),
          openUrl: (url) => opened.push(`url ${url}`),
          openThread: (href) => opened.push(`thread ${href}`) > 0,
        },
      },
    );
    await page.getByRole("button", { name: "Preview src/a.ts" }).click();

    await page.getByRole("button", { name: "Skill Deploy. Show details" }).click();
    await expect.element(page.getByText("Ship it to production")).toBeVisible();
    await page.getByRole("button", { name: "View instructions" }).click();
    // A skill the agent does not offer says so, with nothing to open.
    await page.getByRole("button", { name: "Skill Gone. Show details" }).click();
    await expect
      .element(page.getByText("No description is available for this skill."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "View instructions" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await page.getByRole("button", { name: "Open pull request #12" }).click();
    await page.getByRole("button", { name: "Thread, Fix" }).click();
    expect(opened).toEqual([
      "file src/a.ts",
      "skill deploy",
      "url https://github.com/acme/app/pull/12",
      "thread jhin://n/threads/t",
    ]);
  });

  it("shows a legacy @path and a skill as chips that write back their exact text", async () => {
    const prompt = "use $review on @./lib/b.ts and €deploy";
    const editor = mount(prompt);
    const root = editor.editable();
    // T3's label: the skill's display name, else its name in title case (D1004).
    await expectChipText(root.querySelector("[data-skill='review']"), "Review");
    await expectChipText(root.querySelector("[data-skill='deploy']"), "Deploy");
    await expectChipText(root.querySelector("[data-mention='./lib/b.ts']"), "b.ts");

    editor.handle.focus();
    await userEvent.keyboard(" ok");
    await editor.reported(`${prompt} ok`);
  });

  it("shows a picked pull request and thread as chips by their label, written back unchanged", async () => {
    const editor = mount("see #1");
    const pr = "[#12](https://github.com/acme/app/pull/12) ";
    editor.handle.replaceRange(4, 6, pr);
    const root = editor.editable();
    const prChip = root.querySelector("[data-reference='pull-request']")!;
    await expectChipText(prChip, "#12");
    expect(prChip.getAttribute("data-href")).toBe("https://github.com/acme/app/pull/12");

    const thread = "[Fix the cache](jhin://node-1/threads/t-2) ";
    const end = editor.value().length;
    editor.handle.replaceRange(end, end, `and @fix`);
    editor.handle.replaceRange(end + 4, end + 8, thread);
    await expectChipText(root.querySelector("[data-reference='thread']"), "Fix the cache");
    expect(editor.value()).toBe(`see ${pr}and ${thread}`);

    editor.handle.focus();
    await userEvent.keyboard("ok");
    await editor.reported(`see ${pr}and ${thread}ok`);
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

    await userEvent.click(page.getByRole("combobox", { name: "Code language: Python" }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search languages" }), "zzz");
    await expect.element(page.getByText("No matching languages.")).toBeVisible();
    await userEvent.fill(page.getByRole("combobox", { name: "Search languages" }), "plain");
    await userEvent.click(page.getByRole("option", { name: "Plain text" }));
    // Something follows the language, so plain text writes `text` to keep it.
    await editor.reported("```text title=x\nconst a = 1;2\n```");

    editor.setDisabled(true);
    await expect
      .element(page.getByRole("combobox", { name: "Code language: Plain text" }))
      .toBeDisabled();
    editor.setDisabled(false);
    await expect
      .element(page.getByRole("combobox", { name: "Code language: Plain text" }))
      .toBeEnabled();
  });
});

describe("wrapping a selection (D844)", () => {
  it("wraps the selection in a bracket or quote and keeps it selected", async () => {
    const editor = mount("say word");
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    tiptap.commands.setTextSelection({ from: 5, to: 9 });
    tiptap.commands.focus();
    await userEvent.keyboard("(");
    await editor.reported("say (word)");
    await userEvent.keyboard('"');
    await editor.reported('say ("word")');
    expect(
      tiptap.state.doc.textBetween(tiptap.state.selection.from, tiptap.state.selection.to),
    ).toBe("word");
  });

  it("replaces a selection that holds the space a chip needs, as T3 does", async () => {
    const editor = mount("[a.ts](src/a.ts) next");
    const tiptap = (editor.editable() as HTMLElement & { editor: Editor }).editor;
    const end = tiptap.state.doc.content.size - 1;
    // The space after the chip and "next".
    tiptap.commands.setTextSelection({ from: end - 5, to: end });
    expect(tiptap.state.doc.textBetween(end - 5, end)).toBe(" next");
    // The editor's text input handler declines, so the browser's plain replace runs, as T3's
    // does. Asked directly: how a browser replaces a range beside a chip varies.
    const view = tiptap.view;
    const wrapped = view.someProp("handleTextInput", (handle) =>
      handle(view, end - 5, end, "(", () => view.state.tr),
    );
    expect(wrapped).toBeFalsy();
    expect(editor.value()).toBe("[a.ts](src/a.ts) next");
    // Without the chip's space, the same selection wraps.
    tiptap.commands.setTextSelection({ from: end - 4, to: end });
    expect(
      view.someProp("handleTextInput", (handle) =>
        handle(view, end - 4, end, "(", () => view.state.tr),
      ),
    ).toBe(true);
    await editor.reported("[a.ts](src/a.ts) (next)");
  });
});

describe("headings, rules and task lists in the prompt", () => {
  it("shows headings styled and writes back their hashes and spacing", () => {
    const prompt = "# Title\n##  Two\n#\tTab\n#1234 is a reference\n####### seven\n# ";
    const editor = mount(prompt);
    const root = editor.editable();
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("h2")?.textContent).toBe("Two");
    expect(root.querySelectorAll("h1")).toHaveLength(3);
    expect(root.querySelectorAll("p")).toHaveLength(2);

    editor.handle.setValue(editor.value());
    expect(editor.value()).toBe(prompt);
  });

  it("turns typed hashes and a space into a heading, but not in a list or without the space", async () => {
    const editor = mount("");
    editor.handle.focus();
    await userEvent.keyboard("## Hi");
    await editor.reported("## Hi");
    expect(editor.editable().querySelector("h2")?.textContent).toBe("Hi");

    editor.setFromParent("- a");
    editor.handle.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}# x");
    await editor.reported("- a\n- # x");
    expect(editor.editable().querySelector("h1")).toBeNull();

    editor.setFromParent("");
    editor.handle.focus();
    await userEvent.keyboard("#12");
    await editor.reported("#12");
    expect(editor.editable().querySelector("h1")).toBeNull();
  });

  it("shows rules and writes back the text each was written with", async () => {
    const prompt = "a\n***\n- - -\ntext\n___";
    const editor = mount(prompt);
    const root = editor.editable();
    expect(root.querySelectorAll("hr")).toHaveLength(3);
    editor.handle.setValue(editor.value());
    expect(editor.value()).toBe(prompt);

    // The line kept after a final rule takes the caret, and is written only once it has text.
    expect(editor.handle.cursor()).toBe(prompt.length);
    editor.handle.focus();
    await userEvent.keyboard("x");
    await editor.reported(`${prompt}\nx`);
  });

  it("turns typed dashes into a rule, and stars or underscores once a space follows", async () => {
    const editor = mount("");
    editor.handle.focus();
    await userEvent.keyboard("---");
    await editor.reported("---");
    expect(editor.editable().querySelectorAll("hr")).toHaveLength(1);
    await userEvent.keyboard("x");
    await editor.reported("---\nx");

    editor.setFromParent("");
    editor.handle.focus();
    await userEvent.keyboard("***");
    await editor.reported("***");
    expect(editor.editable().querySelector("hr")).toBeNull();
    await userEvent.keyboard(" ");
    await editor.reported("*** ");
    expect(editor.editable().querySelectorAll("hr")).toHaveLength(1);
  });

  it("shows tasks as checkboxes and writes back their markers", () => {
    const prompt = "- [ ] one\n-  [x]  two\n  - [ ] child\n- [ ]";
    const editor = mount(prompt);
    const boxes = editor.editable().querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((box) => box.checked)).toEqual([false, true, false, false]);
    editor.handle.setValue(editor.value());
    expect(editor.value()).toBe(prompt);

    // T3 writes an upper-case check as a lower-case one.
    editor.setFromParent("- [X] done");
    expect(editor.handle.value()).toBe("- [x] done");
  });

  it("checks and unchecks a task from its checkbox", async () => {
    const editor = mount("- [ ] one\n- [x] two");
    const boxes = editor.editable().querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    await userEvent.click(boxes[0]!);
    await editor.reported("- [x] one\n- [x] two");
    await userEvent.click(boxes[1]!);
    await editor.reported("- [x] one\n- [ ] two");
  });

  it("opens a task list from typed `- [ ] `, continues it unchecked and leaves it from an empty task", async () => {
    const editor = mount("");
    editor.handle.focus();
    await userEvent.keyboard("- [[x] buy");
    await editor.reported("- [x] buy");
    expect(editor.editable().querySelectorAll("input[type=checkbox]")).toHaveLength(1);

    await userEvent.keyboard("{Shift>}{Enter}{/Shift}milk");
    await editor.reported("- [x] buy\n- [ ] milk");
    await userEvent.keyboard("{Shift>}{Enter}{Enter}{/Shift}after");
    await editor.reported("- [x] buy\n- [ ] milk\nafter");
    expect(editor.editable().querySelectorAll("input[type=checkbox]")).toHaveLength(2);
    expect(editor.submits).toEqual([]);
  });

  it("turns a bullet into a task when `[ ] ` is typed at its start", async () => {
    const editor = mount("");
    editor.handle.focus();
    await userEvent.keyboard("* [[ ] t");
    await editor.reported("- [ ] t");
    expect(editor.editable().querySelectorAll("input[type=checkbox]")).toHaveLength(1);
  });
});

/** Pastes `text` as the clipboard's plain text through the editor's own paste handler. */
function paste(editor: Mounted, text: string): void {
  const view = (editor.editable() as HTMLElement & { editor: Editor }).editor.view;
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData, cancelable: true });
  view.someProp("handlePaste", (handle) => handle(view, event, view.state.doc.slice(0, 0)));
}

describe("plain and literal text (T3's Rich text composer setting and literal answers)", () => {
  it("shows markdown as typed without rich text, and keeps the chips", async () => {
    const prompt = "**bold** `code`\n- one\n> quote\n# Title\n---\nread [a.ts](src/a.ts) now";
    const editor = mount(prompt, { richText: false });
    const root = editor.editable();
    expect(root.getAttribute("data-composer-rich-text")).toBe("false");
    expect(root.querySelector("strong, code, ul, blockquote, h1, hr, pre")).toBeNull();
    await expectChipText(root.querySelector("[data-mention='src/a.ts']"), "a.ts");
    editor.handle.setValue(editor.value());
    expect(editor.value()).toBe(prompt);
  });

  it("builds the editor again when the setting changes, keeping the prompt", async () => {
    const prompt = "**bold**\n- one";
    const editor = mount(prompt);
    expect(editor.editable().querySelector("strong")?.textContent).toBe("bold");
    editor.setRichText(false);
    expect(editor.editable().getAttribute("data-composer-rich-text")).toBe("false");
    expect(editor.editable().querySelector("strong, ul")).toBeNull();
    expect(editor.editable().textContent).toBe("**bold**- one");
    editor.setRichText(true);
    expect(editor.editable().getAttribute("data-composer-rich-text")).toBe("true");
    expect(editor.editable().querySelector("strong")?.textContent).toBe("bold");
    expect(editor.value()).toBe(prompt);
  });

  it("applies no markdown input rules and continues no list without rich text", async () => {
    const editor = mount("- one", { richText: false });
    editor.handle.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}# **b** ");
    await editor.reported("- one\n# **b** ");
    const root = editor.editable();
    expect(root.querySelector("strong, ul, li, h1")).toBeNull();
    expect(editor.submits).toEqual([]);
  });

  it("pastes markdown as text with chips without rich text", async () => {
    const editor = mount("", { richText: false });
    editor.handle.focus();
    paste(editor, "- **x** [b.ts](src/b.ts)");
    await editor.reported("- **x** [b.ts](src/b.ts) ");
    const root = editor.editable();
    expect(root.querySelector("strong, ul")).toBeNull();
    expect(root.querySelector("[data-mention='src/b.ts']")).not.toBeNull();
  });

  it("takes literal text character for character: no chips, no styling, no surround", async () => {
    const prompt = "read [a.ts](src/a.ts) **now**\n- $skill";
    const editor = mount(prompt, { literalText: true, richText: true });
    const root = editor.editable();
    expect(root.getAttribute("data-composer-rich-text")).toBe("false");
    expect(root.querySelector("[data-mention], [data-skill], strong, ul")).toBeNull();
    expect(root.textContent).toBe("read [a.ts](src/a.ts) **now**- $skill");

    const tiptap = (root as HTMLElement & { editor: Editor }).editor;
    const view = tiptap.view;
    tiptap.commands.setTextSelection({ from: 1, to: 5 });
    expect(
      view.someProp("handleTextInput", (handle) => handle(view, 1, 5, "(", () => view.state.tr)),
    ).toBeFalsy();
    // Nothing was wrapped; the same call wraps in rich text (D844's test is the positive control).
    expect(editor.value()).toBe(prompt);

    tiptap.commands.setTextSelection(tiptap.state.doc.content.size - 1);
    paste(editor, " [c.ts](src/c.ts)");
    await editor.reported(`${prompt} [c.ts](src/c.ts)`);
    expect(root.querySelector("[data-mention]")).toBeNull();
  });
});
