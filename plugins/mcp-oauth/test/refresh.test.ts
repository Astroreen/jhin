import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createRefreshStore, type RefreshGrant } from "../src/refresh.ts";

const grant: RefreshGrant = {
  clientId: "client-1",
  clientName: "Agent",
  resource: "http://127.0.0.1/mcp",
  scopes: ["threads.read"],
  approver: { id: "owner" },
  tokenId: "token-1",
};

/** A store over a fresh file and a clock the test moves. */
function store() {
  const file = Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-refresh-")), "refresh.json");
  const clock = { now: 1_000_000 };
  return { file, clock, refresh: createRefreshStore({ file, now: () => clock.now }) };
}

describe("a retry of a lost refresh answer (security.md D1705)", () => {
  it("is taken only from the spending address, by its client, within 60 seconds", () => {
    const { clock, refresh } = store();
    const first = refresh.issue(grant);
    const found = refresh.find(first);
    if (found.kind !== "ok") throw new Error("not issued");
    refresh.spend(found.record.hash, "10.0.0.1");
    const next = refresh.issue({ ...grant, tokenId: "token-2" }, found.record.family);
    const spent = refresh.find(first);
    if (spent.kind !== "spent") throw new Error("not spent");

    expect(refresh.retry(spent.record, "client-1", "10.0.0.2")).toBeUndefined();
    expect(refresh.retry(spent.record, "client-2", "10.0.0.1")).toBeUndefined();
    clock.now += 60_001;
    expect(refresh.retry(spent.record, "client-1", "10.0.0.1")).toBeUndefined();
    clock.now -= 1;
    // Exactly the window: still a retry, which forgets the unused token it issued.
    expect(refresh.retry(spent.record, "client-1", "10.0.0.1")).toMatchObject({
      tokenId: "token-2",
    });
    expect(refresh.find(next)).toEqual({ kind: "unknown" });
  });

  it("is never taken for a token spent before D1705, which kept no time", () => {
    const { file, refresh } = store();
    const first = refresh.issue(grant);
    const found = refresh.find(first);
    if (found.kind !== "ok") throw new Error("not issued");
    refresh.issue({ ...grant, tokenId: "token-2" }, found.record.family);
    // As an older node wrote it: spent, with neither time nor address.
    const written = JSON.parse(Fs.readFileSync(file, "utf8")) as {
      tokens: Record<string, unknown>[];
    };
    written.tokens[0] = { ...written.tokens[0], spent: true };
    Fs.writeFileSync(file, JSON.stringify(written));
    const reread = createRefreshStore({ file, now: () => 1_000_000 });
    const spent = reread.find(first);
    if (spent.kind !== "spent") throw new Error("not spent");
    expect(reread.retry(spent.record, "client-1", undefined)).toBeUndefined();
  });
});
