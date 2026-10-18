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
 * `undefined` until the first answer; empty if the first one fails.
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
        // A later failure says nothing new about the mesh: keep what is known.
        // Without any answer (no mesh plugin, or it fails) no remote is known; a
        // transient first failure reads as unreachable until the next mesh event.
        .catch(() => {
          if (disposed || request !== latest) return;
          setKnown((previous) =>
            previous !== undefined && previous.node === node ? previous : { node, members: [] },
          );
        });
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
