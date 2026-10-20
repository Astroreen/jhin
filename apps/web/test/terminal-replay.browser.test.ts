import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { muteRepliesWhileReplaying } from "../src/plugins/terminal/replay.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Resolves in a task of its own, as a key press does: no timer, one message. */
const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", () => {
      channel.port1.close();
      resolve();
    });
    channel.port1.start();
    channel.port2.postMessage(null);
  });

/** A real xterm wired as the viewport wires it: replies muted while replaying, the rest sent. */
function terminal() {
  const element = document.createElement("div");
  document.body.append(element);
  const xterm = new Terminal();
  xterm.open(element);
  let replaying = 0;
  const mute = muteRepliesWhileReplaying(xterm, () => replaying > 0);
  const sent: string[] = [];
  const input = xterm.onData((data) => {
    if (!mute.isReply()) sent.push(data);
  });
  cleanups.push(() => {
    input.dispose();
    mute.dispose();
    xterm.dispose();
    element.remove();
  });
  /** Writes `data` as replayed output; resolves once it is parsed. */
  const replay = (data: string) =>
    new Promise<void>((resolve) => {
      replaying += 1;
      xterm.write(data, () => {
        replaying -= 1;
        resolve();
      });
    });
  /** A replay that stays open across several writes until `end()`. */
  const openReplay = () => {
    replaying += 1;
    return {
      write: (data: string) => new Promise<void>((resolve) => xterm.write(data, resolve)),
      end: () => {
        replaying -= 1;
      },
    };
  };
  const live = (data: string) => new Promise<void>((resolve) => xterm.write(data, resolve));
  return { xterm, sent, replay, openReplay, live };
}

describe("muting replies while replaying", () => {
  it("sends a key typed between two parsed parts of a replay, once and in order", async () => {
    const view = terminal();
    // A replay in two writes, the first with a colour query and a cursor
    // query in it: the replay is still open when the user types.
    const replay = view.openReplay();
    await replay.write(`$ ${ESC}]4;1;?${BEL}${ESC}[6n`);
    // The key comes in a task of its own, as typing does, mid-replay.
    await nextTask();
    view.xterm.input("e");
    await replay.write("more kept output");
    replay.end();
    // Then live output with a query: answered, after the key.
    await view.live(`${ESC}[5;7H${ESC}[6n`);
    expect(view.sent).toEqual(["e", `${ESC}[5;7R`]);
  });

  it("answers a live colour query parsed in the same task right after a replayed one", async () => {
    const view = terminal();
    // Queued together: xterm may parse both writes in one task.
    const replayed = view.replay(`${ESC}]4;1;?${BEL}`);
    const live = view.live(`${ESC}]4;2;?${BEL}`);
    await replayed;
    await live;
    expect(view.sent).toHaveLength(1);
    expect(view.sent[0]?.startsWith(`${ESC}]4;2;rgb:`)).toBe(true);
  });
});
