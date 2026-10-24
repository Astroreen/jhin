// The attachments of the composer and of a sent message follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/components/chat/ChatComposer.tsx (the
// thumbnails, video tiles and file rows above the prompt, ComposerVideoThumbnail, the file
// dialog), chat/MessagesTimeline.tsx (a sent message's images, videos and file rows) and
// media/MediaVideoPlayer.tsx (a sent video's tile: its first frame once visible, and a Play
// button that opens it). A chunk of its own, loaded with the first attachment (D440).
import type { StoredAttachment, TurnAttachment } from "@jhin/agent-api";
import { Button, Spinner, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import { DownloadIcon, EyeIcon, FileIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { formatAttachmentSize } from "../../lib/attachment-files.ts";
import { isVideoAttachment, prepareVideoFirstFrame } from "../../lib/file-preview.ts";
import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import { useChat } from "./services.ts";
import {
  AttachmentLoaderContext,
  AttachmentPanelContext,
  AttachmentPreviewDialog,
  VideoPreviewDialog,
  useAttachmentUrl,
} from "./attachment-media.tsx";
import type { ComposerAttachment, ComposerAttachmentsProps } from "./composer-attachments.tsx";

/** T3's ComposerVideoThumbnail: a picked video's first frame, behind its tile. */
function VideoThumbnail(props: { src: string; className?: string }) {
  return (
    <video
      aria-hidden="true"
      className={cn("pointer-events-none size-full object-cover", props.className)}
      muted
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      playsInline
      preload="metadata"
      src={props.src}
    />
  );
}

/** A picked file's object URL, for as long as the component shows it. */
function useObjectUrl(file: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (file === undefined) return;
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(undefined);
    };
  }, [file]);
  return url;
}

/** Whether `element` has come within 200 px of the viewport (T3 preloads a video then). */
function useNearViewport(element: Element | null): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (element === null || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, near]);
  return near;
}

/** A sent video: its first frame once near the viewport, and a Play button that opens it. */
function MessageVideoAttachment({ attachment }: { attachment: StoredAttachment }) {
  const loader = useContext(AttachmentLoaderContext);
  const [tile, setTile] = useState<HTMLSpanElement | null>(null);
  const near = useNearViewport(tile);
  const url = useAttachmentUrl(attachment, loader, near);
  const [open, setOpen] = useState(false);
  if (loader === undefined) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border/80 bg-black px-2 py-3 text-center text-2xs text-white/70">
        {attachment.name}
      </div>
    );
  }
  return (
    <span className="relative block aspect-[4/3] w-full" ref={setTile}>
      {url === undefined ? (
        <span
          aria-label="Loading video"
          className="block size-full rounded-lg border border-border/80 bg-black"
          role="status"
        />
      ) : (
        <VideoThumbnail
          className="aspect-auto rounded-lg border border-border/80 bg-black object-contain"
          src={url}
        />
      )}
      <button
        aria-label={`Play ${attachment.name}`}
        className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
          <PlayIcon aria-hidden className="size-4 fill-current" />
        </span>
      </button>
      {open ? (
        <VideoPreviewDialog
          loader={loader}
          mimeType={attachment.mimeType}
          name={attachment.name}
          onClose={() => setOpen(false)}
          sizeBytes={attachment.sizeBytes}
          stored={attachment}
        />
      ) : null}
    </span>
  );
}

function ImageAttachment({ attachment }: { attachment: TurnAttachment }) {
  const url = useAttachmentUrl(attachment, useContext(AttachmentLoaderContext));
  return (
    <div className="aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70">
      {url === undefined ? (
        <div aria-label={attachment.name} className="size-full" role="img" />
      ) : (
        <a href={url} rel="noopener noreferrer" target="_blank">
          <img
            alt={attachment.name}
            className="block size-full cursor-zoom-in object-cover"
            src={url}
          />
        </a>
      )}
    </div>
  );
}

/**
 * T3's file row in a sent message: its icon and name open its preview, and a
 * button downloads it.
 */
