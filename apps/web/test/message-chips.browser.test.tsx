import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { isMacPlatform } from "../src/lib/keybindings.ts";
import { ChatMarkdown } from "../src/plugins/chat/markdown.tsx";
import {
  type AgentFileLinks,
  AgentFileLinksContext,
  type MessageContextChips,
  MessageContextChipsContext,
} from "../src/plugins/chat/message-context.ts";

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function render(
  text: string,
  chips: MessageContextChips | undefined,
  links?: AgentFileLinks,
): void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <AgentFileLinksContext value={links}>
        <MessageContextChipsContext value={chips}>
          <ChatMarkdown lineBreaks text={text} />
        </MessageContextChipsContext>
      </AgentFileLinksContext>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
}

const skills = [{ name: "deploy", description: "Ship it", path: "/s/SKILL.md" }];

describe("a sent message's file and skill chips (D1341)", () => {
  it("shows a file link as its chip that opens the preview, and a known skill as its chip", async () => {
    const opened: string[] = [];
    render(
      "check [app.ts](src/app.ts) and [](src/) with $deploy then, not $gone\n\n- also $deploy\n\n| step |\n| --- |\n| $deploy now |\n\n`$deploy` [docs](https://example.com/$deploy)",
      {
        records: new Map(),
        actions: {},
        skills,
        previewFile: (path) => opened.push(path),
      },
    );
    await page.getByRole("button", { name: "Preview src/app.ts" }).click();
    expect(opened).toEqual(["src/app.ts"]);
    // A folder's chip opens nothing.
    await expect.element(page.getByText("src", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Preview src/" }).elements()).toHaveLength(0);
    // Known skills are chips in a paragraph, a list item and a table cell; an unknown one, code
    // and a link stay text.
    expect(page.getByText("Deploy", { exact: true }).elements()).toHaveLength(3);
    await expect.element(page.getByText(/not \$gone/)).toBeVisible();
    await expect.element(page.getByRole("code")).toHaveTextContent("$deploy");
    await expect
      .element(page.getByRole("link", { name: "docs" }))
      .toHaveAttribute("href", "https://example.com/$deploy");
  });

  it("keeps a file link a link outside a user message", async () => {
    render("see [app.ts](src/app.ts) and $deploy", undefined);
    await expect.element(page.getByRole("link", { name: "app.ts" })).toBeVisible();
    await expect.element(page.getByText(/and \$deploy/)).toBeVisible();
  });

  it("shows a file chip without a preview where the view opens none", async () => {
    render("see [app.ts](src/app.ts)", { records: new Map(), actions: {} });
    await expect.element(page.getByText("app.ts", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Preview src/app.ts" }).elements()).toHaveLength(0);
    expect(page.getByRole("link").elements()).toHaveLength(0);
  });
});

describe("an agent's file chip (D1643)", () => {
  const text = "Changed [a.ts](src/lib/a.ts:12:3) and `src/ui/a.ts`.";
  function agentLinks() {
    const calls: string[] = [];
    const links: AgentFileLinks = {
      workspaceRoot: "/w/acme",
      open: (path, line) => calls.push(`preview ${path} ${line ?? ""}`),
      parentSuffixes: new Map([
        ["/w/acme/src/lib/a.ts", "src/lib"],
        ["/w/acme/src/ui/a.ts", "src/ui"],
      ]),
      editors: [
        { id: "file-manager", label: "Files" },
        { id: "vscode", label: "VS Code" },
        { id: "zed", label: "Zed" },
      ],
      openInEditor: (path, editor, position) =>
        calls.push(`editor ${editor.id} ${path} ${position.line ?? ""}:${position.column ?? ""}`),
      copyPath: (value, title) => calls.push(`copy ${title} ${value}`),
    };
    return { calls, links };
  }

  it("ends with its folders when another shares its name, and its line and column", async () => {
    const { links } = agentLinks();
    render(text, undefined, links);
    await expect.element(page.getByText("a.ts · src/lib · L12:C3", { exact: true })).toBeVisible();
    await expect.element(page.getByText("a.ts · src/ui", { exact: true })).toBeVisible();
  });

  it("opens in the right panel, or with ⌘/Ctrl in the editor last chosen", async () => {
    localStorage.setItem("jhin.lastEditor", "zed");
    const { calls, links } = agentLinks();
    render(text, undefined, links);
    const chip = page.getByRole("button", { name: "Preview src/lib/a.ts" });
    await chip.click();
    const mac = isMacPlatform(navigator.platform);
    act(() => {
      chip
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: !mac, metaKey: mac }));
    });
    expect(calls).toEqual(["preview src/lib/a.ts 12", "editor zed src/lib/a.ts 12:3"]);
    localStorage.removeItem("jhin.lastEditor");
  });

  it("has T3's menu: open in the editor, copy the relative or the full path", async () => {
    localStorage.setItem("jhin.lastEditor", "vscode");
    const { calls, links } = agentLinks();
    render(text, undefined, links);
    const chip = page.getByRole("button", { name: "Preview src/lib/a.ts" });
    const openMenu = () =>
      act(() => {
        chip
          .element()
          .dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
          );
      });
    openMenu();
    await page.getByRole("menuitem", { name: "Open in VS Code" }).click();
    openMenu();
    await page.getByRole("menuitem", { name: "Copy relative path" }).click();
    openMenu();
    await page.getByRole("menuitem", { name: "Copy full path" }).click();
    expect(calls).toEqual([
      "editor vscode src/lib/a.ts 12:3",
      "copy Relative path acme/src/lib/a.ts:12:3",
      "copy Full path /w/acme/src/lib/a.ts:12:3",
    ]);
    localStorage.removeItem("jhin.lastEditor");
  });

  it("is a chip for the composer's own link form in an agent's message", async () => {
    const { links } = agentLinks();
    render("see [a.ts](src/lib/a.ts)", undefined, links);
    await expect.element(page.getByRole("button", { name: "Preview src/lib/a.ts" })).toBeVisible();
  });
});
