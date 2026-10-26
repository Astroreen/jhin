// The nodes Civilization mode reads (agents.md D1527), as a React hook.
import type { Connections, MeshMembership } from "@jhin/client-api";
import { useMemo, useSyncExternalStore } from "react";

import { createMeshTargets, meshTargets, type MeshTarget } from "./mesh-targets.ts";

/** Every open connection and reachable member of its mesh, followed while mounted. */
export function useMeshTargets(
  connections: Connections,
  mesh: MeshMembership | undefined,
): readonly MeshTarget[] {
  const store = useMemo(() => {
    // What shows before the first subscription: the open connections as known now.
    let last: readonly MeshTarget[] = meshTargets(connections.list(), (id) => mesh?.members(id));
    return {
      subscribe(listener: () => void) {
        const followed = createMeshTargets(connections, mesh);
        last = followed.snapshot();
        const subscription = followed.subscribe(() => {
          last = followed.snapshot();
          listener();
        });
        listener();
        return () => {
          subscription.dispose();
          followed.dispose();
        };
      },
      snapshot: () => last,
    };
  }, [connections, mesh]);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
