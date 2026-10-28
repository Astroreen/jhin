// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/fileTreeDragMention.ts.
//
// Rows of the file explorer dragged into the composer (t3-parity.md D1642): the dragged rows, the
// selection when the row is in it, carry their mentions joined by a space.
import {
  COMPOSER_MENTION_DRAG_TYPE,
  composerMentionFromTreePath,
} from "../../lib/composer-context.ts";

interface FileTreeDragTransfer {
  setData(format: string, data: string): void;
}

export interface FileTreeDragStartEvent {
  readonly dataTransfer: FileTreeDragTransfer | null;
  composedPath(): ReadonlyArray<unknown>;
}

export interface FileTreeDragMentionController {
  isDragInProgress(): boolean;
  handleSelectionChange(selectedPaths: ReadonlyArray<string>): void;
  handleDragStart(event: FileTreeDragStartEvent): void;
  handleDragEnd(deselect: (treePath: string) => void): void;
}

const itemPathOf = (node: unknown): string | null => {
  if (typeof node !== "object" || node === null) return null;
  const element = node as { getAttribute?: (name: string) => string | null };
  return typeof element.getAttribute === "function" ? element.getAttribute("data-item-path") : null;
};

export function createFileTreeDragMentionController(): FileTreeDragMentionController {
  let selection: ReadonlyArray<string> = [];
  let draggedPaths: ReadonlyArray<string> = [];
  return {
    isDragInProgress: () => draggedPaths.length > 0,
    handleSelectionChange(selectedPaths) {
      selection = selectedPaths;
    },
    handleDragStart(event) {
      if (event.dataTransfer === null) return;
      // Only drags that originate on a tree row are mentions; a text/plain
      // fallback would also tag drags of selected text from the panel chrome.
      let itemPath: string | null = null;
      for (const node of event.composedPath()) {
        itemPath = itemPathOf(node);
        if (itemPath !== null) break;
      }
      if (itemPath === null) return;
      const dragged = selection.includes(itemPath) ? selection : [itemPath];
      const mentions = dragged
        .map((path) => composerMentionFromTreePath(path))
        .filter((mention): mention is string => mention !== null);
      if (mentions.length === 0) return;
      draggedPaths = dragged;
      event.dataTransfer.setData(COMPOSER_MENTION_DRAG_TYPE, mentions.join(" "));
    },
    handleDragEnd(deselect) {
      if (draggedPaths.length === 0) return;
      for (const path of draggedPaths) deselect(path);
      draggedPaths = [];
    },
  };
}
