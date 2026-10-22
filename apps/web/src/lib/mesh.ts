import type { MeshMember, MeshMembership } from "@jhin/client-api";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The nodes of a connected node's mesh from `client.mesh@1`: every view reads
 * the connection's one shared feed. `undefined` until the first answer; empty
 * if the first one fails.
 */
export function useMeshMembers(
  mesh: MeshMembership,
  connection: string | undefined,
): readonly MeshMember[] | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (connection === undefined) return () => undefined;
      const subscription = mesh.subscribe(connection, listener);
      return () => subscription.dispose();
    },
    [mesh, connection],
  );
  return useSyncExternalStore(subscribe, () =>
    connection === undefined ? undefined : mesh.members(connection),
  );
}
