import { CONNECTIONS_CAPABILITY, type Connections, type NodeConnection } from "@jhin/client-api";
import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable, z } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

const STORAGE_KEY = "jhin.nodes";

const WebSocketUrl = z
  .string()
  .refine(
    (value) => URL.canParse(value) && /^wss?:$/.test(new URL(value).protocol),
    "must be a ws:// or wss:// URL",
  );

const Saved = z.object({ url: WebSocketUrl, token: z.string().min(1), label: z.string().min(1) });
type Saved = z.infer<typeof Saved>;

/** Saved nodes; entries that do not parse are dropped instead of breaking the client. */
function load(): Saved[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const parsed = Saved.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The node that served this page, when it did: `ws(s)://<host>/rpc`. */
function sameOriginUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
}

// Tokens are kept in localStorage: any script on this origin can read them,
// including user client plugins. Recorded as a known limit in the plan.

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
        // An unchanged node keeps its object: views keyed on it do not restart.
        snapshot = [...nodes.values()].map(({ saved, client }) => {
          const previous = snapshot.find((node) => node.id === saved.url);
          return previous !== undefined &&
            previous.client === client &&
            previous.label === saved.label &&
            previous.state === client.state
            ? previous
            : { id: saved.url, url: saved.url, label: saved.label, client, state: client.state };
        });
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
          const saved = Saved.parse({
            url,
            token,
            label: label ?? (URL.canParse(url) ? new URL(url).host : url),
          });
          const existing = nodes.get(saved.url);
          // The same node with the same token stays connected (e.g. a reload with #token=).
          if (existing === undefined || existing.saved.token !== saved.token) {
            existing?.client.close();
            open(saved);
            persist();
            changed();
          }
          return snapshot.find((node) => node.id === saved.url)!;
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
