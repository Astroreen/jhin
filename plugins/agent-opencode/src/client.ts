// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// packages/provider-opencode/src/server/v2/OpenCode2Client.ts at eb7b35ac: Basic auth with the
// user `opencode`, `location[directory]` queries, `{ data }` envelopes, `_tag` errors and the
// event stream with its silence limit, rewritten on `fetch` without OpenCode's client packages.

/** An error OpenCode declared (`{ "_tag": "SessionNotFoundError", "message": … }`), or a transport one. */
export class OpenCodeError extends Error {
  /** OpenCode's `_tag`, e.g. `SessionNotFoundError`; `undefined` for transport failures. */
  readonly tag: string | undefined;
  readonly status: number | undefined;
  constructor(message: string, tag?: string, status?: number) {
    super(message);
    this.name = tag ?? "OpenCodeError";
    this.tag = tag;
    this.status = status;
  }
}

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly providerID: string;
  readonly name?: string;
  readonly limit?: { readonly context?: number; readonly input?: number };
  /** The model's variants, e.g. reasoning efforts (D882). */
  readonly variants?: readonly { readonly id: string }[];
}

export interface SessionInfo {
  readonly id: string;
  readonly agent?: string;
  readonly model?: ModelRef;
  readonly permissions?: readonly PermissionRule[];
  readonly location?: { readonly directory?: string };
}

/** A message of a session as `GET /api/session/:id/message` lists it; fields read one by one. */
export interface SessionMessage {
  readonly id: string;
  readonly type: string;
  /** An `idle` message's: how the execution before it ended. */
  readonly outcome?: string;
  /** An `assistant` message's parts: text, reasoning and tools. */
  readonly content?: readonly Record<string, unknown>[];
}

