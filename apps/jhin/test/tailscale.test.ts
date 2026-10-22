import { describe, expect, it } from "vite-plus/test";

import type { Probe, RuntimeState } from "../src/pair.ts";
import {
  localTarget,
  parseMagicDnsName,
  publishOverTailscale,
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
  overrides: { status?: { code: number; stdout: string }; serve?: number } = {},
) {
  const calls: string[][] = [];
  const run: TailscaleRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "status") return overrides.status ?? { code: 0, stdout: STATUS };
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

describe("Tailscale Serve for jhin pair", () => {
  it("reads the MagicDNS name and builds T3's HTTPS base", () => {
    expect(parseMagicDnsName(STATUS)).toBe("studio.tail1234.ts.net");
    expect(parseMagicDnsName("{}")).toBeUndefined();
    expect(parseMagicDnsName("{not-json")).toBeUndefined();
    expect(tailscaleBaseUrl("studio.tail1234.ts.net", 443)).toBe("https://studio.tail1234.ts.net");
    expect(tailscaleBaseUrl("studio.tail1234.ts.net", 8443)).toBe(
      "https://studio.tail1234.ts.net:8443",
    );
    expect(localTarget("http://0.0.0.0:7777")).toBe("http://127.0.0.1:7777");
    expect(localTarget("http://[::]:7777")).toBe("http://127.0.0.1:7777");
    expect(localTarget("http://100.64.0.5:7777")).toBe("http://100.64.0.5:7777");
  });

  it("creates a mapping where nothing answers, then waits for this node behind it", async () => {
    const tailscale = fakeTailscale();
    const { probe, seen } = probes(
      { kind: "unreachable" },
      { kind: "unreachable" },
      { kind: "node", instance: "this-node" },
    );
    const published = await publishOverTailscale({
      node,
      servePort: 443,
      run: tailscale.run,
      probe,
      pause,
    });
    expect(published.baseUrl).toBe("https://studio.tail1234.ts.net");
    expect(tailscale.calls).toEqual([
      ["status", "--json"],
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
      node,
      servePort: 8443,
      run: tailscale.run,
      probe,
      pause,
    });
    expect(published).toEqual({ baseUrl: "https://studio.tail1234.ts.net:8443", notes: [] });
    expect(tailscale.calls).toEqual([["status", "--json"]]);
  });

  it("never replaces a mapping that answers as something else", async () => {
    const other = fakeTailscale();
    await expect(
      publishOverTailscale({
        node,
        servePort: 443,
        run: other.run,
        probe: probes({ kind: "node", instance: "another-node" }).probe,
        pause,
      }),
    ).rejects.toThrow("already fronts a different Jhin node");
    await expect(
      publishOverTailscale({
        node,
        servePort: 443,
        run: other.run,
        probe: probes({ kind: "other" }).probe,
        pause,
      }),
    ).rejects.toThrow("already serves something that is not this Jhin node");
    expect(other.calls.some((call) => call[0] === "serve")).toBe(false);
  });

  it("says why when Tailscale is missing, has no MagicDNS name, or serve fails", async () => {
    const options = { node, servePort: 443, probe: probes({ kind: "unreachable" }).probe, pause };
    await expect(
      publishOverTailscale({
        ...options,
        run: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow("Could not talk to Tailscale. Is tailscaled running?");
    await expect(
      publishOverTailscale({
        ...options,
        run: fakeTailscale({ status: { code: 0, stdout: "{}" } }).run,
      }),
    ).rejects.toThrow("This machine has no MagicDNS name.");
    await expect(
      publishOverTailscale({ ...options, run: fakeTailscale({ serve: 1 }).run }),
    ).rejects.toThrow(
      "tailscale serve failed for HTTPS port 443. Run `tailscale serve --https=443 --bg http://127.0.0.1:7777` by hand to see why.",
    );
  });

  it("notes when the fresh endpoint has not answered yet", async () => {
    const published = await publishOverTailscale({
      node,
      servePort: 443,
      run: fakeTailscale().run,
      probe: probes({ kind: "unreachable" }).probe,
      pause,
    });
    expect(published.notes.at(-1)).toContain("The HTTPS endpoint has not answered yet.");
  });
});
