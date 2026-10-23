import { describe, expect, it } from "vite-plus/test";

import { renderApprovalPage } from "../src/html.ts";
import { grantsFor } from "../src/index.ts";

describe("the approval page (security.md D1193)", () => {
  it("says which asked-for permissions have shell access (D1364)", () => {
    const page = renderApprovalPage({
      clientName: "Agent",
      redirectHost: "127.0.0.1:9999",
      nodeHost: "127.0.0.1:7777",
      params: {},
      permissions: [
        { permission: "threads.read", title: "View threads" },
        { permission: "terminals.write", title: "Use terminals", shellAccess: true },
      ],
      nonce: "n",
    });
    const items = page.match(/<li>.*?<\/li>/gs) ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).not.toContain("Shell access");
    expect(items[1]).toContain(
      `<strong class="shell">Shell access: runs commands on this machine as the node's user.</strong>`,
    );
  });
});

describe("permissions the node could not describe (security.md D1364)", () => {
  it("says it cannot tell which of them run commands", () => {
    const render = (permissionsUnknown: boolean) =>
      renderApprovalPage({
        clientName: "Agent",
        redirectHost: "127.0.0.1:9999",
        nodeHost: "127.0.0.1:7777",
        params: {},
        permissions: [{ permission: "terminals.write" }],
        nonce: "n",
        ...(permissionsUnknown ? { permissionsUnknown } : {}),
      });
    expect(render(true)).toContain(
      "cannot tell which of them run commands on this machine. Approve only what you would give shell access.",
    );
    expect(render(false)).not.toContain("cannot tell which of them");
  });
});

describe("T3's access levels (security.md D1369)", () => {
  it("offers read only first, then the runtime modes, with T3's note", () => {
    const page = renderApprovalPage({
      clientName: "Agent",
      redirectHost: "127.0.0.1:9999",
      nodeHost: "127.0.0.1:7777",
      params: {},
      permissions: [],
      csrf: "c",
      nonce: "n",
    });
    const levels = [...page.matchAll(/name="access" value="([^"]+)"( checked)?/g)].map((match) => [
      match[1],
      match[2] !== undefined,
    ]);
    expect(levels).toEqual([
      ["read-only", true],
      ["approval-required", false],
      ["auto-accept-edits", false],
      ["full-access", false],
    ]);
    expect(page).toContain("<strong>Supervised</strong>");
    // Nothing readable asked for: "Read only" is offered disabled, "Supervised" chosen.
    const unreadable = renderApprovalPage({
      clientName: "Agent",
      redirectHost: "127.0.0.1:9999",
      nodeHost: "127.0.0.1:7777",
      params: {},
      permissions: [],
      csrf: "c",
      nonce: "n",
      nothingReadable: true,
    });
    expect(unreadable).toContain('value="read-only" disabled');
    expect(unreadable).toContain('value="approval-required" checked');
    expect(page).toContain(
      "Beyond read only, it can start, message and stop threads, and none of them can run with more than the mode you pick.",
    );
  });

  it("grants read only the asked reads, and any other level what was asked and its ceiling", () => {
    const asked = ["threads.read", "threads.write", "projects.read"];
    expect(grantsFor("read-only", asked)).toEqual(["threads.read", "projects.read"]);
    expect(grantsFor("approval-required", asked)).toEqual([
      ...asked,
      "threads.mode.approval-required",
    ]);
    expect(grantsFor("full-access", asked)).toEqual([...asked, "threads.mode.full-access"]);
  });
});
