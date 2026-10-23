import { describe, expect, it } from "vite-plus/test";

import { renderApprovalPage } from "../src/html.ts";

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
