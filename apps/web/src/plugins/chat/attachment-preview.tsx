// The preview of an attachment follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/AttachmentFilePreview.tsx (the file preview, its header and
// actions), files/fileSurfaceChrome.tsx (its actions, loading and failure), files/AudioPreview.tsx,
// files/BrowserDocumentFrame.tsx (the sandboxed HTML frame), the composer's file dialog in
// chat/ChatComposer.tsx, and chat/ExpandedImageDialog.tsx with media/MediaVideoPlayer.tsx (a video
// played full size). T3 fetches a signed URL with an HTTP range; here the bytes come from the node
// through `attachments.read`. A loaded chunk of its own (D440).
import type { StoredAttachment } from "@jhin/agent-api";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogTitle,
  ScrollArea,
  Spinner,
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  copyText,
  cn,
} from "@jhin/ui";
import {
  Table2Icon,
  CheckIcon,
  ChevronRightIcon,
  Code2Icon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  RotateCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrapTextIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";

import { DelimitedTablePreview, filePreviewDelimiter } from "./delimited-table.tsx";

import { formatAttachmentSize } from "../../lib/attachment-files.ts";
import {
  FILE_TEXT_PREVIEW_MAX_BYTES,
  decodeFilePreviewText,
  filePreviewKind,
} from "../../lib/file-preview.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import { DIFF_SECTION, DiffSettings, useSection } from "../../lib/settings.ts";
import type { AttachmentLoader } from "./attachment-media.tsx";
import { MessageText } from "./message-text.tsx";
import { useChat } from "./services.ts";

/** Where an attachment's bytes come from: the file still in the composer, or its node. */
export interface AttachmentPreviewSource {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** The file picked in this composer, while it has it. */
  readonly file?: Blob | undefined;
  /** The upload on the node, read with `loader`. */
  readonly stored?: StoredAttachment | undefined;
  readonly loader?: AttachmentLoader | undefined;
}

/** T3's ReadOnlySourcePreview: highlighted text, a chunk of its own as in T3. */
const SourcePreview = lazyChunk(
  () => import("./attachment-source.tsx").then((module) => module.ReadOnlySourcePreview),
  {
    loading: () => <FileSurfaceLoading className="p-4" />,
    failed: (props) => <PlainSource {...props} />,
  },
);

function PlainSource(props: { name: string; text: string; wordWrap: boolean }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <pre
        className={cn(
          "p-4 font-mono text-xs leading-5",
          props.wordWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        )}
      >
        {props.text}
      </pre>
    </ScrollArea>
  );
}

const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3";

export function FileSurfaceAction(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const pressed = props.pressed;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          pressed === undefined ? (
            <Button
              aria-label={props.label}
              className="shrink-0"
              disabled={props.disabled ?? false}
              onClick={props.onPress}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {props.children}
            </Button>
          ) : (
            <Toggle
              aria-label={props.label}
              className="shrink-0"
              disabled={props.disabled ?? false}
              onPressedChange={props.onPress}
              pressed={pressed}
              size="sm"
              variant="ghost"
            >
              {props.children}
            </Toggle>
          )
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function FileSurfaceNotice(props: { readonly children: ReactNode }) {
  return (
    <div
      className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground"
      role="status"
    >
      {props.children}
    </div>
  );
}

export function FileSurfaceLoading(props: { readonly className?: string }) {
  return (
    <div
      aria-label="Loading file"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center text-muted-foreground",
        props.className,
      )}
      role="status"
    >
      <Spinner size="lg" />
    </div>
  );
}

