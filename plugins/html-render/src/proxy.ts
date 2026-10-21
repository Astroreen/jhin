// Follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/htmlRender/publicProxy.ts.
// A SOCKS5 proxy on loopback that every request of a rendered page goes through, WebSockets
// too: it connects only to addresses it checked as public, so a name that later resolves
// elsewhere (DNS rebinding) changes nothing.
import * as Dns from "node:dns/promises";
import * as Net from "node:net";
import * as Os from "node:os";

const LOCAL_ADDRESSES = new Net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// Also the IPv6 ranges that carry an IPv4 address a translator may route to without checking
// it: IPv4-compatible, local-use NAT64, and Teredo.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new Net.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new Net.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");
const MAPPED = new Net.BlockList();
MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

function ipv6Groups(address: string): number[] {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
}

/** The IPv4 address an IPv4-mapped, NAT64 or 6to4 address stands for, checked as well. */
function embeddedIPv4(address: string): string | undefined {
  const at =
    MAPPED.check(address, "ipv6") || NAT64.check(address, "ipv6")
      ? 6
      : SIX_TO_FOUR.check(address, "ipv6")
        ? 1
        : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function ownAddresses(): Net.BlockList {
  const own = new Net.BlockList();
  for (const entry of Object.values(Os.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
}

/** This machine, a private network, or an IPv6 address carrying one. */
export function isLocalAddress(address: string): boolean {
  const family = Net.isIP(address);
  if (family === 0) return true;
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocalAddress(embedded);
}

async function publicAddresses(host: string) {
  const addresses =
    Net.isIP(host) !== 0
      ? [{ address: host, family: Net.isIP(host) }]
      : await Dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return undefined;
  return addresses.some(({ address }) => isLocalAddress(address)) ? undefined : addresses;
}

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
const MAX_EARLY_BYTES = 64 * 1024;

function readRequest(data: Buffer) {
  if (data.length < 5) return "short" as const;
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
}

/** Starts the proxy on a free loopback port. */
export async function startPublicProxy(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Net.Socket>();
  const track = (socket: Net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const refuse = (client: Net.Socket, code: number) =>
    client.end(reply(code), () => client.destroy());
  const server = Net.createServer((client) => {
    track(client);
    let data = Buffer.alloc(0);
    let greeted = false;
    const onData = (received: Buffer) => {
      data = Buffer.concat([data, received]);
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(data);
      if (request === "short") return;
      client.off("data", onData);
      if (request === undefined || request.command !== 1 || request.port === 0) {
        refuse(client, 7);
        return;
      }
      const early: Buffer[] = [request.rest];
      let earlyBytes = request.rest.length;
      const holdEarly = (piece: Buffer) => {
        earlyBytes += piece.length;
        if (earlyBytes > MAX_EARLY_BYTES) {
          client.destroy();
          return;
        }
        early.push(piece);
      };
      client.on("data", holdEarly);
      void publicAddresses(request.host).then((addresses) => {
        if (client.destroyed) return;
        client.off("data", holdEarly);
        if (addresses === undefined) {
          refuse(client, 2);
          return;
        }
        client.pause();
        // Connects only to the addresses just checked, trying each.
        const upstream = track(
          Net.connect({
            host: request.host,
            port: request.port,
            autoSelectFamily: true,
            lookup: (_host, options, callback) =>
              options.all
                ? callback(null, addresses)
                : callback(null, addresses[0]!.address, addresses[0]!.family),
          }),
        );
        upstream.once("connect", () => {
          client.write(reply(0));
          for (const chunk of early) upstream.write(chunk);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
