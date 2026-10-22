import type { Disposable } from "@jhin/sdk";

/** `mesh.streams@1`, provided by `jhin.mesh` (D501). */
export const MESH_STREAMS_CAPABILITY = "mesh.streams";

/**
 * Streams a node shares with the other members of its mesh. Members may read
 * only the streams D26 names (threads, the thread index, `mesh`) unless a
 * plugin shares more: a shared stream can be subscribed to over a link and
 * relayed to another node's clients (D499), read from `rpc.streams@1` when a
 * plugin serves it there and from the event log otherwise.
 */
export interface MeshStreams {
  /**
   * Shares `name` (a stream, or every stream under a prefix ending in `/`)
   * until the returned disposable is disposed.
   */
  share(name: string): Disposable;
}

/** Where a node serves the streams it relays from members. */
export const RELAY_PREFIX = "relay/";

/** The stream a node relays `owner`'s `stream` under (D499): `relay/<owner>/<stream>`. */
export function relayStream(owner: string, stream: string): string {
  return `${RELAY_PREFIX}${owner}/${stream}`;
}

/** The owner and stream of a relay's name, or `undefined` for any other stream. */
export function parseRelayStream(name: string): { owner: string; stream: string } | undefined {
  if (!name.startsWith(RELAY_PREFIX)) return undefined;
  const rest = name.slice(RELAY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { owner: rest.slice(0, slash), stream: rest.slice(slash + 1) };
}
