import * as Http from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake server got. */
export interface Received {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown> | undefined;
  readonly authorization: string | undefined;
}

export interface FakeModel {
  readonly providerID: string;
  readonly id: string;
  readonly name?: string;
  readonly limit?: { context?: number; input?: number };
  readonly variants?: { id: string }[];
}

interface FakeSession {
  id: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  permissions?: unknown[];
  location: { directory: string };
}

/** What a script playing OpenCode for one prompt can do. */
export interface Play {
  readonly sessionId: string;
  readonly body: Record<string, unknown>;
  /** Sends one event on every open event stream. */
  emit(type: string, data: Record<string, unknown>): void;
  /** Resolves with the next request matching `method` and a path ending in `suffix`. */
  next(method: string, suffix: string): Promise<Received>;
}

export type Script = (play: Play) => Promise<void> | void;

/**
 * A fake OpenCode 2 server over a real socket: the HTTP API and event stream the runtime uses,
 * with every prompt played by the next script. Requests are recorded in order.
 */
export async function fakeOpenCode(
  options: {
    password?: string | (() => string | undefined);
    version?: string;
    models?: FakeModel[];
    defaultModel?: FakeModel | null;
    agents?: { id: string; permissions?: unknown[] }[];
    commands?: { name: string }[];
    scripts?: Script[];
    /** How many model lists answer as a directory whose plugins still activate. */
    unavailable?: number;
  } = {},
) {
  const received: Received[] = [];
  const waiters: { method: string; suffix: string; resolve: (request: Received) => void }[] = [];
  const streams = new Set<Http.ServerResponse>();
  const sessions = new Map<string, FakeSession>();
  const active = new Set<string>();
  const scripts = [...(options.scripts ?? [])];
  const models = options.models ?? [
    {
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      limit: { context: 1_000_000 },
    },
    {
      providerID: "openai",
      id: "gpt-6",
      name: "GPT-6",
      limit: { context: 400_000, input: 272_000 },
    },
  ];
  let sessionCount = 0;
  let unavailable = options.unavailable ?? 0;
  const rejections: { status: number; body: unknown }[] = [];
  const holds: Promise<void>[] = [];
  const streamClosed: (() => void)[] = [];
  let streamOpened: (() => void) | undefined;
  let streamOpenedPromise = new Promise<void>((resolve) => (streamOpened = resolve));
  /** What an interrupt answers; by default it ends a running execution as interrupted. */
  let onInterrupt = (
    sessionId: string,
  ): { interrupted: boolean } | Promise<{ interrupted: boolean }> => {
    if (!active.has(sessionId)) return { interrupted: false };
    emit("session.execution.interrupted", { sessionID: sessionId, reason: "user" });
    active.delete(sessionId);
    return { interrupted: true };
  };

  const emit = (type: string, data: Record<string, unknown>) => {
    if (type === "session.execution.started") active.add(String(data["sessionID"]));
    if (type.startsWith("session.execution.") && type !== "session.execution.started") {
      active.delete(String(data["sessionID"]));
    }
    const frame = `data: ${JSON.stringify({ id: `evt_${Date.now()}`, created: Date.now(), type, data })}\n\n`;
    for (const stream of streams) stream.write(frame);
  };

  const next = (method: string, suffix: string) =>
    new Promise<Received>((resolve) => waiters.push({ method, suffix, resolve }));

  const json = (res: Http.ServerResponse, status: number, value?: unknown) => {
    if (value === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };
  const notFound = (res: Http.ServerResponse, tag: string, message: string) =>
    json(res, 404, { _tag: tag, message });

  const play = (sessionId: string, body: Record<string, unknown>) => {
    const script = scripts.shift();
    if (script === undefined) throw new Error(`no script for prompt ${JSON.stringify(body)}`);
    void Promise.resolve(script({ sessionId, body, emit, next })).catch((error: unknown) => {
      console.error("fake opencode script failed", error);
    });
  };

  const server = Http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const request: Received = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        body: raw.length === 0 ? undefined : (JSON.parse(raw) as Record<string, unknown>),
        authorization: req.headers.authorization,
      };
      received.push(request);
      const password =
        typeof options.password === "function" ? options.password() : options.password;
      if (
        password !== undefined &&
        request.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
      ) {
        json(res, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
        return;
      }
      handle(request, res);
      for (const waiter of waiters) {
        if (waiter.method === request.method && request.path.endsWith(waiter.suffix)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(request);
          break;
        }
      }
    });
  });

  const handle = (request: Received, res: Http.ServerResponse) => {
    const { method, path } = request;
    const body = request.body ?? {};
    const location = { directory: request.query.get("location[directory]") ?? "/" };
    if (method === "GET" && path === "/api/info") {
      return json(res, 200, {
        version: options.version ?? "2.0.29",
        pid: 1,
        urls: [],
        paths: { tmp: "/tmp" },
      });
    }
    if (method === "GET" && path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      streams.add(res);
      res.on("close", () => {
        streams.delete(res);
        for (const closed of streamClosed.splice(0)) closed();
      });
      streamOpened?.();
      return;
    }
    if (method === "GET" && path === "/api/model" && unavailable > 0) {
      unavailable--;
      return json(res, 503, {
        _tag: "ServiceUnavailableError",
        message: "Location plugins did not finish activating",
        service: "plugin",
      });
    }
    if (method === "GET" && path === "/api/model")
      return json(res, 200, { location, data: models });
    if (method === "GET" && path === "/api/model/default") {
      return json(res, 200, {
        location,
        data: options.defaultModel === undefined ? models[0] : options.defaultModel,
      });
    }
    if (method === "GET" && path === "/api/agent") {
      return json(res, 200, { location, data: options.agents ?? [] });
    }
    if (method === "GET" && path === "/api/command") {
      return json(res, 200, { location, data: options.commands ?? [] });
    }
    if (method === "GET" && path === "/api/session/active") {
      return json(res, 200, {
        data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])),
      });
    }
    if (method === "POST" && path === "/api/session") {
      const id = `ses_${++sessionCount}`;
      const session: FakeSession = {
        id,
        location: body["location"] as { directory: string },
        ...(body["model"] === undefined
          ? {}
          : { model: body["model"] as FakeSession["model"] & object }),
        ...(body["permissions"] === undefined
          ? {}
          : { permissions: body["permissions"] as unknown[] }),
      };
      sessions.set(id, session);
      return json(res, 200, { data: session });
    }
    const match = /^\/api\/session\/(ses_[^/]+)(\/.*)?$/.exec(path);
    if (match === null)
      return json(res, 404, { _tag: "NotFound", message: `no route ${method} ${path}` });
    const sessionId = match[1]!;
    const rest = match[2] ?? "";
    const session = sessions.get(sessionId);
    if (session === undefined)
      return notFound(res, "SessionNotFoundError", `Session not found: ${sessionId}`);
    if (rest === "" && method === "GET") return json(res, 200, { data: session });
    if (rest === "" && method === "PATCH") {
      if (body["permissions"] !== undefined) session.permissions = body["permissions"] as unknown[];
      return json(res, 204);
    }
    if (rest === "/agent") {
      session.agent = String(body["agent"]);
      return json(res, 204);
    }
    if (rest === "/model") {
      session.model = body["model"] as NonNullable<FakeSession["model"]>;
      return json(res, 204);
    }
    if (rest === "/prompt" || rest === "/command" || rest === "/compact") {
      const rejection = rejections.shift();
      if (rejection !== undefined) return json(res, rejection.status, rejection.body);
      const hold = holds.shift() ?? Promise.resolve();
      void hold.then(() => {
        json(res, 200, { data: { id: body["id"] ?? "msg_x" } });
        play(sessionId, { ...body, kind: rest.slice(1) });
      });
      return;
    }
    if (rest === "/interrupt") {
      void Promise.resolve(onInterrupt(sessionId)).then((answer) => json(res, 200, answer));
      return;
    }
    if (rest === "/synthetic") return json(res, 204);
    if (/^\/permission\/[^/]+\/reply$/.test(rest)) return json(res, 204);
    if (/^\/form\/[^/]+(\/reply)?$/.test(rest)) return json(res, 204);
    return json(res, 404, { _tag: "NotFound", message: `no route ${method} ${path}` });
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    received,
    sessions,
    active,
    emit,
    next,
    /** Adds scripts for later prompts. */
    script(...more: Script[]) {
      scripts.push(...more);
    },
    /** Resolves once an event stream is open (the next one after a previous resolved). */
    streamOpened: () => {
      const opened = streamOpenedPromise;
      return opened;
    },
    resetStreamOpened() {
      streamOpenedPromise = new Promise<void>((resolve) => (streamOpened = resolve));
    },
    /** Ends every open event stream, as a server that lost them. */
    dropStreams() {
      for (const stream of streams) stream.destroy();
      streams.clear();
    },
    /** Resolves when the next event stream closes. */
    streamClosed: () => new Promise<void>((resolve) => streamClosed.push(resolve)),
    /** Answers the next prompt only once `release` is called. */
    holdPrompt() {
      let release!: () => void;
      holds.push(new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    /** Refuses the next prompt with this status and `_tag`. */
    rejectPrompt(status: number, tag: string, message: string) {
      rejections.push({ status, body: { _tag: tag, message } });
    },
    setInterrupt(
      handler: (sessionId: string) => { interrupted: boolean } | Promise<{ interrupted: boolean }>,
    ) {
      onInterrupt = handler;
    },
    /** The requests with this method whose path ends in `suffix`. */
    calls: (method: string, suffix: string) =>
      received.filter((request) => request.method === method && request.path.endsWith(suffix)),
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type FakeOpenCode = Awaited<ReturnType<typeof fakeOpenCode>>;

// --- Scripted executions ------------------------------------------------------------

/** An execution that answers `text` in one streamed text block, with one step's usage. */
export function answer(text: string, options: { tokens?: number; cost?: number } = {}): Script {
  return ({ sessionId, emit }) => {
    const ids = { sessionID: sessionId, assistantMessageID: "msg_a1" };
    emit("session.execution.started", { sessionID: sessionId });
    emit("session.step.started", {
      ...ids,
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
      started: 1,
    });
    emit("session.text.started", { ...ids, ordinal: 0 });
    const half = Math.ceil(text.length / 2);
    for (const part of [text.slice(0, half), text.slice(half)]) {
      if (part.length > 0) emit("session.text.delta", { ...ids, ordinal: 0, delta: part });
    }
    emit("session.text.ended", { ...ids, ordinal: 0, text });
    emit("session.step.ended", {
      ...ids,
      finish: "stop",
      cost: options.cost ?? 0,
      tokens: {
        input: options.tokens ?? 100,
        output: 20,
        reasoning: 5,
        cache: { read: 50, write: 10 },
      },
    });
    emit("session.execution.succeeded", { sessionID: sessionId });
  };
}
