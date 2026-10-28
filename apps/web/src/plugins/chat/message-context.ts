// The context records of the message being rendered (t3-parity.md D1007), for the markdown's
// `jhin-context://` links: kept apart from the chips so the entry chunk does not load them.
import type { AgentSkill, MessageContextRecord } from "@jhin/agent-api";
import type { EditorInfo } from "@jhin/host-api";
import { createContext } from "react";

import type { ContextChipActions } from "./context-chips.tsx";

export interface MessageContextChips {
  readonly records: ReadonlyMap<string, MessageContextRecord>;
  readonly actions: ContextChipActions;
  /** The thread agent's skills: a `$name` of one is its chip (D1341). */
  readonly skills?: readonly AgentSkill[] | undefined;
  /** Opens a mentioned file in the file panel (D1342); without it a file's chip only shows. */
  readonly previewFile?: ((path: string) => void) | undefined;
}

/** What the thread view gives its messages' file and skill chips (D1341). */
export interface MessageFileChips {
  readonly skills?: readonly AgentSkill[] | undefined;
  /** Opens a file of the project in the right panel, at a line when one is named (D1430). */
  readonly previewFile?: ((path: string, line?: number) => void) | undefined;
  /** The folder the thread's files are in (its worktree, else its project's), for an agent's links. */
  readonly workspaceRoot?: string | undefined;
  /** The node's editors, for an agent's file chip's "Open in <editor>" (D1643). */
  readonly editors?: readonly EditorInfo[] | undefined;
  /** Opens a file of the thread in an editor, at its line and column (D1643, D1644). */
  readonly openInEditor?: OpenInEditor | undefined;
  /** Copies a file chip's path, saying so (T3's `handleCopy`, D1643). */
  readonly copyPath?: CopyPath | undefined;
}

type OpenInEditor = (
  path: string,
  editor: EditorInfo,
  position: { readonly line?: number; readonly column?: number },
) => void;

type CopyPath = (value: string, title: "Relative path" | "Full path") => void;

/** An agent's message: its links and inline code that name a project's file are chips (D1431). */
export interface AgentFileLinks {
  readonly workspaceRoot: string;
  open(path: string, line?: number): void;
  /** The parent folder suffixes of the message's files that share a name (T3's, D1643). */
  readonly parentSuffixes: ReadonlyMap<string, string>;
  readonly editors: readonly EditorInfo[];
  readonly openInEditor?: OpenInEditor | undefined;
  readonly copyPath?: CopyPath | undefined;
}

/** Without it, an agent's file links stay links. */
export const AgentFileLinksContext = createContext<AgentFileLinks | undefined>(undefined);

/** Without it, a reference renders as its label. */
export const MessageContextChipsContext = createContext<MessageContextChips | undefined>(undefined);
