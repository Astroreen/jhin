// The editors of a node (`editors.list`), for the file explorer's "Open" and "Open with"
// (t3-parity.md D1642) and an agent's file chip's "Open in <editor>" (D1643), as T3 reads its
// server's `availableEditors`.
import { targetKey, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";
import type { EditorInfo } from "@jhin/host-api";
import { useEffect, useState } from "react";

const NO_EDITORS: readonly EditorInfo[] = [];

/** The node's editors, the file manager among them; none until read, or without the editors plugin. */
export function useNodeEditors(
  threads: ThreadsCatalog,
  target: NodeTarget,
  enabled = true,
): readonly EditorInfo[] {
  const node = targetKey(target);
  const [listed, setListed] = useState<{ node: string; editors: readonly EditorInfo[] }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    threads.call<{ editors?: EditorInfo[] } | undefined>(target, "editors.list", {}).then(
      (answer) => current && setListed({ node, editors: answer?.editors ?? NO_EDITORS }),
      // A node without the editors plugin opens nothing.
      () => current && setListed({ node, editors: NO_EDITORS }),
    );
    return () => {
      current = false;
    };
  }, [node, enabled]);
  return enabled && listed?.node === node ? listed.editors : NO_EDITORS;
}
