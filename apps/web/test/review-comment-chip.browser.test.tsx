// A review comment's chip opens T3's popover with its file, lines, text and patch
// (docs/plans/source-control.md D1458).
import type { ReviewCommentContextRecord } from "@jhin/agent-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ContextRecordChip } from "../src/plugins/chat/context-chips.tsx";

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

const record: ReviewCommentContextRecord = {
  version: 1,
  kind: "review-comment",
  contextId: "review-comment_1",
  label: "app.ts L2",
  sectionId: "jhin.source-control.git:branch",
  sectionTitle: "Changes",
  filePath: "src/app.ts",
  startIndex: 2,
  endIndex: 2,
  rangeLabel: "+2",
  text: "Why **three**?",
  diff: "@@ -0,0 +2,1 @@\n+const two = 3;",
};

it("opens the comment's file, lines, text and patch in its popover", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ContextRecordChip
        actions={{}}
        href="jhin-context://review-comment_1"
        label="app.ts L2"
        record={record}
        unavailable="Context no longer available"
      />,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  await userEvent.click(
    page.getByRole("button", { name: "Review comment, app.ts L2. Show details" }),
  );
  const popup = page.getByRole("dialog", { name: "Review comment, app.ts L2" });
  await expect.element(popup.getByText("src/app.ts")).toBeVisible();
  await expect.element(popup.getByText("Changes · +2")).toBeVisible();
  // The text as markdown.
  await expect.element(popup.getByText("three", { exact: true })).toBeVisible();
  expect(popup.getByText("three", { exact: true }).element().tagName).toBe("STRONG");
  // The patch, in its read-only view.
  await expect.element(popup.getByText("const two = 3;")).toBeVisible();
});
