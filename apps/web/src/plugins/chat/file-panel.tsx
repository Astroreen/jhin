// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/files/FilePreviewPanel.tsx (a workspace file beside the thread, its
// breadcrumbs, its read error with "Try again") and the file tab of
// apps/web/src/components/RightPanelTabs.tsx.
//
// A mentioned file's preview right of the thread (t3-parity.md D1342): a chunk of its own (D440),
// loaded when the panel first opens. The file is read through `projects.read-file`.
import type { NodeTarget } from "@jhin/client-api";
import { targetKey } from "@jhin/client-api";
import type { StoredAttachment } from "@jhin/agent-api";
import type { EditorInfo } from "@jhin/host-api";
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { ChevronDownIcon, FolderTreeIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useCatalog } from "../../lib/hooks.ts";
import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { preferredEditor, rememberEditor } from "../../lib/preferred-editor.ts";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";
import {
  AttachmentFilePreview,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./attachment-preview.tsx";
import { FileExplorer } from "./file-explorer.tsx";
import { FileEditor } from "./file-editor.tsx";
import { useAttachmentLoader } from "./attachment-media.tsx";
import { basename } from "./file-chips.tsx";
import { revealKey } from "./file-panel-route.ts";
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
  /**
   * A surface of the right panel (t3-parity.md D1424): its strip has the file's tab, so the
   * panel's own head goes.
   */
  readonly embedded?: boolean;
  /** Opens a file from the explorer beside it, in the right panel (D1428). */
  readonly onOpenFile?: (path: string) => void;
  onClose(): void;
}

/** Whether a file shows T3's explorer beside it, kept on this device (T3's `fileExplorerOpen`). */
const EXPLORER_KEY = "jhin:file-explorer-open";

