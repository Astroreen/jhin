// MCP apps of Codex's tool calls (providers.md D1401–D1403). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/shared/src/mcpApp.ts (the MIME type, size
// limit, CSP and permission readers, mcpAppContentSecurityPolicy, injectMcpAppCsp),
// apps/server/src/mcpApps/McpAppSnapshot.ts (readMcpAppDocument) and the resource URI of
// an `mcpToolCall` in apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts.
import type { AgentMcpApp } from "@jhin/agent-api";

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APP_RESOURCE_SCHEME = "ui://";
const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 256;

type Csp = NonNullable<AgentMcpApp["csp"]>;
type Permission = NonNullable<AgentMcpApp["permissions"]>[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `ui://` resource an `mcpToolCall` names (T3's codexMcpAppResourceUri). */
export function mcpAppResourceUri(item: Record<string, unknown>): string | undefined {
  const ui = isRecord(item["mcpAppUi"]) ? item["mcpAppUi"]["resourceUri"] : undefined;
  const context = isRecord(item["appContext"]) ? item["appContext"]["resourceUri"] : undefined;
  const uri = ui ?? item["mcpAppResourceUri"] ?? context;
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

// Only scheme-qualified origins, optionally with a leading `*.` subdomain wildcard, survive:
// anything else (keywords, paths, quotes, white space) could widen or break the policy.
const DOMAIN_PATTERN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

function readDomains(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .filter(
      (domain): domain is string =>
        typeof domain === "string" &&
        domain.length <= MAX_DOMAIN_LENGTH &&
        DOMAIN_PATTERN.test(domain),
    )
    .slice(0, MAX_DOMAINS);
  return domains.length === 0 ? undefined : domains;
}

export function readMcpAppCsp(value: unknown): Csp | undefined {
  if (!isRecord(value)) return undefined;
  const csp: Record<string, readonly string[]> = {};
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
    const domains = readDomains(value[key]);
    if (domains !== undefined) csp[key] = domains;
  }
  return Object.keys(csp).length === 0 ? undefined : (csp as Csp);
}

function readMcpAppPermissions(value: unknown): Permission[] | undefined {
  if (!isRecord(value)) return undefined;
  const permissions = (["camera", "microphone", "geolocation", "clipboardWrite"] as const).filter(
    (key) => isRecord(value[key]),
  );
  return permissions.length === 0 ? undefined : permissions;
}

/**
 * The Content-Security-Policy of an app's document, as the spec builds it: undeclared
 * origins stay blocked, and nothing loads from the host's own origin.
 */
export function mcpAppContentSecurityPolicy(csp: Csp | undefined): string {
  const resources = csp?.resourceDomains?.join(" ") ?? "";
  const list = (domains: readonly string[] | undefined, fallback: string) =>
    domains === undefined || domains.length === 0 ? fallback : domains.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains, "'none'")}`,
    `frame-src ${list(csp?.frameDomains, "'none'")}`,
    "object-src 'none'",
    `base-uri ${list(csp?.baseUriDomains, "'none'")}`,
    "form-action 'none'",
  ].join("; ");
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The policy as the document's first element: it can only tighten what the frame allows. */
export function injectMcpAppCsp(html: string, csp: Csp | undefined): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
    mcpAppContentSecurityPolicy(csp),
  )}">`;
  // After a leading doctype, so the document stays in standards mode.
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  return doctype
    ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}`
    : `<!doctype html>${meta}${html}`;
}

/**
 * The app document of a resource read (`mcpServer/resource/read`'s contents): HTML of the
 * MCP app MIME type, with its `_meta.ui`; `null` for one over the size limit.
 */
function readMcpAppDocument(
  contents: readonly unknown[],
  uri: string,
): { readonly html: string | null; readonly meta: unknown } | undefined {
  for (const content of contents) {
    if (!isRecord(content)) continue;
    if (content["uri"] !== undefined && content["uri"] !== uri) continue;
    const mimeType = typeof content["mimeType"] === "string" ? content["mimeType"] : "";
    if (mimeType.replace(/\s+/g, "").toLowerCase() !== MCP_APP_MIME_TYPE) continue;
    // Sizes are checked before decoding: a string's UTF-8 form is at least its length, and
    // base64 decodes to three quarters of its own.
    const text = content["text"];
    const blob = content["blob"];
    const html =
      typeof text === "string"
        ? text.length > MCP_APP_MAX_HTML_BYTES
          ? null
          : text
        : typeof blob === "string"
          ? blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4
            ? null
            : Buffer.from(blob, "base64").toString("utf8")
          : undefined;
    if (html === null) return { html: null, meta: undefined };
    if (html === undefined || html.trim() === "") continue;
    const meta = isRecord(content["_meta"]) ? content["_meta"]["ui"] : undefined;
    return { html, meta };
  }
  return undefined;
}

/**
 * The app a tool call returned, from its resource read: its document with the policy in it
 * (kept by `keep`, which names it), or undefined when there is none or it is too large.
 */
export async function snapshotMcpApp(input: {
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly contents: readonly unknown[];
  readonly keep: (html: string) => Promise<string>;
}): Promise<AgentMcpApp | undefined> {
  const document = readMcpAppDocument(input.contents, input.resourceUri);
  if (document === undefined || document.html === null) return undefined;
  if (new TextEncoder().encode(document.html).byteLength > MCP_APP_MAX_HTML_BYTES) return undefined;
  const ui = isRecord(document.meta) ? document.meta : {};
  const csp = readMcpAppCsp(ui["csp"]);
  const permissions = readMcpAppPermissions(ui["permissions"]);
  const documentId = await input.keep(injectMcpAppCsp(document.html, csp));
  return {
    server: input.server,
    tool: input.tool,
    resourceUri: input.resourceUri,
    documentId,
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(typeof ui["prefersBorder"] === "boolean" ? { prefersBorder: ui["prefersBorder"] } : {}),
  };
}
