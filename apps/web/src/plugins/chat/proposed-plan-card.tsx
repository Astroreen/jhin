// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ProposedPlanCard.tsx at eb7b35ac.
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  cn,
} from "@jhin/ui";
import { EllipsisIcon } from "lucide-react";
import { useContext, useId, useState } from "react";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  canCollapsePlan,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../lib/proposed-plan.ts";
import { useCopy } from "../../lib/hooks.ts";
import { MessageText } from "./message-text.tsx";
import { ChatContext } from "./services.ts";

/** Writes the plan into the thread's project (`projects.write-file`); resolves with the path written. */
export type SavePlan = (path: string, contents: string) => Promise<{ relativePath: string }>;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

export function ProposedPlanCard({
  planMarkdown,
  workspaceRoot,
  onSave,
}: {
  planMarkdown: string;
  /** The project folder, named in the save dialog. */
  workspaceRoot?: string;
  /** Absent where the plan cannot be saved (no project, or the node is not reachable). */
  onSave?: SavePlan;
}) {
  const toasts = useContext(ChatContext)?.toasts;
  const [expanded, setExpanded] = useState(false);
  const { copied, copy } = useCopy({
    onError: (error) =>
      toasts?.show({
        type: "error",
        title: "Could not copy plan",
        description: errorText(error) ?? "An error occurred while copying.",
      }),
  });
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  // The path last submitted, so reopening the dialog offers it again.
  const [lastSavePath, setLastSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const canCollapse = canCollapsePlan(planMarkdown);
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const isCollapsed = canCollapse && !expanded;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);
  const canSave = onSave !== undefined && workspaceRoot !== undefined;

  const handleCopyPlan = () => copy(saveContents);

  const openSaveDialog = () => {
    if (!canSave) {
      toasts?.show({
        type: "error",
        title: "Workspace path is unavailable",
        description: "This thread does not have a workspace path to save into.",
      });
      return;
    }
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = (savePath: string) => {
    const relativePath = savePath.trim();
    if (onSave === undefined) return;
    if (!relativePath) {
      toasts?.show({ type: "warning", title: "Enter a workspace path" });
      return;
    }
    setLastSavePath(savePath);
    setIsSavingToWorkspace(true);
    onSave(relativePath, saveContents).then(
      (result) => {
        setIsSavingToWorkspace(false);
        setIsSaveDialogOpen(false);
        toasts?.show({
          type: "success",
          title: "Plan saved to workspace",
          description: result.relativePath,
        });
      },
      (error: unknown) => {
        setIsSavingToWorkspace(false);
        toasts?.show({
          type: "error",
          title: "Could not save plan",
          description: errorText(error) ?? "An error occurred while saving.",
        });
      },
    );
  };

  return (
    <div
      aria-label={title}
      className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5"
      data-proposed-plan
      role="article"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem closeOnClick={false} onClick={handleCopyPlan}>
              {copied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={() => downloadPlanAsTextFile(downloadFilename, saveContents)}>
              Download as markdown
            </MenuItem>
            <MenuItem disabled={!canSave || isSavingToWorkspace} onClick={openSaveDialog}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")}>
          <MessageText
            text={
              isCollapsed
                ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
                : displayedPlanMarkdown
            }
          />
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button onClick={() => setExpanded((value) => !value)} size="sm" variant="outline">
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) setIsSaveDialogOpen(open);
        }}
        open={isSaveDialogOpen}
      >
        {/* The form owns the path so a keystroke re-renders it, not the dialog chrome. */}
        <DialogPopup className="max-w-xl">
          <SavePlanToWorkspaceForm
            initialPath={lastSavePath || downloadFilename}
            onCancel={() => setIsSaveDialogOpen(false)}
            onSave={handleSaveToWorkspace}
            placeholder={downloadFilename}
            saving={isSavingToWorkspace}
            workspaceRoot={workspaceRoot}
          />
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function SavePlanToWorkspaceForm({
  initialPath,
  placeholder,
  workspaceRoot,
  saving,
  onCancel,
  onSave,
}: {
  initialPath: string;
  placeholder: string;
  workspaceRoot: string | undefined;
  saving: boolean;
  onCancel: () => void;
  onSave: (path: string) => void;
}) {
  const [savePath, setSavePath] = useState(initialPath);
  const savePathInputId = useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(savePath);
      }}
    >
      <DialogHeader>
        <DialogTitle>Save plan to workspace</DialogTitle>
        <DialogDescription>
          Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label className="grid gap-1.5" htmlFor={savePathInputId}>
          <span className="text-xs font-medium text-foreground">Workspace path</span>
          <Input
            disabled={saving}
            id={savePathInputId}
            onChange={(event) => setSavePath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            value={savePath}
          />
        </label>
      </DialogPanel>
      <DialogFooter>
        <Button disabled={saving} onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={saving} size="sm" type="submit">
          {saving ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
