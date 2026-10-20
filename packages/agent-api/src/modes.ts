/**
 * How much an agent may do without asking, as in T3 Code:
 * - `approval-required` ("Supervised"): ask before commands and file changes;
 * - `auto-accept-edits`: approve file edits, ask before other actions;
 * - `full-access`: commands and edits run without prompts.
 */
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
/** The default when nobody chose one (T3 Code's default too). */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

/** `plan` asks the agent to propose a plan instead of changing anything. */
export const INTERACTION_MODES = ["default", "plan"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];
