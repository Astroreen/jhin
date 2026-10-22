// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/BrowserImportWizard.tsx and browserImportWizard.logic.ts
// (the wizard's steps, wording and outcomes). docs/plans/preview.md, D1205.
import {
  BROWSER_IMPORT_FAILURE_COPY,
  BROWSER_IMPORT_FAILURE_REASONS,
  type BrowserImportFailureReason,
  type BrowserImportSource,
} from "@jhin/preview-api";
import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Spinner,
  cn,
} from "@jhin/ui";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon, HardDriveIcon } from "lucide-react";
import { useRef, useState } from "react";

interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string };

type WizardTargetSelection =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly profileId: string };

export type ImportOutcome =
  | {
      readonly kind: "imported";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | { readonly kind: "blocked"; readonly reason: BrowserImportFailureReason };

type WizardStep =
  | { readonly step: "quit" }
  | {
      readonly step: "fullDiskAccess";
      readonly resume: "configure" | "import";
      readonly checked?: boolean;
    }
  | { readonly step: "configure" }
  | { readonly step: "checking"; readonly check: "browser" | "fullDiskAccess" }
  | { readonly step: "importing" }
  | {
      readonly step: "done";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | { readonly step: "blocked"; readonly reason: BrowserImportFailureReason };

/** The reason a node's `PREVIEW_IMPORT_FAILED` carries; anything else reads as a read failure. */
export function importFailureReason(cause: unknown): BrowserImportFailureReason {
  const reason = (cause as { details?: { reason?: unknown } } | null)?.details?.reason;
  return BROWSER_IMPORT_FAILURE_REASONS.find((known) => known === reason) ?? "readFailed";
}

function initialTargetSelection(
  canCreateProfile: boolean,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTargetSelection {
  if (canCreateProfile) return { kind: "new" };
  const first = targetProfiles[0];
  return first ? { kind: "existing", profileId: first.id } : { kind: "new" };
}

function resolveWizardTarget(
  selection: WizardTargetSelection,
  newProfileId: string,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTarget | undefined {
  if (selection.kind === "new") return { kind: "new", profileId: newProfileId };
  const profile = targetProfiles.find((candidate) => candidate.id === selection.profileId);
  return profile === undefined
    ? undefined
    : { kind: "existing", profileId: selection.profileId, name: profile.name };
}

function initialWizardStep(source: BrowserImportSource): WizardStep {
  if (source.unavailable === "browserRunning") return { step: "quit" };
  if (source.unavailable === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure" };
  }
  if (source.unavailable !== undefined) return { step: "blocked", reason: source.unavailable };
  if (source.profiles.length === 0) return { step: "blocked", reason: "unknownSourceProfile" };
  return { step: "configure" };
}

function outcomeToStep(outcome: ImportOutcome): WizardStep {
  if (outcome.kind === "imported") return { step: "done", ...outcome };
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "import", checked: true };
  }
  return { step: "blocked", reason: outcome.reason };
}

const refreshedSourceStep = (source: BrowserImportSource | undefined): WizardStep =>
  source === undefined ? { step: "blocked", reason: "unknownSource" } : initialWizardStep(source);

function fullDiskAccessRecheckStep(source: BrowserImportSource | undefined): WizardStep {
  const next = refreshedSourceStep(source);
  return next.step === "fullDiskAccess" ? { ...next, checked: true } : next;
}

function refreshedSourceProfileDirectory(current: string, source: BrowserImportSource): string {
  if (source.profiles.some((profile) => profile.directory === current)) return current;
  return source.profiles[0]?.directory ?? "";
}

function isRetryableReason(reason: BrowserImportFailureReason): boolean {
  switch (reason) {
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "keychainUnavailable":
    case "readFailed":
    case "sessionUnavailable":
    case "profileNotSaved":
      return true;
    default:
      return false;
  }
}

function formatSkippedDomains(domains: ReadonlyArray<string>): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0]!;
  if (domains.length <= 3) return `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}`;
  return `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more`;
}

function cookieCountLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return "no cookies";
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

