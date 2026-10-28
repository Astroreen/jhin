// "Publish repository" follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/GitActionsControl.tsx (PublishRepositoryDialog: its steps Provider,
// Repository and Summary, the provider cards, the repository field after the forge's host,
// Visibility, "Advanced" with Remote and Protocol, the pending and failure notes, and the
// summary). Jhin has no forge discovery yet, so every card is offered and a forge's refusal
// shows as "Publish failed". docs/plans/source-control.md D1667, D1668.
import type { PublishedRepository } from "@jhin/source-control-api";
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
  RadioGroup,
  Spinner,
  Toggle,
  ToggleGroup,
  cn,
} from "@jhin/ui";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, ChevronDownIcon, GlobeIcon, LockIcon } from "lucide-react";
import { useRef, useState } from "react";

import { forgeIcon } from "./forge-icons.tsx";

type PublishForge = "github" | "gitlab";

/** T3's definitions of the forges Jhin publishes to: label, host and repository hint. */
const PUBLISH_FORGES: readonly {
  readonly value: PublishForge;
  readonly label: string;
  readonly host: string;
  readonly pathPlaceholder: string;
}[] = [
  { value: "github", label: "GitHub", host: "github.com", pathPlaceholder: "owner/repo" },
  { value: "gitlab", label: "GitLab", host: "gitlab.com", pathPlaceholder: "group/project" },
];

const STEPS = ["Provider", "Repository", "Summary"] as const;

