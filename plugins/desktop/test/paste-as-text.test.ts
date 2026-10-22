import { describe, expect, it } from "vite-plus/test";

import { pasteAsText } from "../src/paste-as-text.ts";

function recorder(options: { chat: boolean; bridge: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      has: (command: string) => options.chat && command === "chat.composer.paste-as-text",
      execute: async (command: string) => void calls.push(`execute:${command}`),
      paste: options.bridge ? async () => void calls.push("paste") : undefined,
    },
  };
}

describe("pasteAsText (D946)", () => {
  it("arms the composer, then pastes", async () => {
    const { calls, deps } = recorder({ chat: true, bridge: true });
    await pasteAsText(deps);
    expect(calls).toEqual(["execute:chat.composer.paste-as-text", "paste"]);
  });

  it("pastes plainly without the chat plugin", async () => {
    const { calls, deps } = recorder({ chat: false, bridge: true });
    await pasteAsText(deps);
    expect(calls).toEqual(["paste"]);
  });

  it("arms nothing when the app cannot paste", async () => {
    const { calls, deps } = recorder({ chat: true, bridge: false });
    await pasteAsText(deps);
    expect(calls).toEqual([]);
  });
});
