import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import type { SendOutcome } from "../src/plugins/chat/send.ts";
import {
  createUnconfirmed,
  useUnconfirmed,
  type UnconfirmedMessage,
} from "../src/plugins/chat/unconfirmed.ts";

const message: UnconfirmedMessage = { text: "hello", attachments: [], settings: {} };

/** A thread's view with an unconfirmed first message; each send is answered with `answer`. */
function mountThread(answer: SendOutcome) {
  const store = createUnconfirmed();
  store.set("t1", message);
  const sent: UnconfirmedMessage[] = [];
  const view: {
    api?: ReturnType<typeof useUnconfirmed>;
    arrive?: () => void;
  } = {};
  function Thread() {
    const [arrived, setArrived] = useState(false);
    view.arrive = () => setArrived(true);
    view.api = useUnconfirmed(store, "t1", arrived, async (next) => {
      sent.push(next);
      return answer;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Thread />));
  return { store, sent, view, unmount: () => act(() => root.unmount()) };
}

describe("an unconfirmed first message", () => {
  it("is forgotten once its thread shows a turn", async () => {
    const thread = mountThread({ kind: "sent" });
    expect(thread.view.api?.message).toEqual(message);
    await act(async () => thread.view.arrive!());
    expect(thread.view.api?.message).toBeUndefined();
    expect(thread.store.get("t1")).toBeUndefined();
    expect(thread.sent).toEqual([]);
    thread.unmount();
  });

  it("is sent again on request, and kept when that fails", async () => {
    const failing = mountThread({ kind: "failed", message: "Not connected" });
    await act(async () => {
      await failing.view.api!.resend();
    });
    expect(failing.sent).toEqual([message]);
    expect(failing.store.get("t1")).toEqual(message);
    failing.unmount();

    const working = mountThread({ kind: "sent" });
    await act(async () => {
      await working.view.api!.resend();
    });
    expect(working.store.get("t1")).toBeUndefined();
    expect(working.view.api?.message).toBeUndefined();
    working.unmount();
  });
});
