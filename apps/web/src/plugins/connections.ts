import { CONNECTIONS_CAPABILITY, type Connections, type NodeConnection } from "@jhin/client-api";
import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import { copyText } from "@jhin/ui";

import { builtin } from "../lib/builtin.ts";
import { createNodeStore } from "../lib/node-store.ts";
import {
  closeSession,
  currentSession,
  looksLikePairingCode,
  openSession,
  pairWithCode,
} from "../lib/session.ts";

const WebSocketUrl = z
  .string()
  .refine(
    (value) => URL.canParse(value) && /^wss?:$/.test(new URL(value).protocol),
    "must be a ws:// or wss:// URL",
  );

/**
 * A saved node: with a token, or `session` for the page's own node, whose
 * token is in an httpOnly cookie the page never reads (security.md D421).
 */
const Saved = z.union([
  z.object({ url: WebSocketUrl, token: z.string().min(1), label: z.string().min(1) }),
  z.object({ url: WebSocketUrl, session: z.literal(true), label: z.string().min(1) }),
]);
type Saved = z.infer<typeof Saved>;

/** Saved nodes; entries that do not parse are dropped instead of breaking the client. */
function parseSaved(raw: unknown): Saved[] {
  const byUrl = new Map<string, Saved>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const parsed = Saved.safeParse(entry);
    if (parsed.success && !byUrl.has(parsed.data.url)) byUrl.set(parsed.data.url, parsed.data);
  }
  return [...byUrl.values()];
}

/** The node that served this page, when it did: `ws(s)://<host>/rpc`. */
function sameOriginUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
}

/**
 * A token or pairing code in the URL fragment (`#token=…`, T3's pairing link
 * `/pair#token=<CODE>`) is for this page's own node; the fragment never
 * reaches the server and is removed at once (D422).
 */
function takeTokenFromUrl(): string | undefined {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token === null) return undefined;
  params.delete("token");
  const rest = params.toString();
  // The pairing page has done its work: the client opens at its root.
  const path = location.pathname === "/pair" ? "/" : location.pathname;
  history.replaceState(null, "", `${path}${location.search}${rest === "" ? "" : `#${rest}`}`);
  return token;
}

const sameSaved = (a: Saved, b: Saved) =>
  ("token" in a ? a.token : undefined) === ("token" in b ? b.token : undefined) &&
  "session" in a === "session" in b;

