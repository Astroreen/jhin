import { CONNECTIONS_CAPABILITY, type Connections, type NodeConnection } from "@jhin/client-api";
import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

const STORAGE_KEY = "jhin.nodes";

interface Saved {
  readonly url: string;
  readonly token: string;
  readonly label: string;
}

function load(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Saved[];
  } catch {
    return [];
  }
}

/** The node that served this page, when it did: `ws(s)://<host>/rpc`. */
function sameOriginUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
}

/**
 * A token in the URL fragment (`#token=…`) connects this page's own node;
 * the fragment never reaches the server and is removed at once.
 */
function takeTokenFromUrl(): string | undefined {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token === null) return undefined;
  params.delete("token");
  const rest = params.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${rest === "" ? "" : `#${rest}`}`,
  );
  return token;
}

export const connectionsPlugin = builtin(
  "jhin.connections",
  { provides: { [CONNECTIONS_CAPABILITY]: "1.0.0" } },
  definePlugin({
    activate(context) {
      const listeners = new Set<() => void>();
      const nodes = new Map<string, { saved: Saved; client: RpcClient }>();
      let snapshot: readonly NodeConnection[] = [];
      const changed = () => {
        snapshot = [...nodes.values()].map(({ saved, client }) => ({
          id: saved.url,
          url: saved.url,
          label: saved.label,
          client,
          state: client.state,
        }));
        for (const listener of Array.from(listeners)) listener();
      };
      const persist = () =>
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([...nodes.values()].map((node) => node.saved)),
        );

      const open = (saved: Saved) => {
        const client = createRpcClient({ connect: () => connectWebSocket(saved.url, saved.token) });
        client.onState(changed);
        nodes.set(saved.url, { saved, client });
      };

      const connections: Connections = {
        list: () => snapshot,
        get: (id) => snapshot.find((node) => node.id === id),
        add({ url, token, label }) {
          nodes.get(url)?.client.close();
          open({ url, token, label: label ?? new URL(url).host });
          persist();
          changed();
          return snapshot.find((node) => node.id === url)!;
        },
        remove(id) {
          nodes.get(id)?.client.close();
          nodes.delete(id);
          persist();
          changed();
        },
        subscribe(listener) {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      };

      for (const saved of load()) open(saved);
      const token = takeTokenFromUrl();
      if (token !== undefined)
        connections.add({ url: sameOriginUrl(), token, label: location.host });
      changed();

      context.services.provide(CONNECTIONS_CAPABILITY, connections);
      context.subscriptions.add({
        dispose() {
          for (const node of nodes.values()) node.client.close();
          nodes.clear();
        },
      });
    },
  }),
);
