// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: the node views of
// apps/web/src/components/ComposerPromptEditorTiptap.tsx (ComposerMentionNodeView,
// ComposerSkillNodeView), apps/web/src/components/chat/FileTagChip.tsx,
// apps/web/src/components/chat/SkillInlineText.tsx (SkillChipIcon) and
// apps/web/src/components/ThreadContextChip.tsx.
//
// The prompt's chips as T3 draws them (t3-parity.md D1002–D1005): a file with its icon, a skill
// with its description and "View instructions", a pull request and a thread. The document keeps
// the chip's source; these only show it.
import {
  type AgentSkill,
  formatAssistantCitationHref,
  type MessageContextRecord,
  parseAssistantCitationHref,
  parseContextHref,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@jhin/agent-api";
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
import { GitPullRequestIcon, MessagesSquareIcon } from "lucide-react";
import { createContext, type ReactNode, use, useRef, useState } from "react";

import { revealAssistantCitation } from "../../lib/assistant-text-selection.ts";
import { citationSource, threadLinks } from "../../lib/composer-context.ts";
import { skillDisplayName } from "../../lib/composer-menu.ts";
import { AttachmentPreviewDialog } from "./attachment-media.tsx";
import { ComposerCitationChip } from "./citation-chips.tsx";
import { type ContextChipActions, ContextRecordChip } from "./context-chips.tsx";
import { openFilePanel } from "./file-panel-route.ts";
import { basename, FileMentionChip, SkillChipIcon } from "./file-chips.tsx";
import { isTooLarge, readPreviewFile } from "./preview-file.ts";
import { useChat } from "./services.ts";

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

/** A file or folder: its Pierre icon and basename; pressed, its preview (T3's mention chip). */
export function MentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerChipsContext);
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <FileMentionChip
        contentEditable={false}
        onPreview={actions.previewFile}
        path={String(node.attrs["path"] ?? "")}
      />
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
export function ReferenceNodeView({ node, editor, getPos }: NodeViewProps) {
  const actions = use(ComposerChipsContext);
  const kind = String(node.attrs["kind"] ?? "thread");
  const label = String(node.attrs["label"] ?? "");
  const href = String(node.attrs["href"] ?? "");
  const citation = kind === "citation" ? parseAssistantCitationHref(href) : null;
  if (citation !== null) {
    // T3's onSaveComment: the atom's link is written again with the comment in it.
    const comment = (text: string) => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (!editor.isEditable || typeof pos !== "number") return;
      const next = withAssistantCitationComment(citation, text);
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          href: formatAssistantCitationHref(next),
          source: serializeAssistantCitation(next),
        }),
      );
    };
    return (
      <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME} contentEditable={false}>
        <ComposerCitationChip
          citation={citation}
          onComment={editor.isEditable ? comment : undefined}
          showSource={actions.showCitationSource}
        />
      </NodeViewWrapper>
    );
  }
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

/**
 * The composer's chip actions on its node: a file previewed in the file panel (D1342), a skill's
 * SKILL.md in D854's dialog, a thread opened, a pull request in the browser.
 */
export function useComposerChipActions(options: {
  readonly target: NodeTarget;
  readonly projectId: string | undefined;
  /** The composer's thread; without it, a draft of the project. */
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
  const open = (origin: string, name: string, input: Record<string, unknown>) => {
    const request = ++latest.current;
    readPreviewFile(chat.threads, target, name, "agents.skill.read", input).then(
      (read) => {
        if (request !== latest.current) return;
        setShown({ name, ...read, origin });
      },
      (error: unknown) => {
        if (request !== latest.current) return;
        chat.toasts?.show(
          isTooLarge(error)
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
  const links = threadLinks(
    { target, nodeId: options.nodeId, selfNodeId: options.selfNodeId },
    (at) => chat.threads.catalog(at),
    (route) => chat.navigation.navigate(route),
  );
  const actions: ComposerChipActions = {
    skills: options.skills,
    records: options.records,
    ...links,
    showCitationSource: citationSource(links, (citation) =>
      revealAssistantCitation(document, citation),
    ),
    // T3's right-hand file panel (D1342), beside the thread or draft on screen.
    previewFile:
      projectId === undefined
        ? undefined
        : (path) =>
            openFilePanel(
              chat.navigation,
              {
                target,
                ...(options.threadId === undefined
                  ? { projectId }
                  : { threadId: options.threadId }),
              },
              path,
            ),
    viewInstructions:
      projectId === undefined
        ? undefined
        : (skill) =>
            open("Skill", basename(skill.path) || "SKILL.md", {
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