const CARD = cn(
  "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);
const cardState = (selected: boolean) =>
  selected
    ? "border-primary bg-background shadow-sm ring-2 ring-inset ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
    : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent";

export function PublishRepositoryDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `git.publish` for the control's project. */
  publish: (input: {
    forge: PublishForge;
    repository: string;
    visibility: "private" | "public";
    remoteName: string;
    protocol: "ssh" | "https";
  }) => Promise<PublishedRepository>;
  openUrl: (url: string) => void;
}) {
  const [forge, setForge] = useState<PublishForge>("github");
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [remoteName, setRemoteName] = useState("origin");
  const [protocol, setProtocol] = useState<"ssh" | "https">("ssh");
  const [step, setStep] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishedRepository | null>(null);
  const attempts = useRef(0);
  const current = PUBLISH_FORGES.find((item) => item.value === forge) ?? PUBLISH_FORGES[0]!;
  const Mark = forgeIcon({ kind: forge });
  const [owner = "", ...rest] = repository.trim().split("/");
  const canSubmit = !pending && owner.trim() !== "" && rest.join("/").trim() !== "";

  const reset = () => {
    attempts.current += 1;
    setPending(false);
    setRemoteName("origin");
    setRepository("");
    setStep(0);
    setAdvancedOpen(false);
    setError(null);
    setResult(null);
  };
  const onOpenChange = (open: boolean) => {
    props.onOpenChange(open);
    if (!open) reset();
  };
  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    // A result that arrives after the dialog was closed is not shown as a stale summary.
    const attempt = ++attempts.current;
    const current = () => attempt === attempts.current;
    props
      .publish({
        forge,
        repository: repository.trim(),
        visibility,
        remoteName: remoteName.trim() || "origin",
        protocol,
      })
      .then(
        (published) => {
          if (!current()) return;
          setResult(published);
          setStep(2);
        },
        (failure: unknown) => {
          if (current())
            setError(failure instanceof Error ? failure.message : "An error occurred.");
        },
      )
      .finally(() => {
        if (current()) setPending(false);
      });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={props.open}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish repository</DialogTitle>
          <DialogDescription>
            Pick where to host it, then point us at a repo to push to.
          </DialogDescription>
          <ol aria-label="Steps" className="mt-2 flex items-center gap-2 text-xs">
            {STEPS.map((label, index) => {
              const summary =
                index === 0 ? current.label : index === 1 ? result?.repository.nameWithOwner : null;
              return (
                <li
                  aria-current={index === step ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5",
                    index === step ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                  key={label}
                >
                  <span
                    className={cn(
                      "grid size-4 place-items-center rounded-full border text-2xs",
                      index <= step ? "border-primary text-primary" : "border-border",
                    )}
                  >
                    {index < step ? <CheckIcon className="size-2.5" /> : index + 1}
                  </span>
                  {label}
                  {index < step && summary ? (
                    <span className="font-normal text-muted-foreground">· {summary}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </DialogHeader>
        <DialogPanel>
          <div className={cn("space-y-2", step !== 0 && "hidden")}>
            <span className="text-xs font-medium text-foreground" id="publish-provider-cards-label">
              Provider
            </span>
            <RadioGroup
              aria-labelledby="publish-provider-cards-label"
              className="grid grid-cols-2"
              onValueChange={(value) => setForge(value as PublishForge)}
              value={forge}
            >
              {PUBLISH_FORGES.map((option) => {
                const Icon = forgeIcon({ kind: option.value });
                return (
                  <RadioPrimitive.Root
                    className={cn(CARD, "py-3", cardState(forge === option.value))}
                    key={option.value}
                    value={option.value}
                  >
                    <Icon aria-hidden className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
          </div>

          <div className={cn("space-y-5", step !== 1 && "hidden")}>
            <div className="space-y-2">
              <label
                className="text-xs font-medium text-foreground"
                htmlFor="publish-repository-path"
              >
                Repository
              </label>
              <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
                <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                  <Mark className="size-3.5" />
                  {current.host}/
                </span>
                <input
                  className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
                  disabled={pending}
                  id="publish-repository-path"
                  name="publish-repository-path"
                  onChange={(event) => setRepository(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={current.pathPlaceholder}
                  value={repository}
                />
              </div>
            </div>

            <div className="space-y-2">
              <span
                className="text-xs font-medium text-foreground"
                id="publish-visibility-cards-label"
              >
                Visibility
              </span>
              <RadioGroup
                aria-labelledby="publish-visibility-cards-label"
                className="grid grid-cols-2"
                disabled={pending}
                onValueChange={(value) => setVisibility(value as "private" | "public")}
                value={visibility}
              >
                {[
                  {
                    value: "private" as const,
                    label: "Private",
                    description: "Only invited people",
                    Icon: LockIcon,
                  },
                  {
                    value: "public" as const,
                    label: "Public",
                    description: "Anyone on the web",
                    Icon: GlobeIcon,
                  },
                ].map((option) => (
                  <RadioPrimitive.Root
                    className={cn(CARD, "py-2.5", cardState(visibility === option.value))}
                    key={option.value}
                    value={option.value}
                  >
                    <option.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </RadioPrimitive.Root>
                ))}
              </RadioGroup>
            </div>

            <div>
              <button
                aria-expanded={advancedOpen}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setAdvancedOpen((open) => !open)}
                type="button"
              >
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform", advancedOpen ? "" : "-rotate-90")}
                />
                Advanced
              </button>
              {advancedOpen ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5" htmlFor="publish-remote-name">
                    <span className="text-xs font-medium text-foreground">Remote</span>
                    <Input
                      disabled={pending}
                      id="publish-remote-name"
                      onChange={(event) => setRemoteName(event.target.value)}
                      placeholder="origin"
                      value={remoteName}
                    />
                  </label>
                  <div className="space-y-1.5">
                    <span
                      className="text-xs font-medium text-foreground"
                      id="publish-protocol-label"
                    >
                      Protocol
                    </span>
                    <ToggleGroup
                      aria-labelledby="publish-protocol-label"
                      disabled={pending}
                      onValueChange={(next) => {
                        const value = next[0];
                        if (value === "ssh" || value === "https") setProtocol(value);
                      }}
                      value={[protocol]}
                    >
                      <Toggle value="ssh">SSH</Toggle>
                      <Toggle value="https">HTTPS</Toggle>
                    </ToggleGroup>
                  </div>
                </div>
              ) : null}
            </div>

            {pending ? (
              <div
                aria-live="polite"
                className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
                role="status"
              >
                <Spinner aria-hidden className="size-3.5" />
                Publishing repository to {current.label}...
              </div>
            ) : null}
            {error !== null && !pending ? (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                <p className="font-medium">Publish failed</p>
                <p className="mt-0.5 text-destructive/90">{error}</p>
              </div>
            ) : null}
          </div>

          <div className={cn("space-y-4", step !== 2 && "hidden")}>
            {result !== null ? (
              <>
                <div className="flex flex-col items-center gap-2 py-1 text-center">
                  <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
                    <CheckIcon aria-hidden className="size-4" />
                  </span>
                  <h3 className="text-sm font-semibold text-foreground">
                    {result.status === "pushed" ? "Repository published" : "Repository created"}
                  </h3>
                  <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                    {result.status === "pushed"
                      ? `${result.branch} is now live on ${current.label}.`
                      : `Remote "${result.remoteName}" is set up. Make a commit and push it to share your code.`}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2 dark:border-transparent dark:bg-white/[0.035]">
                  <Mark className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {result.repository.nameWithOwner}
                  </span>
                </div>
                <Button
                  className="w-full"
                  onClick={() => props.openUrl(result.repository.url)}
                  size="sm"
                  variant="outline"
                >
                  Open on {current.label}
                </Button>
              </>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {step === 2 ? (
            <Button onClick={() => onOpenChange(false)} size="sm">
              Done
            </Button>
          ) : (
            <>
              <Button
                disabled={pending}
                onClick={() => (step === 0 ? onOpenChange(false) : setStep(0))}
                size="sm"
                variant="outline"
              >
                {step === 0 ? "Cancel" : "Back"}
              </Button>
              {step === 0 ? (
                <Button onClick={() => setStep(1)} size="sm">
                  Next
                </Button>
              ) : (
                <Button disabled={!canSubmit} onClick={submit} size="sm">
                  {pending ? (
                    <>
                      <Spinner aria-hidden className="size-3.5" />
                      Publishing...
                    </>
                  ) : (
                    "Publish"
                  )}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
