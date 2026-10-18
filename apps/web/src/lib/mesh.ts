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
  // Keyed by the connection, so a new one never sees the previous one's members.
  const [known, setKnown] = useState<{
    node: NodeConnection;
    members: readonly MeshNode[];
  }>();
  useEffect(() => {
    if (node === undefined || node.state !== "open") return;
    let disposed = false;
    let latest = 0;
    const load = () => {
      // Answers can arrive out of order: only the newest request may update.
      const request = ++latest;
      void node.client
        .call<MeshNode[]>("mesh.nodes")
        .then((nodes) => {
          if (!disposed && request === latest) setKnown({ node, members: nodes });
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
  return known !== undefined && known.node === node ? known.members : undefined;
}
