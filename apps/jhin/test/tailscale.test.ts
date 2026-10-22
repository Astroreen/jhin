import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { probeNode, type Probe, type RuntimeState } from "../src/pair.ts";
import {
  fileMappings,
  parseMagicDnsName,
  publishOverTailscale,
  replaceable,
  tailscaleBaseUrl,
  type TailscaleRunner,
} from "../src/tailscale.ts";

const node: RuntimeState = {
  url: "http://0.0.0.0:7777",
  pid: 1,
  instance: "this-node",
  startedAt: 0,
};
const STATUS = JSON.stringify({ Self: { DNSName: "studio.tail1234.ts.net." } });

/** A fake `tailscale` that records its calls; `serve` succeeds unless told otherwise. */
function fakeTailscale(
  overrides: {
    status?: { code: number; stdout: string };
    serve?: number;
    serveStatus?: string;
  } = {},
) {
  const calls: string[][] = [];
  const run: TailscaleRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "status") return overrides.status ?? { code: 0, stdout: STATUS };
    if (args[0] === "serve" && args[1] === "status") {
      return { code: 0, stdout: overrides.serveStatus ?? "{}" };
    }
    return { code: overrides.serve ?? 0, stdout: "" };
  };
  return { calls, run };
}

/** Probes answer in order; the last answer repeats. */
function probes(...answers: Probe[]) {
  const seen: string[] = [];
  return {
    seen,
    probe: async (baseUrl: string) => {
      seen.push(baseUrl);
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
  };
}

const pause = async () => {};

function memoryMappings() {
  const kept = new Map<number, string>();
  return {
    target: (port: number) => kept.get(port),
    remember: (port: number, target: string) => void kept.set(port, target),
  };
}

describe("Tailscale Serve for jhin pair", () => {
  it("reads the MagicDNS name and builds T3's HTTPS base", () => {
    expect(parseMagicDnsName(STATUS)).toBe("studio.tail1234.ts.net");
    expect(parseMagicDnsName("{}")).toBeUndefined();
    expect(parseMagicDnsName("{not-json")).toBeUndefined();
    expect(tailscaleBaseUrl("studio.tail1234.ts.net", 443)).toBe("https://studio.tail1234.ts.net");
    expect(tailscaleBaseUrl("studio.tail1234.ts.net", 8443)).toBe(
      "https://studio.tail1234.ts.net:8443",
    );
  });

  it("creates a mapping where nothing answers, then waits for this node behind it", async () => {
    const tailscale = fakeTailscale();
    const { probe, seen } = probes(
      { kind: "unreachable" },
      { kind: "unreachable" },
      { kind: "node", instance: "this-node" },
    );
    const published = await publishOverTailscale({
      mappings: memoryMappings(),
      node,
      servePort: 443,
      run: tailscale.run,
      probe,
      pause,
    });
    expect(published.baseUrl).toBe("https://studio.tail1234.ts.net");
    expect(tailscale.calls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:7777"],
    ]);
    expect(seen).toHaveLength(3);
    expect(published.notes[0]).toBe(
      "Tailscale Serve now maps https://studio.tail1234.ts.net to this node and persists across restarts. Remove it with `tailscale serve --https=443 off`.",
    );
    expect(published.notes[1]).toContain("jhin.http.trustProxy");
    expect(published.notes.join("\n")).not.toContain("has not answered yet");
  });

  it("keeps a mapping that already fronts this node, and creates nothing", async () => {
    const tailscale = fakeTailscale();
    const { probe } = probes({ kind: "node", instance: "this-node" });
    const published = await publishOverTailscale({
      mappings: memoryMappings(),
      node,
      servePort: 8443,
      run: tailscale.run,
      probe,
      pause,
    });
    expect(published.baseUrl).toBe("https://studio.tail1234.ts.net:8443");
    expect(published.notes).toEqual([expect.stringContaining("jhin.http.trustProxy")]);
    expect(tailscale.calls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
    ]);
  });

  it("never pairs through a funneled port, even one that already fronts this node", async () => {
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: fakeTailscale({
          serveStatus: JSON.stringify({ AllowFunnel: { "studio.tail1234.ts.net:443": true } }),
        }).run,
        probe: probes({ kind: "node", instance: "this-node" }).probe,
        pause,
      }),
    ).rejects.toThrow("public through Tailscale Funnel");
  });

  it("never replaces a mapping that answers as something else", async () => {
    const other = fakeTailscale();
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: other.run,
        probe: probes({ kind: "node", instance: "another-node" }).probe,
        pause,
      }),
    ).rejects.toThrow("already fronts a different Jhin node");
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: other.run,
        probe: probes({ kind: "other" }).probe,
        pause,
      }),
    ).rejects.toThrow("already serves something that is not this Jhin node");
    expect(other.calls.some((call) => call[0] === "serve" && call[1] === "--bg")).toBe(false);
  });

  it("says why when Tailscale is missing, has no MagicDNS name, or serve fails", async () => {
    const options = { node, servePort: 443, probe: probes({ kind: "unreachable" }).probe, pause };
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        ...options,
        run: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow("Could not talk to Tailscale. Is tailscaled running?");
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        ...options,
        run: fakeTailscale({ status: { code: 0, stdout: "{}" } }).run,
      }),
    ).rejects.toThrow("This machine has no MagicDNS name.");
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        ...options,
        run: fakeTailscale({ serve: 1 }).run,
      }),
    ).rejects.toThrow(
      "tailscale serve failed for HTTPS port 443. Run `tailscale serve --https=443 --bg http://127.0.0.1:7777` by hand to see why.",
    );
  });

  it("notes when the fresh endpoint has not answered yet", async () => {
    const published = await publishOverTailscale({
      mappings: memoryMappings(),
      node,
      servePort: 443,
      run: fakeTailscale().run,
      probe: probes({ kind: "unreachable" }).probe,
      pause,
    });
    expect(published.notes.at(-1)).toContain("The HTTPS endpoint has not answered yet.");
  });
});