const cookieResultCount = (count: number): string =>
  `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;

interface BrowserImportWizardProps {
  readonly source: BrowserImportSource;
  /** The node whose browsers are read and whose profile gets the cookies. */
  readonly destinationName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly onImport: (input: {
    readonly sourceProfileDirectory: string;
    readonly target: WizardTarget;
  }) => Promise<ImportOutcome>;
  readonly onRefreshSource: () => Promise<BrowserImportSource | undefined>;
  readonly onClose: () => void;
}

/** T3's "Import from" wizard, for one browser of one node. */
export function BrowserImportWizard({
  source: initialSource,
  destinationName,
  targetProfiles,
  canCreateProfile,
  onImport,
  onRefreshSource,
  onClose,
}: BrowserImportWizardProps) {
  const [source, setSource] = useState(initialSource);
  const [step, setStep] = useState<WizardStep>(() => initialWizardStep(initialSource));
  const [sourceProfileDirectory, setSourceProfileDirectory] = useState(
    () => initialSource.profiles[0]?.directory ?? "",
  );
  const [target, setTarget] = useState<WizardTargetSelection>(() =>
    initialTargetSelection(canCreateProfile, targetProfiles),
  );
  const [targetError, setTargetError] = useState<string>();
  const newProfileId = useRef(crypto.randomUUID());
  // A second Import click before React has left the configure screen would start a
  // second run; the ref settles synchronously where state does not.
  const importInFlight = useRef(false);

  const runImport = () => {
    if (importInFlight.current) return;
    const chosen = resolveWizardTarget(target, newProfileId.current, targetProfiles);
    if (chosen === undefined) {
      setTargetError("That profile is no longer available. Choose where to import these cookies.");
      setStep({ step: "configure" });
      return;
    }
    setTargetError(undefined);
    importInFlight.current = true;
    setStep({ step: "importing" });
    void onImport({ sourceProfileDirectory, target: chosen })
      .then((outcome) => setStep(outcomeToStep(outcome)))
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }))
      .finally(() => {
        importInFlight.current = false;
      });
  };

  const recheckSource = (
    check: "browser" | "fullDiskAccess",
    nextStep: (refreshed: BrowserImportSource | undefined) => WizardStep,
  ) => {
    setStep({ step: "checking", check });
    void onRefreshSource()
      .then((refreshed) => {
        if (refreshed) {
          setSource(refreshed);
          setSourceProfileDirectory((current) =>
            refreshedSourceProfileDirectory(current, refreshed),
          );
        }
        setStep(nextStep(refreshed));
      })
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }));
  };

  const closable = step.step !== "importing";
  return (
    <Dialog open onOpenChange={(open) => (open || !closable ? undefined : onClose())}>
      <DialogPopup className="max-w-lg" showCloseButton={closable}>
        {step.step === "quit" ? (
          <QuitStep
            source={source}
            onCancel={onClose}
            onRechecked={() => recheckSource("browser", refreshedSourceStep)}
          />
        ) : step.step === "fullDiskAccess" ? (
          <FullDiskAccessStep
            source={source}
            stillRequired={step.checked === true}
            onCancel={onClose}
            onContinue={() =>
              step.resume === "import"
                ? runImport()
                : recheckSource("fullDiskAccess", fullDiskAccessRecheckStep)
            }
          />
        ) : step.step === "importing" ? (
          <ProgressStep
            title="Importing cookies"
            description="This may take a moment."
            label="Importing…"
          />
        ) : step.step === "checking" ? (
          <ProgressStep
            title={`Checking ${source.name}`}
            description={
              step.check === "fullDiskAccess"
                ? "Checking Full Disk Access."
                : "Checking whether the browser has closed."
            }
            label={step.check === "fullDiskAccess" ? "Checking access…" : "Checking…"}
          />
        ) : step.step === "done" ? (
          <DoneStep {...step} destinationName={destinationName} onClose={onClose} />
        ) : step.step === "blocked" ? (
          <BlockedStep
            source={source}
            reason={step.reason}
            onClose={onClose}
            onRetry={isRetryableReason(step.reason) ? runImport : undefined}
          />
        ) : (
          <ConfigureStep
            source={source}
            destinationName={destinationName}
            targetProfiles={targetProfiles}
            canCreateProfile={canCreateProfile}
            sourceProfileDirectory={sourceProfileDirectory}
            onSourceProfileChange={setSourceProfileDirectory}
            target={target}
            onTargetChange={(selection) => {
              setTarget(selection);
              setTargetError(undefined);
            }}
            targetError={targetError}
            onCancel={onClose}
            onImport={runImport}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function QuitStep(props: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onRechecked: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Quit {props.source.name} to import</DialogTitle>
        <DialogDescription>
          {props.source.name} is open, so its cookies can&rsquo;t be read yet. Quit it, then
          continue.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={props.onRechecked}>I&rsquo;ve quit it</Button>
      </DialogFooter>
    </>
  );
}

/**
 * T3's Full Disk Access step. The grant is made on the node's Mac, which this
 * client cannot open System Settings on, so "Continue" checks the node again.
 */
function FullDiskAccessStep(props: {
  readonly source: BrowserImportSource;
  readonly stillRequired: boolean;
  readonly onCancel: () => void;
  readonly onContinue: () => void;
}) {
  const { source } = props;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Let Jhin read {source.name}&rsquo;s cookies</DialogTitle>
        <DialogDescription>
          To import cookies from {source.name}, Jhin needs Full Disk Access. Turn it on in System
          Settings, then come back to finish the import — you can revoke it again once the import is
          done.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
          <HardDriveIcon aria-hidden="true" className="size-8 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">Full Disk Access</span>
            <span className="block text-xs text-muted-foreground">
              Read {source.name}&apos;s cookies for this import.
            </span>
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {props.stillRequired
            ? "Access is still required. Quit and reopen Jhin if you just allowed it, then retry the import."
            : "If access doesn't update after you allow it, quit and reopen Jhin, then retry the import."}
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={props.onContinue}>Continue</Button>
      </DialogFooter>
    </>
  );
}

function ConfigureStep(props: {
  readonly source: BrowserImportSource;
  readonly destinationName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: WizardTargetSelection;
  readonly targetError: string | undefined;
  readonly onTargetChange: (target: WizardTargetSelection) => void;
  readonly onCancel: () => void;
  readonly onImport: () => void;
}) {
  const { source, target, targetProfiles, canCreateProfile } = props;
  const targetMissing =
    target.kind === "existing" &&
    !targetProfiles.some((profile) => profile.id === target.profileId);
  const targetUncreatable = target.kind === "new" && !canCreateProfile;
  const targetFeedback =
    props.targetError ??
    (targetMissing
      ? "That profile is no longer available. Choose where to import these cookies."
      : targetUncreatable
        ? "You've reached the profile limit. Choose an existing profile to import into."
        : undefined);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from {source.name}</DialogTitle>
        <DialogDescription>
          Choose which cookies to import for {props.destinationName}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <section aria-label="From" className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              From
            </p>
            {source.profiles.map((profile) => (
              <SelectableTile
                key={profile.directory}
                selected={props.sourceProfileDirectory === profile.directory}
                title={profile.name}
                subtitle={cookieCountLabel(profile.cookieCount)}
                onSelect={() => props.onSourceProfileChange(profile.directory)}
              />
            ))}
          </section>
          <div className="flex shrink-0 items-center justify-center text-muted-foreground">
            <ArrowDownIcon className="size-4 sm:hidden" />
            <ArrowRightIcon className="hidden size-4 sm:block" />
          </div>
          <section aria-label="Into" className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Into
            </p>
            {canCreateProfile ? (
              <SelectableTile
                selected={target.kind === "new"}
                title="New profile"
                subtitle="Created for these cookies"
                onSelect={() => props.onTargetChange({ kind: "new" })}
              />
            ) : null}
            {targetProfiles.map((profile) => (
              <SelectableTile
                key={profile.id}
                selected={target.kind === "existing" && target.profileId === profile.id}
                title={profile.name}
                subtitle="Existing profile"
                onSelect={() => props.onTargetChange({ kind: "existing", profileId: profile.id })}
              />
            ))}
          </section>
        </div>
        {targetFeedback ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {targetFeedback}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          disabled={props.sourceProfileDirectory === "" || targetMissing || targetUncreatable}
          onClick={props.onImport}
        >
          Import
        </Button>
      </DialogFooter>
    </>
  );
}

function SelectableTile(props: {
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        props.selected
          ? "border-primary bg-primary/8"
          : "border-border/60 hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{props.title}</span>
        {props.subtitle ? (
          <span className="block truncate text-xs tabular-nums text-muted-foreground">
            {props.subtitle}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          props.selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {props.selected ? <CheckIcon className="size-2.5" /> : null}
      </span>
    </button>
  );
}

function ProgressStep(props: {
  readonly title: string;
  readonly description: string;
  readonly label: string;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">{props.label}</span>
        </div>
      </DialogPanel>
    </>
  );
}

function DoneStep(props: {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedDomains: ReadonlyArray<string>;
  readonly targetName: string;
  readonly destinationName: string;
  readonly onClose: () => void;
}) {
  const { imported, skipped, destinationName } = props;
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {imported > 0
            ? `Imported ${cookieResultCount(imported)}`
            : skipped > 0
              ? `Skipped ${cookieResultCount(skipped)}`
              : "No cookies found"}
        </DialogTitle>
        <DialogDescription>
          {imported > 0
            ? `Added to ${props.targetName} for ${destinationName}.${skipped > 0 ? ` ${cookieResultCount(skipped)} skipped.` : ""}`
            : skipped > 0
              ? `No cookies were imported for ${destinationName}.`
              : `There were no cookies to import for ${destinationName}.`}
        </DialogDescription>
      </DialogHeader>
      {props.skippedDomains.length > 0 ? (
        <DialogPanel>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Skipped
          </p>
          <p className="mt-1 text-sm text-foreground">
            {formatSkippedDomains(props.skippedDomains)}
          </p>
        </DialogPanel>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button />} onClick={props.onClose}>
          Done
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function BlockedStep(props: {
  readonly source: BrowserImportSource;
  readonly reason: BrowserImportFailureReason;
  readonly onClose: () => void;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Couldn&rsquo;t import from {props.source.name}</DialogTitle>
        <DialogDescription>{BROWSER_IMPORT_FAILURE_COPY[props.reason]}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          Close
        </Button>
        {props.onRetry ? <Button onClick={props.onRetry}>Try again</Button> : null}
      </DialogFooter>
    </>
  );
}
