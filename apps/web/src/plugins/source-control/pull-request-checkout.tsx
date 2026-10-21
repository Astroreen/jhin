// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/
// PullRequestThreadDialog.tsx (the dialog) and packages/client-runtime/src/
// pullRequestLinkInput.ts with source-control-github's client definition (reading a
// reference: a URL, `gh pr checkout <x>`, 123 or #123).
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";
import type { PreparedPullRequest, PullRequest } from "@jhin/source-control-api";
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
import { GitPullRequestIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const GITHUB_CHECKOUT_COMMAND = /^gh\s+pr\s+checkout\s+(.+)$/i;
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)([/?#].*)?$/i;

/**
 * T3's parsePullRequestReference for GitHub: a pull request URL as it is, the
 * argument of `gh pr checkout`, or the digits of `123` / `#123`; else null.
 */
export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const reference = GITHUB_CHECKOUT_COMMAND.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (GITHUB_PULL_REQUEST_URL.test(reference)) return reference;
  return /^#?(\d+)$/.exec(reference)?.[1] ?? null;
}

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
  readonly threads: ThreadsCatalog;
  readonly initialReference: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPrepared: (prepared: PreparedPullRequest) => void;
}

/** T3's "Checkout pull request" dialog, for GitHub (D903). */
export function PullRequestCheckoutDialog({
  open,
  target,
  projectId,
  threads,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestCheckoutDialogProps) {
  const input = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (!open || parsedDebounced === null || resolved.has(parsedDebounced)) return;
    let current = true;
    void threads
      .call<{ pullRequest: PullRequest }>(target, "git.pr.resolve", {
        projectId,
        reference: parsedDebounced,
      })
      .then(({ pullRequest }) => {
        if (current) setResolved((known) => new Map(known).set(parsedDebounced, pullRequest));
      })
      .catch((error: unknown) => {
        if (current)
          setResolveError({ reference: parsedDebounced, message: (error as Error).message });
      });
    return () => {
      current = false;
    };
  }, [open, parsedDebounced, projectId, resolved, target, threads]);

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
        error instanceof Error ? error.message : "Failed to prepare pull request thread.",
      );
    } finally {
      setPreparing(undefined);
    }
  };

  const validation = !dirty
    ? undefined
    : reference.trim() === ""
      ? "Paste a pull request URL, checkout command, or enter 123 / #123."
      : parsed === null
        ? "Use a pull request URL, checkout command, 123, or #123."
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
            <GitPullRequestIcon className="me-2 size-4" />
            Checkout pull request
          </DialogTitle>
          <DialogDescription>
            Resolve a GitHub pull request, then create the draft thread in the main repo or in a
            dedicated worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground capitalize">pull request</span>
            <Input
              onChange={(event) => {
                setDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                if (!isResolving && !pending) void confirm("worktree");
              }}
              placeholder="PR URL, checkout command, or #42"
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
              Resolving pull request...
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
