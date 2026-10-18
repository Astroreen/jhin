import {
  createCaller,
  createRpcClient,
  serveRpc,
  type Peer,
  type RpcClient,
  type RpcServerOptions,
} from "@jhin/rpc";
import { toDisposable, type Disposable, type Invocation } from "@jhin/sdk";

import { shortestPath } from "./routing.ts";
import {
  MemberRecordSchema,
  type JoinRequest,
  type JoinResponse,
  type MemberRecord,
  type MemberView,
  type MeshOptions,
  type Resolution,
} from "./types.ts";

/** Hops a forwarded call may take before it is dropped. */
const MAX_HOPS = 8;
/** Lifetime of a link token: long enough for a slow handshake, short enough to be useless later. */
const TOKEN_TTL_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 15 * 60 * 1000;
const ADDRESS = /^jhin:\/\/([^/]+)\/?(.*)$/;

export class MeshError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MeshError";
    this.code = code;
    this.details = details;
  }
}

interface Link {
  call(method: string, params: unknown, trace?: string): Promise<unknown>;
}

export interface Mesh extends Disposable {
  readonly nodeId: string;
  self(): MemberRecord;
  /** Where this node's mesh endpoint can be dialled. */
  setUrls(urls: readonly string[]): void;
  members(): readonly MemberView[];
  /** A one-time code another node redeems with `join` (D27). */
  invite(): { readonly code: string; readonly expiresAt: number };
  acceptJoin(request: JoinRequest): JoinResponse;
  join(url: string, code: string): Promise<MemberRecord>;
  /** The node id a link token proves, or undefined. */
  verifyToken(token: string): string | undefined;
  /** Serves an inbound link from `nodeId` (its token already verified). */
  accept(peer: Peer, nodeId: string): void;
  /** Runs `method` on `target`, directly or through relays. */
  call(target: string, method: string, params: unknown, trace?: string): Promise<unknown>;
  resolve(address: string): Resolution;
  onChange(listener: () => void): Disposable;
}

