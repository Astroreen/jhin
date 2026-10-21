// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/diffFileActions.ts
// (resolving a diff's path in the workspace), editorPreferences.ts (the preferred editor) and
// fileContextMenu.ts ("Reveal in …", "Open with", the failure toasts) and
// components/preview/fileExplorerLabel.ts (the reveal wording).
import { targetKey, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";
import type { EditorInfo, FileManagerRevealKind } from "@jhin/host-api";
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

/**
 * `path` relative to `root`, with `.` and `..` resolved; undefined when it is
 * not inside it. Windows paths compare without case, as their file systems do.
 */
export function pathInside(root: string, path: string): string | undefined {
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
  const segments = (value: string) => {
    const out: string[] = [];
    // A backslash separates on Windows only: on POSIX it may be part of a name.
    for (const part of (windows ? value.replaceAll("\\", "/") : value).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out;
  };
  const rootSegments = segments(root);
  const pathSegments = segments(path);
  const same = (a: string | undefined, b: string | undefined) =>
    windows ? a?.toLowerCase() === b?.toLowerCase() : a === b;
  if (pathSegments.length <= rootSegments.length) return undefined;
  if (!rootSegments.every((segment, index) => same(segment, pathSegments[index]))) return undefined;
  return pathSegments.slice(rootSegments.length).join("/");
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

/** T3's wording of the file manager's item, by what the node's file manager is (D922). */
function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Reveal in Finder";
  if (kind === "file-explorer") return "Reveal in File Explorer";
  return "Reveal in Files";
}

interface EditorsList {
  readonly editors: readonly EditorInfo[];
  readonly revealKind?: FileManagerRevealKind;
}

/** The editors of each node (`editors.list`), read once per target; none where the plugin is absent. */
export function createEditors(threads: ThreadsCatalog, toasts: Toasts | undefined) {
  /** Each node's answer; a failed read is not kept, so the next view asks again. */
  const lists = new Map<string, EditorsList>();
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
      .call<Partial<EditorsList> | undefined>(target, "editors.list", {})
      .then(
        (answer) =>
          lists.set(key, {
            editors: answer?.editors ?? NO_EDITORS,
            ...(answer?.revealKind === undefined ? {} : { revealKind: answer.revealKind }),
          }),
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
    options: { reveal?: boolean } = {},
  ): Promise<void> => {
    const reveal = options.reveal === true;
    try {
      await threads.call(target, "editors.open", {
        projectId,
        path,
        editor: editor.id,
        ...(reveal ? { reveal: true } : {}),
      });
      // Remembered once it opened: an editor that fails is not the one the next click uses.
      if (editor.id !== "file-manager") rememberEditor(editor.id);
    } catch (error) {
      toasts?.show({
        type: "error",
        title: reveal
          ? "Unable to reveal file"
          : editor.id === "file-manager"
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
      return useSyncExternalStore(
        subscriberFor(target),
        () => lists.get(key)?.editors ?? NO_EDITORS,
      );
    },
    /** What the node's file manager is, for its "Reveal in …" item. */
    useRevealKind(target: NodeTarget): FileManagerRevealKind | undefined {
      const key = targetKey(target);
      return useSyncExternalStore(subscriberFor(target), () => lists.get(key)?.revealKind);
    },
    open,
  };
}

export type Editors = ReturnType<typeof createEditors>;

/**
 * T3's file context menu: "Reveal in …" with the file manager (the file shown,
 * never run by its default application, D922) and "Open with" every editor found.
 */
export function FileContextMenuPopup(props: {
  editors: readonly EditorInfo[];
  revealKind: FileManagerRevealKind | undefined;
  onOpen(editor: EditorInfo): void;
  onReveal(fileManager: EditorInfo): void;
}) {
  const fileManager = props.editors.find((editor) => editor.id === "file-manager");
  const others = props.editors.filter((editor) => editor.id !== "file-manager");
  return (
    <ContextMenuPopup>
      {fileManager === undefined ? null : props.revealKind === undefined ? (
        // A node from before D922 says no kind and cannot reveal: its folder opens.
        <MenuItem onClick={() => props.onOpen(fileManager)}>Open containing folder</MenuItem>
      ) : (
        <MenuItem onClick={() => props.onReveal(fileManager)}>
          {revealInFileExplorerLabelForKind(props.revealKind)}
        </MenuItem>
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
