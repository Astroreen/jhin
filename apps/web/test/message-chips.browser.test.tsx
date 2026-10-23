import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ChatMarkdown } from "../src/plugins/chat/markdown.tsx";
import {
  type MessageContextChips,
  MessageContextChipsContext,
} from "../src/plugins/chat/message-context.ts";

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function render(text: string, chips: MessageContextChips | undefined): void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <MessageContextChipsContext value={chips}>
        <ChatMarkdown lineBreaks text={text} />
      </MessageContextChipsContext>,
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
