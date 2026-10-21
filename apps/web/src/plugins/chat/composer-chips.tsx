// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: the node views of
// apps/web/src/components/ComposerPromptEditorTiptap.tsx (ComposerMentionNodeView,
// ComposerSkillNodeView), apps/web/src/components/chat/FileTagChip.tsx,
// apps/web/src/components/chat/SkillInlineText.tsx (SkillChipIcon) and
// apps/web/src/components/ThreadContextChip.tsx.
//
// The prompt's chips as T3 draws them (t3-parity.md D1002–D1005): a file with its icon, a skill
// with its description and "View instructions", a pull request and a thread. The document keeps
// the chip's source; these only show it.
import { type AgentSkill, type MessageContextRecord, parseContextHref } from "@jhin/agent-api";
import type { NodeTarget } from "@jhin/client-api";
import {
  Button,
  ContextChip,
  ContextChipLabel,
  ContextChipPopover,
  PopoverClose,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { BoxIcon, GitPullRequestIcon, MessagesSquareIcon } from "lucide-react";
import { createContext, type ReactNode, use, useRef, useState } from "react";

import { threadLinks } from "../../lib/composer-context.ts";
import { skillDisplayName } from "../../lib/composer-menu.ts";
import { FILE_TEXT_PREVIEW_MAX_BYTES, filePreviewKind } from "../../lib/file-preview.ts";
import { AttachmentPreviewDialog } from "./attachment-media.tsx";
import { type ContextChipActions, ContextRecordChip } from "./context-chips.tsx";
import { useChat } from "./services.ts";
import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";

/** What the composer lets its chips do; without it they only show. */
export interface ComposerChipActions extends ContextChipActions {
  /** The prompt's context records by id (D1006): what its `jhin-context://` references name. */
  readonly records?: ReadonlyMap<string, MessageContextRecord> | undefined;
  /** The agent's skills, for a skill chip's name and description. */
  readonly skills: readonly AgentSkill[];
  /** Opens a mentioned file's preview (T3's openMention). */
  readonly previewFile?: ((path: string) => void) | undefined;
  /** Opens a skill's instructions (T3's "View instructions"). */
  readonly viewInstructions?: ((skill: AgentSkill) => void) | undefined;
}

export const ComposerChipsContext = createContext<ComposerChipActions>({ skills: [] });

/** T3's chip selection: the browser's highlight over a selected chip. */
const CHIP_NODE_SELECTION_CLASS_NAME =
  "relative inline-flex select-none items-center align-middle leading-none [.ProseMirror-selectednode>&]:after:pointer-events-none [.ProseMirror-selectednode>&]:after:absolute [.ProseMirror-selectednode>&]:after:inset-0 [.ProseMirror-selectednode>&]:after:rounded-sm [.ProseMirror-selectednode>&]:after:bg-[Highlight] [.ProseMirror-selectednode>&]:after:opacity-30 [.ProseMirror-selectednode>&]:after:content-['']";

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/** T3's SkillChipIcon: lucide's box, a little bolder. */
function SkillChipIcon() {
  return <BoxIcon aria-hidden strokeWidth={1.85} />;
}

/** A file or folder: its Pierre icon and basename; pressed, its preview (T3's mention chip). */
export function MentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerChipsContext);
  const theme = useResolvedTheme();
  const path = String(node.attrs["path"] ?? "");
  const folder = /[\\/]$/.test(path);
  const content = (
    <>
      <PierreEntryIcon kind={folder ? "directory" : "file"} pathValue={path} theme={theme} />
      <ContextChipLabel>{basename(path)}</ContextChipLabel>
    </>
  );
  const preview = folder ? undefined : actions.previewFile;
  const chip =
    preview === undefined ? (
      <ContextChip contentEditable={false} kind="mention" spellCheck={false} tabIndex={0}>
        {content}
      </ContextChip>
    ) : (
      <ContextChip
        aria-label={`Preview ${path}`}
        contentEditable={false}
        kind="mention"
        onClick={() => preview(path)}
        render={<button type="button" />}
        spellCheck={false}
      >
        {content}
      </ContextChip>
    );
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top">{path}</TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}

/** A skill: its name; pressed, its description and "View instructions" (T3's skill chip). */
export function SkillNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerChipsContext);
  const name = String(node.attrs["name"] ?? "");
  const skill = actions.skills.find((candidate) => candidate.name === name);
  const label = skillDisplayName(skill ?? { name });
  const viewInstructions = skill === undefined ? undefined : actions.viewInstructions;
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME} contentEditable={false}>
      <ContextChipPopover
        accessibleLabel={`Skill ${label}`}
        icon={<SkillChipIcon />}
        kind="skill"
        label={label}
      >
        <div className="space-y-3 p-2 text-sm">
          <p className="font-medium">{label}</p>
          <p>{skill?.description?.trim() || "No description is available for this skill."}</p>
          {viewInstructions !== undefined && skill !== undefined ? (
            // Closes the popover first, so the instructions' dialog is not under it.
            <PopoverClose
              onClick={() => viewInstructions(skill)}
              render={<Button size="sm" variant="outline" />}
            >
              View instructions
            </PopoverClose>
          ) : null}
        </div>
      </ContextChipPopover>
    </NodeViewWrapper>
  );
}

