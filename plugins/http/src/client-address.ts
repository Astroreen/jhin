import type { IncomingHttpHeaders } from "node:http";
import * as Net from "node:net";

export type ForwardedHeader = "x-forwarded-for" | "forwarded";

/** `::ffff:10.0.0.1` → `10.0.0.1`, so IPv4 rules match IPv4 peers on dual-stack sockets. */
function unmap(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped === null ? address : mapped[1]!;
}

/** Parses `trustProxy` entries; throws on anything that is not an address or a CIDR range. */
export function trustList(entries: readonly string[]): Net.BlockList {
  const list = new Net.BlockList();
  for (const entry of entries) {
    const [address = "", prefix, extra] = entry.trim().split("/");
    const family = Net.isIP(address);
    const bits = prefix === undefined ? undefined : Number(prefix);
    const max = family === 4 ? 32 : 128;
    if (
      family === 0 ||
      extra !== undefined ||
      (bits !== undefined && (!/^\d+$/.test(prefix!) || bits > max))
    )
      throw new Error(`jhin.http.trustProxy: ${entry} is not an IP address or a CIDR range`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, bits, type);
  }
  return list;
}

function trusted(list: Net.BlockList, address: string): boolean {
  const family = Net.isIP(address);
  if (family === 0) return false;
  return list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * One hop of a forwarded chain as an address: strips quotes, `[…]` around
 * IPv6 and a port. Anything else (`unknown`, `_hidden`) is kept as it is: it
 * is never trusted, so it ends the walk.
 */
function hop(value: string): string {
  let text = value.trim().replace(/^"(.*)"$/, "$1");
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed !== null) text = bracketed[1]!;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  return unmap(text);
}

/** Hops of `X-Forwarded-For` or RFC 7239 `Forwarded`, the client first. */
function chain(headers: IncomingHttpHeaders, header: ForwardedHeader): string[] {
  const raw = headers[header];
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  if (text.trim() === "") return [];
  if (header === "x-forwarded-for") return text.split(",").map(hop);
  const hops: string[] = [];
  for (const element of text.split(",")) {
    const pair = element
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith("for="));
    // An element without `for=` says nothing about who sent it: treat it as unknown.
    hops.push(pair === undefined ? "unknown" : hop(pair.slice(4)));
  }
  return hops;
}

/**
 * The address a request comes from. It is the socket's peer unless that peer
 * is a trusted proxy; then the forwarded chain is walked from the right and
 * the first hop that is not a trusted proxy is the client. A header sent by
 * an untrusted peer is never read, so it cannot be spoofed by clients.
 */
export function clientAddress(
  peer: string | undefined,
  headers: IncomingHttpHeaders,
  options: { readonly trust: Net.BlockList; readonly header: ForwardedHeader },
): string {
  let current = unmap(peer ?? "unknown");
  const hops = chain(headers, options.header);
  while (trusted(options.trust, current) && hops.length > 0) current = hops.pop()!;
  return current;
}
