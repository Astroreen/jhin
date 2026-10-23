// T3's device setup wizard (docs/plans/preview.md, D1328, D1329), derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/device/DeviceSetup.tsx (its steps, statuses
// and copy), DeviceHostUpdates.tsx and components/ui/wizard.tsx (the step list).
import type { DevicePlatform, DeviceState } from "@jhin/preview-api";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Spinner,
  Switch,
  cn,
} from "@jhin/ui";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");

const deviceHubDescription =
  "Enable this environment to open simulators and emulators, whether they run here or on a remote device host.";
const agentDeviceDescription =
  "Allow new agent sessions in this environment to start and control local and remote devices, with required tools set up automatically.";

/** The node's settings the wizard changes (D1328). */
const DEVICES_SECTION = "jhin.devices";

/** T3's `deviceHubReadiness`: the hub runs, or is getting there. */
function deviceHubReadiness(state: DeviceState) {
  const statuses = Object.values(state.hostStatuses ?? {}).map((host) => host.status);
  const ready = statuses.includes("ready");
  const busy =
    !ready && statuses.some((status) => status === "installing" || status === "starting");
  return { ready, busy };
}

/** T3's `platformSetupStatus`, for this node's own host. */
function platformSetupStatus(state: DeviceState, platform: DevicePlatform) {
  const availabilities = state.hosts.flatMap((host) =>
    host.platforms.filter((candidate) => candidate.platform === platform),
  );
  if (!availabilities.some((candidate) => candidate.available)) {
    return {
      ready: false,
      message: availabilities[0]?.reason ?? `${platformName(platform)} support was not detected.`,
    };
  }
  if (
    deviceHubReadiness(state).ready &&
    !state.devices.some((each) => each.platform === platform)
  ) {
    return {
      ready: false,
      message:
        platform === "ios"
          ? "Xcode is installed, but no iOS Simulator is available. Install a runtime in Xcode Settings → Components."
          : "The Android SDK is installed, but no virtual device exists. Create one in Android Studio → Device Manager.",
    };
  }
  return {
    ready: true,
    message:
      platform === "ios"
        ? "Xcode and iOS Simulator are available."
        : "The Android SDK and Emulator are available.",
  };
}

