// The context records of the message being rendered (t3-parity.md D1007), for the markdown's
// `jhin-context://` links: kept apart from the chips so the entry chunk does not load them.
import type { MessageContextRecord } from "@jhin/agent-api";
import { createContext } from "react";

import type { ContextChipActions } from "./context-chips.tsx";

export interface MessageContextChips {
  readonly records: ReadonlyMap<string, MessageContextRecord>;
  readonly actions: ContextChipActions;
}

/** Without it, a reference renders as its label. */
export const MessageContextChipsContext = createContext<MessageContextChips | undefined>(undefined);
