// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: the node views of
// apps/web/src/components/ComposerPromptEditorTiptap.tsx (ComposerMentionNodeView,
// ComposerSkillNodeView), apps/web/src/components/chat/FileTagChip.tsx,
// apps/web/src/components/chat/SkillInlineText.tsx (SkillChipIcon) and
// apps/web/src/components/ThreadContextChip.tsx.
//
// The prompt's chips as T3 draws them (t3-parity.md D1002–D1005): a file with its icon, a skill
// with its description and "View instructions", a pull request and a thread. The document keeps
// the chip's source; these only show it.
import type { AgentSkill } from "@jhin/agent-api";
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
import { createContext, type ReactNode, use, useState } from "react";

import { skillDisplayName } from "../../lib/composer-menu.ts";
import { FILE_TEXT_PREVIEW_MAX_BYTES, filePreviewKind } from "../../lib/file-preview.ts";
import { AttachmentPreviewDialog } from "./attachment-media.tsx";
import { useChat } from "./services.ts";
import { PierreEntryIcon } from "../../lib/pierre-entry-icon.tsx";
import { useResolvedTheme } from "../../lib/resolved-theme.ts";

/** What the composer lets its chips do; without it they only show. */
export interface ComposerChipActions {
  /** The agent's skills, for a skill chip's name and description. */
  readonly skills: readonly AgentSkill[];
  /** Opens a mentioned file's preview (T3's openMention). */
  readonly previewFile?: ((path: string) => void) | undefined;
  /** Opens a skill's instructions (T3's "View instructions"). */
  readonly viewInstructions?: ((skill: AgentSkill) => void) | undefined;
  /** Opens a linked thread, when it is one this composer's node can show. */
  readonly openThread?: ((href: string) => boolean) | undefined;
  readonly openUrl?: ((url: string) => void) | undefined;
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
  const thread = kind === "thread";
  const open = thread
    ? actions.openThread === undefined
      ? undefined
      : () => actions.openThread?.(href)
    : actions.openUrl === undefined
      ? undefined
      : () => actions.openUrl?.(href);
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME} contentEditable={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextChip
              aria-label={thread ? `Thread, ${label}` : `Open pull request ${label}`}
              kind={thread ? "thread" : "pull-request"}
              onClick={open}
              render={<button type="button" />}
              spellCheck={false}
            >
              {thread ? <MessagesSquareIcon /> : <GitPullRequestIcon />}
              <ContextChipLabel>{label}</ContextChipLabel>
            </ContextChip>
          }
        />
        <TooltipPopup side="top">{thread ? "Open thread" : href}</TooltipPopup>
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
  readonly skills: readonly AgentSkill[];
}): { actions: ComposerChipActions; dialog: ReactNode } {
  const chat = useChat();
  const [shown, setShown] = useState<
    { name: string; sizeBytes: number; file: Blob; origin: string } | undefined
  >();
  const { target, projectId } = options;
  const open = (origin: string, name: string, method: string, input: Record<string, unknown>) => {
    const media = ["image", "video", "audio", "pdf"].includes(filePreviewKind({ name }));
    // One byte past the MiB tells the dialog the text was cut.
    const maxBytes = media ? MEDIA_PREVIEW_MAX_BYTES : FILE_TEXT_PREVIEW_MAX_BYTES + 1;
    chat.threads.call<FileHead>(target, method, { ...input, maxBytes }).then(
      (head) => {
        if (media && head.truncated) {
          chat.toasts?.show({ type: "error", title: `${name} is too large to preview` });
          return;
        }
        const bytes = Uint8Array.from(atob(head.data), (character) => character.charCodeAt(0));
        setShown({ name, sizeBytes: head.sizeBytes, file: new Blob([bytes]), origin });
      },
      (error: unknown) =>
        chat.toasts?.show({
          type: "error",
          title: `Could not open ${name}`,
          description: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  const actions: ComposerChipActions = {
    skills: options.skills,
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
    openThread: (href) => {
      const match = /^jhin:\/\/([^/]+)\/threads\/([^/?#]+)$/.exec(href);
      if (match === null || options.nodeId === undefined || match[1] !== options.nodeId) {
        return false;
      }
      chat.navigation.navigate({
        node: target.node,
        ...(target.remote === undefined ? {} : { remote: target.remote }),
        thread: decodeURIComponent(match[2]!),
      });
      return true;
    },
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
        onClose={() => setShown(undefined)}
        origin={shown.origin}
        sizeBytes={shown.sizeBytes}
      />
    );
  return { actions, dialog };
}
