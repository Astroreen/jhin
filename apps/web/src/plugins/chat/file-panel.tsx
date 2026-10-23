// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/FilePreviewPanel.tsx (a workspace file beside the thread, its
// breadcrumbs, its read error with "Try again") and the file tab of
// apps/web/src/components/RightPanelTabs.tsx.
//
// A mentioned file's preview right of the thread (t3-parity.md D1342): a chunk of its own (D440),
// loaded when the panel first opens. The file is read through `projects.read-file`.
import type { NodeTarget } from "@jhin/client-api";
import { targetKey } from "@jhin/client-api";
import { Button, Tooltip, TooltipPopup, TooltipTrigger } from "@jhin/ui";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useCatalog } from "../../lib/hooks.ts";
import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import {
  AttachmentFilePreview,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./attachment-preview.tsx";
import { basename } from "./file-chips.tsx";
import { isTooLarge, type PreviewFile, readPreviewFile } from "./preview-file.ts";
import { useChat } from "./services.ts";

export interface FilePanelProps {
  readonly target: NodeTarget;
  /** The thread on screen: a file of its worktree comes first. */
  readonly threadId: string | undefined;
  /** A draft's project, where no thread is open yet. */
  readonly projectId: string | undefined;
  /** The file, relative to the project's folder (or the thread's worktree). */
  readonly path: string;
  onClose(): void;
}

/** T3's inline right panel: its tab of the file, then the file. */
export function FilePanel(props: FilePanelProps) {
  const chat = useChat();
  const theme = useResolvedTheme();
  const catalog = useCatalog(chat.threads, props.target);
  const record =
    props.threadId === undefined
      ? undefined
      : catalog?.threads.find((thread) => thread.id === props.threadId);
  const projectId = props.projectId ?? record?.projectId;
  const project = catalog?.projects.find((candidate) => candidate.id === projectId);
  const name = basename(props.path);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<
    { key: string; file: PreviewFile } | { key: string; error: string } | undefined
  >();
  // Everything the read depends on: another node, thread, project, file or retry reads again.
  const key = `${targetKey(props.target)}|${projectId ?? ""}|${props.threadId ?? ""}|${props.path}|${revision}`;

  useEffect(() => {
    if (projectId === undefined) return;
    let current = true;
    readPreviewFile(chat.threads, props.target, name, "projects.read-file", {
      projectId,
      ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
      path: props.path,
    }).then(
      (file) => current && setRead({ key, file }),
      (error: unknown) =>
        current &&
        setRead({
          key,
          error: isTooLarge(error)
            ? `${name} is too large to preview.`
            : error instanceof Error
              ? error.message
              : String(error),
        }),
    );
    return () => {
      current = false;
    };
  }, [key]);

  const shown = read?.key === key ? read : undefined;
  // T3's breadcrumbs: the project, then each folder down to the file.
  const folders = props.path.split(/[\\/]/).slice(0, -1).filter(Boolean);
  const trail = [project?.name ?? "Workspace", ...folders];
  return (
    <aside
      aria-label="File preview"
      className="flex h-full w-[42vw] min-w-[360px] max-w-[560px] shrink-0 flex-col border-l border-border bg-background"
      data-file-panel
    >
      <div className="drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 border-b border-border/60 pr-3 pl-2">
        <div className="flex h-6 max-w-56 min-w-0 shrink items-center gap-1 rounded-md bg-accent pr-0.5 pl-1.5 text-xs text-foreground">
          <PierreEntryIcon kind="file" pathValue={props.path} theme={theme} />
          <span className="min-w-0 truncate" title={props.path}>
            {name}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Close ${name}`}
                  className="size-4 min-h-4 rounded-sm"
                  onClick={props.onClose}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <XIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close {name}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {projectId === undefined ? (
        catalog === undefined ? (
          <FileSurfaceLoading />
        ) : (
          // The node's catalog has no such thread (it was deleted, or the link is old); should
          // it come, the file is read then.
          <FileSurfaceFailure
            message={
              props.threadId === undefined
                ? "This file's project is not available."
                : "This file's thread is not available."
            }
          />
        )
      ) : shown === undefined ? (
        <FileSurfaceLoading />
      ) : "error" in shown ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <FileSurfaceFailure message={shown.error} onRetry={() => setRevision((n) => n + 1)} />
          <p className="px-6 pb-6 text-center text-xs text-muted-foreground">
            Attempted path
            <code className="block break-all font-mono text-foreground select-all">
              {props.path}
            </code>
          </p>
        </div>
      ) : (
        <AttachmentFilePreview
          file={shown.file.file}
          key={key}
          mimeType=""
          name={name}
          sizeBytes={shown.file.sizeBytes}
          trail={trail}
        />
      )}
    </aside>
  );
}
