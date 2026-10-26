// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// packages/contracts/src/orchestrationV2.ts (OrchestrationV2ThreadLaunchWorkspaceStrategy).
import { z } from "@jhin/sdk";

/**
 * Where a new thread works (T3's three launch strategies, orchestration.md
 * D252, D983, D1513): the project checkout (`root`), a new worktree from
 * `baseRef`, or a checkout that is already there. One schema for
 * `threads.create`'s `workspace`, `orchestration.launch` and scheduled tasks.
 */
export const WorkspaceStrategy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("root"), branch: z.string().min(1).optional() }),
  z.object({
    type: z.literal("existing_worktree"),
    worktreePath: z.string().min(1),
    branch: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("worktree"),
    baseRef: z.string().min(1),
    branch: z.string().min(1).optional(),
    startFromOrigin: z.boolean().optional(),
  }),
]);
export type WorkspaceStrategy = z.output<typeof WorkspaceStrategy>;