describe("what a fresh mapping may replace (security.md D1189)", () => {
  const status = (tcp: object, handlers: object) =>
    JSON.stringify({
      TCP: { "443": tcp },
      Web: { "studio.tail1234.ts.net:443": { Handlers: { "/": handlers } } },
    });

  it("takes an empty port or a mapping jhin pair made, and nothing else", () => {
    const ours = "http://127.0.0.1:7777";
    expect(replaceable("{}", 443, ours)).toBe(true);
    expect(replaceable("", 443, ours)).toBe(true);
    expect(
      replaceable(status({ HTTPS: true }, { Proxy: "http://127.0.0.1:7777" }), 443, ours),
    ).toBe(true);
    expect(
      replaceable(status({ HTTPS: true }, { Proxy: "http://127.0.0.1:7777" }), 8443, undefined),
    ).toBe(true);
    // As tailscale may print it: with a trailing slash. (A real `serve status`
    // printed `"Proxy": "http://127.0.0.1:9"` for a target given as that.)
    expect(
      replaceable(status({ HTTPS: true }, { Proxy: "http://127.0.0.1:7777/" }), 443, ours),
    ).toBe(true);
    // Someone's stopped dev server on loopback is not ours to take.
    expect(
      replaceable(status({ HTTPS: true }, { Proxy: "http://127.0.0.1:3000" }), 443, ours),
    ).toBe(false);
    expect(replaceable(status({ TCPForward: "127.0.0.1:22" }, {}), 443, ours)).toBe(false);
    expect(replaceable(status({ HTTPS: true }, { Path: "/srv/www" }), 443, ours)).toBe(false);
    expect(replaceable(status({ HTTPS: true }, { Text: "hello" }), 443, ours)).toBe(false);
    // `serve` rewrites only `/`: another path of ours would stay published beside it.
    expect(
      replaceable(
        JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "studio.tail1234.ts.net:443": {
              Handlers: {
                "/": { Proxy: "http://127.0.0.1:7777" },
                "/old": { Proxy: "http://127.0.0.1:7777" },
              },
            },
          },
        }),
        443,
        ours,
      ),
    ).toBe(false);
    // A taken port without handlers is not known to be ours.
    expect(replaceable(JSON.stringify({ TCP: { "443": { HTTPS: true } } }), 443, ours)).toBe(false);
    expect(replaceable("{not json", 443, ours)).toBe(false);
    // A funneled port is public: never re-pointed at the node.
    expect(
      replaceable(
        JSON.stringify({
          ...JSON.parse(status({ HTTPS: true }, { Proxy: "http://127.0.0.1:7777" })),
          AllowFunnel: { "studio.tail1234.ts.net:443": true },
        }),
        443,
        ours,
      ),
    ).toBe(false);
  });

  it("remembers what it mapped, in a 0600 file of the home", () => {
    const file = Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-ts-")), "cli", "map.json");
    const mappings = fileMappings(file);
    expect(mappings.target(443)).toBeUndefined();
    mappings.remember(443, "http://127.0.0.1:3000");
    // One per port: a newer target replaces an old one, which claims nothing any more.
    mappings.remember(443, "http://127.0.0.1:7777");
    mappings.remember(8443, "http://127.0.0.1:7777");
    expect(fileMappings(file).target(443)).toBe("http://127.0.0.1:7777");
    expect(fileMappings(file).target(8443)).toBe("http://127.0.0.1:7777");
    expect(fileMappings(file).target(10000)).toBeUndefined();
    expect(Fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the link when the mapping cannot be recorded", async () => {
    const published = await publishOverTailscale({
      mappings: {
        target: () => undefined,
        remember: () => {
          throw new Error("read-only home");
        },
      },
      node,
      servePort: 443,
      run: fakeTailscale().run,
      probe: probes({ kind: "unreachable" }, { kind: "node", instance: "this-node" }).probe,
      pause,
    });
    expect(published.baseUrl).toBe("https://studio.tail1234.ts.net");
    expect(published.notes.join("\n")).toContain("Could not record this mapping");
  });

  it("repeats what tailscale said when serve fails", async () => {
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: async (args) =>
          args[0] === "status"
            ? { code: 0, stdout: STATUS }
            : args[1] === "status"
              ? { code: 0, stdout: "{}" }
              : {
                  code: 1,
                  stdout: "",
                  stderr:
                    "\nServe is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/serve\n",
                },
        probe: probes({ kind: "unreachable" }).probe,
        pause,
      }),
    ).rejects.toThrow("Tailscale said: Serve is not enabled on your tailnet.");
  });

  it("leaves an occupied port alone, even when its backend is down", async () => {
    const tailscale = fakeTailscale({
      serveStatus: JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }),
    });
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: tailscale.run,
        probe: probes({ kind: "unreachable" }).probe,
        pause,
      }),
    ).rejects.toThrow("already serves something that is not this Jhin node");
    expect(tailscale.calls.some((call) => call[0] === "serve" && call[1] === "--bg")).toBe(false);
  });

  it("never hands out a link when something else answers the fresh mapping", async () => {
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: fakeTailscale().run,
        probe: probes({ kind: "unreachable" }, { kind: "other" }).probe,
        pause,
      }),
    ).rejects.toThrow(
      /answers as something that is not this Jhin node.*remove it with `tailscale serve --https=443 off`/,
    );
    await expect(
      publishOverTailscale({
        mappings: memoryMappings(),
        node,
        servePort: 443,
        run: fakeTailscale().run,
        probe: probes({ kind: "unreachable" }, { kind: "node", instance: "another-node" }).probe,
        pause,
      }),
    ).rejects.toThrow("already fronts a different Jhin node");
  });
});

