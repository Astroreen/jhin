// T3 Code's apps/web/src/components/chat/threadDetailsPanelStyles.ts (MIT, see
// THIRD_PARTY_NOTICES.md): the rows of the thread details panel, shared by the sections
// plugins contribute to `chat.thread.details` (t3-parity.md D802).
export const HOVER_SURFACE =
  "hover:!bg-black/[0.035] data-pressed:!bg-black/[0.035] dark:hover:!bg-white/[0.08] dark:data-pressed:!bg-white/[0.08]";
export const ROW_CONTENT = "gap-2.5 px-2.5 text-left";
export const CONTROL = `h-8 min-w-0 rounded-lg border-transparent ${ROW_CONTENT} text-[13px] font-medium text-foreground/80`;
export const CONTROL_BASE =
  "relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border outline-none transition-[box-shadow,scale] [&:active]:scale-[0.97] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-default aria-disabled:opacity-64";
export const ROW = `${CONTROL_BASE} ${CONTROL} w-full justify-start bg-transparent shadow-none ${HOVER_SURFACE}`;
export const SPLIT_GROUP = `flex w-full items-center rounded-lg ${HOVER_SURFACE}`;
export const SPLIT_PRIMARY = `${CONTROL_BASE} ${CONTROL} flex-1 justify-start rounded-e-none bg-transparent shadow-none ${HOVER_SURFACE}`;
export const SPLIT_SECONDARY = `${CONTROL_BASE} ${CONTROL} w-8 justify-center rounded-s-none px-0 bg-transparent shadow-none ${HOVER_SURFACE}`;
export const SPLIT_SEPARATOR = "h-4 w-px shrink-0 bg-border/65";
/** A row's icon action (T3's `THREAD_DETAILS_PANEL_ICON_ACTION_CLASS`). */
export const ICON_ACTION = `${CONTROL_BASE} size-6 justify-center rounded-md border-transparent bg-transparent p-0 shadow-none ${HOVER_SURFACE}`;
/** A row's meta action, the pull request's second line (T3's `…_META_ACTION_CLASS`). */
export const META_ACTION = `${CONTROL_BASE} h-6 gap-1 rounded-md border-transparent px-1.5 text-xs font-medium text-muted-foreground bg-transparent shadow-none ${HOVER_SURFACE}`;
