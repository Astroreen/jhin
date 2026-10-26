import type { Disposable } from "@jhin/sdk";

/** `mesh.streams@1`, provided by `jhin.mesh` (D501); 1.1 adds following a member's stream (D1522). */
export const MESH_STREAMS_CAPABILITY = "mesh.streams";

/** One event of a member's stream, with the owner's sequence. */
export interface MemberEvent {
  readonly stream: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
  /** ISO 8601 time of the append on the owner. */
  readonly at: string;
}

/** A member's stream followed from this node (D1522). */
export interface FollowedMemberStream extends Disposable {
  /**
   * The owner's head once attached; rejects with the relay's error
   * (`NODE_UNREACHABLE`, `STREAM_NOT_SHARED`, `PERMISSION_DENIED`, `RELAY_*`).
   */
  readonly ready: Promise<number>;
}

/** Another member of the mesh, as `mesh.streams@1.1` lists it. */
export interface StreamMember {
  readonly nodeId: string;
  /** A route to it exists now. */
  readonly reachable: boolean;
}

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
  /**
   * 1.1 (D1522): follows `stream` on the member `node` from `after`, as a relay
   * does (D499): `listener` hears each event with the owner's sequence. An
   * attached follower waits while the route is away and resumes where it
   * was; `onEnd` hears a refusal that comes later (the owner stopped sharing).
   */
  follow?(
    node: string,
    stream: string,
    after: number,
    listener: (event: MemberEvent) => void,
    onEnd?: (error: unknown) => void,
  ): FollowedMemberStream;
  /** 1.1: the other members, each with whether it is reachable now. */
  members?(): readonly StreamMember[];
  /** 1.1: hears every change of the members or of their reachability. */
  onChange?(listener: () => void): Disposable;
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

/**
 * Whether `nodeId` is **away** (agents.md D1547, D1551): `members` (`members()`
 * of `mesh.streams@1.1`) lists it unreachable. A node it does not list is not
 * known yet, not away; without members (no mesh, or a provider before 1.1)
 * no node is away. Call it for another node: `members()` never lists this one.
 */
export function isAway(members: readonly StreamMember[] | undefined, nodeId: string): boolean {
  return members?.find((item) => item.nodeId === nodeId)?.reachable === false;
}