/** A pull request (`[#12](url)`) or a thread (`[title](jhin://…)`), by its label. */
export function ReferenceNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerChipsContext);
  const kind = String(node.attrs["kind"] ?? "thread");
  const label = String(node.attrs["label"] ?? "");
  const href = String(node.attrs["href"] ?? "");
  if (kind === "context") {
    const reference = parseContextHref(href);
    return (
      <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME} contentEditable={false}>
        <ContextRecordChip
          actions={actions}
          href={href}
          label={label}
          record={reference === null ? undefined : actions.records?.get(reference.contextId)}
          unavailable="This context is no longer available. Remove it or attach it again."
        />
      </NodeViewWrapper>
    );
  }
  const thread = kind === "thread";
  // A chip that cannot open is no button: a thread of a node out of reach, a link of no web page.
  const open = thread
    ? actions.openThread !== undefined && actions.canOpenThread?.(href) === true
      ? () => actions.openThread?.(href)
      : undefined
    : actions.openUrl !== undefined && /^https?:\/\//i.test(href)
      ? () => actions.openUrl?.(href)
      : undefined;
  const content = (
    <>
      {thread ? <MessagesSquareIcon /> : <GitPullRequestIcon />}
      <ContextChipLabel>{label}</ContextChipLabel>
    </>
  );
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME} contentEditable={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            open === undefined ? (
              <ContextChip
                aria-label={thread ? `Thread, ${label}` : `Pull request ${label}`}
                kind={thread ? "thread" : "pull-request"}
                spellCheck={false}
                tabIndex={0}
              >
                {content}
              </ContextChip>
            ) : (
              <ContextChip
                aria-label={thread ? `Thread, ${label}` : `Open pull request ${label}`}
                kind={thread ? "thread" : "pull-request"}
                onClick={open}
                render={<button type="button" />}
                spellCheck={false}
              >
                {content}
              </ContextChip>
            )
          }
        />
        <TooltipPopup side="top">
          {thread ? (open === undefined ? "Thread no longer available" : "Open thread") : href}
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}

/** What `projects.read-file` and `agents.skill.read` answer. */
interface FileHead {
  readonly path: string;
  readonly sizeBytes: number;
  readonly data: string;
  readonly truncated: boolean;
}

/** Media is shown whole, up to a video's 50 MB (D855); text only its first MiB, as D854. */
const MEDIA_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The composer's chip actions on its node: a file previewed in D854's dialog (T3 opens it in its
 * file panel), a skill's SKILL.md the same way, a thread opened, a pull request in the browser.
 */
export function useComposerChipActions(options: {
  readonly target: NodeTarget;
  readonly projectId: string | undefined;
  readonly threadId: string | undefined;
  readonly agentId: string | undefined;
  /** The id of the composer's node, which a thread's `jhin://` address names. */
  readonly nodeId: string | undefined;
  /** The id of the node the client is connected to; another one is reached as its remote. */
  readonly selfNodeId: string | undefined;
  readonly skills: readonly AgentSkill[];
  readonly records: ReadonlyMap<string, MessageContextRecord>;
}): { actions: ComposerChipActions; dialog: ReactNode } {
  const chat = useChat();
  const [shown, setShown] = useState<
    { name: string; sizeBytes: number; file: Blob; origin: string } | undefined
  >();
  /** The latest preview asked for: an earlier one that answers late is not shown over it. */
  const latest = useRef(0);
  const { target, projectId } = options;
  const open = (origin: string, name: string, method: string, input: Record<string, unknown>) => {
    const media = ["image", "video", "audio", "pdf"].includes(filePreviewKind({ name }));
    // Media whole or not at all, refused on the node before it is read; text its first MiB, one
    // byte past it telling the dialog the text was cut.
    const limit = media
      ? { maxBytes: MEDIA_PREVIEW_MAX_BYTES, whole: true }
      : { maxBytes: FILE_TEXT_PREVIEW_MAX_BYTES + 1 };
    const request = ++latest.current;
    chat.threads.call<FileHead>(target, method, { ...input, ...limit }).then(
      (head) => {
        if (request !== latest.current) return;
        setShown({
          name,
          sizeBytes: head.sizeBytes,
          file: new Blob([decodeBase64(head.data)]),
          origin,
        });
      },
      (error: unknown) => {
        if (request !== latest.current) return;
        chat.toasts?.show(
          (error as { code?: unknown } | null)?.code === "FILE_TOO_LARGE"
            ? { type: "error", title: `${name} is too large to preview` }
            : {
                type: "error",
                title: `Could not open ${name}`,
                description: error instanceof Error ? error.message : String(error),
              },
        );
      },
    );
  };
  const actions: ComposerChipActions = {
    skills: options.skills,
    records: options.records,
    ...threadLinks(
      { target, nodeId: options.nodeId, selfNodeId: options.selfNodeId },
      (at) => chat.threads.catalog(at),
      (route) => chat.navigation.navigate(route),
    ),
    previewFile:
      projectId === undefined
        ? undefined
        : (path) =>
            open("Workspace", basename(path), "projects.read-file", {
              projectId,
              ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
              path,
            }),
    viewInstructions:
      projectId === undefined
        ? undefined
        : (skill) =>
            open("Skill", basename(skill.path) || "SKILL.md", "agents.skill.read", {
              projectId,
              ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
              name: skill.name,
            }),
    openUrl: (url) => {
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    },
  };
  const dialog =
    shown === undefined ? null : (
      <AttachmentPreviewDialog
        file={shown.file}
        mimeType=""
        name={shown.name}
        onClose={() => {
          // A preview still on its way when the dialog closes does not open it again.
          latest.current += 1;
          setShown(undefined);
        }}
        origin={shown.origin}
        sizeBytes={shown.sizeBytes}
      />
    );
  return { actions, dialog };
}

/** Base64 to bytes: the browser's own decoder where it has one, else in one pass. */
function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> })
    .fromBase64;
  if (native !== undefined) return native(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
