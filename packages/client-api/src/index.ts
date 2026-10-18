import type { ConnectionState, RpcClient } from "@jhin/rpc";
import { z, type Disposable } from "@jhin/sdk";

export const CONNECTIONS_CAPABILITY = "client.connections";
export const NAVIGATION_CAPABILITY = "client.navigation";

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

export interface Route {
  readonly node?: string;
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