export function createMesh(options: MeshOptions): Mesh {
  const now = options.now ?? (() => Date.now());
  const randomId =
    options.randomId ??
    (() => (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID());
  const log = options.logger;
  const selfId = options.identity.nodeId;

  const records = new Map<string, MemberRecord>();
  for (const record of options.members ?? []) {
    if (record.nodeId !== selfId) records.set(record.nodeId, record);
  }
  let self: MemberRecord = {
    nodeId: selfId,
    publicKey: options.identity.publicKey,
    name: options.identity.name,
    urls: [],
    neighbors: [],
    version: now(),
  };
  records.set(selfId, self);

  const links = new Map<string, Set<Link>>();
  const clients = new Map<string, RpcClient>();
  const invites = new Map<string, number>();
  const listeners = new Set<() => void>();
  let closed = false;

  const changed = () => {
    options.persist?.([...records.values()]);
    for (const listener of Array.from(listeners)) listener();
  };

  /** A new version of our own record: always larger, also across restarts. */
  const updateSelf = (change: Partial<Pick<MemberRecord, "urls" | "neighbors">>) => {
    self = { ...self, ...change, version: Math.max(now(), self.version + 1) };
    records.set(selfId, self);
    changed();
    gossip();
  };

  const linkedIds = () => new Set([...links].filter(([, set]) => set.size > 0).map(([id]) => id));

  const refreshNeighbors = () => {
    const neighbors = [...linkedIds()].toSorted();
    if (neighbors.join() !== self.neighbors.join()) updateSelf({ neighbors });
  };

  const addLink = (nodeId: string, link: Link): Disposable => {
    const set = links.get(nodeId) ?? new Set();
    set.add(link);
    links.set(nodeId, set);
    refreshNeighbors();
    // Tell the new neighbor everything we know.
    void link.call("mesh.gossip", { records: [...records.values()] }).catch(() => undefined);
    return toDisposable(() => {
      set.delete(link);
      refreshNeighbors();
    });
  };

  function gossip(): void {
    if (closed) return;
    const payload = { records: [...records.values()] };
    for (const set of links.values()) {
      for (const link of set) void link.call("mesh.gossip", payload).catch(() => undefined);
    }
  }

  /** Records that do not parse are dropped: one bad record must not spread or stick. */
  const valid = (incoming: unknown): MemberRecord[] =>
    (Array.isArray(incoming) ? incoming : []).flatMap((item) => {
      const parsed = MemberRecordSchema.safeParse(item);
      if (!parsed.success) log.warn("mesh record ignored", { issues: parsed.error.issues.length });
      return parsed.success ? [parsed.data] : [];
    });

  /** Keeps the newest version of each record; returns whether anything changed. */
  function merge(incoming: readonly MemberRecord[]): boolean {
    let any = false;
    for (const record of valid(incoming)) {
      if (record.nodeId === selfId) {
        // Our own record from before a restart: move past its version.
        if (record.version > self.version) updateSelf({});
        continue;
      }
      const known = records.get(record.nodeId);
      if (known !== undefined && known.version >= record.version) continue;
      records.set(record.nodeId, record);
      any = true;
      ensureDialer(record.nodeId);
    }
    if (any) {
      changed();
      gossip();
    }
    return any;
  }

  const token = (target: string) => {
    const expiresAt = now() + TOKEN_TTL_MS;
    const data = `jhin-mesh-link:${selfId}:${target}:${expiresAt}`;
    return `${selfId}.${target}.${expiresAt}.${options.sign(data)}`;
  };

  /** Requests arriving over a link: mesh internals, or commands of this node. */
  const serveLink = (nodeId: string): RpcServerOptions => ({
    caller: { id: `node:${nodeId}`, permissions: ["*"] },
    logger: log,
    hello: () => ({ nodeId: selfId }),
    newTraceId: randomId,
    async execute(method, params, invocation) {
      if (method === "mesh.gossip") {
        merge((params as { records?: MemberRecord[] } | undefined)?.records ?? []);
        return {};
      }
      if (method === "mesh.forward") return forward(params as Forward, invocation.traceId);
      return options.execute(method, params, invocation);
    },
  });

  /** Keeps an outbound link to `nodeId` while it advertises an address. */
  function ensureDialer(nodeId: string): void {
    if (closed || nodeId === selfId || clients.has(nodeId)) return;
    if ((records.get(nodeId)?.urls.length ?? 0) === 0) return;
    let attempt = 0;
    let current: Disposable | undefined;
    const client = createRpcClient({
      retryDelay: options.retryDelay ?? ((n) => Math.min(250 * 2 ** (n - 1), 15_000)),
      connect: () => {
        // The newest record decides where to go (D24: the URL is only where, not who).
        const urls = records.get(nodeId)?.urls ?? [];
        if (urls.length === 0) return Promise.reject(new Error("no address"));
        const url = urls[attempt++ % urls.length]!;
        return options.transport.dial(url, token(nodeId));
      },
      onConnected: (peer) => void serveRpc(peer, serveLink(nodeId)),
    });
    client.onState((state) => {
      if (state === "open" && current === undefined) {
        current = addLink(nodeId, {
          call: (method, params, trace) =>
            client.call(method, params, trace === undefined ? {} : { trace }),
        });
      } else if (state !== "open" && current !== undefined) {
        current.dispose();
        current = undefined;
      }
    });
    clients.set(nodeId, client);
  }

  interface Forward {
    readonly origin: string;
    readonly target: string;
    readonly method: string;
    readonly params: unknown;
    readonly hops: number;
  }

  async function forward(request: Forward, trace?: string): Promise<unknown> {
    if (request.target === selfId) {
      const invocation: Invocation = {
        caller: { id: `node:${request.origin}`, permissions: ["*"] },
        ...(trace === undefined ? {} : { traceId: trace }),
      };
      return options.execute(request.method, request.params, invocation);
    }
    if (request.hops >= MAX_HOPS) {
      throw new MeshError(
        "MESH_TOO_MANY_HOPS",
        `Gave up after ${MAX_HOPS} hops towards ${request.target}`,
      );
    }
    const path = shortestPath(records, selfId, linkedIds(), request.target);
    if (path === undefined || path.length < 2) {
      throw new MeshError(
        "NODE_UNREACHABLE",
        `Node ${request.target} cannot be reached from ${selfId}`,
        {
          target: request.target,
        },
      );
    }
    const next = [...(links.get(path[1]!) ?? [])][0];
    if (next === undefined)
      throw new MeshError("NODE_UNREACHABLE", `Link to ${path[1]} just closed`);
    return next.call("mesh.forward", { ...request, hops: request.hops + 1 }, trace);
  }

  const view = (record: MemberRecord): MemberView => {
    const route = shortestPath(records, selfId, linkedIds(), record.nodeId);
    return {
      record,
      self: record.nodeId === selfId,
      linked: linkedIds().has(record.nodeId),
      reachable: route !== undefined,
      ...(route === undefined ? {} : { route }),
    };
  };

  for (const record of records.values()) ensureDialer(record.nodeId);

  return {
    nodeId: selfId,
    self: () => self,
    setUrls(urls) {
      if (urls.join() !== self.urls.join()) updateSelf({ urls: [...urls] });
    },
    members: () =>
      [...records.values()]
        .map(view)
        .toSorted(
          (a, b) => Number(b.self) - Number(a.self) || a.record.name.localeCompare(b.record.name),
        ),
    invite() {
      for (const [code, expiresAt] of invites) if (expiresAt < now()) invites.delete(code);
      const code = randomId();
      const expiresAt = now() + INVITE_TTL_MS;
      invites.set(code, expiresAt);
      return { code, expiresAt };
    },
    acceptJoin(request) {
      const expiresAt = invites.get(request.code);
      invites.delete(request.code);
      if (expiresAt === undefined || expiresAt < now()) {
        throw new MeshError("INVITE_INVALID", "The invite code is unknown, used or expired");
      }
      const [record] = valid([request.record]);
      if (record === undefined)
        throw new MeshError("JOIN_INVALID", "The joining node's record is malformed");
      log.info("node joined the mesh", { node: record.nodeId, name: record.name });
      merge([record]);
      return { record: self, members: [...records.values()] };
    },
    async join(url, code) {
      const response = await options.transport.join(url, { code, record: self });
      merge([response.record, ...response.members]);
      return response.record;
    },
    verifyToken(value) {
      const [nodeId, target, expires, signature] = value.split(".");
      if (
        nodeId === undefined ||
        target !== selfId ||
        expires === undefined ||
        signature === undefined
      ) {
        return undefined;
      }
      const record = records.get(nodeId);
      const expiresAt = Number(expires);
      // A finite time in the near future: no NaN, no token that lives for years.
      if (record === undefined || !Number.isFinite(expiresAt)) return undefined;
      if (expiresAt < now() || expiresAt > now() + 2 * TOKEN_TTL_MS) return undefined;
      const data = `jhin-mesh-link:${nodeId}:${target}:${expires}`;
      return options.verify(record.publicKey, data, signature) ? nodeId : undefined;
    },
    accept(peer, nodeId) {
      const server = serveRpc(peer, serveLink(nodeId));
      const caller = createCaller(peer);
      const link = addLink(nodeId, {
        call: (method, params, trace) =>
          caller.call(method, params, trace === undefined ? {} : { trace }),
      });
      peer.onClose(() => {
        link.dispose();
        caller.dispose();
        server.dispose();
      });
    },
    call(target, method, params, trace) {
      return forward({ origin: selfId, target, method, params, hops: 0 }, trace);
    },
    resolve(address) {
      const match = ADDRESS.exec(address);
      if (match === null)
        throw new MeshError("ADDRESS_INVALID", `${address} is not a jhin:// address`);
      const record = records.get(match[1]!);
      return {
        address,
        nodeId: match[1]!,
        path: match[2] ?? "",
        ...(record === undefined ? {} : { member: view(record) }),
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose() {
      closed = true;
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
