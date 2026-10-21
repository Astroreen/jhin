import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import type { IncomingMessage } from "node:http";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  HOST_IDENTITY_CAPABILITY,
  HOST_PATHS_CAPABILITY,
  type HostIdentity,
  type HostPaths,
  sendConfigChange,
} from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import {
  createMesh,
  meshCallCommand,
  meshRelayCommand,
  serveRelays,
  type MemberRecord,
  type MemberView,
  type MeshTransport,
} from "@jhin/mesh-core";
import { MESH_STREAMS_CAPABILITY, type MeshStreams } from "@jhin/mesh-api";
import {
  CLOSE_UNAUTHENTICATED,
  LIVE_STREAMS_CAPABILITY,
  TOKEN_PROTOCOL_PREFIX,
  PROTOCOL,
  connectWebSocket,
  webSocketPeer,
  type LiveStreams,
  type WebSocketLike,
} from "@jhin/rpc";
import { definePlugin, isGrant, z, describePermissions } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";
import { WebSocketServer, type WebSocket } from "ws";

import { OUTBOX_STREAM, createOutbox, type Delivery, type Patch } from "./outbox.ts";

const MESH_PATH = "/mesh";
/** Every change of the mesh as seen from this node; clients wait on it. */
export const MESH_STREAM = "mesh";
const NAMESPACE = "jhin.mesh";
const MAX_BODY = 1024 * 1024;
const JOIN_ATTEMPTS_PER_MINUTE = 20;

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
const Config = z
  .object({
    name: z.string().min(1).optional().meta({
      title: "Name",
      description: "How other nodes see this one; defaults to the host name.",
    }),
    /** D28: `[]` for a node behind NAT, reached through the links it dials. */
    advertise: z
      .array(z.string())
      .optional()
      .meta({
        title: "Advertised URLs",
        description:
          "Mesh URLs other nodes dial (ws://host:port/mesh). Defaults to this node's HTTP address; none for a node nobody can reach directly: it dials out and is reached through those links.",
        examples: ["ws://example.com:7777/mesh"],
        advanced: true,
      }),
    /** security.md D416. */
    memberPermissions: z
      .array(z.string().refine(isGrant, "must be a permission, a pattern such as git.* or *"))
      .default(["*"])
      .meta({
        title: "Permissions of other nodes",
        description:
          "What a call from another node of the mesh may do here; a call also never gets more than its caller holds on the node it came from. Everything by default: the mesh is one owner's.",
        advanced: true,
      }),
    /** D26. */
    history: z
      .union([
        z.literal("on-open").meta({ title: "When a thread is opened" }),
        z.literal("eager").meta({ title: "Every thread, eagerly" }),
      ])
      .default("on-open")
      .meta({
        title: "Copy threads of other nodes",
        description:
          "When this node keeps a copy of another node's thread: once it is opened here, or every thread of every node at once.",
      }),
    /** D50: an expired change ends as `mesh.config.expired` in `mesh/outbox`. */
    queueExpiryHours: z
      .number()
      .positive()
      .nullable()
      .default(24 * 30)
      .meta({
        title: "Keep queued changes for (hours)",
        description:
          "A config change for a node that stays away this long is dropped instead of waiting forever. None keeps it until the node returns.",
        advanced: true,
      }),
  })
  .meta({ title: "Mesh", description: "How this node meets the other nodes of its owner." });

