import { isPlainHttpUrl } from "@jhin/auth-api";
import { CONNECTIONS_CAPABILITY, type Connections, type NodeConnection } from "@jhin/client-api";
import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import { copyText } from "@jhin/ui";

import { builtin } from "../lib/builtin.ts";
import { createDeviceKey, isDeviceKey, type DeviceKey } from "../lib/dpop.ts";
import { createNodeStore } from "../lib/node-store.ts";
import {
  closeSession,
  currentSession,
  looksLikePairingCode,
  openSession,
  pageBase,
  pairWithCode,
  rpcUrl,
  webSocketTicket,
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
  z.object({
    url: WebSocketUrl,
    token: z.string().min(1),
    label: z.string().min(1),
    /** The key the token is bound to (security.md D1368): it connects through tickets. */
    key: z.custom<DeviceKey>(isDeviceKey).optional(),
  }),
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
  // Under the page's base path, as a node behind a proxy path serves both.
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${pageBase()}rpc`;
}

/**
 * A token or pairing code in the URL fragment (`#token=…`, T3's pairing link
 * `/pair#token=<CODE>`) is for this page's own node; the fragment never
 * reaches the server and is removed at once (D422). A `jhin client` page's
 * link (T3's hosted link, `/pair?host=<node>&label=<name>#token=<CODE>`,
 * security.md D1190) names the node in `host`: removed with it.
 */
