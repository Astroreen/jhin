// MCP elicitations Codex asks for (providers.md D1146). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/server/src/provider/CodexMcpElicitation.ts
// (describeMcpElicitation, toMcpElicitationResponse), its schemas read field by field here.
import type { ApprovalDecision } from "@jhin/agent-api";

/** T3's decisions; `accept-always` is T3's "Always allow", which Jhin does not offer yet. */
type ElicitationDecision = ApprovalDecision | "accept-always";
type PersistenceDecision = "accept-for-session" | "accept-always";

interface FormField {
  readonly type?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly default?: unknown;
  readonly enum?: readonly string[] | null;
  readonly enumNames?: readonly string[] | null;
  readonly oneOf?: readonly { readonly const: string; readonly title?: string | null }[] | null;
}

interface Form {
  readonly properties?: Readonly<Record<string, FormField>>;
  readonly required?: readonly string[] | null;
}

/** `mcpServer/elicitation/request`'s params, as far as Jhin reads them. */
export interface ElicitationRequest {
  readonly serverName: string;
  readonly message: string;
  readonly mode?: string;
  readonly elicitationId?: string;
  readonly requestedSchema?: unknown;
  readonly _meta?: unknown;
}

export interface ElicitationResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
  readonly _meta?: { readonly persist: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The params read field by field; undefined when they are not an elicitation. */
export function readElicitation(params: Record<string, unknown>): ElicitationRequest | undefined {
  const serverName = text(params["serverName"]);
  const message = text(params["message"]);
  if (serverName === undefined || message === undefined) return undefined;
  return {
    serverName,
    message,
    ...(text(params["mode"]) === undefined ? {} : { mode: text(params["mode"])! }),
    ...(text(params["elicitationId"]) === undefined
      ? {}
      : { elicitationId: text(params["elicitationId"])! }),
    requestedSchema: params["requestedSchema"],
    _meta: params["_meta"],
  };
}

function persistenceDecision(value: string): PersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "accept-for-session";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "accept-always";
  }
  return null;
}

function formOf(payload: ElicitationRequest): Form | undefined {
  if (payload.mode === "url" || !isRecord(payload.requestedSchema)) return undefined;
  const properties = payload.requestedSchema["properties"];
  const required = payload.requestedSchema["required"];
  if (properties !== undefined && !isRecord(properties)) return undefined;
  return {
    ...(properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(properties).filter(([, field]) => isRecord(field)),
          ) as Record<string, FormField>,
        }),
    ...(Array.isArray(required)
      ? { required: required.filter((key): key is string => typeof key === "string") }
      : {}),
  };
}

function fieldOptions(field: FormField) {
  if (Array.isArray(field.oneOf)) {
    return field.oneOf
      .filter((option) => typeof option?.const === "string")
      .map((option) => ({ value: option.const, label: text(option.title) }));
  }
  return (Array.isArray(field.enum) ? field.enum : []).map((value, index) => ({
    value: String(value),
    label: text(field.enumNames?.[index]),
  }));
}

function isPersistenceField(key: string, field: FormField): boolean {
  return (
    persistenceDecision(key) !== null ||
    key.toLowerCase() === "persist" ||
    persistenceDecision(text(field.title) ?? "") !== null ||
    persistenceDecision(text(field.description) ?? "") !== null
  );
}

/** Which app asks, and which of T3's decisions the request takes. */
export function describeElicitation(payload: ElicitationRequest): {
  readonly appName: string;
  readonly decisions: readonly ApprovalDecision[];
  /** T3's label of the session allowance, when the form names one. */
  readonly sessionLabel?: string;
} {
  const meta = isRecord(payload._meta) ? payload._meta : {};
  const target = isRecord(meta["target"]) ? meta["target"] : {};
  const toolParams = isRecord(meta["tool_params"]) ? meta["tool_params"] : {};
  const appName =
    text(meta["app_name"]) ??
    text(meta["appName"]) ??
    text(meta["app"]) ??
    text(target["app"]) ??
    text(target["name"]) ??
    text(toolParams["app_name"]) ??
    text(toolParams["app"]) ??
    payload.message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1] ??
    text(meta["connector_name"]) ??
    text(meta["connectorName"]) ??
    payload.serverName;
  const persistence = new Map<PersistenceDecision, string>();
  const persist = meta["persist"];
  for (const value of typeof persist === "string"
    ? [persist]
    : Array.isArray(persist)
      ? persist
      : []) {
    const decision = typeof value === "string" ? persistenceDecision(value) : null;
    if (decision) persistence.set(decision, "");
  }
  if (meta["allowPersistentApproval"] === true) persistence.set("accept-always", "");
  for (const [key, field] of Object.entries(formOf(payload)?.properties ?? {})) {
    for (const option of fieldOptions(field)) {
      const decision = persistenceDecision(option.value);
      if (decision) persistence.set(decision, option.label ?? "");
    }
    if (field.type === "boolean" && isPersistenceField(key, field)) {
      persistence.set("accept-always", text(field.title) ?? "");
    }
  }
  const session =
    persistence.has("accept-for-session") &&
    toElicitationResponse(payload, "accept-for-session").action === "accept";
  return {
    appName,
    decisions: [
      "cancel",
      "decline",
      ...(session ? (["accept-for-session"] as const) : []),
      "accept",
    ],
    ...(session && persistence.get("accept-for-session")
      ? { sessionLabel: persistence.get("accept-for-session")! }
      : {}),
  };
}

export function toElicitationResponse(
  payload: ElicitationRequest,
  decision: ElicitationDecision,
): ElicitationResponse {
  if (decision === "decline" || decision === "cancel") return { action: decision };
  if (payload.mode === "url") return { action: "decline" };
  const persist =
    decision === "accept-for-session"
      ? "session"
      : decision === "accept-always"
        ? "always"
        : undefined;
  const form = formOf(payload);
  const content: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const chosen = fieldOptions(field).find((option) =>
      persist
        ? persistenceDecision(option.value) === decision
        : /once|accept|approve|allow/i.test(option.value) &&
          persistenceDecision(option.value) === null,
    );
    if (chosen) content[key] = chosen.value;
    else if (field.type === "boolean" && isPersistenceField(key, field)) {
      content[key] = decision === "accept-always";
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }
  if (form?.required?.some((key) => !Object.hasOwn(content, key))) return { action: "decline" };
  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}
