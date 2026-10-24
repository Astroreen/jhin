// T3 Code's preferred editor (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/editorPreferences.ts
// at eb7b35ac, the editor last chosen on this device; shared by the diff panel and the file panel.
import type { EditorInfo } from "@jhin/host-api";

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

export function rememberEditor(id: string): void {
  try {
    localStorage.setItem(LAST_EDITOR_KEY, id);
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}
