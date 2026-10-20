import { z, type Invocation, type Logger } from "@jhin/sdk";
import type { LiveStreams, Peer } from "@jhin/rpc";
import type { EventLog } from "@jhin/storage-api";

/** Every record from another node is parsed with this before it is used or stored. */
export const MemberRecordSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^.]+$/, "node ids contain no dots"),
  publicKey: z.string().min(1).max(512),
  name: z.string().max(256),
  urls: z.array(z.string().max(2048)).max(16),
  neighbors: z.array(z.string().max(128)).max(1024),
  version: z.number().int().nonnegative(),
});

/** What a node says about itself; spread to every member by gossip (D25). */
export interface MemberRecord {
  readonly nodeId: string;
  /** Ed25519 public key (D23), as the signer encodes it. */
  readonly publicKey: string;
  readonly name: string;
  /** Where its mesh endpoint can be dialled; empty for a node nobody can reach directly. */
  readonly urls: readonly string[];
  /** Nodes it currently has a live link with. */
  readonly neighbors: readonly string[];
  /** Grows with every change the node makes to its own record; the higher one wins. */
  readonly version: number;
}

export interface JoinRequest {
  readonly code: string;
  readonly record: MemberRecord;
}

export interface JoinResponse {
  readonly record: MemberRecord;
  readonly members: readonly MemberRecord[];
}

/** How nodes reach each other: WebSockets in a node, an in-memory network in tests. */
export interface MeshTransport {
  /** Opens a link to a mesh endpoint, presenting a signed link token. */
  dial(url: string, token: string): Promise<Peer>;
  /** Redeems an invite at the node whose join endpoint is `url`. */
  join(url: string, request: JoinRequest): Promise<JoinResponse>;
}

export interface MeshOptions {
  readonly identity: { readonly nodeId: string; readonly publicKey: string; readonly name: string };
  sign(data: string): string;
  verify(publicKey: string, data: string, signature: string): boolean;
  readonly transport: MeshTransport;
  /** Runs a command on this node for a call that arrived over the mesh. */
  execute(method: string, params: unknown, invocation: Invocation): Promise<unknown>;
  /** Members remembered from earlier runs. */
  readonly members?: readonly MemberRecord[];
  persist?(members: readonly MemberRecord[]): void;
  readonly logger: Logger;
  now?(): number;
  randomId?(): string;
  retryDelay?(attempt: number): number;
  /**
   * How long one relayed hop waits for its answer (default 30 s). Mesh calls are
   * for quick commands; long work, like a turn, starts and returns at once.
   */
  readonly callDeadlineMs?: number;
  /**
   * This node's event log: neighbors may subscribe to its streams over a link,
   * and mirrors of other nodes' streams are kept in it (D26).
   */
  readonly log?: EventLog;
  /** Mirrors to resume from an earlier run, and where to remember the current ones. */
  readonly mirrors?: readonly { readonly owner: string; readonly stream: string }[];
  persistMirrors?(mirrors: readonly { owner: string; stream: string }[]): void;
  /**
   * What a call from another member may do here (security.md D416): it runs
   * with the intersection of these grants and the scope its caller sent.
   * Defaults to `*` (one owner's trust domain, D22).
   */
  memberPermissions?(): readonly string[];
  /**
   * This node's live streams (`rpc.streams@1`): the ones shared with the mesh
   * (D501) are read from here by members, not from the event log.
   */
  readonly streams?: Pick<LiveStreams, "sourceOf">;
}

export interface MemberView {
  readonly record: MemberRecord;
  readonly self: boolean;
  /** This node holds a live link to it. */
  readonly linked: boolean;
  /** A path to it exists (direct or through relays). */
  readonly reachable: boolean;
  /** Node ids from this node to it, both ends included. */
  readonly route?: readonly string[];
}

export interface Resolution {
  readonly address: string;
  readonly nodeId: string;
  /** The part after the node id, e.g. "threads/42". */
  readonly path: string;
  readonly member?: MemberView;
}
