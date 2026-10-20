import type { DesktopUpdateState } from "@jhin/desktop-api";
import { describe, expect, it } from "vite-plus/test";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmation,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "../src/update-logic.ts";

const IDLE: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.0",
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("the update control (T3's desktopUpdate.logic)", () => {
  it("checks when idle, downloads an offer, installs a download", () => {
    expect(resolveDesktopUpdateButtonAction(IDLE)).toBe("none");
    expect(canCheckForUpdate(IDLE)).toBe(true);
    expect(canCheckForUpdate({ ...IDLE, status: "disabled", enabled: false })).toBe(false);

    const available = { ...IDLE, status: "available" as const, availableVersion: "1.2.0" };
    expect(resolveDesktopUpdateButtonAction(available)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(available)).toBe("Update 1.2.0 ready to download");

    const downloading = { ...available, status: "downloading" as const, downloadPercent: 40.7 };
    expect(getDesktopUpdateButtonTooltip(downloading)).toBe("Downloading update (40%)");
    expect(canCheckForUpdate(downloading)).toBe(false);

    const downloaded = { ...available, status: "downloaded" as const, downloadedVersion: "1.2.0" };
    expect(resolveDesktopUpdateButtonAction(downloaded)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(downloaded)).toBe(
      "Update 1.2.0 downloaded. Click to restart and install.",
    );
  });

  it("offers a retry after a failure", () => {
    const failedDownload = {
      ...IDLE,
      status: "error" as const,
      availableVersion: "1.2.0",
      errorContext: "download" as const,
    };
    expect(resolveDesktopUpdateButtonAction(failedDownload)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(failedDownload)).toBe(
      "Download failed for 1.2.0. Click to retry.",
    );
    const failedCheck = { ...IDLE, status: "error" as const, message: "feed unreachable" };
    expect(resolveDesktopUpdateButtonAction(failedCheck)).toBe("none");
    expect(getDesktopUpdateButtonTooltip(failedCheck)).toBe("feed unreachable");
  });

  it("asks before installing, in T3's words, and links the release", () => {
    expect(
      getDesktopUpdateInstallConfirmation({
        availableVersion: "1.2.0",
        downloadedVersion: "1.2.0",
      }),
    ).toEqual({
      title: "Install update 1.2.0 and restart Jhin?",
      description:
        "Any running tasks will be interrupted. Make sure you're ready before continuing.",
    });
    expect(getDesktopUpdateReleaseUrl("1.2.0")).toBe(
      "https://github.com/Astroreen/jhin/releases/tag/v1.2.0",
    );
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
  });
});