function WizardSteps(props: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly isStepDisabled: (step: number) => boolean;
  readonly onStepChange: (step: number) => void;
}) {
  return (
    <ol
      aria-label="Setup progress"
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-background p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
    >
      {props.steps.map((step, index) => (
        <li className="min-w-0" key={step}>
          <button
            aria-current={index === props.currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}`}
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent max-sm:justify-center max-sm:px-2",
              index === props.currentStep &&
                "bg-card text-foreground shadow-xs ring-1 ring-inset ring-black/5 dark:shadow-none dark:ring-white/5",
            )}
            disabled={props.isStepDisabled(index)}
            onClick={() => props.onStepChange(index)}
            type="button"
          >
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                index < props.currentStep
                  ? "bg-primary text-primary-foreground ring-primary"
                  : index === props.currentStep
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
              )}
            >
              {index < props.currentStep ? <CheckIcon className="size-4 shrink-0" /> : index + 1}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-sm font-medium max-sm:hidden",
                index === props.currentStep ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** T3's host rows: the hub installing or starting, and a failure with its Retry. */
function HostUpdates(props: {
  readonly state: DeviceState;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  if (!props.state.setup?.hubEnabled) return null;
  return (
    <div className="space-y-2">
      {props.state.hosts.map((host) => {
        const status = props.state.hostStatuses?.[host.id];
        if (!status || !["installing", "starting", "failed"].includes(status.status)) return null;
        const failed = status.status === "failed";
        return (
          <div
            className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2 text-xs"
            key={host.id}
            role={failed ? "alert" : "status"}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{host.label}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {status.detail ??
                  (failed
                    ? "Device support could not start."
                    : status.status === "installing"
                      ? "Installing device tools…"
                      : "Starting device tools…")}
              </p>
              {failed ? (
                <p className="mt-1 text-muted-foreground">
                  Check the host connection and network access, then retry. Your device settings are
                  saved.
                </p>
              ) : null}
            </div>
            {failed ? (
              <Button disabled={props.retrying} onClick={props.onRetry} size="sm" variant="outline">
                {props.retrying ? "Retrying…" : "Retry"}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PlatformStatus(props: {
  readonly platform: string;
  readonly status: { readonly ready: boolean; readonly message: string };
}) {
  const Icon = props.status.ready ? CheckIcon : CircleAlertIcon;
  return (
    <div className="flex gap-2 rounded-md border border-border/60 px-3 py-2">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          props.status.ready ? "text-success" : "text-muted-foreground",
        )}
      />
      <div>
        <p className="font-medium">{props.platform}</p>
        <p className="text-xs text-muted-foreground">{props.status.message}</p>
      </div>
    </div>
  );
}

function SetupStatus(props: { readonly label: string; readonly pending: boolean }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      {props.pending ? (
        <Spinner className="size-3" />
      ) : (
        <CheckIcon className="size-3 text-success" />
      )}
      {props.label}
    </p>
  );
}

export interface DeviceSetupProps {
  readonly state: DeviceState;
  /** Runs a command on the node the panel shows. */
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly onError: (title: string, error: unknown) => void;
  /**
   * The wizard closed: Cancel (the user declined), dismissed (Escape, a click outside), or
   * done (Done recorded the setup on the node).
   */
  readonly onClose: (reason: "cancel" | "dismiss" | "done") => void;
}

/**
 * A hub still installing, or one that cannot run here, answers `DEVICE_UNAVAILABLE` and says
 * so in its status row; anything else (a permission, a dropped connection) is the caller's.
 */
const showsInStatus = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "DEVICE_UNAVAILABLE";

/** T3's "Set up devices": the hub, the simulators and the agents' access, then Done. */
function DeviceSetup(props: DeviceSetupProps) {
  const { state } = props;
  const [pending, setPending] = useState<"hub" | "check" | "agent" | "complete" | "retry" | null>(
    null,
  );
  const [step, setStep] = useState(0);
  const enabled = state.setup?.hubEnabled === true;
  const { ready, busy } = deviceHubReadiness(state);
  const localPlatformsUnavailable = state.hosts.some(
    (host) => !host.platforms.some((platform) => platform.available),
  );

  // An enabled hub that does not run yet starts now, as T3's wizard lists on open.
  const started = useRef(false);
  const call = useRef(props.call);
  call.current = props.call;
  const onError = useRef(props.onError);
  onError.current = props.onError;
  useEffect(() => {
    if (!enabled || ready || busy || started.current) return;
    started.current = true;
    // A hub that fails to start shows in its status (and offers Retry); a refused call
    // (permission, a dropped connection) has no status, so it is said here.
    void call.current("device.hub.access", {}).catch((error: unknown) => {
      if (!showsInStatus(error)) onError.current("Couldn't start the device hub", error);
    });
  }, [enabled, ready, busy]);

  const update = async (
    kind: NonNullable<typeof pending>,
    values: { hub?: boolean; agentAccess?: boolean; onboardingCompleted?: boolean },
  ) => {
    setPending(kind);
    try {
      await props.call("host.config.patch", {
        layer: "node",
        section: DEVICES_SECTION,
        values,
      });
      // Turned on: the hub starts now, so the wizard shows it installing (T3's list on enable).
      if (values.hub === true) {
        await props.call("device.hub.access", {}).catch((error: unknown) => {
          if (!showsInStatus(error)) props.onError("Couldn't start the device hub", error);
        });
      }
      if (kind === "complete") props.onClose("done");
    } catch (error) {
      props.onError("Couldn't change the device setup", error);
    } finally {
      setPending(null);
    }
  };

  const hubStatus = Object.values(state.hostStatuses ?? {})[0]?.status;
  const hubPending = pending === "hub" || (busy && pending !== "agent");
  const agentPending = pending === "agent" || (state.setup?.agentAccessEnabled === true && busy);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Set up devices</DialogTitle>
        <DialogDescription>
          Review what runs on this environment before using simulators and emulators.
        </DialogDescription>
        <WizardSteps
          currentStep={step}
          isStepDisabled={(requested) => busy || pending !== null || requested > step}
          onStepChange={setStep}
          steps={["Device hub", "Simulators", "Agent access"]}
        />
      </DialogHeader>
      <div className="min-w-0 space-y-4 bg-background/80 px-6 py-5 text-sm ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5">
        <HostUpdates
          onRetry={() => {
            setPending("retry");
            void props
              .call("device.hub.access", {})
              .catch((error: unknown) => props.onError("Device support could not start", error))
              .finally(() => setPending(null));
          }}
          retrying={pending === "retry"}
          state={state}
        />
        {step === 0 ? (
          <section className="space-y-3">
            <h3 className="font-medium">Enable the device hub</h3>
            <div className="flex items-start justify-between gap-4">
              <p className="text-muted-foreground">{deviceHubDescription}</p>
              <Switch
                aria-label="Enable device hub"
                checked={enabled}
                disabled={busy || pending !== null}
                onCheckedChange={(checked) =>
                  void update("hub", {
                    hub: Boolean(checked),
                    // On: agent access as it stands, written so the hub no longer implies it
                    // (D1329); off: off too, as T3's wizard does.
                    agentAccess: checked ? state.setup?.agentAccessEnabled === true : false,
                  })
                }
              />
            </div>
            {hubPending || ready ? (
              <SetupStatus
                label={
                  hubPending
                    ? hubStatus === "installing"
                      ? "Installing device hub…"
                      : hubStatus === "starting"
                        ? "Starting device hub…"
                        : "Updating device hub…"
                    : "Device hub is ready."
                }
                pending={hubPending}
              />
            ) : null}
          </section>
        ) : null}
        {step === 1 || (step === 0 && enabled && localPlatformsUnavailable) ? (
          <section className={cn("space-y-3", step === 0 && "mt-4")}>
            <h3 className="font-medium">Check simulator support</h3>
            <div className="space-y-3">
              <PlatformStatus platform="iOS" status={platformSetupStatus(state, "ios")} />
              <PlatformStatus platform="Android" status={platformSetupStatus(state, "android")} />
              <p className="text-xs text-muted-foreground">
                You can use either platform. Fixing a missing platform does not block the other one.
              </p>
              <Button
                disabled={!enabled || busy || pending !== null}
                onClick={() => {
                  setPending("check");
                  void props
                    .call("device.list", {})
                    .catch((error: unknown) => props.onError("Couldn't check devices", error))
                    .finally(() => setPending(null));
                }}
                size="sm"
                variant="outline"
              >
                {pending === "check" ? <Spinner className="size-3" /> : null}
                {pending === "check" ? "Checking…" : "Check again"}
              </Button>
            </div>
          </section>
        ) : null}
        {step === 2 ? (
          <section className="space-y-3">
            <h3 className="font-medium">Allow agent control</h3>
            <div className="flex items-start justify-between gap-4">
              <p className="text-muted-foreground">{agentDeviceDescription}</p>
              <Switch
                aria-label="Allow agents to control devices"
                checked={state.setup?.agentAccessEnabled === true}
                disabled={!enabled || busy || pending !== null}
                onCheckedChange={(checked) =>
                  void update("agent", { agentAccess: Boolean(checked) })
                }
              />
            </div>
            {agentPending ? (
              <SetupStatus
                label={
                  hubStatus === "installing"
                    ? "Installing agent tools…"
                    : hubStatus === "starting"
                      ? "Starting agent tools…"
                      : "Updating agent access…"
                }
                pending
              />
            ) : state.setup?.agentAccessEnabled === true && state.setup.agentToolsReady ? (
              <SetupStatus label="Agent tools are ready." pending={false} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Leave this off to keep manual device controls without giving agents access.
            </p>
          </section>
        ) : null}
      </div>
      <DialogFooter>
        {step === 0 ? (
          <Button onClick={() => props.onClose("cancel")} variant="outline">
            Cancel
          </Button>
        ) : (
          <Button
            disabled={busy || pending !== null}
            onClick={() => setStep(step - 1)}
            variant="outline"
          >
            Back
          </Button>
        )}
        {step < 2 ? (
          <Button disabled={!ready || pending !== null} onClick={() => setStep(step + 1)}>
            Continue
          </Button>
        ) : (
          <Button
            disabled={!ready || pending !== null}
            onClick={() =>
              // The choice the wizard showed is written, so a node whose agent access only
              // followed the hub records the user's decision (D1328).
              void update("complete", {
                onboardingCompleted: true,
                agentAccess: state.setup?.agentAccessEnabled === true,
              })
            }
          >
            {pending === "complete" ? "Saving…" : "Done"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** The wizard in T3's dialog, over the Device panel. */
export function DeviceSetupDialog(props: DeviceSetupProps) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose("dismiss"))}>
      <DialogPopup className="max-w-xl">
        <DeviceSetup {...props} />
      </DialogPopup>
    </Dialog>
  );
}
