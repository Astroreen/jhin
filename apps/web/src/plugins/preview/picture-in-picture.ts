// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/browser/serverPictureInPicture.ts
// (a tab's frames in the browser's picture-in-picture window, docs/plans/preview.md, D1327).
import { PreviewEvents, previewFramesStream } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import type { Disposable } from "@jhin/sdk";

interface WebKitVideo {
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

/** Whether this browser can float a video of a canvas (T3's `supportsServerPictureInPicture`). */
export function supportsPictureInPicture(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
  const video = HTMLVideoElement.prototype as HTMLVideoElement & WebKitVideo;
  return (
    (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") ||
    typeof video.webkitSetPresentationMode === "function"
  );
}

function base64Blob(data: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

export const pictureInPictureKey = (threadId: string, tabId: string): string =>
  JSON.stringify([threadId, tabId]);

/**
 * The one tab popped out into the browser's picture-in-picture window. It
 * lives outside the panel and the mini player, so the window outlives them.
 */
export function createPictureInPicture() {
  let active: { readonly key: string; readonly stop: () => void } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const close = () => {
    const current = active;
    active = null;
    current?.stop();
    emit();
  };

  return {
    key: () => active?.key ?? null,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
    /** Closes the window of a tab that went. */
    forget(threadId: string, tabId: string): void {
      if (active?.key === pictureInPictureKey(threadId, tabId)) close();
    },
    /**
     * Opens the window during the user's gesture, seeded with the frame on
     * screen, then follows the tab's frames stream (T3's `openServerPictureInPicture`).
     */
    async open(input: {
      readonly client: RpcClient;
      readonly threadId: string;
      readonly tabId: string;
      readonly seed: HTMLCanvasElement | null;
      /** The tab's frames stopped coming (the stream failed): the window closes and says why. */
      readonly onStreamError?: (error: unknown) => void;
      /**
       * The thread's tabs, followed while the window is open: it closes when its tab does,
       * wherever the player and the panel are by then.
       */
      readonly tabs?: {
        tabs(): readonly { tabId: string }[];
        loaded(): boolean;
        subscribe(listener: () => void): Disposable;
      };
    }): Promise<void> {
      // Its callers check first; any other gets a reason, not a bare TypeError.
      if (!supportsPictureInPicture()) {
        throw new Error("This browser has no picture-in-picture window for the preview.");
      }
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      // Nothing could be painted: no window rather than a blank one.
      if (context === null) throw new Error("The browser gave no canvas to paint the preview on.");
      const seed = input.seed && input.seed.width > 0 && input.seed.height > 0 ? input.seed : null;
      canvas.width = seed?.width ?? 640;
      canvas.height = seed?.height ?? 400;
      // The capture emits a frame per draw, so the seed is drawn after it starts.
      const stream = canvas.captureStream();
      try {
        if (seed) context.drawImage(seed, 0, 0);
        else context.fillRect(0, 0, canvas.width, canvas.height);
      } catch (error) {
        // Not started: nothing of it stays, before the window owns its stream (below).
        for (const track of stream.getTracks()) track.stop();
        throw error;
      }
      // Only now, with the new one ready to start, does a window already up give way to it.
      close();
      const video = document.createElement("video") as HTMLVideoElement & WebKitVideo;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      // Safari only floats a video that is in the document.
      video.style.cssText =
        "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none";
      video.dataset["previewPictureInPicture"] = input.tabId;
      document.body.append(video);

      let painting = false;
      let waiting: string | undefined;
      let stopped = false;
      /** Ends a wait of the start when the window is closed meanwhile. */
      let interrupt: (() => void) | undefined;
      const paint = async (data: string) => {
        if (painting) {
          waiting = data;
          return;
        }
        painting = true;
        try {
          const bitmap = await createImageBitmap(base64Blob(data));
          try {
            if (!stopped) {
              if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
              }
              context.drawImage(bitmap, 0, 0);
            }
          } finally {
            // Closed whether or not it was drawn.
            bitmap.close();
          }
        } catch {
          // A frame that does not decode is skipped.
        } finally {
          painting = false;
          const next = waiting;
          waiting = undefined;
          if (next !== undefined && !stopped) void paint(next);
        }
      };
      let frames: Disposable | undefined;
      let following: Disposable | undefined;
      const onLeave = () => {
        if (active === current) close();
      };
      const onPresentationMode = () => {
        if (video.webkitPresentationMode !== "picture-in-picture") onLeave();
      };
      const current = {
        key: pictureInPictureKey(input.threadId, input.tabId),
        stop: () => {
          stopped = true;
          interrupt?.();
          frames?.dispose();
          following?.dispose();
          video.removeEventListener("leavepictureinpicture", onLeave);
          video.removeEventListener("webkitpresentationmodechanged", onPresentationMode);
          if (document.pictureInPictureElement === video) {
            void document.exitPictureInPicture().catch(() => undefined);
          } else if (video.webkitPresentationMode === "picture-in-picture") {
            video.webkitSetPresentationMode?.("inline");
          }
          for (const track of stream.getTracks()) track.stop();
          video.srcObject = null;
          video.remove();
        },
      };
      active = current;
      emit();
      try {
        await video.play();
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve, reject) => {
            // Whichever way the wait ends, neither listener stays on the video.
            const done = () => {
              interrupt = undefined;
              video.removeEventListener("loadedmetadata", loaded);
              video.removeEventListener("error", failed);
            };
            const loaded = () => {
              done();
              resolve();
            };
            const failed = () => {
              done();
              reject(new Error("The preview video did not start."));
            };
            interrupt = loaded;
            video.addEventListener("loadedmetadata", loaded);
            video.addEventListener("error", failed);
          });
        }
        // Closed or replaced meanwhile: nothing to float, and nothing to report.
        if (active !== current) return;
        if (
          document.pictureInPictureEnabled &&
          typeof video.requestPictureInPicture === "function"
        ) {
          video.addEventListener("leavepictureinpicture", onLeave);
          await video.requestPictureInPicture();
          // Closed while the browser opened it: the window that just came up goes too.
          if (active !== current && document.pictureInPictureElement === video) {
            await document.exitPictureInPicture().catch(() => undefined);
          }
        } else {
          video.addEventListener("webkitpresentationmodechanged", onPresentationMode);
          video.webkitSetPresentationMode?.("picture-in-picture");
        }
      } catch (error) {
        if (active !== current) return;
        onLeave();
        throw error;
      }
      if (active !== current) return;
      const tabs = input.tabs;
      if (tabs !== undefined) {
        // Followed once the feed has loaded: a feed that never loads leaves the window to
        // the user and to the frames stream, which ends with the tab.
        const check = () => {
          if (tabs.loaded() && !tabs.tabs().some((tab) => tab.tabId === input.tabId)) onLeave();
        };
        following = tabs.subscribe(check);
        check();
        // Its tab was already gone (told now, or as the feed subscribed): the window closed, so
        // the feed is let go too, and nothing watches the tab's frames.
        if (active !== current) {
          following.dispose();
          return;
        }
      }
      // Subscribing makes this window a viewer: the node streams the tab while it is open.
      try {
        frames = input.client.subscribe(
          previewFramesStream(input.threadId, input.tabId),
          {
            after: 0,
            onError: (error: unknown) => {
              if (active !== current) return;
              onLeave();
              input.onStreamError?.(error);
            },
          },
          (event) => {
            if (event.type !== PreviewEvents.frame) return;
            const data = (event.payload as { data?: unknown } | null)?.data;
            if (typeof data === "string") void paint(data);
          },
        );
      } catch (error) {
        // No frames to show: the window does not stay up empty.
        onLeave();
        throw error;
      }
      // A stream that failed while subscribing closed the window before `frames` was set: the
      // subscription it handed back goes too.
      if (active !== current) frames.dispose();
    },
    dispose: close,
  };
}

export type PictureInPicture = ReturnType<typeof createPictureInPicture>;
