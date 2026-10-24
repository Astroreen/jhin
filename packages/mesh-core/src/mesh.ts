import { parseRelayStream, relayStream, RELAY_PREFIX } from "@jhin/mesh-api";
import {
  createCaller,
  createRpcClient,
  serveRpc,
  type FollowedStream,
  type Peer,
  type RpcClient,
  type RpcError,
  type RpcServerOptions,
  type ServedStream,
  type StreamSource,
} from "@jhin/rpc";
import {
  intersectPermissions,
  missingPermissions,
  toDisposable,
  type Disposable,
  type Invocation,
} from "@jhin/sdk";
import type { EventLog, StoredEvent } from "@jhin/storage-api";

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
/** Versions are times; one further ahead than this is a broken clock or a lie, and is dropped. */
const MAX_VERSION_SKEW_MS = 60 * 60 * 1000;
/** Copies a node keeps at most (its own opens and neighbors' requests together). */
const MAX_MIRRORS = 10_000;
/** Streams a node relays at once at most, for its own clients and its neighbors together (D502). */
const MAX_RELAYS = 10_000;
const ADDRESS = /^jhin:\/\/([^/]+)\/?(.*)$/;
/**
 * Streams neighbors may read and copy (D26): thread histories, the thread
 * index, copies of them, and mesh changes. Everything else stays private.
 */
const MIRRORABLE = /^(threads|thread\/[^/]+|mesh|mirror\/[^/]+\/(threads|thread\/[^/]+))$/;

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

/** What becomes of a subscription over a link: accepted with the head then, or refused. */
interface LinkOutcome {
  onReady?(head: number): void;
  onError?(error: RpcError): void;
}

interface Link {
  call(method: string, params: unknown, trace?: string): Promise<unknown>;
  subscribe(
    stream: string,
    after: number,
    onEvent: (event: StoredEvent) => void,
    outcome?: LinkOutcome,
  ): Disposable;
  /** Drops the link (inbound links only: a newer connection from the same node supersedes it). */
  close?(): void;
}

/** Default deadline of one relayed hop: an answer must come back within it. */
const CALL_DEADLINE_MS = 30_000;