function FileAttachment({ attachment }: { attachment: StoredAttachment }) {
  const loader = useContext(AttachmentLoaderContext);
  const openInPanel = useContext(AttachmentPanelContext);
  const theme = useResolvedTheme();
  const [previewing, setPreviewing] = useState(false);
  const chat = useChat();
  const identity = (
    <>
      <PierreEntryIcon kind="file" pathValue={attachment.name} theme={theme} />
      <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
    </>
  );
  if (loader === undefined) {
    return <div className="flex min-w-0 items-center gap-2 py-1 text-sm">{identity}</div>;
  }
  const download = () => {
    loader.url(attachment).then(
      (url) => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
      },
      (cause: unknown) =>
        chat.toasts?.show({
          type: "error",
          title: "Could not save file",
          description: cause instanceof Error ? cause.message : "Please try again.",
        }),
    );
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        aria-label={`Preview ${attachment.name}`}
        className="focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
        // T3 opens it in the right panel (D1435).
        onClick={() => (openInPanel === undefined ? setPreviewing(true) : openInPanel(attachment))}
        type="button"
      >
        {identity}
        <EyeIcon className="size-4 shrink-0" />
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Download ${attachment.name}`}
              onClick={download}
              size="icon-xs"
              variant="ghost-muted"
            />
          }
        >
          <DownloadIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Download {attachment.name}</TooltipPopup>
      </Tooltip>
      {previewing ? (
        <AttachmentPreviewDialog
          loader={loader}
          mimeType={attachment.mimeType}
          name={attachment.name}
          onClose={() => setPreviewing(false)}
          sizeBytes={attachment.sizeBytes}
          stored={attachment}
        />
      ) : null}
    </div>
  );
}

/** T3's attachments of a sent message: images and videos in a grid, then a row per file. */
export function MessageAttachments({ attachments }: { attachments: readonly TurnAttachment[] }) {
  const images = attachments.filter((attachment) => attachment.kind === "image");
  const stored = attachments.filter(
    (attachment): attachment is StoredAttachment =>
      attachment.kind === "file" && "id" in attachment,
  );
  const videos = stored.filter(isVideoAttachment);
  const files = stored.filter((attachment) => !isVideoAttachment(attachment));
  if (attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      {images.length > 0 || videos.length > 0 ? (
        <div className="grid max-w-[210px] grid-cols-2 gap-2">
          {images.map((attachment, index) => (
            <ImageAttachment attachment={attachment} key={`${attachment.name}-${index}`} />
          ))}
          {videos.map((attachment) => (
            <MessageVideoAttachment attachment={attachment} key={attachment.id} />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-col gap-1">
          {files.map((attachment) => (
            <FileAttachment attachment={attachment} key={attachment.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const progressText = (progress: number) =>
  `${Math.floor(Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * 100)}%`;

/** A picked video's tile: its first frame and a Play button, as T3's composer shows it. */
function ComposerVideoTile(props: {
  item: ComposerAttachment;
  file: File | undefined;
  onPlay(): void;
  onRemove(localId: string): void;
  onRetry(localId: string): void;
}) {
  const { item } = props;
  const url = useObjectUrl(props.file);
  return (
    <div
      className="relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
      data-attachment-status={item.status}
    >
      <button
        aria-label={`Play ${item.name}`}
        className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
        onClick={props.onPlay}
        type="button"
      >
        {url === undefined ? null : (
          <>
            <VideoThumbnail className="absolute inset-0" src={url} />
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
          </>
        )}
        <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
      </button>
      {item.status === "uploading" ? (
        <span
          aria-label={`Uploading ${item.name}`}
          aria-valuenow={Math.round(item.progress * 100)}
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground"
          role="progressbar"
        >
          {progressText(item.progress)}
        </span>
      ) : null}
      {item.status === "failed" ? (
        <span className="absolute bottom-1 left-1 flex">
          <RetryButton item={item} onRetry={props.onRetry} variant="overlay" />
        </span>
      ) : null}
      <span className="absolute top-1 right-1 flex">
        <Button
          aria-label={`Remove ${item.name}`}
          onClick={() => props.onRemove(item.localId)}
          size="icon-xs"
          variant="media-close"
        >
          <XIcon />
        </Button>
      </span>
    </div>
  );
}

/**
 * T3's attachments above the prompt: image thumbnails and video tiles, then a
 * row per file; a file's name opens its preview, a video's tile plays it.
 */
export function ComposerAttachments(props: ComposerAttachmentsProps) {
  const theme = useResolvedTheme();
  const [previewId, setPreviewId] = useState<string | undefined>();
  const [playingId, setPlayingId] = useState<string | undefined>();
  const images = props.items.filter((item) => item.kind === "image");
  const videos = props.items.filter(isVideoAttachment);
  const others = props.items.filter((item) => item.kind === "file" && !isVideoAttachment(item));
  const sourceOf = (item: ComposerAttachment) => ({
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    file: props.fileOf(item.localId),
    stored: item.stored,
    loader: props.loader,
  });
  const canOpen = (item: ComposerAttachment) =>
    props.fileOf(item.localId) !== undefined ||
    (item.stored !== undefined && props.loader !== undefined);
  const previewed = props.items.find((item) => item.localId === previewId);
  const playing = props.items.find((item) => item.localId === playingId);
  if (props.items.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2">
      {images.length > 0 || videos.length > 0 ? (
        <div className="flex max-w-full flex-wrap gap-2">
          {images.map((item) => (
            <div
              className="group/attachment relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-background"
              data-attachment-status={item.status}
              key={item.localId}
            >
              {item.previewUrl === undefined ? (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <FileIcon className="size-5" />
                </div>
              ) : (
                <img alt={item.name} className="h-full w-full object-cover" src={item.previewUrl} />
              )}
              {item.status === "uploading" ? (
                <div
                  aria-label={`Uploading ${item.name}`}
                  aria-valuenow={Math.round(item.progress * 100)}
                  className="absolute inset-0 flex items-center justify-center bg-background/60"
                  role="progressbar"
                >
                  <Spinner size="sm" />
                </div>
              ) : item.status === "failed" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                  <RetryButton item={item} onRetry={props.onRetry} />
                </div>
              ) : null}
              <span className="absolute top-1 right-1 flex">
                <Button
                  aria-label={`Remove ${item.name}`}
                  onClick={() => props.onRemove(item.localId)}
                  size="icon-xs"
                  variant="media-close"
                >
                  <XIcon />
                </Button>
              </span>
            </div>
          ))}
          {videos.map((item) => (
            <ComposerVideoTile
              file={props.fileOf(item.localId)}
              item={item}
              key={item.localId}
              onPlay={() => {
                if (canOpen(item)) setPlayingId(item.localId);
              }}
              onRemove={props.onRemove}
              onRetry={props.onRetry}
            />
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="flex flex-col gap-1">
          {others.map((item) => (
            <div
              className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
              data-attachment-status={item.status}
              key={item.localId}
            >
              <PierreEntryIcon kind="file" pathValue={item.name} theme={theme} />
              <button
                className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-2"
                disabled={!canOpen(item)}
                onClick={() => setPreviewId(item.localId)}
                type="button"
              >
                {item.name}
              </button>
              <span
                className={cn(
                  "shrink-0 text-xs tabular-nums",
                  item.status === "failed" ? "text-destructive" : "text-muted-foreground",
                )}
                {...(item.status === "uploading"
                  ? {
                      role: "progressbar",
                      "aria-label": `Uploading ${item.name}`,
                      "aria-valuenow": Math.round(item.progress * 100),
                    }
                  : {})}
              >
                {item.status === "uploading"
                  ? progressText(item.progress)
                  : item.status === "failed"
                    ? "Attach again"
                    : formatAttachmentSize(item.sizeBytes)}
              </span>
              {item.status === "failed" ? (
                <RetryButton item={item} onRetry={props.onRetry} />
              ) : null}
              <Button
                aria-label={`Remove ${item.name}`}
                onClick={() => props.onRemove(item.localId)}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {previewed === undefined ? null : (
        <AttachmentPreviewDialog
          key={previewed.localId}
          {...sourceOf(previewed)}
          onClose={() => setPreviewId(undefined)}
          onRemove={() => {
            props.onRemove(previewed.localId);
            setPreviewId(undefined);
          }}
          origin="Draft"
        />
      )}
      {playing === undefined ? null : (
        <VideoPreviewDialog
          key={playing.localId}
          {...sourceOf(playing)}
          onClose={() => setPlayingId(undefined)}
        />
      )}
    </div>
  );
}

function RetryButton(props: {
  item: ComposerAttachment;
  onRetry(localId: string): void;
  variant?: "ghost" | "overlay";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Retry ${props.item.name}`}
            onClick={() => props.onRetry(props.item.localId)}
            size="icon-xs"
            variant={props.variant ?? "ghost"}
          />
        }
      >
        <RotateCcwIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.item.error ?? "Upload failed"}</TooltipPopup>
    </Tooltip>
  );
}
