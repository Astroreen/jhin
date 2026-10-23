import * as Net from "node:net";

/**
 * The names a node answers to for browsers (security.md D1362). A request
 * from a page on any other name is a DNS rebinding page and is refused.
 */
export interface HostPolicy {
  /** `host` is `requestedHost`: a name or address, with a port or without. */
  allows(host: string): boolean;
  /** Adds a name (or `.example.com`, or `*`) until the disposable is disposed. */
  add(entry: string): () => void;
}

/** The name without its port, its brackets and its case; undefined for nothing sensible. */
export function hostName(host: string): string | undefined {
  const text = host.trim().toLowerCase();
  // A bare IPv6 address has no port to strip.
  if (Net.isIP(text) === 6) return text;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed !== null) return bracketed[1];
  const name = text.replace(/:\d+$/, "").replace(/\.$/, "");
  return name === "" ? undefined : name;
}

export function hostPolicy(options: {
  readonly configured: readonly string[];
  readonly machineName: string;
}): HostPolicy {
  const entries = new Map<string, number>();
  const add = (entry: string) => {
    const key = entry.trim().toLowerCase();
    entries.set(key, (entries.get(key) ?? 0) + 1);
    return () => {
      const count = entries.get(key) ?? 0;
      if (count <= 1) entries.delete(key);
      else entries.set(key, count - 1);
    };
  };
  for (const entry of options.configured) add(entry);
  const machine = options.machineName.trim().toLowerCase().replace(/\.$/, "");
  const label = machine.split(".")[0] ?? machine;
  const own = new Set(
    [machine, label, `${machine}.local`, `${label}.local`].filter((name) => name !== ".local"),
  );
  return {
    add,
    allows(host) {
      const name = hostName(host);
      if (name === undefined) return false;
      if (entries.has("*")) return true;
      // A rebinding page always uses a name: an address is never one.
      if (Net.isIP(name) !== 0) return true;
      if (name === "localhost" || name.endsWith(".localhost")) return true;
      // Tailscale answers these, never a page's author (Tailscale Serve keeps them as Host).
      if (name.endsWith(".ts.net")) return true;
      if (own.has(name)) return true;
      for (const entry of entries.keys()) {
        if (entry.startsWith(".")) {
          if (name === entry.slice(1) || name.endsWith(entry)) return true;
        } else if (hostName(entry) === name) return true;
      }
      return false;
    },
  };
}

/**
 * Whether a request carries a browser's marks: `Origin`, `Sec-Fetch-Site`, or
 * a `User-Agent` that starts with `Mozilla/`, as every browser's does. The
 * last one counts because a page on plain `http:` gets no `Sec-Fetch-*`
 * headers and sends no `Origin` with a same-origin GET.
 */
export function fromBrowser(headers: {
  readonly origin?: string | undefined;
  readonly [header: string]: string | string[] | undefined;
}): boolean {
  // Not `Sec-Fetch-Mode`: Node's `fetch` sends it too, and Node is no browser.
  if (headers.origin !== undefined || headers["sec-fetch-site"] !== undefined) return true;
  const agent = headers["user-agent"];
  return typeof agent === "string" && agent.startsWith("Mozilla/");
}
