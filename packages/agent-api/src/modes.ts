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

/**
 * Grants that name the runtime modes a caller's turns may run in
 * (security.md D1370): `threads.mode.approval-required` and so on.
 */
export const RUNTIME_MODE_GRANT_PREFIX = "threads.mode.";

/**
 * The most a caller with `grants` may run a turn with: the highest mode its
 * grants name explicitly, or undefined (no ceiling) when they name none.
 * An explicit mode wins over a pattern that covers more (`threads.*`,
 * `threads.mode.*`, `*`): a ceiling is a limit, so a grant beside it never
 * lifts it.
 */
export function ceilingOf(grants: readonly string[] | undefined): RuntimeMode | undefined {
  if (grants === undefined) return undefined;
  // RUNTIME_MODES runs from the narrowest to the broadest (modes.test.ts pins it).
  const named = RUNTIME_MODES.filter((mode) =>
    grants.includes(`${RUNTIME_MODE_GRANT_PREFIX}${mode}`),
  );
  return named.at(-1);
}

/** `mode`, lowered to `ceiling` when it is above it. */
export function capRuntimeMode(mode: RuntimeMode, ceiling: RuntimeMode | undefined): RuntimeMode {
  if (ceiling === undefined) return mode;
  return RUNTIME_MODES.indexOf(mode) > RUNTIME_MODES.indexOf(ceiling) ? ceiling : mode;
}
