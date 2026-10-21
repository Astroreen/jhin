// URL normalisation and the address bar follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/shared/src/preview.ts.

export const PREVIEW_URL_MAX_LENGTH = 2048;

/** The WHATWG URL parser both sides have (Node and browsers); the package has no DOM or Node types. */
declare const URL: new (input: string) => { readonly href: string; readonly protocol: string };

export type PreviewUrlProblem = "empty" | "parse" | "unsupported-protocol";

export class PreviewUrlError extends Error {
  readonly reason: PreviewUrlProblem;
  readonly inputLength: number;
  readonly protocol: string | undefined;

  constructor(reason: PreviewUrlProblem, inputLength: number, protocol?: string) {
    super(
      `Invalid preview URL (${reason}${protocol === undefined ? "" : `: ${protocol}`}; input length ${inputLength}).`,
    );
    this.name = "PreviewUrlError";
    this.reason = reason;
    this.inputLength = inputLength;
    this.protocol = protocol;
  }
}

const LOOPBACK_PREFIX = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

function protocolOf(raw: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(raw)?.[1]?.toLowerCase().concat(":");
}

/**
 * An absolute http(s) URL from what an agent passed: a schemeless loopback
 * host gets `http`, any other schemeless host `https`.
 */
export function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new PreviewUrlError("empty", raw.length);
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${LOOPBACK_PREFIX.test(trimmed) ? "http" : "https"}://${trimmed}`;
  let parsed: { readonly href: string; readonly protocol: string };
  try {
    parsed = new URL(candidate);
  } catch {
    throw new PreviewUrlError("parse", raw.length, protocolOf(candidate));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlError("unsupported-protocol", raw.length, parsed.protocol);
  }
  return parsed.href;
}

const SEARCH_URL = "https://duckduckgo.com/?q=";
const ADDRESS_HOST = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const NON_WEB_SCHEMES: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "mailto:",
  "sms:",
  "ssh:",
  "tel:",
  "view-source:",
  "ws:",
  "wss:",
]);

/** What the panel's address bar opens: a URL, a host, or a search for anything else. */
export function resolveAddressBarInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.length === 0) {
    return normalizePreviewUrl(trimmed);
  }
  if (!/\s/.test(trimmed)) {
    // `mailto:x` is a scheme, `devbox:8080` a bare host and port.
    const protocol = protocolOf(trimmed);
    if (
      protocol !== undefined &&
      (NON_WEB_SCHEMES.has(protocol) || !BARE_HOST_PORT.test(trimmed))
    ) {
      if (protocol !== "http:" && protocol !== "https:") {
        throw new PreviewUrlError("unsupported-protocol", raw.length, protocol);
      }
      return normalizePreviewUrl(trimmed);
    }
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
    const withoutUser = authority.replace(/^[^@]*@/, "");
    const host = withoutUser.replace(/:\d+$/, "");
    const hasPort = host.length < withoutUser.length;
    if (hasPort || ADDRESS_HOST.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      try {
        return normalizePreviewUrl(trimmed);
      } catch {
        // Not a host after all: search for it.
      }
    }
  }
  return `${SEARCH_URL}${encodeURIComponent(trimmed)}`;
}
