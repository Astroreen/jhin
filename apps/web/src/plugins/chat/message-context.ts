// The context records of the message being rendered (t3-parity.md D1007), for the markdown's
// `jhin-context://` links: kept apart from the chips so the entry chunk does not load them.
import type { AgentSkill, MessageContextRecord } from "@jhin/agent-api";
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
  readonly previewFile?: ((path: string) => void) | undefined;
}

/** Without it, a reference renders as its label. */
export const MessageContextChipsContext = createContext<MessageContextChips | undefined>(undefined);
