// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/diffFileActions.ts
// (resolving a diff's path in the workspace), editorPreferences.ts (the preferred editor) and
// fileContextMenu.ts ("Open", "Open with", the failure toasts).
import { targetKey, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";
import type { EditorInfo } from "@jhin/host-api";
import {
  ContextMenuPopup,
  MenuItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  type Toasts,
} from "@jhin/ui";
import { useSyncExternalStore } from "react";

function normalizedRelativePathSegments(filePath: string): readonly string[] | null {
  if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return null;
  const segments = filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

const trimSlash = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * A repository-relative path of a diff as a path relative to the project's
 * folder, which may sit below the repository's root; none for a file outside
 * the project (D287, T3's resolveDiffPathForWorkspace).
 */
export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: string | undefined;
}): string | null {
  const fileSegments = normalizedRelativePathSegments(input.filePath);
  if (!fileSegments) return null;
  if (!input.workspaceRoot || !input.repositoryRoot) return fileSegments.join("/");
  const workspace = trimSlash(input.workspaceRoot);
  const repository = trimSlash(input.repositoryRoot);
  if (workspace === repository) return fileSegments.join("/");
  if (!workspace.startsWith(`${repository}/`)) return null;
  const workspaceSegments = workspace
    .slice(repository.length + 1)
    .split("/")
    .filter(Boolean);
  const belongs = workspaceSegments.every((segment, index) => fileSegments[index] === segment);
  if (!belongs) return null;
  const relative = fileSegments.slice(workspaceSegments.length);
  return relative.length > 0 ? relative.join("/") : null;
}

const LAST_EDITOR_KEY = "jhin.lastEditor";

/** The editor to open with: the last one chosen on this device if the node has it, else its first. */
export function preferredEditor(
  editors: readonly EditorInfo[],
  storage: Pick<Storage, "getItem"> = localStorage,
): EditorInfo | undefined {
  let last: string | null = null;
  try {
    last = storage.getItem(LAST_EDITOR_KEY);
  } catch {
    last = null;
  }
  return (
    editors.find((editor) => editor.id === last) ??
    editors.find((editor) => editor.id !== "file-manager")
  );
}

function rememberEditor(id: string) {
  try {
    localStorage.setItem(LAST_EDITOR_KEY, id);
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}

const NO_EDITORS: readonly EditorInfo[] = [];

/** The editors of each node (`editors.list`), read once per target; none where the plugin is absent. */
export function createEditors(threads: ThreadsCatalog, toasts: Toasts | undefined) {
  /** Each node's answer; a failed read is not kept, so the next view asks again. */
  const lists = new Map<string, readonly EditorInfo[]>();
  const loading = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const load = (target: NodeTarget) => {
    const key = targetKey(target);
    if (loading.has(key)) return;
    loading.add(key);
    void threads
      .call<{ editors?: EditorInfo[] } | undefined>(target, "editors.list", {})
      .then(
        (answer) => lists.set(key, answer?.editors ?? NO_EDITORS),
        () => lists.delete(key),
      )
      .finally(() => {
        loading.delete(key);
        changed();
      });
  };
  const subscribers = new Map<string, (listener: () => void) => () => void>();
  /** A view that starts following a node reads its editors again (one installed meanwhile shows). */
  const subscriberFor = (target: NodeTarget) => {
    const key = targetKey(target);
    let subscribe = subscribers.get(key);
    if (subscribe === undefined) {
      const fixed = { ...target };
      subscribe = (listener) => {
        listeners.add(listener);
        load(fixed);
        return () => listeners.delete(listener);
      };
      subscribers.set(key, subscribe);
    }
    return subscribe;
  };
  const open = async (
    target: NodeTarget,
    projectId: string,
    path: string,
    editor: EditorInfo,
  ): Promise<void> => {
    try {
      await threads.call(target, "editors.open", { projectId, path, editor: editor.id });
      // Remembered once it opened: an editor that fails is not the one the next click uses.
      if (editor.id !== "file-manager") rememberEditor(editor.id);
    } catch (error) {
      toasts?.show({
        type: "error",
        title:
          editor.id === "file-manager"
            ? "Could not open the folder"
            : `Could not open in ${editor.label}`,
        description: `${path}: ${(error as Error).message}`,
      });
    }
  };
  return {
    /** The node's editors, read when a view starts following the node. */
    useEditors(target: NodeTarget): readonly EditorInfo[] {
      const key = targetKey(target);
      return useSyncExternalStore(subscriberFor(target), () => lists.get(key) ?? NO_EDITORS);
    },
    open,
  };
}

export type Editors = ReturnType<typeof createEditors>;

/**
 * T3's file context menu: the file manager (on the containing folder, so no
 * file of the project is run by its default application) and "Open with"
 * every editor found.
 */
export function FileContextMenuPopup(props: {
  editors: readonly EditorInfo[];
  onOpen(editor: EditorInfo): void;
}) {
  const fileManager = props.editors.find((editor) => editor.id === "file-manager");
  const others = props.editors.filter((editor) => editor.id !== "file-manager");
  return (
    <ContextMenuPopup>
      {fileManager === undefined ? null : (
        <MenuItem onClick={() => props.onOpen(fileManager)}>Open containing folder</MenuItem>
      )}
      {others.length === 0 ? null : (
        <MenuSub>
          <MenuSubTrigger>Open with</MenuSubTrigger>
          <MenuSubPopup>
            {others.map((editor) => (
              <MenuItem key={editor.id} onClick={() => props.onOpen(editor)}>
                {editor.label}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      )}
    </ContextMenuPopup>
  );
}