describe("probing an address (security.md D1184, D1189)", () => {
  it("tells this node, a gone backend, something else and nothing apart", async () => {
    const thisNode = (response: Http.ServerResponse) =>
      response.writeHead(200, { "content-type": "application/json" }).end('{"instance":"abc"}');
    const goneBackend = (response: Http.ServerResponse) =>
      response.writeHead(502).end("Bad Gateway");
    const otherJson = (response: Http.ServerResponse) =>
      response.writeHead(200, { "content-type": "application/json" }).end('{"hello":1}');
    const html = (response: Http.ServerResponse) =>
      response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
    // Each case on its own server: probeNode always asks the origin's /.well-known/jhin.
    const servers: Http.Server[] = [];
    const listen = async (answer: (response: Http.ServerResponse) => void) => {
      const one = Http.createServer((_request, response) => answer(response));
      servers.push(one);
      await new Promise<void>((resolve) => one.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(one.address() as AddressInfo).port}`;
    };
    try {
      expect(await probeNode(await listen(thisNode))).toEqual({
        kind: "node",
        instance: "abc",
      });
      expect(await probeNode(await listen(goneBackend))).toEqual({
        kind: "unreachable",
      });
      expect(await probeNode(await listen(otherJson))).toEqual({
        kind: "other",
      });
      expect(await probeNode(await listen(html))).toEqual({
        kind: "other",
      });
      const closed = await listen(thisNode);
      await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
      expect(await probeNode(closed)).toEqual({ kind: "unreachable" });
    } finally {
      for (const one of servers) one.close();
    }
  });
});
