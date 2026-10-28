// Rows of the file explorer dragged into the composer (t3-parity.md D1642), as T3's
// fileTreeDragMention.test.ts checks them.
import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_MENTION_DRAG_TYPE,
  composerMentionFromTreePath,
  dataTransferHasComposerMention,
  PULL_REQUEST_DRAG_TYPE,
} from "../src/lib/composer-context.ts";
import { createFileTreeDragMentionController } from "../src/plugins/chat/file-tree-drag-mention.ts";

const makeTransfer = (plainText = "") => {
  const data = new Map<string, string>([["text/plain", plainText]]);
  return {
    setData: (format: string, value: string) => void data.set(format, value),
    getData: (format: string) => data.get(format) ?? "",
    data,
  };
};

const rowNode = (path: string) => ({
  getAttribute: (name: string) => (name === "data-item-path" ? path : null),
});

describe("a file tree row's mention", () => {
  it("is the composer's file link, a folder without its slash, the root none", () => {
    expect(composerMentionFromTreePath("docs/index.md")).toBe("[index.md](docs/index.md)");
    expect(composerMentionFromTreePath("docs/architecture/")).toBe(
      "[architecture](docs/architecture)",
    );
    expect(composerMentionFromTreePath("/")).toBeNull();
  });

  it("is a drag the composer takes, as a pull request is", () => {
    expect(dataTransferHasComposerMention([COMPOSER_MENTION_DRAG_TYPE])).toBe(true);
    expect(dataTransferHasComposerMention([PULL_REQUEST_DRAG_TYPE])).toBe(true);
    expect(dataTransferHasComposerMention(["text/plain", "Files"])).toBe(false);
    expect(COMPOSER_MENTION_DRAG_TYPE).toBe("application/x-jhin-composer-mention");
  });
});

describe("dragging rows of the file explorer", () => {
  it("tags a row drag with the mention payload and flags the drag", () => {
    const controller = createFileTreeDragMentionController();
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [{}, rowNode("docs/index.md"), {}],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[index.md](docs/index.md)");
    expect(controller.isDragInProgress()).toBe(true);
  });

  it("strips the trailing slash from directory rows", () => {
    const controller = createFileTreeDragMentionController();
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/architecture/")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[architecture](docs/architecture)");
  });

  it("does not tag drags of selected text from the panel chrome", () => {
    const controller = createFileTreeDragMentionController();
    const transfer = makeTransfer("selected text");
    controller.handleDragStart({ dataTransfer: transfer, composedPath: () => [{}] });
    expect(transfer.data.has(COMPOSER_MENTION_DRAG_TYPE)).toBe(false);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("deselects the dragged row exactly once when the drag ends", () => {
    const deselected: string[] = [];
    const controller = createFileTreeDragMentionController();
    const deselect = (path: string) => void deselected.push(path);
    controller.handleDragStart({
      dataTransfer: makeTransfer(),
      composedPath: () => [rowNode("src/app.ts")],
    });
    controller.handleDragEnd(deselect);
    controller.handleDragEnd(deselect);
    expect(deselected).toEqual(["src/app.ts"]);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("drags the whole selection when the dragged row is part of it", () => {
    const deselected: string[] = [];
    const controller = createFileTreeDragMentionController();
    controller.handleSelectionChange(["docs/index.md", "docs/api.md", "src/app.ts"]);
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/api.md")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe(
      "[index.md](docs/index.md) [api.md](docs/api.md) [app.ts](src/app.ts)",
    );
    controller.handleDragEnd((path) => void deselected.push(path));
    expect(deselected).toEqual(["docs/index.md", "docs/api.md", "src/app.ts"]);
  });

  it("drags only the row under the cursor when it is outside the selection", () => {
    const controller = createFileTreeDragMentionController();
    controller.handleSelectionChange(["docs/index.md"]);
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("src/app.ts")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[app.ts](src/app.ts)");
  });
});
