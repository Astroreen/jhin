import type { NodeConnection } from "@jhin/client-api";
import { useEffect, useState } from "react";

export interface MeshNode {
  readonly nodeId: string;
  readonly name: string;
  readonly self: boolean;
  readonly reachable: boolean;
}

/**
 * The nodes of a connected node's mesh, kept current from its `mesh` stream.
 * `undefined` until the first answer, and while none has succeeded.
 */
export function useMeshNodes(node: NodeConnection | undefined): readonly MeshNode[] | undefined {
  const [members, setMembers] = useState<readonly MeshNode[] | undefined>(undefined);
  useEffect(() => {
    setMembers(undefined);
    if (node === undefined || node.state !== "open") return;
    let disposed = false;
    let latest = 0;
    const load = () => {
      // Answers can arrive out of order: only the newest request may update.
      const request = ++latest;
      void node.client
        .call<MeshNode[]>("mesh.nodes")
        .then((nodes) => {
          if (!disposed && request === latest) setMembers(nodes);
        })
        // A failed answer says nothing about the mesh: keep what is known. A node
        // without the mesh plugin never answers, so its routes are never judged.
        .catch(() => undefined);
    };
    load();
    const subscription = node.client.subscribe("mesh", {}, load);
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [node]);
  return members;
}