function readExplorerOpen(): boolean {
  try {
    return localStorage.getItem(EXPLORER_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * T3's OpenInPicker of the file panel (D1429): the preferred editor, and the others in a menu.
 * A thread's worktree has none: editors open a project folder's files only (terminal.md D965).
 */
function OpenInEditor(props: { target: NodeTarget; projectId: string; path: string }) {
  const chat = useChat();
  const [editors, setEditors] = useState<readonly EditorInfo[] | undefined>(undefined);
  const node = targetKey(props.target);
  useEffect(() => {
    let current = true;
    chat.threads.call<{ editors: EditorInfo[] }>(props.target, "editors.list", {}).then(
      (listed) =>
        current && setEditors(listed.editors.filter((editor) => editor.id !== "file-manager")),
      // A node without the editors plugin opens nothing.
      () => current && setEditors([]),
    );
    return () => {
      current = false;
    };
  }, [node]);
  if (editors === undefined || editors.length === 0) return null;
  const preferred = preferredEditor(editors);
  const open = (editor: EditorInfo | undefined) => {
    if (editor === undefined) return;
    rememberEditor(editor.id);
    void chat.threads
      .call(props.target, "editors.open", {
        projectId: props.projectId,
        path: props.path,
        editor: editor.id,
      })
      .catch((error: unknown) =>
        chat.toasts?.show({
          type: "error",
          title: "Unable to open in editor",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  };
  return (
    <div aria-label="Open in editor" className="flex shrink-0 items-center" role="group">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Open file in preferred editor"
              onClick={() => open(preferred)}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <SquareArrowOutUpRightIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open in {preferred?.label ?? "editor"}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger render={<Button aria-label="Choose editor" size="icon-xs" variant="ghost" />}>
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          {editors.map((editor) => (
            <MenuItem key={editor.id} onClick={() => open(editor)}>
              Open in {editor.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** A sent message's file as a surface of the right panel (D1435), T3's `attachment:<id>`. */
export function AttachmentPanel(props: {
  readonly target: NodeTarget;
  readonly attachment: StoredAttachment;
}) {
  const loader = useAttachmentLoader(props.target);
  return (
    <section aria-label="File preview" className="flex min-h-0 flex-1 flex-col" data-file-panel>
      <AttachmentFilePreview
        loader={loader}
        mimeType={props.attachment.mimeType}
        name={props.attachment.name}
        origin="Attachment"
        sizeBytes={props.attachment.sizeBytes}
        stored={props.attachment}
      />
    </section>
  );
}

/** The right panel's `files` surface: T3's explorer of the project, or the thread's worktree. */
export function FilesPanel(props: {
  readonly target: NodeTarget;
  readonly threadId: string | undefined;
  readonly projectId: string | undefined;
  onOpenFile(path: string): void;
}) {
  const chat = useChat();
  const catalog = useCatalog(chat.threads, props.target);
  const record =
    props.threadId === undefined
      ? undefined
      : catalog?.threads.find((thread) => thread.id === props.threadId);
  const projectId = props.projectId ?? record?.projectId;
  const project = catalog?.projects.find((candidate) => candidate.id === projectId);
  return (
    <section aria-label="Files" className="flex min-h-0 flex-1 flex-col" data-files-panel="">
      {projectId === undefined || project === undefined ? (
        catalog === undefined ? (
          <FileSurfaceLoading />
        ) : (
          <FileSurfaceFailure message="This thread's project is not available." />
        )
      ) : (
        <FileExplorer
          key={`${targetKey(props.target)}|${projectId}|${props.threadId ?? ""}`}
          onOpenFile={props.onOpenFile}
          projectName={project.name}
          selectedPath={null}
          source={{
            threads: chat.threads,
            target: props.target,
            projectId,
            ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
          }}
        />
      )}
    </section>
  );
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
  const [explorerOpen, setExplorerOpen] = useState(readExplorerOpen);
  // T3 edits a project's file in place, in the right panel (D1438).
  const editable = props.embedded === true && projectId !== undefined;
  // A line asked for by a link to it (D1430).
  const reveal = useSyncExternalStore(chat.fileReveals.subscribe, () =>
    chat.fileReveals.get(
      revealKey(
        {
          target: props.target,
          ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
          ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
        },
        props.path,
      ),
    ),
  );
  const showExplorer =
    props.embedded === true &&
    props.onOpenFile !== undefined &&
    explorerOpen &&
    projectId !== undefined &&
    project !== undefined;
  const openIn =
    props.embedded === true && projectId !== undefined && record?.worktreePath === undefined ? (
      <OpenInEditor path={props.path} projectId={projectId} target={props.target} />
    ) : null;
  const explorerToggle =
    props.embedded === true && props.onOpenFile !== undefined ? (
      <FileSurfaceAction
        label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
        onPress={() => {
          const next = !explorerOpen;
          setExplorerOpen(next);
          try {
            localStorage.setItem(EXPLORER_KEY, String(next));
          } catch {
            // Blocked storage: for this panel only.
          }
        }}
        pressed={explorerOpen}
      >
        <FolderTreeIcon className="size-3.5" />
      </FileSurfaceAction>
    ) : null;
  // T3's explorer beside the file, the file selected in it.
  const explorer = showExplorer ? (
    <aside className="flex min-h-0 w-[min(22rem,46%)] min-w-64 shrink-0 border-l border-border/60 bg-background">
      <FileExplorer
        key={`${targetKey(props.target)}|${projectId}|${props.threadId ?? ""}`}
        onOpenFile={props.onOpenFile!}
        projectName={project.name}
        selectedPath={props.path}
        source={{
          threads: chat.threads,
          target: props.target,
          projectId,
          ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
        }}
      />
    </aside>
  ) : undefined;
  const body =
    projectId === undefined ? (
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
          <code className="block break-all font-mono text-foreground select-all">{props.path}</code>
        </p>
      </div>
    ) : (
      <AttachmentFilePreview
        actions={
          <>
            {openIn}
            {explorerToggle}
          </>
        }
        aside={explorer}
        file={shown.file.file}
        renderSource={
          editable
            ? (source) => (
                <FileEditor
                  comment={(record) => chat.composer.current?.insertContext(record) === "inserted"}
                  name={name}
                  onSaveError={(error) =>
                    chat.toasts?.show({
                      type: "error",
                      title: "Unable to save file",
                      description: error instanceof Error ? error.message : String(error),
                    })
                  }
                  path={props.path}
                  reveal={reveal}
                  save={(contents) =>
                    chat.threads
                      .call(props.target, "projects.write-file", {
                        projectId,
                        ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
                        path: props.path,
                        contents,
                      })
                      .then(() => undefined)
                  }
                  text={source.text}
                  uncomment={(contextId) => void chat.composer.current?.removeContext(contextId)}
                  wordWrap={source.wordWrap}
                />
              )
            : undefined
        }
        reveal={reveal}
        key={key}
        mimeType=""
        name={name}
        sizeBytes={shown.file.sizeBytes}
        trail={trail}
      />
    );
  if (props.embedded === true) {
    return (
      <section aria-label="File preview" className="flex min-h-0 flex-1 flex-col" data-file-panel>
        {body}
      </section>
    );
  }
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
      {body}
    </aside>
  );
}
