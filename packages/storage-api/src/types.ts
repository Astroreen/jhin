import { DOTTED_ID, type Disposable } from "@jhin/sdk";

export const KV_CAPABILITY = "storage.kv";
export const EVENTLOG_CAPABILITY = "storage.eventlog";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** `storage.kv@1`: namespaced JSON values. */
export interface KeyValueStore {
  get(namespace: string, key: string): Promise<Json | undefined>;
  set(namespace: string, key: string, value: Json): Promise<void>;
  /** Resolves `true` when the key existed. */
  delete(namespace: string, key: string): Promise<boolean>;
  /** Entries of a namespace sorted by key, optionally only keys starting with `prefix`. */
  list(namespace: string, options?: { prefix?: string }): Promise<{ key: string; value: Json }[]>;
}

export interface NewEvent {
  /** Namespaced lowercase dotted type: `agent.turn.started`. */
  readonly type: string;
  readonly payload: Json;
}

export interface StoredEvent extends NewEvent {
  readonly stream: string;
  /** Position in the stream: 1, 2, 3… without gaps. */
  readonly sequence: number;
  /** ISO 8601 time of the append. */
  readonly at: string;
}

export interface AppendOptions {
  /** Optimistic concurrency: the append fails with CONFLICT unless the stream's head equals this. */
  readonly expectedHead?: number;
}

/** `storage.eventlog@1`: append-only streams with gap-free per-stream sequences. */
export interface EventLog {
  /** Appends atomically: either every event is stored or none is. */
  append(
    stream: string,
    events: readonly NewEvent[],
    options?: AppendOptions,
  ): Promise<StoredEvent[]>;
  /** Events with `sequence > after` (default 0), in order, at most `limit`. */
  read(stream: string, options?: { after?: number; limit?: number }): Promise<StoredEvent[]>;
  /** Sequence of the last event, 0 for an empty stream. */
  head(stream: string): Promise<number>;
  streams(options?: { prefix?: string }): Promise<{ stream: string; head: number }[]>;
  /** Receives every event appended after this call, in order. */
  subscribe(stream: string, listener: (event: StoredEvent) => void): Disposable;
}

export type StorageErrorCode = "CONFLICT" | "INVALID";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: StorageErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.details = details;
  }
}

export function assertName(kind: "namespace" | "key" | "stream", value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageError("INVALID", `${kind} must be a non-empty string`, { [kind]: value });
  }
}

export function assertEvents(events: readonly NewEvent[]): void {
  for (const event of events) {
    if (!DOTTED_ID.test(event.type) || !event.type.includes(".")) {
      throw new StorageError(
        "INVALID",
        `Event type ${event.type} must be a namespaced lowercase dotted id`,
        {
          type: event.type,
        },
      );
    }
  }
}

/** Deep copy of a JSON value; also rejects values JSON cannot represent. */
export function copyJson<T extends Json>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new StorageError("INVALID", "Value is not JSON-serialisable");
  return JSON.parse(text) as T;
}