/** One frame of `GET /api/event`. */
export interface StreamEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** OpenCode writes a heartbeat every 10–15 s; a stream silent for longer is lost (T3's limit). */
const SILENT_STREAM_MS = 45_000;

/** Read through a call: an abort may land while a request waits. */
const aborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

/** How long a request waits for a directory's plugins to activate, and how often it asks. */
const ACTIVATION_WAIT_MS = 60_000;
const ACTIVATION_RETRY_MS = 500;

/** Runs `run` after `ms` unless cancelled; tests pass one they fire themselves. */
export interface Clock {
  after(ms: number, run: () => void): () => void;
}

export const realClock: Clock = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export interface ClientOptions {
  readonly url: string;
  readonly password?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
}

export type OpenCodeClient = ReturnType<typeof createClient>;

/** A client of one OpenCode 2 server. */
export function createClient(options: ClientOptions) {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? realClock;
  const headers: Record<string, string> =
    options.password === undefined || options.password.length === 0
      ? {}
      : {
          authorization: `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`,
        };

  const url = (path: string, query: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const search = params.toString();
    return `${base}${path}${search.length === 0 ? "" : `?${search}`}`;
  };

  type Init = {
    query?: Record<string, string | undefined>;
    body?: unknown;
    signal?: AbortSignal;
  };

  /**
   * A directory OpenCode has not served yet answers `ServiceUnavailableError` while its
   * plugins activate (about ten seconds); the request is sent again until it is ready.
   */
  async function request<T>(method: string, path: string, init: Init = {}): Promise<T> {
    let waited = 0;
    for (;;) {
      try {
        return await requestOnce<T>(method, path, init);
      } catch (error) {
        if (
          !(error instanceof OpenCodeError) ||
          error.tag !== "ServiceUnavailableError" ||
          waited >= ACTIVATION_WAIT_MS ||
          init.signal?.aborted === true
        ) {
          throw error;
        }
        waited += ACTIVATION_RETRY_MS;
        await new Promise<void>((resolve) => {
          const cancel = clock.after(ACTIVATION_RETRY_MS, done);
          init.signal?.addEventListener("abort", done, { once: true });
          function done() {
            cancel();
            init.signal?.removeEventListener("abort", done);
            resolve();
          }
        });
        // Stopped while it waited: the caller learns of its own abort, not the old refusal.
        if (aborted(init.signal)) {
          throw new OpenCodeError("The request was aborted.", "AbortError");
        }
      }
    }
  }

  async function requestOnce<T>(method: string, path: string, init: Init): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(url(path, init.query), {
        method,
        headers: {
          ...headers,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch (error) {
      throw new OpenCodeError(
        `Could not reach the OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      let tag: string | undefined;
      let message = `The OpenCode server returned HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(text) as { _tag?: unknown; message?: unknown };
        if (typeof parsed._tag === "string") tag = parsed._tag;
        if (typeof parsed.message === "string" && parsed.message.length > 0) {
          message = parsed.message;
        }
      } catch {
        // Not JSON: the status says enough.
      }
      if (response.status === 401 && tag === undefined) tag = "UnauthorizedError";
      throw new OpenCodeError(message, tag, response.status);
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  const enc = encodeURIComponent;
  const location = (directory: string) => ({ "location[directory]": directory });
  const unwrap = <T>(value: { data: T }) => value.data;

  return {
    url: base,
    info: (signal?: AbortSignal) =>
      request<{ version: string; pid: number }>(
        "GET",
        "/api/info",
        signal === undefined ? {} : { signal },
      ),
    models: async (directory: string) =>
      unwrap(
        await request<{ data: ModelInfo[] }>("GET", "/api/model", { query: location(directory) }),
      ),
    defaultModel: async (directory: string) =>
      unwrap(
        await request<{ data: ModelInfo | null }>("GET", "/api/model/default", {
          query: location(directory),
        }),
      ),
    agents: async (directory: string) =>
      unwrap(
        await request<{ data: { id: string; permissions?: PermissionRule[] }[] }>(
          "GET",
          "/api/agent",
          { query: location(directory) },
        ),
      ),
    commands: async (directory: string, signal?: AbortSignal) =>
      unwrap(
        await request<{ data: { name: string }[] }>("GET", "/api/command", {
          query: location(directory),
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
    createSession: async (body: {
      location: { directory: string };
      model?: ModelRef;
      permissions: readonly PermissionRule[];
    }) => unwrap(await request<{ data: SessionInfo }>("POST", "/api/session", { body })),
    getSession: async (sessionId: string) =>
      unwrap(await request<{ data: SessionInfo }>("GET", `/api/session/${enc(sessionId)}`)),
    updateSession: (sessionId: string, body: { permissions: readonly PermissionRule[] }) =>
      request<void>("PATCH", `/api/session/${enc(sessionId)}`, { body }),
    switchAgent: (sessionId: string, agent: string) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/agent`, { body: { agent } }),
    switchModel: (sessionId: string, model: ModelRef) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/model`, { body: { model } }),
    /** One page of a session's messages, newest first (`cursor` asks for the next). */
    messages: (sessionId: string, cursor?: string) =>
      request<{ data: SessionMessage[]; cursor?: { next?: string } }>(
        "GET",
        `/api/session/${enc(sessionId)}/message`,
        { query: cursor === undefined ? { order: "desc", limit: "50" } : { cursor, limit: "50" } },
      ),
    active: async () =>
      unwrap(await request<{ data: Record<string, unknown> }>("GET", "/api/session/active")),
    prompt: (
      sessionId: string,
      body: { id: string; text: string; delivery?: "steer" },
      signal?: AbortSignal,
    ) =>
      request<unknown>("POST", `/api/session/${enc(sessionId)}/prompt`, {
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    /** Takes back a prompt OpenCode has not delivered yet (a steer). */
    cancelInbox: (sessionId: string, inboxId: string) =>
      request<void>("DELETE", `/api/session/${enc(sessionId)}/inbox/${enc(inboxId)}`),
    command: (sessionId: string, body: { name: string; text: string }, signal?: AbortSignal) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/command`, {
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    compact: (sessionId: string, body: { id: string }, signal?: AbortSignal) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/compact`, {
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    synthetic: (sessionId: string, body: { text: string; delivery: "steer"; resume: boolean }) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/synthetic`, { body }),
    interrupt: (sessionId: string, signal?: AbortSignal) =>
      request<{ interrupted: boolean }>(
        "POST",
        `/api/session/${enc(sessionId)}/interrupt`,
        signal === undefined ? {} : { signal },
      ),
    replyPermission: (
      sessionId: string,
      requestId: string,
      body: { decision: "once" | "always" | "reject"; message?: string },
    ) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/permission/${enc(requestId)}/reply`, {
        body,
      }),
    replyForm: (sessionId: string, formId: string, answer: Record<string, unknown>) =>
      request<void>("POST", `/api/session/${enc(sessionId)}/form/${enc(formId)}/reply`, {
        body: { answer },
      }),
    cancelForm: (sessionId: string, formId: string) =>
      request<void>("DELETE", `/api/session/${enc(sessionId)}/form/${enc(formId)}`),

    /**
     * Opens `GET /api/event` and calls `onEvent` for every frame. Resolves once the stream is
     * open; `closed` settles when it ends: with an error when it broke or went silent for
     * 45 s (D330), without one when `close()` ended it.
     */
    async subscribe(
      onEvent: (event: StreamEvent) => void,
    ): Promise<{ close(): void; closed: Promise<void> }> {
      const abort = new AbortController();
      // A server that takes the connection but never answers counts as silent too.
      const cancelOpening = clock.after(SILENT_STREAM_MS, () => abort.abort());
      let response: Response;
      try {
        response = await doFetch(url("/api/event"), {
          headers: { ...headers, accept: "text/event-stream" },
          signal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.aborted) {
          throw new OpenCodeError("The OpenCode server did not open its event stream.");
        }
        throw new OpenCodeError(
          `Could not reach the OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        cancelOpening();
      }
      if (!response.ok || response.body === null) {
        abort.abort();
        throw new OpenCodeError(
          `The OpenCode server refused its event stream (HTTP ${response.status}).`,
          response.status === 401 ? "UnauthorizedError" : undefined,
          response.status,
        );
      }
      let closing = false;
      let cancelSilence = () => {};
      let silent = false;
      const arm = () => {
        cancelSilence();
        cancelSilence = clock.after(SILENT_STREAM_MS, () => {
          silent = true;
          abort.abort();
        });
      };
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const closed = (async () => {
        let buffer = "";
        arm();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buffer += value;
            for (;;) {
              const end = buffer.search(/\r?\n\r?\n/);
              if (end === -1) break;
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
              if (data.length === 0) continue;
              let event: unknown;
              try {
                event = JSON.parse(data);
              } catch {
                continue;
              }
              if (
                typeof event === "object" &&
                event !== null &&
                typeof (event as StreamEvent).type === "string"
              ) {
                const { type, data: payload } = event as { type: string; data?: unknown };
                onEvent({
                  type,
                  data:
                    typeof payload === "object" && payload !== null
                      ? (payload as Record<string, unknown>)
                      : {},
                });
              }
            }
          }
        } catch (error) {
          if (closing) return;
          if (silent) throw new OpenCodeError("The OpenCode server stopped sending events.");
          throw error;
        } finally {
          cancelSilence();
        }
        if (!closing) throw new OpenCodeError("The OpenCode event stream ended.");
      })();
      return {
        closed,
        close() {
          closing = true;
          cancelSilence();
          abort.abort();
        },
      };
    },
  };
}