function loadKeys(dir: string): { privateKey: Crypto.KeyObject; publicKey: string } {
  const file = Path.join(dir, "mesh-key.pem");
  if (!Fs.existsSync(file)) {
    const { privateKey } = Crypto.generateKeyPairSync("ed25519");
    Fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const privateKey = Crypto.createPrivateKey(Fs.readFileSync(file));
  const publicKey = Crypto.createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  return { privateKey, publicKey };
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) request.destroy(new Error("Body too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/** `ws://host:port/mesh` → `http://host:port`: where a member's HTTP routes live. */
const httpBase = (meshUrl: string) => meshUrl.replace(/^ws/, "http").replace(/\/mesh$/, "");

const describe = (member: MemberView) => ({
  nodeId: member.record.nodeId,
  name: member.record.name,
  urls: [...member.record.urls],
  self: member.self,
  linked: member.linked,
  reachable: member.reachable,
  ...(member.route === undefined ? {} : { route: [...member.route] }),
});

const NodeView = z.object({
  nodeId: z.string(),
  name: z.string(),
  urls: z.array(z.string()),
  self: z.boolean(),
  linked: z.boolean(),
  reachable: z.boolean(),
  route: z.array(z.string()).optional(),
});

export default definePlugin({
  async activate(context) {
    context.config.define("jhin.mesh", Config);
    const config = context.config.get<z.output<typeof Config>>("jhin.mesh");
    const http = context.services.get<HttpServer>(HTTP_SERVER_CAPABILITY);
    const paths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
    const { nodeId } = context.services.get<HostIdentity>(HOST_IDENTITY_CAPABILITY);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const keys = loadKeys(paths.dataDir(context.plugin.id));
    // Who may follow the mesh's streams over a client connection (security.md D415), and
    // where relays are served to this node's clients (D499; without it, there are none).
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    if (live?.guard !== undefined) {
      context.subscriptions.add(live.guard(MESH_STREAM, ["mesh.read"]));
      context.subscriptions.add(live.guard(OUTBOX_STREAM, ["mesh.admin"]));
      // Copies of members' streams (D26) need what the stream itself needs.
      context.subscriptions.add(
        live.guard("mirror/", (stream) => {
          // `mirror/<owner>/<stream>`, where a relay's copy may itself be a mirror.
          let copied = stream;
          while (copied.startsWith("mirror/")) copied = copied.split("/").slice(2).join("/");
          if (copied === MESH_STREAM) return ["mesh.read"];
          return copied === "threads" || copied.startsWith("thread/")
            ? ["threads.read"]
            : ["mesh.admin"];
        }),
      );
    }

    const transport: MeshTransport = {
      dial: (url, token) => connectWebSocket(url, token),
      async join(url, request) {
        const response = await fetch(`${url.replace(/\/$/, "")}${MESH_PATH}/join`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = (await response.json()) as { code?: string; message?: string };
        if (!response.ok)
          throw Object.assign(new Error(body.message ?? "join failed"), {
            code: body.code ?? "JOIN_FAILED",
          });
        return body as never;
      },
    };

    const remembered = (await kv.get(NAMESPACE, "members")) as MemberRecord[] | undefined;
    const rememberedMirrors = (await kv.get(NAMESPACE, "mirrors")) as
      | { owner: string; stream: string }[]
      | undefined;
    let writes: Promise<unknown> = Promise.resolve();
    const mesh = createMesh({
      identity: { nodeId, publicKey: keys.publicKey, name: config.name ?? Os.hostname() },
      sign: (data) => Crypto.sign(null, Buffer.from(data), keys.privateKey).toString("base64url"),
      verify(publicKey, data, signature) {
        try {
          const key = Crypto.createPublicKey({
            key: Buffer.from(publicKey, "base64url"),
            format: "der",
            type: "spki",
          });
          return Crypto.verify(null, Buffer.from(data), key, Buffer.from(signature, "base64url"));
        } catch {
          return false;
        }
      },
      transport,
      execute: (method, params, invocation) => context.commands.execute(method, params, invocation),
      memberPermissions: () =>
        context.config.get<z.output<typeof Config>>("jhin.mesh").memberPermissions,
      ...(remembered === undefined ? {} : { members: remembered }),
      // Writes are chained so an older snapshot never lands after a newer one.
      log,
      ...(rememberedMirrors === undefined ? {} : { mirrors: rememberedMirrors }),
      persistMirrors: (mirrors) => {
        writes = writes
          .then(() => kv.set(NAMESPACE, "mirrors", mirrors as unknown as Json))
          .catch(() => undefined);
      },
      persist: (members) => {
        writes = writes
          .then(() => kv.set(NAMESPACE, "members", members as unknown as Json))
          .catch(() => undefined);
      },
      logger: context.log,
      ...(live === undefined ? {} : { streams: live }),
    });
    context.subscriptions.add(mesh);
    // D501: plugins share their streams with members through this.
    context.services.provide<MeshStreams>(MESH_STREAMS_CAPABILITY, {
      share: (name) => mesh.share(name),
    });
    // D502: a relay needs mesh.call and what the relayed stream needs here.
    if (live !== undefined) {
      context.subscriptions.add(serveRelays(mesh, live));
    }
    mesh.setUrls(config.advertise ?? [`${http.url.replace(/^http/, "ws")}${MESH_PATH}`]);

    context.subscriptions.add(
      mesh.onChange(() => {
        const nodes = mesh.members().map(describe);
        void log
          .append(MESH_STREAM, [{ type: "mesh.nodes.changed", payload: nodes as unknown as Json }])
          .catch(() => undefined);
      }),
    );

    const joinAttempts = new Map<string, number>();

    // Links from other nodes: a signed link token in the WebSocket subprotocol.
    const inbound = new Set<WebSocket>();
    const sockets = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    });
    context.subscriptions.add(
      http.upgrade(MESH_PATH, (request, socket, head) => {
        const offered = String(request.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((value) => value.trim())
          .find((value) => value.startsWith(TOKEN_PROTOCOL_PREFIX));
        const from =
          offered === undefined
            ? undefined
            : mesh.verifyToken(offered.slice(TOKEN_PROTOCOL_PREFIX.length));
        sockets.handleUpgrade(request, socket, head, (ws) => {
          if (from === undefined) {
            ws.close(CLOSE_UNAUTHENTICATED, "not a member");
            return;
          }
          inbound.add(ws);
          ws.on("close", () => inbound.delete(ws));
          mesh.accept(webSocketPeer(ws as unknown as WebSocketLike), from);
        });
      }),
    );
    context.subscriptions.add({
      // Upgraded sockets no longer belong to the HTTP server: close them here.
      dispose() {
        for (const ws of inbound) ws.close(1001, "node stopping");
        inbound.clear();
        sockets.close();
      },
    });

    context.subscriptions.add(
      http.route("POST", `${MESH_PATH}/join`, async (request, response) => {
        // Invite codes are random UUIDs; this only keeps guessing and floods cheap to refuse.
        // Behind a trusted reverse proxy (jhin.http.trustProxy) each client has its own bucket.
        const caller = http.clientAddress(request);
        const minute = Math.floor(Date.now() / 60_000);
        const key = `${caller}:${minute}`;
        const attempts = (joinAttempts.get(key) ?? 0) + 1;
        joinAttempts.set(key, attempts);
        for (const old of joinAttempts.keys())
          if (!old.endsWith(`:${minute}`)) joinAttempts.delete(old);
        if (attempts > JOIN_ATTEMPTS_PER_MINUTE) {
          response
            .writeHead(429, { "content-type": "application/json", "retry-after": "60" })
            .end(
              JSON.stringify({ code: "TOO_MANY_JOIN_ATTEMPTS", message: "Try again in a minute" }),
            );
          return;
        }
        try {
          const result = mesh.acceptJoin((await readJson(request)) as never);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          response
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ code: failure.code ?? "JOIN_FAILED", message: failure.message }));
        }
      }),
    );

    // D24: `/n/<nodeId>/<path>` on any node leads to that node.
    context.subscriptions.add(
      http.route("GET", "/n/*", (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const [, , target, ...rest] = url.pathname.split("/");
        // Leading slashes would turn "/n/<self>//evil.com" into a protocol-relative redirect.
        const path = rest.join("/").replace(/^\/+/, "");
        const resolved = mesh.resolve(`jhin://${target ?? ""}/${path}`);
        const member = resolved.member;
        const base = member?.self === true ? "" : member?.record.urls[0];
        if (member === undefined || base === undefined) {
          response.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({
              code: "NODE_UNKNOWN_OR_UNADDRESSED",
              node: target,
              member: member === undefined ? null : describe(member),
            }),
          );
          return;
        }
        const location = `${base === "" ? "" : httpBase(base)}/${path}${url.search}`;
        response.writeHead(307, { location }).end();
      }),
    );

    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "mesh.read": {
        title: "View the mesh",
        description: "Read the mesh's nodes and resolve addresses.",
      },
      "mesh.open": {
        title: "Connect nodes",
        description: "Open and close connections to other nodes.",
      },
      "mesh.admin": {
        title: "Manage the mesh",
        description: "Invite and join nodes, and change their config.",
      },
    });
    context.commands.register({
      name: "mesh.open",
      description:
        "Starts keeping a copy of another node's stream here (D26) and names the local stream to read",
      input: z.object({ node: z.string().min(1), stream: z.string().min(1) }),
      output: z.object({ stream: z.string() }),
      permissions: ["mesh.open"],
      handler: ({ node, stream }) => ({ stream: mesh.mirror(node, stream) }),
    });
    if (live !== undefined) context.commands.register(meshRelayCommand(mesh));
    context.commands.register({
      name: "mesh.close",
      description: "Stops keeping a copy of another node's stream; what was copied stays readable",
      input: z.object({ node: z.string().min(1), stream: z.string().min(1) }),
      output: z.object({}),
      permissions: ["mesh.open"],
      handler: ({ node, stream }) => {
        mesh.unmirror(node, stream);
        return {};
      },
    });

    if (config.history === "eager") {
      // Follow every node's index of threads and mirror each thread it lists.
      const followed = new Set<string>();
      const follow = () => {
        for (const member of mesh.members()) {
          if (member.self || !member.reachable || followed.has(member.record.nodeId)) continue;
          const owner = member.record.nodeId;
          followed.add(owner);
          const index = mesh.mirror(owner, "threads");
          // The index also records changes to projects and threads; only a created thread is new.
          const take = (event: { type: string; payload: unknown }) => {
            if (event.type !== "threads.thread.created") return;
            const id = (event.payload as { id?: unknown } | null)?.id;
            if (typeof id === "string") mesh.mirror(owner, `thread/${id}`);
          };
          context.subscriptions.add(log.subscribe(index, take));
          void log
            .read(index)
            .then((events) => events.forEach(take))
            .catch((error: unknown) =>
              context.log.warn("thread index unreadable", { node: owner, error: String(error) }),
            );
        }
      };
      context.subscriptions.add(mesh.onChange(follow));
      follow();
    }

    // --- Settings fan-out (D20, D50) ---------------------------------------
    // One change for many nodes. A node that cannot be reached gets it later:
    // the change waits in this node's outbox (outbox.ts) until a route to it exists.
    type Outcome =
      | { node: string; status: "applied" }
      | { node: string; status: "conflict"; localAt: number }
      | { node: string; status: "queued" }
      | { node: string; status: "failed"; error: string };

    const unreachable = (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      return code === "NODE_UNREACHABLE" || code === "MESH_TIMEOUT" || code === "DISCONNECTED";
    };
    // Each node is checked for what it can do when the change reaches it (D475).
    const deliver = async (node: string, patch: Patch): Promise<Delivery> => {
      const result = await sendConfigChange(
        (method, params) =>
          node === nodeId
            ? context.commands.execute(method, params)
            : mesh.call(node, method, params),
        patch,
      );
      return result.applied
        ? { status: "applied" }
        : { status: "conflict", localAt: result.conflict?.localAt ?? 0 };
    };

    const outbox = createOutbox({
      kv,
      log,
      now: Date.now,
      expireAfterMs: config.queueExpiryHours === null ? null : config.queueExpiryHours * 3_600_000,
      reachable: (node) =>
        mesh.members().find((member) => member.record.nodeId === node)?.reachable === true,
      deliver,
      unreachable,
      newId: () => Crypto.randomUUID(),
      logger: context.log,
    });
    const flushSafely = () =>
      void outbox
        .flush()
        .catch((error: unknown) =>
          context.log.warn("config outbox delivery failed", { error: String(error) }),
        );
    context.subscriptions.add(mesh.onChange(flushSafely));
    // Changes queued before a restart go out as soon as routes exist again.
    flushSafely();

    context.commands.register({
      name: "mesh.config.patch",
      description:
        "Applies one config change to several nodes (or all); unreachable ones get it when they return (D20, D50)",
      input: z.object({
        nodes: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
        layer: z.enum(["node", "project"]),
        section: z.string().min(1),
        values: z.record(z.string(), z.unknown()),
        /**
         * Keys to remove from the section, so they take their default again
         * (D84); a node older than this ignores them.
         */
        unset: z.array(z.string()).optional(),
        /**
         * The same change as edits of leaf paths (D476), for nodes that have
         * `host.config.edit`; older ones get `values` and `unset` (D475).
         */
        edits: z
          .array(z.object({ path: z.array(z.string()).min(1), value: z.unknown().optional() }))
          .optional(),
      }),
      output: z.object({
        at: z.number(),
        results: z.array(
          z.object({
            node: z.string(),
            status: z.enum(["applied", "conflict", "queued", "failed"]),
            localAt: z.number().optional(),
            error: z.string().optional(),
          }),
        ),
      }),
      permissions: ["mesh.admin", "host.config.write"],
      handler: async ({ nodes, layer, section, values, unset, edits }) => {
        const patch: Patch = {
          layer,
          section,
          values,
          ...(unset === undefined || unset.length === 0 ? {} : { unset }),
          ...(edits === undefined ? {} : { edits }),
          at: Date.now(),
        };
        const targets =
          nodes === "all" ? mesh.members().map((member) => member.record.nodeId) : nodes;
        // In parallel: one slow or unreachable node does not hold up the others.
        const results = await Promise.all(
          targets.map(async (node): Promise<Outcome> => {
            try {
              return { node, ...(await deliver(node, patch)) };
            } catch (error) {
              if (!unreachable(error)) return { node, status: "failed", error: String(error) };
              await outbox.enqueue(node, patch);
              // The node may have come back while the change was being queued.
              flushSafely();
              return { node, status: "queued" };
            }
          }),
        );
        return { at: patch.at, results };
      },
    });

    context.commands.register({
      name: "mesh.config.pending",
      description:
        "Config changes still waiting for their node (D50), oldest first; ones that waited past jhin.mesh.queueExpiryHours end as mesh.config.expired",
      input: z.object({}),
      output: z.array(
        z.object({
          id: z.string(),
          node: z.string(),
          layer: z.enum(["node", "project"]),
          section: z.string(),
          queuedAt: z.number(),
          expiresAt: z.number().nullable(),
        }),
      ),
      permissions: ["mesh.read"],
      // Values may be secrets: only where they go is listed.
      handler: async () =>
        (await outbox.pending()).map((change) => ({
          id: change.id,
          node: change.node,
          layer: change.patch.layer,
          section: change.patch.section,
          queuedAt: change.queuedAt,
          expiresAt: change.expiresAt,
        })),
    });

    context.commands.register({
      name: "mesh.invite",
      description: "A one-time code another node uses to join this mesh (jhin mesh.join)",
      input: z.object({}),
      output: z.object({ url: z.string(), code: z.string(), expiresAt: z.number() }),
      permissions: ["mesh.admin"],
      handler: () => ({ url: http.url, ...mesh.invite() }),
    });
    context.commands.register({
      name: "mesh.join",
      description: "Joins the mesh of the node at url with its invite code",
      input: z.object({ url: z.string().url(), code: z.string().min(1) }),
      output: z.object({ nodeId: z.string(), name: z.string() }),
      permissions: ["mesh.admin"],
      handler: async ({ url, code }) => {
        const record = await mesh.join(url, code);
        return { nodeId: record.nodeId, name: record.name };
      },
    });
    context.commands.register({
      name: "mesh.nodes",
      description: "Every node of the mesh, whether it is reachable, and the route to it",
      input: z.object({}),
      output: z.array(NodeView),
      permissions: ["mesh.read"],
      handler: () => mesh.members().map(describe),
    });
    context.commands.register(meshCallCommand(mesh));
    context.commands.register({
      name: "mesh.resolve",
      description: "Resolves a jhin:// address to its node and the route to it",
      input: z.object({ address: z.string() }),
      output: z.object({
        address: z.string(),
        nodeId: z.string(),
        path: z.string(),
        node: NodeView.optional(),
      }),
      permissions: ["mesh.read"],
      handler: ({ address }) => {
        const resolved = mesh.resolve(address);
        return {
          address: resolved.address,
          nodeId: resolved.nodeId,
          path: resolved.path,
          ...(resolved.member === undefined ? {} : { node: describe(resolved.member) }),
        };
      },
    });
    context.log.info("mesh ready", { nodeId, urls: mesh.self().urls });
  },
});
