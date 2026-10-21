// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/desktopUpdate.logic.ts.
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@jhin/desktop-api";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event. A download can resolve before that write lands, so fall back to the
 * version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

/** T3's confirmation text, as the title and description of a `ui.dialogs` confirmation. */
export function getDesktopUpdateInstallConfirmation(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): { readonly title: string; readonly description: string } {
  const version = state.downloadedVersion ?? state.availableVersion;
  return {
    title: `Install update${version ? ` ${version}` : ""} and restart Jhin?`,
    description: "Any running tasks will be interrupted. Make sure you're ready before continuing.",
  };
}

const RELEASES = "https://github.com/Astroreen/jhin/releases";

/** The release page of a version on this repository's GitHub releases (D519). */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalized = version?.trim();
  if (!normalized) return null;
  return `${RELEASES}/tag/v${encodeURIComponent(normalized)}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
