import { PreviewEvents, previewFramesStream } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import {
  createPictureInPicture,
  pictureInPictureKey,
} from "../src/plugins/preview/picture-in-picture.ts";

/** A node whose streams the test feeds: each subscription, its listener and whether it ended. */
function fakeClient() {
  const subscriptions: {
    stream: string;
    listener: (event: StoredEvent) => void;
    fail: (error: unknown) => void;
    disposed: boolean;
  }[] = [];
  const client = {
    subscribe: (
      stream: string,
      options: { onError?: (error: unknown) => void },
      listener: (event: StoredEvent) => void,
    ) => {
      const entry = {
        stream,
        listener,
        fail: (error: unknown) => options.onError?.(error),
        disposed: false,
      };
      subscriptions.push(entry);
      return {
        dispose: () => {
          entry.disposed = true;
        },
      };
    },
    call: async () => ({}),
  } as unknown as RpcClient;
  return { client, subscriptions };
}

/** A thread's tabs the test changes. */
function fakeTabs(ids: string[]) {
  let list = ids.map((tabId) => ({ tabId }));
  const listeners = new Set<() => void>();
  return {
    tabs: () => list,
    loaded: () => true,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    close(tabId: string) {
      list = list.filter((tab) => tab.tabId !== tabId);
      for (const listener of listeners) listener();
    },
  };
}

/** Runs `work` inside a real click, which the browser's picture-in-picture needs. */
async function withGesture(work: () => void) {
  const button = document.createElement("button");
  button.textContent = "gesture";
  button.addEventListener("click", work, { once: true });
  document.body.append(button);
  await userEvent.click(button);
  button.remove();
}

/** A one-pixel JPEG, base64. */
const JPEG = await (async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/jpeg"),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
})();

const pips: ReturnType<typeof createPictureInPicture>[] = [];
afterEach(() => {
  for (const pip of pips.splice(0)) pip.dispose();
});

describe("the preview's picture-in-picture window (D1327)", () => {
  it("watches the tab's frames while open and stops watching when closed", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({ client, threadId: "t1", tabId: "a", seed: null });
    });
    await opened;
    expect(document.pictureInPictureElement?.tagName).toBe("VIDEO");
    expect(subscriptions.map((each) => each.stream)).toEqual([previewFramesStream("t1", "a")]);
    // A frame is painted into the window's video.
    subscriptions[0]!.listener({
      type: PreviewEvents.frame,
      payload: { data: JPEG, width: 2, height: 2 },
    } as unknown as StoredEvent);
    pip.close();
    expect(subscriptions[0]!.disposed).toBe(true);
    expect(pip.key()).toBeNull();
    expect(document.querySelector("video[data-preview-picture-in-picture]")).toBeNull();
  });

  it("closes with its tab, wherever the player is by then", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    const tabs = fakeTabs(["a", "b"]);
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({ client, threadId: "t1", tabId: "a", seed: null, tabs });
    });
    await opened;
    tabs.close("b");
    expect(pip.key()).toBe(pictureInPictureKey("t1", "a"));
    tabs.close("a");
    expect(pip.key()).toBeNull();
    expect(subscriptions[0]!.disposed).toBe(true);
  });

  it("closes at once for a tab already gone, and never watches its frames", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    const tabs = fakeTabs(["b"]);
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({ client, threadId: "t1", tabId: "a", seed: null, tabs });
    });
    await expect(opened).resolves.toBeUndefined();
    expect(pip.key()).toBeNull();
    expect(subscriptions).toEqual([]);
    expect(document.querySelector("video[data-preview-picture-in-picture]")).toBeNull();
  });

  it("lets go of the frames when the stream fails as it is subscribed", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    // The stream refuses at once: `onError` runs inside `subscribe`.
    const failing = {
      ...client,
      subscribe: (...args: Parameters<RpcClient["subscribe"]>) => {
        const subscription = client.subscribe(...args);
        subscriptions.at(-1)!.fail(new Error("refused"));
        return subscription;
      },
    } as unknown as RpcClient;
    const failures: unknown[] = [];
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({
        client: failing,
        threadId: "t1",
        tabId: "a",
        seed: null,
        onStreamError: (error) => failures.push(error),
      });
    });
    await opened;
    expect(failures).toHaveLength(1);
    expect(pip.key()).toBeNull();
    expect(subscriptions[0]!.disposed).toBe(true);
  });

  it("keeps the window that is up when a new one cannot start", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({ client, threadId: "t1", tabId: "a", seed: null });
    });
    await opened;
    // The next open gets no canvas to paint on: it fails before it touches the first.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    try {
      await expect(pip.open({ client, threadId: "t1", tabId: "b", seed: null })).rejects.toThrow(
        "no canvas",
      );
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
    expect(pip.key()).toBe(pictureInPictureKey("t1", "a"));
    expect(subscriptions.map((each) => each.disposed)).toEqual([false]);
    expect(document.pictureInPictureElement?.tagName).toBe("VIDEO");
  });

  it("lets a later open replace an earlier one still starting, without an error", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await withGesture(() => {
      first = pip.open({ client, threadId: "t1", tabId: "a", seed: null });
      second = pip.open({ client, threadId: "t1", tabId: "b", seed: null });
    });
    await expect(first).resolves.toBeUndefined();
    await second;
    expect(pip.key()).toBe(pictureInPictureKey("t1", "b"));
    // Only the window that stayed watches its tab.
    expect(subscriptions.map((each) => each.stream)).toEqual([previewFramesStream("t1", "b")]);
    expect(document.querySelectorAll("video[data-preview-picture-in-picture]")).toHaveLength(1);
    // The window that is up is the second's.
    expect(document.pictureInPictureElement).toBe(
      document.querySelector("video[data-preview-picture-in-picture]"),
    );
  });

  it("closes quietly when the user closes it while it is still starting", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({ client, threadId: "t1", tabId: "a", seed: null });
      pip.close();
    });
    await expect(opened).resolves.toBeUndefined();
    expect(pip.key()).toBeNull();
    expect(subscriptions).toEqual([]);
    // No window is left behind that nothing tracks.
    expect(document.pictureInPictureElement).toBeNull();
  });

  it("paints the tab's frames into the window, and closes it saying why when they stop", async () => {
    const pip = createPictureInPicture();
    pips.push(pip);
    const { client, subscriptions } = fakeClient();
    const failures: unknown[] = [];
    let opened: Promise<void> = Promise.resolve();
    await withGesture(() => {
      opened = pip.open({
        client,
        threadId: "t1",
        tabId: "a",
        seed: null,
        onStreamError: (error) => failures.push(error),
      });
    });
    await opened;
    const video = document.querySelector<HTMLVideoElement>(
      "video[data-preview-picture-in-picture]",
    )!;
    expect([video.videoWidth, video.videoHeight]).toEqual([640, 400]);
    // A 2 × 2 frame is drawn: the window's video takes its size.
    const resized = new Promise<void>((resolve) =>
      video.addEventListener("resize", () => resolve(), { once: true }),
    );
    subscriptions[0]!.listener({
      type: PreviewEvents.frame,
      payload: { data: JPEG, width: 2, height: 2 },
    } as unknown as StoredEvent);
    await resized;
    expect([video.videoWidth, video.videoHeight]).toEqual([2, 2]);
    // The stream fails: the window closes and the player hears why.
    subscriptions[0]!.fail(new Error("refused"));
    expect(pip.key()).toBeNull();
    expect(failures).toHaveLength(1);
    expect(subscriptions[0]!.disposed).toBe(true);
  });
});
