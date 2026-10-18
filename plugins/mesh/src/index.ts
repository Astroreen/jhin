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
} from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import {
  createMesh,
  type MemberRecord,
  type MemberView,
  type MeshTransport,
} from "@jhin/mesh-core";
import {
  CLOSE_UNAUTHENTICATED,
  TOKEN_PROTOCOL_PREFIX,
  PROTOCOL,
  connectWebSocket,
  webSocketPeer,
  type WebSocketLike,
} from "@jhin/rpc";
import { definePlugin, z } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";
import { WebSocketServer, type WebSocket } from "ws";

const MESH_PATH = "/mesh";
/** Every change of the mesh as seen from this node; clients wait on it. */
export const MESH_STREAM = "mesh";
const NAMESPACE = "jhin.mesh";
const MAX_BODY = 1024 * 1024;
const JOIN_ATTEMPTS_PER_MINUTE = 20;

const Config = z.object({
  /** How other nodes see this one; defaults to the host name. */
  name: z.string().min(1).optional(),
  /**
   * Mesh URLs other nodes dial (`ws://host:port/mesh`). Defaults to this node's
   * HTTP address; `[]` for a node nobody can reach directly (behind NAT): it
   * dials out and is reached through those links (D28).
   */
  advertise: z.array(z.string()).optional(),
});

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
      ...(remembered === undefined ? {} : { members: remembered }),
      // Writes are chained so an older snapshot never lands after a newer one.
      persist: (members) => {
        writes = writes
          .then(() => kv.set(NAMESPACE, "members", members as unknown as Json))
          .catch(() => undefined);
      },
      logger: context.log,
    });
    context.subscriptions.add(mesh);
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
        const caller = request.socket.remoteAddress ?? "unknown";
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
    context.commands.register({
      name: "mesh.call",
      description: "Runs a command on another node of the mesh, through relays when needed",
      input: z.object({
        node: z.string().min(1),
        method: z.string().min(1),
        params: z.unknown().optional(),
      }),
      output: z.unknown(),
      permissions: ["mesh.call"],
      handler: ({ node, method, params }, invocation) =>
        mesh.call(node, method, params ?? {}, invocation.traceId),
    });
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
