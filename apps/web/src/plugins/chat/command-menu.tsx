// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ComposerCommandMenu.tsx
// at eb7b35ac (the rows, their wording, the empty and loading states, a pull request's state
// icon and a thread's icon). T3 builds it on its
// Command list; here it is a plain listbox the editor drives with the arrow keys.
import { cn } from "@jhin/ui";
import {
  FileIcon,
  FolderIcon,
  MessagesSquareIcon,
  SparklesIcon,
  SquareSlashIcon,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import {
  composerSuggestionOptionId,
  skillDisplayName,
  type ComposerMenuItem,
} from "../../lib/composer-menu.ts";
import { resolvePullRequestState } from "../../lib/pull-request.ts";
import { ComposerBanner } from "./banner.tsx";

export type MenuTrigger = "slash-command" | "skill" | "path" | "pull-request";

const LISTBOX_LABEL_BY_TRIGGER: Record<MenuTrigger, string> = {
  path: "Files and folders",
  "pull-request": "Pull requests",
  "slash-command": "Commands",
  skill: "Skills",
};

const SCOPE_LABEL: Record<string, string> = { user: "Personal", project: "Project" };

export function ComposerCommandMenu(props: {
  readonly listId: string;
  readonly items: readonly ComposerMenuItem[];
  readonly isLoading: boolean;
  readonly trigger: MenuTrigger;
  readonly activeItemId: string | null;
  /** What it says with no rows once loaded, when the trigger has its own words (`#`). */
  readonly emptyStateText?: string | undefined;
  onHighlight(itemId: string | null): void;
  onSelect(item: ComposerMenuItem): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (props.activeItemId === null || listRef.current === null) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <ComposerBanner.Surface
      className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap)"
      data-composer-command-drawer="true"
      ref={listRef}
    >
      {props.items.length > 0 ? (
        <div
          aria-label={LISTBOX_LABEL_BY_TRIGGER[props.trigger]}
          className="max-h-72 min-h-0 overflow-y-auto p-1.5"
          id={props.listId}
          role="listbox"
        >
          {props.items.map((item) => {
            const active = props.activeItemId === item.id;
            return (
              <div
                aria-selected={active}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5",
                  active && "bg-accent text-accent-foreground",
                )}
                data-composer-item-id={item.id}
                id={composerSuggestionOptionId(props.listId, item.id)}
                key={item.id}
                onClick={() => props.onSelect(item)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!active) props.onHighlight(item.id);
                }}
                role="option"
              >
                {item.type === "pull-request" ? (
                  <PullRequestStateIcon pullRequest={item.pullRequest} />
                ) : item.type === "thread" ? (
                  <MessagesSquareIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                ) : item.type === "path" ? (
                  item.pathKind === "directory" ? (
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  )
                ) : item.type === "skill" ? (
                  <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <SquareSlashIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
                    {props.trigger === "slash-command" && item.type === "skill" ? (
                      <>
                        <span className="text-muted-foreground">/skill:</span>
                        {skillDisplayName(item.skill)}
                      </>
                    ) : (
                      item.label
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-muted-foreground text-xs">
                    {item.description}
                  </span>
                  {item.type === "skill" && item.skill.scope !== undefined ? (
                    <span className="shrink-0 rounded border border-border px-1 text-2xs text-muted-foreground">
                      {`${SCOPE_LABEL[item.skill.scope] ?? "Provider"}${props.trigger === "skill" ? " Skill" : ""}`}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-5 pt-3.5 pb-7" role="status">
          <p className="text-muted-foreground text-xs">
            {props.isLoading
              ? props.trigger === "skill"
                ? "Searching workspace skills..."
                : props.trigger === "pull-request"
                  ? "Finding pull request..."
                  : "Searching workspace files..."
              : (props.emptyStateText ??
                (props.trigger === "skill"
                  ? "No skills found. Try / to browse provider commands."
                  : props.trigger === "path"
                    ? "No matching files or folders."
                    : "No matching command."))}
          </p>
        </div>
      )}
    </ComposerBanner.Surface>
  );
}

/** A pull request's state as T3 shows it in the row: its glyph in the state's tone, named. */
function PullRequestStateIcon(props: {
  readonly pullRequest: Extract<ComposerMenuItem, { type: "pull-request" }>["pullRequest"];
}) {
  const presentation = resolvePullRequestState(props.pullRequest);
  return (
    <presentation.Icon
      aria-label={presentation.label}
      className={cn("size-4 shrink-0", presentation.toneClassName)}
      role="img"
    />
  );
}
