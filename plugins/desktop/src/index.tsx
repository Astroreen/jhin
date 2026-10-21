// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/sidebar/SidebarUpdatePill.tsx,
// components/sidebar/DesktopUpdateStatusIcon.tsx, components/desktopUpdate.toast.tsx and the About
// section of components/settings/SettingsPanels.tsx.
import { NOTIFICATIONS_CAPABILITY, type ThreadNotifications } from "@jhin/client-api";
import {
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_SHELL_CAPABILITY,
  DesktopMenuContribution,
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  type DesktopBridge,
  type DesktopShell,
} from "@jhin/desktop-api";
import { definePlugin, toDisposable, z, type Disposable } from "@jhin/sdk";
import {
  Button,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  SettingsSection,
  SidebarMenuItem,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SETTINGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  cn,
  type Dialogs,
  type SettingsPages,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { CheckIcon, DownloadIcon, InfoIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { notificationBadge } from "./badge.ts";
import { syncWindowChrome } from "./chrome.ts";
import {
  canCheckForUpdate,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateInstallConfirmation,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "./update-logic.ts";
import { pasteAsText } from "./paste-as-text.ts";

const DOWNLOAD_PROGRESS_RADIUS = 14;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

type StatusIconState = "idle" | "checking" | "available" | "downloading" | "downloaded";

function StatusIcon({
  status,
  downloadPercent,
}: {
  readonly status: StatusIconState;
  readonly downloadPercent: number | null;
}) {
  if (status === "available") {
    return (
      <span className="relative grid size-4 place-items-center">
        <DownloadIcon className="size-4" />
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-sidebar-control-surface"
        />
      </span>
    );
  }
  if (status === "downloading") {
    const percent =
      downloadPercent === null || !Number.isFinite(downloadPercent)
        ? 0
        : Math.min(100, Math.max(0, downloadPercent));
    return (
      <span className="relative grid size-8 place-items-center">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full -rotate-90"
          viewBox="0 0 32 32"
        >
          <circle
            className="stroke-current/22"
            cx="16"
            cy="16"
            fill="none"
            r={DOWNLOAD_PROGRESS_RADIUS}
            strokeWidth="1.5"
          />
          <circle
            className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
            cx="16"
            cy="16"
            fill="none"
            r={DOWNLOAD_PROGRESS_RADIUS}
            stroke="currentColor"
            strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
            strokeDashoffset={DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - percent / 100)}
            strokeLinecap="round"
            strokeWidth="1.5"
          />
        </svg>
        <DownloadIcon className="size-4" />
      </span>
    );
  }
  if (status === "downloaded") {
    return (
      <span className="relative grid size-4 place-items-center">
        <RotateCwIcon className="size-4" />
        <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
          <CheckIcon className="size-2" strokeWidth={3} />
        </span>
      </span>
    );
  }
  return (
    <RefreshCwIcon
      aria-hidden
      className={cn("size-4", status === "checking" && "motion-safe:animate-spin")}
    />
  );
}

/** The update state as the app last reported it, for React and for commands. */
function createUpdateStore(bridge: DesktopBridge, initial: DesktopUpdateState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: DesktopUpdateState) => {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  };
  const stop = bridge.onUpdateState((next) => set(DesktopUpdateState.parse(next)));
  return {
    get: () => state,
    set,
    subscribe(listener: () => void): Disposable {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose: stop,
  };
}

/** The window's menu items added by plugins, sent to the app whenever they change (D516). */
function createMenuContributions(bridge: DesktopBridge) {
  const items = new Map<string, DesktopMenuContribution>();
  const send = () => bridge.setMenuContributions([...items.values()]);
  return {
    contribute(item: DesktopMenuContribution): Disposable {
      const parsed = DesktopMenuContribution.parse(item);
      if (items.has(parsed.id)) throw new Error(`Menu item ${parsed.id} is already contributed`);
      items.set(parsed.id, parsed);
      send();
      return toDisposable(() => {
        if (items.get(parsed.id) !== parsed) return;
        items.delete(parsed.id);
        send();
      });
    },
  };
}

export default definePlugin({
  async activate(context) {
    const bridge = (window as Window & { jhinDesktop?: DesktopBridge }).jhinDesktop;
    // The app's node also serves this plugin to a browser that opens it: there it does nothing.
    if (bridge === undefined || bridge.version !== DESKTOP_BRIDGE_VERSION) {
      context.log.info("not in the desktop app, or a desktop app this plugin does not know", {
        bridgeVersion: bridge?.version,
      });
      return;
    }
    const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
    const pages = context.services.tryGet<SettingsPages>(UI_SETTINGS_CAPABILITY);
    const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
    const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
    const notifications = context.services.tryGet<ThreadNotifications>(NOTIFICATIONS_CAPABILITY);

    context.subscriptions.add(syncWindowChrome(bridge));

    const updates = createUpdateStore(
      bridge,
      DesktopUpdateState.parse(await bridge.getUpdateState()),
    );
    context.subscriptions.add({ dispose: updates.dispose });
    const menu = createMenuContributions(bridge);
    context.subscriptions.add({ dispose: () => bridge.setMenuContributions([]) });

    // A native menu item asks for a command (Settings... runs settings.open).
    context.subscriptions.add({
      dispose: bridge.onMenuCommand((command) => {
        void context.commands
          .execute(command, {})
          .catch((error: unknown) =>
            context.log.warn("menu command failed", { command, error: String(error) }),
          );
      }),
    });

    if (notifications !== undefined) {
      const sync = () =>
        bridge.setNotificationBadge(notificationBadge(notifications.count(), bridge.platform));
      context.subscriptions.add(notifications.subscribe(sync));
      sync();
      context.subscriptions.add({
        dispose: () => bridge.setNotificationBadge({ count: 0, image: null }),
      });
    }

    const shell: DesktopShell = {
      platform: bridge.platform,
      appVersion: bridge.appVersion,
      updates: { state: updates.get, subscribe: updates.subscribe },
      menu,
    };
    context.services.provide(DESKTOP_SHELL_CAPABILITY, shell);

    // T3's Paste as Text from the Edit menu (D946, paste-as-text.ts).
    context.commands.register({
      name: "desktop.paste-as-text",
      title: "Paste as Text",
      description:
        "Pastes the clipboard into the focused field as plain text; in the composer a large paste stays inline instead of becoming a file",
      input: z.object({}),
      output: z.object({}),
      handler: async () => {
        await pasteAsText({
          has: (command) => context.commands.list().some((info) => info.name === command),
          execute: (command) => context.commands.execute(command, {}),
          paste: bridge.pasteAsText?.bind(bridge),
        });
        return {};
      },
    });
    // Every update action is a command (D520), so the palette, keybindings and other plugins reach it.
    context.commands.register({
      name: "desktop.update.state",
      description: "The desktop app's update state",
      input: z.object({}),
      output: DesktopUpdateState,
      handler: () => updates.get(),
    });
    context.commands.register({
      name: "desktop.update.check",
      title: "Check for updates",
      description: "Checks the release track for a newer version of the desktop app",
      input: z.object({}),
      output: DesktopUpdateCheckResult,
      handler: async () => {
        const result = DesktopUpdateCheckResult.parse(await bridge.checkForUpdate());
        updates.set(result.state);
        return result;
      },
    });
    context.commands.register({
      name: "desktop.update.download",
      title: "Download update",
      description: "Downloads the available version of the desktop app",
      input: z.object({}),
      output: DesktopUpdateActionResult,
      handler: async () => {
        const result = DesktopUpdateActionResult.parse(await bridge.downloadUpdate());
        updates.set(result.state);
        return result;
      },
    });
    context.commands.register({
      name: "desktop.update.install",
      title: "Install update and restart",
      description: "Installs the downloaded version and restarts the desktop app",
      input: z.object({}),
      output: DesktopUpdateActionResult,
      handler: async () => {
        const result = DesktopUpdateActionResult.parse(await bridge.installUpdate());
        updates.set(result.state);
        return result;
      },
    });
    context.commands.register({
      name: "desktop.update.channel.set",
      description: "Chooses the release track: stable releases (latest) or nightly builds",
      input: z.object({ channel: DesktopUpdateChannel }),
      output: DesktopUpdateState,
      handler: async ({ channel }) => {
        const state = DesktopUpdateState.parse(await bridge.setUpdateChannel(channel));
        updates.set(state);
        return state;
      },
    });

    const failed = (title: string, error: unknown, fallback: string) =>
      toasts?.show({
        type: "error",
        title,
        description: error instanceof Error ? error.message : fallback,
      });

    /** T3's download: a toast when it finished, the updater's message when it did not. */
    const download = async (notifyDownloaded: boolean) => {
      try {
        const result = (await context.commands.execute(
          "desktop.update.download",
          {},
        )) as DesktopUpdateActionResult;
        if (result.completed && notifyDownloaded) {
          const releaseUrl = getDesktopUpdateReleaseUrl(
            getDesktopUpdateDownloadedVersion(result.state),
          );
          toasts?.show({
            type: "success",
            title: "Update downloaded",
            description: (
              <>
                Restart the app from the update button to install it.
                {releaseUrl === null ? null : (
                  <a
                    className="ml-2 inline text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
                    href={releaseUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Read more
                  </a>
                )}
              </>
            ),
          });
        }
        const error = getDesktopUpdateActionError(result);
        if (error !== null)
          toasts?.show({ type: "error", title: "Could not download update", description: error });
      } catch (error) {
        failed("Could not start update download", error, "An unexpected error occurred.");
      }
    };

    /** Asks first (T3's text); an accepted install quits the app. */
    const install = async () => {
      const state = updates.get();
      let confirmed = false;
      try {
        confirmed =
          dialogs === undefined
            ? // Without the page's dialogs, the window's own confirmation: never install unasked.
              window.confirm(Object.values(getDesktopUpdateInstallConfirmation(state)).join("\n\n"))
            : await dialogs.confirm({
                ...getDesktopUpdateInstallConfirmation(state),
                confirmLabel: "Install",
              });
      } catch (error) {
        failed("Could not confirm update", error, "Update confirmation failed.");
        return;
      }
      if (!confirmed) return;
      try {
        const result = (await context.commands.execute(
          "desktop.update.install",
          {},
        )) as DesktopUpdateActionResult;
        const error = getDesktopUpdateActionError(result);
        if (error !== null)
          toasts?.show({ type: "error", title: "Could not install update", description: error });
      } catch (error) {
        failed("Could not install update", error, "An unexpected error occurred.");
      }
    };

    const check = async () => {
      try {
        const result = (await context.commands.execute(
          "desktop.update.check",
          {},
        )) as DesktopUpdateCheckResult;
        if (!result.checked) {
          toasts?.show({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      } catch (error) {
        failed("Could not check for updates", error, "Update check failed.");
      }
    };

    const subscribeUpdates = (listener: () => void) => {
      const subscription = updates.subscribe(listener);
      return () => subscription.dispose();
    };
    const useUpdateState = () => useSyncExternalStore(subscribeUpdates, updates.get);

    /** T3's sidebar update control: checks when idle, downloads, then installs. */
    function UpdateControl() {
      const state = useUpdateState();
      const [pending, setPending] = useState(false);
      const action = resolveDesktopUpdateButtonAction(state);
      const checking = state.status === "checking";
      const downloading = state.status === "downloading";
      const showDetails = action !== "none" || downloading;
      const iconStatus: StatusIconState = checking
        ? "checking"
        : downloading
          ? "downloading"
          : action === "install"
            ? "downloaded"
            : action === "download"
              ? "available"
              : "idle";
      const tooltip = showDetails
        ? getDesktopUpdateButtonTooltip(state)
        : checking
          ? "Checking for updates…"
          : "Check for updates";
      const disabled = checking
        ? true
        : showDetails
          ? isDesktopUpdateButtonDisabled(state)
          : !canCheckForUpdate(state);
      const inert = disabled || pending;
      const run = () => {
        if (inert) return;
        setPending(true);
        const work =
          action === "download" ? download(true) : action === "install" ? install() : check();
        void work.finally(() => setPending(false));
      };
      return (
        <SidebarMenuItem className="shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-disabled={inert || undefined}
                  aria-label={tooltip}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                    inert ? "cursor-not-allowed" : "cursor-pointer",
                    showDetails
                      ? cn(
                          "bg-sidebar-control-surface text-sidebar-foreground",
                          !inert && "hover:bg-sidebar-row-hover",
                        )
                      : cn(
                          "text-(--sidebar-icon-color)",
                          !inert && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                        ),
                    disabled && !showDetails && "opacity-60",
                  )}
                  onClick={run}
                  type="button"
                />
              }
            >
              <StatusIcon downloadPercent={state.downloadPercent} status={iconStatus} />
            </TooltipTrigger>
            <TooltipPopup side="top">{tooltip}</TooltipPopup>
          </Tooltip>
        </SidebarMenuItem>
      );
    }
    context.subscriptions.add(
      slots.contribute("sidebar.footer", { id: "desktop.update", component: UpdateControl }),
    );

    /** T3's About section: the version with its update button, and the update track. */
    function AboutSection() {
      const state = useUpdateState();
      const [pending, setPending] = useState(false);
      const [changingChannel, setChangingChannel] = useState(false);
      const action = resolveDesktopUpdateButtonAction(state);
      const tooltip = getDesktopUpdateButtonTooltip(state);
      const disabled =
        action === "none" ? !canCheckForUpdate(state) : isDesktopUpdateButtonDisabled(state);
      const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
      const statusLabel: Record<string, string> = {
        checking: "Checking…",
        downloading: "Downloading…",
        "up-to-date": "Up to Date",
      };
      const label = actionLabel[action] ?? statusLabel[state.status] ?? "Check for Updates";
      const run = () => {
        setPending(true);
        const work =
          action === "download" ? download(true) : action === "install" ? install() : check();
        void work.finally(() => setPending(false));
      };
      const chooseChannel = (channel: DesktopUpdateChannel) => {
        if (channel === state.channel) return;
        setChangingChannel(true);
        void context.commands
          .execute("desktop.update.channel.set", { channel })
          .catch((error: unknown) =>
            failed("Could not change update track", error, "Update track change failed."),
          )
          .finally(() => setChangingChannel(false));
      };
      return (
        <SettingsSection id="about" title="About">
          <SettingsRow
            control={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      disabled={disabled || pending}
                      onClick={run}
                      size="sm"
                      variant="outline"
                    >
                      {label}
                    </Button>
                  }
                />
                <TooltipPopup>{tooltip}</TooltipPopup>
              </Tooltip>
            }
            description={
              action === "download" || action === "install"
                ? "Update available."
                : "Current version of the application."
            }
            title={
              <span className="inline-flex items-baseline gap-2">
                <span>Version</span>
                <code className="text-2xs font-medium text-muted-foreground">
                  {bridge!.appVersion}
                </code>
              </span>
            }
          />
          <SettingsRow
            control={
              <Select
                onValueChange={(value) => chooseChannel(value as DesktopUpdateChannel)}
                value={state.channel}
              >
                <SelectTrigger
                  aria-label="Update track"
                  className="w-full sm:w-40"
                  disabled={changingChannel}
                  size="sm"
                >
                  <SelectValue>{state.channel === "nightly" ? "Nightly" : "Stable"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="latest">Stable</SelectItem>
                  <SelectItem value="nightly">Nightly</SelectItem>
                </SelectPopup>
              </Select>
            }
            description="Use stable releases or nightly builds. Switch back anytime."
            title="Update track"
          />
        </SettingsSection>
      );
    }
    if (pages !== undefined) {
      context.subscriptions.add(
        pages.addSection({
          id: "about",
          label: "About",
          icon: InfoIcon,
          order: 90,
          component: AboutSection,
        }),
      );
    }
  },
});