export const connectionsPlugin = builtin(
  "jhin.connections",
  { provides: { [CONNECTIONS_CAPABILITY]: "1.2.0" } },
  definePlugin({
    async activate(context) {
      const store = createNodeStore();
      const listeners = new Set<() => void>();
      const nodes = new Map<string, { saved: Saved; readonly client: RpcClient }>();
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
        void store
          .save([...nodes.values()].map((node) => node.saved))
          .catch((error: unknown) =>
            context.log.error("saving nodes failed", { error: String(error) }),
          );

      const open = (saved: Saved) => {
        // A session node sends no token: the browser adds its cookie to the upgrade.
        const token = "token" in saved ? saved.token : undefined;
        const client = createRpcClient({ connect: () => connectWebSocket(saved.url, token) });
        client.onState(changed);
        nodes.set(saved.url, { saved, client });
      };
      const keep = (saved: Saved) => {
        const existing = nodes.get(saved.url);
        // The same node with the same credential stays connected (e.g. a reload with #token=).
        if (existing === undefined || !sameSaved(existing.saved, saved)) {
          existing?.client.close();
          open(saved);
          persist();
          changed();
        }
        return snapshot.find((node) => node.id === saved.url)!;
      };
      const labelOf = (url: string, label?: string) =>
        label ?? (URL.canParse(url) ? new URL(url).host : url);

      const connections: Connections = {
        list: () => snapshot,
        get: (id) => snapshot.find((node) => node.id === id),
        add: ({ url, token, label }) =>
          keep(Saved.parse({ url, token, label: labelOf(url, label) })),
        async pair({ url, code, label }) {
          WebSocketUrl.parse(url);
          const { token } = await pairWithCode(url, code, `Browser on ${location.host}`);
          return keep(Saved.parse({ url, token, label: labelOf(url, label) }));
        },
        rename(id, label) {
          const node = nodes.get(id);
          const trimmed = label.trim();
          if (node === undefined || trimmed === "" || node.saved.label === trimmed) return;
          node.saved = { ...node.saved, label: trimmed };
          persist();
          changed();
        },
        remove(id) {
          const node = nodes.get(id);
          node?.client.close();
          // Forgetting the page's own node signs this page out of it.
          if (node !== undefined && "session" in node.saved) void closeSession();
          nodes.delete(id);
          persist();
          changed();
        },
        refusedCredential: () => refused,
        subscribe(listener) {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      };

      try {
        for (const saved of parseSaved(await store.load())) open(saved);
      } catch (error) {
        context.log.error("saved nodes unreadable", { error: String(error) });
      }
      // The page's own node: met in the background, so a slow node never holds
      // up the client (security.md D421). A credential in the fragment opens its
      // session; without one, a session it opened before still counts.
      const own = sameOriginUrl();
      let refused: string | undefined;
      let disposed = false;
      const credential = takeTokenFromUrl();
      const meetOwnNode = async () => {
        if (credential !== undefined) {
          const session = await currentSession();
          if (disposed) return;
          if (session === undefined) {
            // No node serves this page (a `jhin client` page): the token is kept here.
            if (!looksLikePairingCode(credential)) {
              keep({ url: own, token: credential, label: location.host });
            } else {
              refused =
                "This page is not served by a node: open the pairing link on the node's own address.";
            }
          } else {
            // A reload with the same `#token=` keeps the session it opened, instead of
            // issuing one more device token; a pairing code always pairs.
            if (session !== true || looksLikePairingCode(credential)) await openSession(credential);
            if (!disposed) keep({ url: own, session: true, label: location.host });
          }
        } else if (
          !nodes.has(own) &&
          // Unasked for, a node that cannot be reached is just not added.
          (await currentSession().catch(() => undefined)) === true &&
          !disposed
        ) {
          keep({ url: own, session: true, label: location.host });
        }
      };
      changed();

      // Another tab changed the saved nodes: this one follows, instead of
      // dropping that tab's changes with its next save.
      const stopFollowing = store.onChange(() => {
        void store.load().then((raw) => {
          const stored = new Map(parseSaved(raw).map((saved) => [saved.url, saved]));
          for (const [url, node] of nodes) {
            const saved = stored.get(url);
            if (saved === undefined || !sameSaved(saved, node.saved)) {
              node.client.close();
              nodes.delete(url);
            } else {
              node.saved = saved;
            }
          }
          for (const saved of stored.values()) if (!nodes.has(saved.url)) open(saved);
          changed();
        });
      });

      context.services.provide(CONNECTIONS_CAPABILITY, connections);
      void meetOwnNode()
        .catch((error: unknown) => {
          context.log.warn("this page's node refused its credential", { error: String(error) });
          refused = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          if (!disposed) changed();
        });

      // What can be done to a connected node, as commands (its menu runs them).
      const Node = z.object({ node: z.string() });
      const known = (id: string) => {
        const node = nodes.get(id);
        if (node === undefined) {
          throw Object.assign(new Error(`Not connected to ${id}`), { code: "NODE_NOT_FOUND" });
        }
        return node;
      };
      context.commands.register({
        name: "node.rename",
        title: "Rename node",
        description: "Changes the name this device shows for a connected node",
        input: Node.extend({ label: z.string().trim().min(1) }),
        output: z.object({}),
        handler: ({ node, label }) => {
          known(node);
          connections.rename?.(node, label);
          return {};
        },
      });
      context.commands.register({
        name: "node.copy-address",
        title: "Copy node address",
        description: "Copies the address a connected node is reached at",
        input: Node,
        output: z.object({}),
        handler: async ({ node }) => {
          await copyText(known(node).saved.url);
          return {};
        },
      });
      context.commands.register({
        name: "node.disconnect",
        title: "Disconnect node",
        description:
          "Forgets a connected node and its token on this device; the node keeps running",
        input: Node,
        output: z.object({}),
        handler: ({ node }) => {
          known(node);
          connections.remove(node);
          return {};
        },
      });

      context.subscriptions.add({
        dispose() {
          disposed = true;
          stopFollowing();
          for (const node of nodes.values()) node.client.close();
          nodes.clear();
        },
      });
    },
  }),
);
