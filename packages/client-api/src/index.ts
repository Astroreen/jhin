import type { ConnectionState, RpcClient } from "@jhin/rpc";
import { z, type Disposable } from "@jhin/sdk";

export const CONNECTIONS_CAPABILITY = "client.connections";
export const NAVIGATION_CAPABILITY = "client.navigation";
export const MESH_CAPABILITY = "client.mesh";

/** One node this client talks to (D8: a client holds N connections). */
export interface NodeConnection {
  /** Stable within this client: the node's RPC URL. */
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly client: RpcClient;
  readonly state: ConnectionState;
}

/** `client.connections@1`: the nodes this client is connected to. */
export interface Connections {
  list(): readonly NodeConnection[];
  get(id: string): NodeConnection | undefined;
  /** Connects to a node and remembers it on this device. */
  add(node: { url: string; token: string; label?: string }): NodeConnection;
  remove(id: string): void;
  /** Fires when the list or any connection state changes. */
  subscribe(listener: () => void): Disposable;
}

/** One node of a connected node's mesh, as that node's `mesh.nodes` lists it. */
export interface MeshMember {
  readonly nodeId: string;
  readonly name: string;
  /** The connected node itself. */
  readonly self: boolean;
  /** The connected node has a route to it now. */
  readonly reachable: boolean;
}

/**
 * `client.mesh@1`: the mesh of each connected node, kept current from its
 * `mesh` stream. One feed per connection, shared by every subscriber: the
 * first subscriber opens it, the last one closes it.
 */
export interface MeshMembership {
  /**
   * What the connection's node reports: `undefined` while nobody subscribes,
   * while the connection is not open and until the first answer; empty when
   * the first answer fails (no mesh plugin there). The same array until it
   * changes.
   */
  members(connection: string): readonly MeshMember[] | undefined;
  /** Follows the connection's mesh; `listener` fires whenever `members` changes. */
  subscribe(connection: string, listener: () => void): Disposable;
}

export interface Route {
  /** The connection (node this client talks to). */
  readonly node?: string;
  /** Another node of that node's mesh, reached through it (D47). */
  readonly remote?: string;
  readonly thread?: string;
  /** A panel opened on top of the main view, e.g. "inspector". */
  readonly panel?: string;
}

/** `client.navigation@1`: where the user is; kept in the URL. */
export interface Navigation {
  current(): Route;
  navigate(route: Route): void;
  subscribe(listener: () => void): Disposable;
}

/** The `jhin.ui` config section: slot rules (D12), keyed by slot name. */
export const UI_CONFIG_SECTION = "jhin.ui";
export const UiConfig = z.object({
  hide: z.record(z.string(), z.array(z.string())).default({}),
  order: z.record(z.string(), z.array(z.string())).default({}),
});
export type UiConfig = z.output<typeof UiConfig>;