// Every runtime this package targets has timers, but lib "ESNext" does not declare them.
const timers = globalThis as unknown as {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

function withDeadline<T>(work: Promise<T>, what: string, ms: number): Promise<T> {
  let handle: unknown;
  const deadline = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(
      () => reject(new MeshError("MESH_TIMEOUT", `No answer from ${what} in ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => timers.clearTimeout(handle));
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
  /**
   * Runs `method` on `target`, directly or through relays, with no more than
   * `scope` (the caller's grants; omitted, the target's member grants alone).
   */
  call(
    target: string,
    method: string,
    params: unknown,
    trace?: string,
    scope?: readonly string[],
  ): Promise<unknown>;
  resolve(address: string): Resolution;
  /**
   * Keeps a copy of `owner`'s `stream` in this node's log (D26) and returns
   * the local stream name (`mirror/<owner>/<stream>`; the stream itself for
   * this node). Sequences match the source; the copy survives the owner
   * going offline and catches up when a route returns.
   */
  mirror(owner: string, stream: string): string;
  /** Stops copying; what was copied stays. */
  unmirror(owner: string, stream: string): void;
  /**
   * The stream to subscribe to for `owner`'s `stream` as it happens (D499):
   * `relay/<owner>/<stream>`, served by `relays`; the stream itself for this node.
   */
  relay(owner: string, stream: string): string;
  /** Serves `relay/…`: each subscription follows the owner's stream through the mesh. */
  readonly relays: StreamSource;
  /** Lets members read and relay `name`, a stream or a prefix ending in `/` (D501). */
  share(name: string): Disposable;
  onChange(listener: () => void): Disposable;
}

/** The event log as neighbors see it: only mirrorable and shared streams. */
function readableLog(
  log: EventLog,
  shared: (stream: string) => boolean,
  lacks: (stream: string) => readonly string[],
): EventLog {
  const readable = (stream: string) => MIRRORABLE.test(stream) || shared(stream);
  const check = (stream: string) => {
    // A shared stream needs what its guard names, within memberPermissions (D416).
    if (!MIRRORABLE.test(stream) && shared(stream)) {
      const missing = lacks(stream);
      if (missing.length > 0) {
        throw new MeshError("PERMISSION_DENIED", `Members may not read ${stream}`, {
          stream,
          missing,
        });
      }
    }
    if (!readable(stream)) {
      throw new MeshError("STREAM_NOT_SHARED", `Stream ${stream} is not shared with other nodes`, {
        stream,
      });
    }
  };
  return {
    append: () =>
      Promise.reject(new MeshError("STREAM_NOT_SHARED", "Neighbors cannot write this log")),
    read: (stream, options) => (check(stream), log.read(stream, options)),
    head: (stream) => (check(stream), log.head(stream)),
    streams: async (options) =>
      (await log.streams(options)).filter((entry) => readable(entry.stream)),
    subscribe: (stream, listener) => (check(stream), log.subscribe(stream, listener)),
  };
}

export function createMesh(options: MeshOptions): Mesh {
  const now = options.now ?? (() => Date.now());
  const randomId =
    options.randomId ??
    (() => (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID());
  const log = options.logger;
  const selfId = options.identity.nodeId;
  const deadlineMs = options.callDeadlineMs ?? CALL_DEADLINE_MS;

  const records = new Map<string, MemberRecord>();
  let self: MemberRecord = {
    nodeId: selfId,
    publicKey: options.identity.publicKey,
    name: options.identity.name,
    urls: [],
    neighbors: [],
    version: now(),
  };
  records.set(selfId, self);
  // Remembered members pass the same checks as gossip: an old or corrupt entry
  // must not break routing on every start.
  for (const record of valid(options.members ?? [])) {
    if (record.nodeId !== selfId) records.set(record.nodeId, record);
  }

  const links = new Map<string, Set<Link>>();
  const clients = new Map<string, RpcClient>();
  const invites = new Map<string, number>();
  const listeners = new Set<() => void>();
  let closed = false;
  /** Inbound connections whose dialer has not spoken yet, by node (`accept`). */
  const quiet = new Map<string, Set<Peer>>();
  const isClosed = () => closed;

  const changed = () => {
    options.persist?.([...records.values()]);
    for (const listener of Array.from(listeners)) listener();
    // Links and routes may have moved: mirrors follow on the next tick.
    void Promise.resolve().then(checkMirrors);
  };

  /** A new version of our own record: always larger, also across restarts. */
  const updateSelf = (change: Partial<Pick<MemberRecord, "urls" | "neighbors">>, past = 0) => {
    self = { ...self, ...change, version: Math.max(now(), self.version + 1, past + 1) };
    records.set(selfId, self);
    changed();
    gossip();
  };

  const linkedIds = () => new Set([...links].filter(([, set]) => set.size > 0).map(([id]) => id));

  const refreshNeighbors = () => {
    const neighbors = [...linkedIds()].toSorted();
    if (neighbors.join() !== self.neighbors.join()) updateSelf({ neighbors });
  };

  const addLink = (nodeId: string, link: Link, direction: "inbound" | "outbound"): Disposable => {
    const set = links.get(nodeId) ?? new Set();
    set.add(link);
    links.set(nodeId, set);
    log.info("mesh link up", { node: nodeId, direction, links: set.size });
    refreshNeighbors();
    // Tell the new neighbor everything we know.
    void link.call("mesh.gossip", { records: [...records.values()] }).catch(() => undefined);
    return toDisposable(() => {
      set.delete(link);
      log.info("mesh link down", { node: nodeId, direction, links: set.size });
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
  function valid(incoming: unknown): MemberRecord[] {
    return (Array.isArray(incoming) ? incoming : []).flatMap((item) => {
      const parsed = MemberRecordSchema.safeParse(item);
      if (!parsed.success) {
        log.warn("mesh record ignored", { issues: parsed.error.issues.length });
        return [];
      }
      if (parsed.data.version > now() + MAX_VERSION_SKEW_MS) {
        log.warn("mesh record from the future ignored", { node: parsed.data.nodeId });
        return [];
      }
      return [parsed.data];
    });
  }

  /** Keeps the newest version of each record; returns whether anything changed. */
  function merge(incoming: readonly MemberRecord[]): boolean {
    let any = false;
    for (const record of valid(incoming)) {
      if (record.nodeId === selfId) {
        // Our own record from before a restart: move past its version.
        if (record.version > self.version) updateSelf({}, record.version);
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

  // --- Shared streams (D501) ------------------------------------------------
  const shares = new Map<string, number>();
  const isShared = (stream: string) => {
    if (shares.has(stream)) return true;
    for (const name of shares.keys())
      if (name.endsWith("/") && stream.startsWith(name)) return true;
    return false;
  };
  /**
   * Live streams `nodeId` subscribes to over its link: relays (which never go
   * back through `nodeId`), and shared streams served from memory.
   */
  const linkStreams = (nodeId: string) => {
    const relayed = relaysFor(nodeId);
    return {
      sourceOf(stream: string): ServedStream | undefined {
        if (stream.startsWith(RELAY_PREFIX)) {
          // A neighbor's relay needs what a local client's does (D502), within memberPermissions.
          const inner = parseRelayStream(stream)?.stream;
          const needs =
            inner === undefined
              ? []
              : (options.streams?.sourceOf(inner)?.permissions ??
                options.streams?.guardOf?.(inner) ?? ["events.read"]);
          const missing = memberLacks(["mesh.call", ...needs]);
          return missing.length === 0
            ? { source: relayed, permissions: [] }
            : { source: refusing(stream, missing), permissions: [] };
        }
        if (!isShared(stream)) return undefined;
        const served = options.streams?.sourceOf(stream);
        if (served === undefined) return undefined;
        const missing = memberLacks(served.permissions);
        return missing.length === 0
          ? served
          : { source: refusing(stream, missing), permissions: [] };
      },
    };
  };
  /**
   * What members may not read of a shared stream (security.md D416): a
   * subscription over a link needs what the stream needs, within
   * `memberPermissions`, as a call from a member does.
   */
  const memberLacks = (needs: readonly string[]) =>
    missingPermissions(options.memberPermissions?.() ?? ["*"], needs);
  /** A source that refuses every subscription to `stream`. */
  const refusing = (stream: string, missing: readonly string[]): StreamSource => {
    const error = () =>
      new MeshError("PERMISSION_DENIED", `Members may not read ${stream}`, { stream, missing });
    return {
      head: () => Promise.reject(error()),
      read: () => Promise.reject(error()),
      subscribe: () => toDisposable(() => undefined),
      follow: () => ({ ready: Promise.reject(error()), dispose: () => undefined }),
    };
  };

  /** Requests arriving over a link: mesh internals, or commands of this node. */
  const serveLink = (nodeId: string): RpcServerOptions => ({
    caller: { id: `node:${nodeId}`, permissions: ["*"] },
    logger: log,
    ...(options.log === undefined
      ? {}
      : {
          log: readableLog(options.log, isShared, (stream) =>
            memberLacks(options.streams?.guardOf?.(stream) ?? []),
          ),
        }),
    streams: linkStreams(nodeId),
    hello: () => ({ nodeId: selfId }),
    newTraceId: randomId,
    async execute(method, params, invocation) {
      if (method === "mesh.gossip") {
        merge((params as { records?: MemberRecord[] } | undefined)?.records ?? []);
        return {};
      }
      if (method === "mesh.forward") return forward(params as Forward, invocation.traceId);
      if (method === "mesh.mirror") {
        const { owner, stream } = (params ?? {}) as { owner?: unknown; stream?: unknown };
        // Only members' streams, and a bounded number of copies, for a neighbor's request.
        if (typeof owner !== "string" || typeof stream !== "string" || !records.has(owner)) {
          throw new MeshError("MIRROR_INVALID", "mesh.mirror needs a member's id and a stream");
        }
        if (!mirrors.has(`mirror/${owner}/${stream}`) && mirrors.size >= MAX_MIRRORS) {
          throw new MeshError("MIRROR_LIMIT", `This node keeps at most ${MAX_MIRRORS} copies`);
        }
        return { stream: mirror(owner, stream) };
      }
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
        current = addLink(
          nodeId,
          {
            call: (method, params, trace) =>
              client.call(method, params, trace === undefined ? {} : { trace }),
            subscribe: (stream, after, onEvent, outcome = {}) =>
              client.subscribe(
                stream,
                {
                  after,
                  ...(outcome.onReady === undefined ? {} : { onReady: outcome.onReady }),
                  ...(outcome.onError === undefined ? {} : { onError: outcome.onError }),
                },
                onEvent,
              ),
          },
          "outbound",
        );
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
    /** The grants of whoever made the call (security.md D416); absent from older nodes. */
    readonly scope?: readonly string[];
  }

  async function forward(request: Forward, trace?: string): Promise<unknown> {
    if (request.target === selfId) {
      const members = options.memberPermissions?.() ?? ["*"];
      // Absent: a node older than D416, capped by the member grants alone. Anything
      // else that is not a list of grants holds nothing.
      const scope =
        request.scope === undefined
          ? undefined
          : Array.isArray(request.scope)
            ? request.scope.filter((grant): grant is string => typeof grant === "string")
            : [];
      const invocation: Invocation = {
        caller: {
          id: `node:${request.origin}`,
          permissions: scope === undefined ? [...members] : intersectPermissions(scope, members),
        },
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
    // The newest link: an older one may be a half-open socket of a restarted node.
    const next = [...(links.get(path[1]!) ?? [])].at(-1);
    if (next === undefined)
      throw new MeshError("NODE_UNREACHABLE", `Link to ${path[1]} just closed`);
    return withDeadline(
      next.call("mesh.forward", { ...request, hops: request.hops + 1 }, trace),
      path[1]!,
      // Each hop waits a little less than the one before, so the hop nearest to
      // the failure reports it.
      Math.max(1, deadlineMs - request.hops * 10),
    );
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

  interface Mirror {
    readonly owner: string;
    readonly stream: string;
    readonly local: string;
    /** The link it currently reads from, and the subscription on it. */
    link: Link | undefined;
    subscription: Disposable | undefined;
    connecting: boolean;
    /** Set when a reconnect was asked for while connecting: run once more. */
    again: boolean;
    /** Appends one at a time, in order. */
    writes: Promise<void>;
  }
  const mirrors = new Map<string, Mirror>();
  const mirrorKey = (owner: string, stream: string) => `mirror/${owner}/${stream}`;
  const persistMirrors = () =>
    options.persistMirrors?.([...mirrors.values()].map(({ owner, stream }) => ({ owner, stream })));

  function mirror(owner: string, stream: string): string {
    if (owner === selfId) return stream;
    if (!MIRRORABLE.test(stream)) {
      throw new MeshError(
        "STREAM_NOT_MIRRORABLE",
        `Stream ${stream} cannot be copied across the mesh`,
        {
          stream,
        },
      );
    }
    const local = mirrorKey(owner, stream);
    if (!mirrors.has(local)) {
      mirrors.set(local, {
        owner,
        stream,
        local,
        link: undefined,
        subscription: undefined,
        connecting: false,
        again: false,
        writes: Promise.resolve(),
      });
      persistMirrors();
      void connectMirror(local);
    }
    return local;
  }

  function unmirror(owner: string, stream: string): void {
    const local = mirrorKey(owner, stream);
    const state = mirrors.get(local);
    if (state === undefined) return;
    state.subscription?.dispose();
    mirrors.delete(local);
    persistMirrors();
  }

  /** Re-attaches mirrors and relays whose link closed or whose route now goes elsewhere. */
  function checkMirrors(): void {
    for (const [local, state] of mirrors) {
      if (currentLink(state.owner) !== state.link) void connectMirror(local);
    }
    for (const state of relaying) {
      if (currentLink(state.owner) !== state.link) attachRelay(state);
    }
  }

  // --- Relays (D499) ----------------------------------------------------------
  interface Relay {
    readonly owner: string;
    readonly stream: string;
    /** The neighbor this relay serves, when one asked: the route must not lead back to it. */
    readonly from: string | undefined;
    readonly listener: (event: StoredEvent) => void;
    /** Ends an attached relay with an error (`rpc.subscription.ended` for its subscriber). */
    readonly end: (error: unknown) => void;
    /** The last sequence passed on: a new attach resumes after it. */
    last: number;
    link: Link | undefined;
    subscription: Disposable | undefined;
    /** Bumped on every attach, so events of an older subscription are dropped. */
    attempt: number;
    /** Settles `ready` once: the first attach's outcome. */
    settle: ((outcome: { head: number } | { error: unknown }) => void) | undefined;
    stop(): void;
  }
  const relaying = new Set<Relay>();
  const maxRelays = options.maxRelays ?? MAX_RELAYS;

  /** A relay that cannot go on: a new one fails its subscription, an attached one ends it. */
  function failRelay(state: Relay, error: unknown): void {
    if (state.settle !== undefined) {
      state.settle({ error });
      return;
    }
    log.warn("relay ended", {
      stream: relayStream(state.owner, state.stream),
      error: String(error),
    });
    state.stop();
    state.end(error);
  }

  function attachRelay(state: Relay): void {
    state.subscription?.dispose();
    state.subscription = undefined;
    const via = shortestPath(records, selfId, linkedIds(), state.owner)?.[1];
    const link = currentLink(state.owner);
    state.link = link;
    const attempt = ++state.attempt;
    if (via === undefined || link === undefined) {
      // No route now: a relay that was attached waits for one; a new one fails.
      state.settle?.({
        error: new MeshError(
          "NODE_UNREACHABLE",
          `Node ${state.owner} cannot be reached from ${selfId}`,
          {
            target: state.owner,
          },
        ),
      });
      return;
    }
    // Routes that briefly disagree could send the relay back where its request came
    // from, and the two nodes would relay to each other until RELAY_LIMIT.
    if (via === state.from) {
      failRelay(
        state,
        new MeshError("RELAY_LOOP", `The route to ${state.owner} leads back to ${via}`, {
          target: state.owner,
        }),
      );
      return;
    }
    // Next to the owner: its stream itself. Further away: the next hop's relay of it.
    const source = via === state.owner ? state.stream : relayStream(state.owner, state.stream);
    state.subscription = link.subscribe(
      source,
      state.last,
      (event) => {
        if (attempt !== state.attempt || !relaying.has(state) || event.sequence <= state.last)
          return;
        state.last = event.sequence;
        state.listener(event);
      },
      {
        onReady: (head) => state.settle?.({ head }),
        onError: (error) => {
          if (attempt === state.attempt) failRelay(state, error);
        },
      },
    );
  }

  /** Serves `relay/…` to this node's clients, or (`from`) to a neighbor over its link. */
  const relaysFor = (from: string | undefined): StreamSource => ({
    // A relay holds nothing itself; it is only followed.
    head: async () => 0,
    read: async () => [],
    subscribe: () => toDisposable(() => undefined),
    follow(name, after, listener, end): FollowedStream {
      const parsed = parseRelayStream(name);
      const refuse = (error: MeshError): FollowedStream => ({
        ready: Promise.reject(error),
        dispose: () => undefined,
      });
      if (parsed === undefined || parsed.owner === selfId) {
        return refuse(
          new MeshError("RELAY_INVALID", `${name} is not a relay of a member's stream`),
        );
      }
      if (relaying.size >= maxRelays) {
        return refuse(
          new MeshError("RELAY_LIMIT", `This node relays at most ${maxRelays} streams`),
        );
      }
      let resolve!: (head: number) => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<number>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      let settled = false;
      const state: Relay = {
        owner: parsed.owner,
        stream: parsed.stream,
        from,
        listener,
        end,
        last: after,
        link: undefined,
        subscription: undefined,
        attempt: 0,
        settle: undefined,
        stop: () => {
          relaying.delete(state);
          state.attempt += 1;
          state.subscription?.dispose();
          state.subscription = undefined;
          // Gone before it attached: whoever waits on `ready` must not wait forever.
          if (!settled) {
            settled = true;
            state.settle = undefined;
            reject(new MeshError("RELAY_CLOSED", "The relay was closed before it attached"));
          }
        },
      };
      const stop = state.stop;
      state.settle = (outcome) => {
        state.settle = undefined;
        settled = true;
        if ("head" in outcome) resolve(outcome.head);
        else {
          stop();
          reject(outcome.error);
        }
      };
      relaying.add(state);
      if (closed) state.settle({ error: new MeshError("NODE_UNREACHABLE", "The mesh is closed") });
      else attachRelay(state);
      return { ready, dispose: stop };
    },
  });
  const relays = relaysFor(undefined);

  function currentLink(owner: string): Link | undefined {
    const via = shortestPath(records, selfId, linkedIds(), owner)?.[1];
    return via === undefined ? undefined : [...(links.get(via) ?? [])].at(-1);
  }

  async function connectMirror(local: string): Promise<void> {
    const state = mirrors.get(local);
    const store = options.log;
    if (state === undefined || store === undefined || closed) return;
    if (state.connecting) {
      // A change arrived mid-connect: it must not be lost (the link may just have died).
      state.again = true;
      return;
    }
    state.connecting = true;
    try {
      do {
        state.again = false;
        await attachMirror(state, store);
        // The route may have moved while we awaited: attach again if so.
        if (mirrors.get(local) === state && currentLink(state.owner) !== state.link)
          state.again = true;
      } while (state.again && mirrors.get(local) === state && !isClosed());
    } finally {
      state.connecting = false;
    }
  }

  async function attachMirror(state: Mirror, store: EventLog): Promise<void> {
    state.subscription?.dispose();
    state.subscription = undefined;
    state.link = undefined;
    const path = shortestPath(records, selfId, linkedIds(), state.owner);
    const via = path?.[1];
    const link = currentLink(state.owner);
    // No route now: the copy stays readable; a later change reconnects it.
    if (via === undefined || link === undefined) return;
    try {
      // Next to the owner: read the stream itself. Further away: the next hop
      // keeps its own copy, and this one reads that.
      let source = state.stream;
      if (via !== state.owner) {
        const answer = (await link.call("mesh.mirror", {
          owner: state.owner,
          stream: state.stream,
        })) as {
          stream: string;
        };
        source = answer.stream;
      }
      const after = await store.head(state.local);
      state.link = link;
      state.subscription = link.subscribe(source, after, (event) => {
        state.writes = state.writes
          .then(async () => {
            const head = await store.head(state.local);
            if (event.sequence <= head) return;
            if (event.sequence !== head + 1) {
              // A gap (an earlier append failed): read again from what we have.
              state.again = true;
              void connectMirror(state.local);
              return;
            }
            await store.append(state.local, [{ type: event.type, payload: event.payload }], {
              expectedHead: head,
            });
          })
          .catch((error: unknown) => {
            log.warn("mirror append failed; reconnecting", {
              stream: state.local,
              error: String(error),
            });
            void connectMirror(state.local);
          });
      });
    } catch (error) {
      log.warn("mirror could not connect", { stream: state.local, error: String(error) });
    }
  }

  for (const saved of options.mirrors ?? []) {
    try {
      mirror(saved.owner, saved.stream);
    } catch (error) {
      log.warn("remembered mirror ignored", { error: String(error) });
    }
  }

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
      // A new connection from a node replaces its older inbound ones: after a
      // restart the old socket may linger half-open and swallow calls.
      // So does one whose dialer has not spoken yet (below).
      for (const old of links.get(nodeId) ?? []) old.close?.();
      for (const old of quiet.get(nodeId) ?? []) old.close(1000, "superseded");
      const server = serveRpc(peer, serveLink(nodeId));
      const caller = createCaller(peer);
      let link: Disposable | undefined;
      let gone = false;
      // The link is used once the dialer has spoken on it: until then its side
      // may not serve requests yet, and one sent the moment the member became
      // reachable (a relay a plugin starts then, agents.md D1522) would be lost.
      const waiting = quiet.get(nodeId) ?? new Set<Peer>();
      waiting.add(peer);
      quiet.set(nodeId, waiting);
      const spoken = peer.onMessage(() => {
        spoken.dispose();
        waiting.delete(peer);
        if (gone || closed) return;
        link = addLink(
          nodeId,
          {
            call: (method, params, trace) =>
              caller.call(method, params, trace === undefined ? {} : { trace }),
            subscribe: (stream, after, onEvent, outcome) =>
              caller.subscribe(stream, after, onEvent, outcome),
            close: () => peer.close(1000, "superseded"),
          },
          "inbound",
        );
      });
      peer.onClose(() => {
        gone = true;
        waiting.delete(peer);
        spoken.dispose();
        link?.dispose();
        caller.dispose();
        server.dispose();
      });
    },
    call(target, method, params, trace, scope) {
      return forward(
        {
          origin: selfId,
          target,
          method,
          params,
          hops: 0,
          ...(scope === undefined ? {} : { scope: [...scope] }),
        },
        trace,
      );
    },
    mirror,
    unmirror,
    relay: (owner, stream) => (owner === selfId ? stream : relayStream(owner, stream)),
    relays,
    share(name) {
      if (name.length === 0) throw new MeshError("SHARE_INVALID", "A shared stream needs a name");
      shares.set(name, (shares.get(name) ?? 0) + 1);
      return toDisposable(() => {
        const count = (shares.get(name) ?? 1) - 1;
        if (count > 0) shares.set(name, count);
        else shares.delete(name);
      });
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
      for (const state of mirrors.values()) state.subscription?.dispose();
      for (const state of relaying) {
        failRelay(state, new MeshError("NODE_UNREACHABLE", "The mesh is closed"));
      }
      relaying.clear();
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