export function FileSurfaceFailure(props: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
      role="alert"
    >
      <p className="text-destructive">{props.message}</p>
      {props.onRetry ? (
        <button
          className="rounded-md border border-input px-2.5 py-1 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={props.onRetry}
          type="button"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

const errorText = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** The type a frame needs for its kind, when the stored one is another (else no copy is made). */
function frameType(kind: string, stored: string | undefined): string | undefined {
  const needed = kind === "pdf" ? "application/pdf" : kind === "html" ? "text/html" : undefined;
  return needed === undefined || stored?.split(";")[0]?.trim().toLowerCase() === needed
    ? undefined
    : needed;
}

/** The attachment's object URL: its own for a picked file, the node's (kept for the page) otherwise. */
function useSourceUrl(
  source: AttachmentPreviewSource,
  wanted: boolean,
  revision: number,
  /**
   * The type a frame must see, which the stored one may not be (`.pdf` saved as
   * `application/octet-stream`): the bytes are wrapped again with it, so the frame shows
   * them rather than downloading them.
   */
  type?: string,
  /** Whether the bytes go in the unsandboxed PDF frame, which shows only a real PDF. */
  pdf = false,
) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { file, stored, loader } = source;
  useEffect(() => {
    // A URL this effect revoked never shows again when it is wanted anew.
    setUrl(null);
    if (!wanted) return;
    setError(null);
    if (file === undefined && (stored === undefined || loader === undefined)) {
      setError("The attachment is unavailable.");
      return;
    }
    let current = true;
    const owned: string[] = [];
    const own = (blob: Blob) => {
      const made = URL.createObjectURL(blob);
      // Closed meanwhile: the cleanup ran before this URL existed.
      if (current) owned.push(made);
      else URL.revokeObjectURL(made);
      return made;
    };
    const show = async () => {
      const shown =
        file !== undefined
          ? own(type === undefined ? file : new Blob([file], { type }))
          : await loader!
              .url(stored!)
              .then(async (loaded) =>
                type === undefined
                  ? loaded
                  : own(new Blob([await (await fetch(loaded)).blob()], { type })),
              );
      // The PDF frame cannot be sandboxed (the built-in viewer refuses it), so only bytes that
      // are a PDF go in it, whatever type the upload claimed.
      if (pdf) {
        const head = await (await (await fetch(shown)).blob()).slice(0, 5).text();
        if (head !== "%PDF-") throw new Error("This file is not a PDF.");
      }
      return shown;
    };
    show().then(
      (shown) => current && setUrl(shown),
      (cause: unknown) => current && setError(errorText(cause, "The attachment is unavailable.")),
    );
    return () => {
      current = false;
      for (const made of owned) URL.revokeObjectURL(made);
    };
  }, [file, stored, loader, wanted, revision, type, pdf]);
  return { url: wanted ? url : null, error: wanted ? error : null };
}

/** The first MiB of the attachment as text (T3 reads a range of the same size). */
async function readText(source: AttachmentPreviewSource) {
  if (source.file !== undefined) {
    const bytes = new Uint8Array(
      await source.file.slice(0, FILE_TEXT_PREVIEW_MAX_BYTES + 1).arrayBuffer(),
    );
    return decodeFilePreviewText(bytes);
  }
  if (source.stored === undefined || source.loader === undefined) {
    throw new Error("The attachment is unavailable.");
  }
  const { bytes, done } = await source.loader.head(source.stored, FILE_TEXT_PREVIEW_MAX_BYTES);
  return decodeFilePreviewText(bytes, !done);
}

/** T3's AttachmentFilePreview: a header with the file's actions, and the file as it can be shown. */
export function AttachmentFilePreview(
  props: AttachmentPreviewSource & {
    /** Where it is: "Draft" in the composer, "Attachment" in a message (T3's breadcrumb). */
    readonly origin?: string;
    /** In place of `origin`: the project's name and each folder down to the file (D1342). */
    readonly trail?: readonly string[];
    readonly onRemove?: () => void;
    readonly onClose?: () => void;
    /** More actions of the subheader, before Close (the file panel's, t3-parity.md D1428). */
    readonly actions?: ReactNode;
    /** Beside the preview, right of it: T3's file explorer in the file panel (D1428). */
    readonly aside?: ReactNode;
    /** A line of its text to show (D1430). */
    readonly reveal?: { readonly line: number; readonly id: number } | undefined;
  },
) {
  const chat = useChat();
  const kind = filePreviewKind(props);
  // T3's table of a CSV or TSV file, its source a toggle away (D1436).
  const delimiter = kind === "text" ? filePreviewDelimiter(props) : null;
  const renderedMode =
    kind === "markdown" ? "markdown" : kind === "html" ? "html" : delimiter ? "table" : null;
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  // Text needs only its first MiB, not the whole file.
  const needsUrl = !needsText && kind !== "unsupported";
  const { url, error } = useSourceUrl(
    props,
    needsUrl,
    revision,
    frameType(kind, props.mimeType),
    kind === "pdf",
  );
  const wordWrap = useSection(chat.context, DIFF_SECTION, DiffSettings).wordWrap;

  useEffect(() => {
    if (!needsText) return;
    let current = true;
    setContent(null);
    setContentError(null);
    readText(props).then(
      (result) => current && setContent(result),
      (cause: unknown) => current && setContentError(errorText(cause, "Could not load this file.")),
    );
    return () => {
      current = false;
    };
  }, [needsText, props.file, props.stored, props.loader, revision]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const failure = error ?? (needsText ? contentError : null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const shownFailure = failure ?? mediaError;
  const showsRawText =
    shownFailure === null &&
    needsText &&
    content !== null &&
    !(kind === "markdown" && rendered) &&
    !(delimiter !== null && rendered);
  const canSave =
    props.file !== undefined || (props.stored !== undefined && props.loader !== undefined);

  const save = () => {
    setSaving(true);
    const target =
      props.file !== undefined
        ? Promise.resolve(URL.createObjectURL(props.file))
        : props.loader!.url(props.stored!);
    target
      .then((downloadUrl) => {
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = props.name;
        anchor.click();
        // A picked file's URL is this save's own; the node's stays cached for the page.
        if (props.file !== undefined) setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      })
      .catch((cause: unknown) =>
        chat.toasts?.show({
          type: "error",
          title: "Could not save file",
          description: errorText(cause, "Please try again."),
        }),
      )
      .finally(() => setSaving(false));
  };

  const body = shownFailure ? (
    <FileSurfaceFailure
      message={shownFailure}
      onRetry={() => {
        setMediaError(null);
        setRevision((value) => value + 1);
      }}
    />
  ) : needsText ? (
    content === null ? (
      <FileSurfaceLoading />
    ) : delimiter !== null && rendered ? (
      <DelimitedTablePreview delimiter={delimiter} name={props.name} text={content.text} />
    ) : kind === "markdown" && rendered ? (
      <ScrollArea className="min-h-0 flex-1">
        <MessageText className="mx-auto max-w-4xl px-6 py-5" text={content.text} />
      </ScrollArea>
    ) : (
      <SourcePreview
        name={props.name}
        reveal={props.reveal}
        text={content.text}
        wordWrap={wordWrap}
      />
    )
  ) : kind === "unsupported" ? (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium">No preview for this file</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Save it to open in an app that supports {props.name.split(".").at(-1) || "this format"}{" "}
        files.
      </p>
    </div>
  ) : url === null ? (
    <FileSurfaceLoading />
  ) : kind === "pdf" ? (
    // The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
    <iframe className="min-h-0 flex-1 border-0 bg-white" key={url} src={url} title={props.name} />
  ) : kind === "html" ? (
    // An opaque origin: the page reaches nothing of the client.
    <iframe
      className="min-h-0 flex-1 border-0 bg-white"
      key={url}
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      src={url}
      title={props.name}
    />
  ) : kind === "audio" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        aria-label={props.name}
        className="w-full max-w-xl"
        controls
        onError={() => setMediaError("Unable to load audio.")}
        preload="metadata"
        src={url}
      />
    </div>
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        aria-label={props.name}
        className="max-h-full max-w-full"
        controls
        onError={() => setMediaError("Unable to load video.")}
        playsInline
        src={url}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        alt={props.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setMediaError("Unable to load image.")}
        src={url}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs">
          {(props.trail ?? [props.origin ?? "Attachment"]).map((crumb, index) => (
            <Fragment key={index}>
              <span className="min-w-0 max-w-40 truncate px-0.5 text-muted-foreground">
                {crumb}
              </span>
              <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
            </Fragment>
          ))}
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            {props.name}
          </span>
          {props.sizeBytes > 0 ? (
            <span className="ml-2 shrink-0 text-muted-foreground">
              {formatAttachmentSize(props.sizeBytes)}
            </span>
          ) : null}
        </div>
        {renderedMode ? (
          <FileSurfaceAction
            label={renderedToggleLabel(renderedMode, rendered)}
            onPress={() => setRendered((value) => !value)}
            pressed={rendered}
          >
            {rendered ? (
              <Code2Icon className="size-3.5" />
            ) : renderedMode === "table" ? (
              <Table2Icon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
          </FileSurfaceAction>
        ) : null}
        {showsRawText ? (
          <FileSurfaceAction
            label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            onPress={() => void chat.settings?.patch(DIFF_SECTION, { wordWrap: !wordWrap })}
            pressed={wordWrap}
          >
            <WrapTextIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {content ? (
          <FileSurfaceAction
            label={copied ? "Copied" : content.truncated ? "Copy preview" : "Copy contents"}
            onPress={() => void copyText(content.text).then(() => setCopied(true))}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </FileSurfaceAction>
        ) : null}
        {canSave ? (
          <FileSurfaceAction
            disabled={saving}
            label={saving ? "Preparing file…" : "Save file"}
            onPress={save}
          >
            <DownloadIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.actions}
        {props.onRemove ? (
          <FileSurfaceAction label="Remove from draft" onPress={props.onRemove}>
            <Trash2Icon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onClose ? (
          <FileSurfaceAction label="Close" onPress={props.onClose}>
            <XIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
      </div>
      {content?.truncated ? (
        <FileSurfaceNotice>
          Preview limited to the first 1 MB
          {props.sizeBytes > 0 ? ` of a ${props.sizeBytes.toLocaleString()} byte file` : ""}. Save
          the file to read it in full.
        </FileSurfaceNotice>
      ) : null}
      {props.aside === undefined ? (
        body
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{body}</div>
          {props.aside}
        </div>
      )}
    </div>
  );
}

/** T3's file dialog: the preview of an attachment, over the thread. */
export function AttachmentPreviewDialog(
  props: AttachmentPreviewSource & {
    readonly origin?: string;
    readonly onRemove?: () => void;
    onClose(): void;
  },
) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      open
    >
      <DialogPopup
        className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{props.name}</DialogTitle>
        <AttachmentFilePreview {...props} />
      </DialogPopup>
    </Dialog>
  );
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

/** T3's ExpandedImageDialog for a video: played full size, with its name under it. */
export function VideoPreviewDialog(props: AttachmentPreviewSource & { onClose(): void }) {
  const [revision, setRevision] = useState(0);
  const { url, error } = useSourceUrl(props, true, revision);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = error !== null || (url !== null && failedUrl === url);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      open
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.86),calc(100vh-var(--native-titlebar-height,0px)-160px))] [--media-width:92vw] sm:[--media-width:calc(92vw-96px)]"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
        showCloseButton={false}
        variant="media"
      >
        <DialogTitle className="sr-only">Expanded video preview</DialogTitle>
        <Button
          aria-label="Close video preview"
          className="absolute top-0 right-0 z-20"
          onClick={props.onClose}
          size="icon-sm"
          type="button"
          variant="media-close"
        >
          <XIcon />
        </Button>
        <div className="relative isolate z-10 flex max-h-full max-w-(--media-width) flex-col items-center">
          {failed ? (
            <span className={EXPANDED_MEDIA_STATE_CLASS_NAME} role="alert">
              <span className="inline-flex items-center gap-1.5">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                Video unavailable · {props.name}
              </span>
              <Button
                onClick={() => {
                  setFailedUrl(null);
                  setRevision((value) => value + 1);
                }}
                size="sm"
                variant="secondary"
              >
                <RotateCwIcon />
                Retry video
              </Button>
            </span>
          ) : url === null ? (
            <span
              aria-label="Loading video"
              className={cn(EXPANDED_MEDIA_STATE_CLASS_NAME, "bg-muted/60")}
              role="status"
            />
          ) : (
            <video
              aria-label={props.name}
              autoPlay
              className="aspect-auto max-h-(--media-height) w-auto max-w-(--media-width) rounded-lg border border-border/70 bg-black object-contain shadow-2xl"
              controls
              onError={() => setFailedUrl(url)}
              playsInline
              preload="metadata"
              src={url}
            />
          )}
          <div className="mt-2 flex max-w-(--media-width) items-center justify-center gap-1.5 text-xs text-white/80 max-sm:px-10">
            <span aria-atomic="true" aria-live="polite" className="truncate">
              {props.name}
            </span>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