function takeTokenFromUrl(): { token: string; host?: string; label?: string } | undefined {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token === null) return undefined;
  params.delete("token");
  const rest = params.toString();
  const query = new URLSearchParams(location.search);
  const onPairPath = /\/pair\/?$/.test(location.pathname);
  const host = onPairPath ? (query.get("host")?.trim() ?? "") : "";
  const label = onPairPath ? (query.get("label")?.trim() ?? "") : "";
  if (onPairPath) {
    query.delete("host");
    query.delete("label");
  }
  const search = query.toString();
  // The pairing page has done its work: the client opens at its root.
  // `/pair`, or `/jhin/pair` behind a proxy path: the client opens at that base.
  const path = location.pathname.replace(/\/pair\/?$/, "/");
  history.replaceState(
    null,
    "",
    `${path}${search === "" ? "" : `?${search}`}${rest === "" ? "" : `#${rest}`}`,
  );
  return {
    token,
    ...(host === "" ? {} : { host }),
    ...(label === "" ? {} : { label }),
  };
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
      // One save after another, each with the list as it is then: two quick
      // changes never land in the wrong order.
      // Saves wait for the saved list to be read first, so none overwrites it.
      let readSaved: () => void = () => {};
      let saving: Promise<void> = new Promise<void>((resolve) => (readSaved = resolve));
      /** Grows with every local change, so a read that raced one is not applied. */
      let changes = 0;
      /** Set when the plugin goes: late answers then open nothing. */
      let disposed = false;
      const persist = () => {
        changes++;
        saving = saving
          .then(() => store.save([...nodes.values()].map((node) => node.saved)))
          .catch((error: unknown) =>
            context.log.error("saving nodes failed", { error: String(error) }),
          );
      };

      const open = (saved: Saved) => {
        // A session node sends no token: the browser adds its cookie to the upgrade.
        const token = "token" in saved ? saved.token : undefined;
        const key = "key" in saved ? saved.key : undefined;
        const client = createRpcClient({
          // A bound token never goes on the socket: a fresh ticket does (D1367).
          connect: async () =>
            connectWebSocket(
              saved.url,
              token !== undefined && key !== undefined
                ? await webSocketTicket(saved.url, token, key)
                : token,
            ),
        });
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

      const pairNode = async ({
        url,
        code,
        label,
      }: {
        url: string;
        code: string;
        label?: string;
      }) => {
        WebSocketUrl.parse(url);
        // Bound to a key of this browser where it can make one (D1368).
        const key = await createDeviceKey();
        const { token, tokenType } = await pairWithCode(
          url,
          code,
          `Browser on ${location.host}`,
          key,
        );
        if (disposed) throw new Error("This client stopped while pairing");
        const kept = keep(
          Saved.parse({
            url,
            token,
            label: labelOf(url, label),
            // An older node answers a bearer token: the key is no use to it.
            ...(tokenType === "DPoP" && key !== undefined ? { key } : {}),
          }),
        );
        refused = undefined;
        return kept;
      };

      const connections: Connections = {
        list: () => snapshot,
        get: (id) => snapshot.find((node) => node.id === id),
        add: ({ url, token, label }) => {
          const kept = keep(Saved.parse({ url, token, label: labelOf(url, label) }));
          // A node the user connected answers the refusal the page was opened with.
          refused = undefined;
          return kept;
        },
        pair: (input) => pairNode(input),
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
          if (node !== undefined && "session" in node.saved) {
            // Best effort: a node that cannot be reached keeps its session cookie
            // until it expires, and offers the node again on the next visit.
            void closeSession().catch((error: unknown) =>
              context.log.warn("signing out of this page's node failed", {
                error: String(error),
              }),
            );
          }
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

      // The saved nodes, read before the client starts, unless IndexedDB does not
      // answer in time (some private modes never do): then the client starts
      // without them, and they join when they come.
      const loading = store
        .load()
        .then((raw) => {
          if (disposed) return;
          for (const saved of parseSaved(raw)) if (!nodes.has(saved.url)) open(saved);
        })
        .catch((error: unknown) =>
          context.log.error("saved nodes unreadable", { error: String(error) }),
        )
        .finally(() => {
          readSaved();
          if (!disposed) changed();
        });
      const SAVED_NODES_WAIT_MS = 2000;
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        loading,
        new Promise<void>((resolve) => (waited = setTimeout(resolve, SAVED_NODES_WAIT_MS))),
      ]);
      clearTimeout(waited);
      // The page's own node: met in the background, so a slow node never holds
      // up the client (security.md D421). A credential in the fragment opens its
      // session; without one, a session it opened before still counts.
      const own = sameOriginUrl();
      let refused: string | undefined;
      const fromUrl = takeTokenFromUrl();
      const credential = fromUrl?.host === undefined ? fromUrl?.token : undefined;
      const meetOwnNode = async () => {
        if (fromUrl?.host !== undefined) {
          // A `jhin client` link (D1190): the code pairs with the node it names,
          // an http(s) address and nothing more. A refusal shows on the page.
          if (!isPlainHttpUrl(fromUrl.host)) {
            throw new Error(
              "This pairing link does not name a node address. Request a new pairing link.",
            );
          }
          const url = rpcUrl(new URL(fromUrl.host).toString());
          // As T3's hosted link: a one-time pairing code only. A link never
          // makes this page keep a standing token for a node it names.
          if (!looksLikePairingCode(fromUrl.token)) {
            throw new Error(
              "This pairing link does not carry a pairing code. Request a new pairing link.",
            );
          }
          await pairNode({
            url,
            code: fromUrl.token,
            ...(fromUrl.label === undefined ? {} : { label: fromUrl.label }),
          });
          return;
        }
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
        } else {
          const saved = nodes.get(own)?.saved;
          if (saved !== undefined && "session" in saved) return;
          // Unasked for, a node that cannot be reached is just not added.
          const session = await currentSession().catch(() => undefined);
          if (disposed || session === undefined) return;
          if (saved !== undefined && "token" in saved) {
            // Saved by a version before D421 with its token: traded for the
            // session cookie, and the readable token leaves this device.
            if (session !== true) await openSession(saved.token);
            if (!disposed) keep({ url: own, session: true, label: saved.label });
          } else if (session === true) {
            keep({ url: own, session: true, label: location.host });
          }
        }
      };
      changed();

      // Another tab changed the saved nodes: this one follows, instead of
      // dropping that tab's changes with its next save.
      const stopFollowing = store.onChange(() => {
        // Our own pending save goes first, so a node just added here is not
        // dropped by reading the list before it landed.
        const before = changes;
        void saving
          .then(() => store.load())
          .then((raw) => {
            // A change made here meanwhile is newer than what was read; its own
            // save writes it, so this read is dropped rather than undoing it.
            if (changes !== before || disposed) return;
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
          })
          .catch((error: unknown) =>
            context.log.error("following another tab's nodes failed", { error: String(error) }),
          );
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
