// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/
// PullRequestThreadDialog.tsx (the dialog, in the forge's terms and name, D1444, D1445).
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import type {
  PreparedPullRequest,
  PullRequest,
  PullRequestProvider,
} from "@jhin/source-control-api";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Spinner,
  cn,
} from "@jhin/ui";
import { useEffect, useRef, useState } from "react";

import { forgePresentation, parsePullRequestReference } from "../../lib/forges.ts";
import { forgeIcon } from "./forge-icons.tsx";

export { parsePullRequestReference };

/** T3's pullRequestStatusTone. */
function statusTone(state: string | undefined): string {
  switch (state) {
    case "merged":
      return "text-violet-600 dark:text-violet-300/90";
    case "closed":
      return "text-zinc-500 dark:text-zinc-400/80";
    case "open":
      return "text-emerald-600 dark:text-emerald-300/90";
    default:
      return "text-muted-foreground";
  }
}

/** How long typing must pause before the reference is resolved (T3's 450 ms). */
const RESOLVE_DELAY_MS = 450;

export interface PullRequestCheckoutDialogProps {
  readonly open: boolean;
  readonly target: NodeTarget;
  readonly projectId: string;
  /** The repository's forge: its mark, name and words in the dialog. */
  readonly provider: PullRequestProvider | null;
  readonly threads: ThreadsCatalog;
  readonly initialReference: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPrepared: (prepared: PreparedPullRequest) => void;
}

/** T3's "Checkout pull request" dialog (D903), in the forge's terms (D1444). */
export function PullRequestCheckoutDialog({
  open,
  target,
  projectId,
  provider,
  threads,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestCheckoutDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const { providerName, terminology } = forgePresentation(provider);
  const { singular } = terminology;
  const Forge = forgeIcon(provider);
  const [reference, setReference] = useState(initialReference);
  const [dirty, setDirty] = useState(false);
  const [debounced, setDebounced] = useState(initialReference);
  const [resolved, setResolved] = useState<Map<string, PullRequest>>(() => new Map());
  const [resolveError, setResolveError] = useState<{ reference: string; message: string }>();
  const [preparing, setPreparing] = useState<"local" | "worktree">();
  const [prepareError, setPrepareError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(reference), RESOLVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [reference]);

  const parsed = parsePullRequestReference(reference);
  const parsedDebounced = parsePullRequestReference(debounced);

  // Answers are kept by reference while the dialog is open, even once the search moved on.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (!open || parsedDebounced === null || resolved.has(parsedDebounced)) return;
    // A failure is shown until the reference is edited; editing it asks again.
    if (resolveError?.reference === parsedDebounced || asked.current.has(parsedDebounced)) return;
    const asking = parsedDebounced;
    asked.current.add(asking);
    void threads
      .call<{ pullRequest: PullRequest }>(target, "git.pr.resolve", {
        projectId,
        reference: asking,
      })
      .then(({ pullRequest }) => {
        if (mounted.current) setResolved((known) => new Map(known).set(asking, pullRequest));
      })
      .catch((error: unknown) => {
        if (mounted.current)
          setResolveError({ reference: asking, message: (error as Error).message });
      })
      .finally(() => asked.current.delete(asking));
  }, [open, parsedDebounced, projectId, resolveError, resolved, target, threads]);

  const pullRequest = parsed === null ? undefined : resolved.get(parsed);
  // Until it is resolved or failed to be: waiting for typing to pause, or for the node.
  const isResolving =
    open && parsed !== null && pullRequest === undefined && resolveError?.reference !== parsed;
  const pending = preparing !== undefined;

  const confirm = async (mode: "local" | "worktree") => {
    if (parsed === null) {
      setDirty(true);
      return;
    }
    if (pullRequest === undefined) return;
    setPrepareError(undefined);
    setPreparing(mode);
    try {
      const prepared = await threads.call<PreparedPullRequest>(target, "git.pr.checkout", {
        projectId,
        reference: parsed,
        mode,
      });
      onPrepared(prepared);
      onOpenChange(false);
    } catch (error) {
      setPrepareError(
        error instanceof Error ? error.message : `Failed to prepare ${singular} thread.`,
      );
    } finally {
      setPreparing(undefined);
    }
  };

  const validation = !dirty
    ? undefined
    : reference.trim() === ""
      ? `Paste a ${singular} URL, checkout command, or enter 123 / #123.`
      : parsed === null
        ? `Use a ${singular} URL, checkout command, 123, or #123.`
        : undefined;
  const error =
    validation ??
    prepareError ??
    (pullRequest === undefined && resolveError?.reference === parsed
      ? resolveError.message
      : undefined);
  const disabled = pullRequest === undefined || isResolving || pending;

  return (
    <Dialog
      onOpenChange={(next: boolean) => {
        if (!pending) onOpenChange(next);
      }}
      open={open}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <Forge className="me-2 size-4" />
            Checkout {singular}
          </DialogTitle>
          <DialogDescription>
            Resolve a {providerName} {singular}, then create the draft thread in the main repo or in
            a dedicated worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground capitalize">{singular}</span>
            <Input
              onChange={(event) => {
                setDirty(true);
                setResolveError(undefined);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                if (!isResolving && !pending) void confirm("worktree");
              }}
              placeholder={`${terminology.shortLabel} URL, checkout command, or #42`}
              ref={input}
              value={reference}
            />
          </label>

          {pullRequest ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{pullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{pullRequest.number} · {pullRequest.headBranch} to {pullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone(pullRequest.state))}>
                  {pullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3" />
              Resolving {singular}...
            </div>
          ) : null}

          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={disabled}
            onClick={() => void confirm("local")}
            size="sm"
            type="button"
            variant="outline"
          >
            {preparing === "local" ? "Preparing local..." : "Local"}
          </Button>
          <Button
            disabled={disabled}
            onClick={() => void confirm("worktree")}
            size="sm"
            type="button"
          >
            {preparing === "worktree" ? "Preparing worktree..." : "Worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
