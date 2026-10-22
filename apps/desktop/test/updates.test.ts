import type { DesktopUpdateChannel, DesktopUpdateState } from "@jhin/desktop-api";
import { describe, expect, it } from "vite-plus/test";

import {
  autoUpdateDisabledReason,
  UpdateController,
  type Updater,
  type UpdateEnvironment,
} from "../src/updates/controller.ts";
import {
  createBaseUpdateState,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "../src/updates/machine.ts";

const PACKAGED: UpdateEnvironment = {
  appVersion: "0.1.0",
  isPackaged: true,
  platform: "linux",
  appImage: "/opt/Jhin.AppImage",
  isDebPackage: false,
  disabledByEnv: false,
  hasFeed: true,
  feedOverride: false,
};

/** An updater whose answers the test chooses; it records what the controller asked. */
function fakeUpdater() {
  const calls: string[] = [];
  let next: { version: string; releaseNotes?: unknown } | null | Error = null;
  let download: ((onProgress: (percent: number) => void) => Promise<void>) | undefined;
  let quit: () => void = () => calls.push("quitAndInstall");
  let reportError: (error: unknown) => void = () => undefined;
  const updater: Updater = {
    async check() {
      calls.push("check");
      if (next instanceof Error) throw next;
      return next;
    },
    download: (onProgress) => {
      calls.push("download");
      return download?.(onProgress) ?? Promise.resolve();
    },
    quitAndInstall: () => quit(),
    setChannel: (channel) => void calls.push(`channel:${channel}`),
    setAllowDowngrade: (allow) => void calls.push(`downgrade:${allow}`),
    onError: (listener) => void (reportError = listener),
  };
  return {
    updater,
    calls,
    offer: (value: { version: string; releaseNotes?: unknown } | null | Error) =>
      void (next = value),
    onDownload: (run: (onProgress: (percent: number) => void) => Promise<void>) =>
      void (download = run),
    onQuit: (run: () => void) => void (quit = run),
    reportError: (error: unknown) => reportError(error),
  };
}

function controller(
  fake: ReturnType<typeof fakeUpdater>,
  options: { environment?: UpdateEnvironment; channel?: DesktopUpdateChannel } = {},
) {
  const persisted: DesktopUpdateChannel[] = [];
  const lifecycle: string[] = [];
  const updates = new UpdateController({
    updater: fake.updater,
    environment: options.environment ?? PACKAGED,
    channel: options.channel ?? "latest",
    persistChannel: (channel) => void persisted.push(channel),
    beforeInstall: async () => void lifecycle.push("node stopped"),
    afterFailedInstall: async () => void lifecycle.push("node started"),
    now: () => "2026-10-20T12:00:00.000Z",
  });
  const states: DesktopUpdateState[] = [];
  updates.onState((state) => states.push(state));
  return { updates, persisted, lifecycle, states };
}

describe("autoUpdateDisabledReason", () => {
  it("gives T3's reasons in T3's order", () => {
    expect(autoUpdateDisabledReason(PACKAGED)).toBeNull();
    expect(autoUpdateDisabledReason({ ...PACKAGED, hasFeed: false, isPackaged: false })).toBe(
      "Automatic updates are not available because no update feed is configured.",
    );
    expect(autoUpdateDisabledReason({ ...PACKAGED, isPackaged: false })).toBe(
      "Automatic updates are only available in packaged production builds.",
    );
    expect(autoUpdateDisabledReason({ ...PACKAGED, disabledByEnv: true })).toBe(
      "Automatic updates are disabled by the JHIN_DISABLE_AUTO_UPDATE setting.",
    );
    expect(autoUpdateDisabledReason({ ...PACKAGED, appImage: undefined })).toBe(
      "Automatic updates on Linux require the AppImage or the .deb package.",
    );
    expect(
      autoUpdateDisabledReason({ ...PACKAGED, appImage: undefined, isDebPackage: true }),
    ).toBeNull();
    // The test feed works in a build that is not packaged.
    expect(
      autoUpdateDisabledReason({
        ...PACKAGED,
        isPackaged: false,
        appImage: undefined,
        feedOverride: true,
      }),
    ).toBeNull();
  });
});

describe("UpdateController", () => {
  it("starts disabled with the reason, and refuses every action", async () => {
    const fake = fakeUpdater();
    const { updates } = controller(fake, { environment: { ...PACKAGED, isPackaged: false } });

    expect(updates.state).toMatchObject({
      enabled: false,
      status: "disabled",
      message: "Automatic updates are only available in packaged production builds.",
    });
    expect(await updates.check()).toMatchObject({ checked: false });
    expect(await updates.download()).toMatchObject({ accepted: false });
    expect(await updates.install()).toMatchObject({ accepted: false });
    expect(fake.calls).toEqual([]);
  });

  it("checks, downloads with progress, and installs after stopping the node", async () => {
    const fake = fakeUpdater();
    const { updates, states, lifecycle } = controller(fake);
    fake.offer({ version: "1.2.0" });

    const checked = await updates.check();
    expect(checked).toMatchObject({
      checked: true,
      state: {
        status: "available",
        availableVersion: "1.2.0",
        checkedAt: "2026-10-20T12:00:00.000Z",
      },
    });
    expect(states.map((state) => state.status)).toEqual(["checking", "available"]);

    fake.onDownload(async (onProgress) => {
      onProgress(10.2);
      onProgress(10.8); // the same whole percent is not reported twice
      onProgress(55);
    });
    const downloaded = await updates.download();
    expect(downloaded).toMatchObject({
      accepted: true,
      completed: true,
      state: {
        status: "downloaded",
        downloadedVersion: "1.2.0",
        downloadPercent: 100,
        canRetry: true,
      },
    });
    expect(states.slice(2).map((state) => [state.status, state.downloadPercent])).toEqual([
      ["downloading", 0],
      ["downloading", 10.2],
      ["downloading", 55],
      ["downloaded", 100],
    ]);

    expect(await updates.install()).toMatchObject({ accepted: true, completed: false });
    expect(lifecycle).toEqual(["node stopped"]);
    expect(fake.calls.at(-1)).toBe("quitAndInstall");
  });

  it("ignores a version of the other track", async () => {
    const fake = fakeUpdater();
    const { updates } = controller(fake);
    fake.offer({ version: "1.3.0-nightly.20261020.1" });

    const result = await updates.check();

    expect(result.state).toMatchObject({ status: "up-to-date", availableVersion: null });
  });

  it("shows nightly's release notes of its own track, and clears them when up to date (D948)", async () => {
    const fake = fakeUpdater();
    const { updates } = controller(fake, { channel: "nightly" });
    fake.offer({
      version: "1.3.0-nightly.20261021.2",
      releaseNotes: [
        {
          version: "1.3.0-nightly.20261021.2",
          note: "## What's Changed\n- fix: second\n- feat: first",
        },
        { version: "1.3.0-preview.20261021.1", note: "- a preview cut" },
        { version: "1.3.0-nightly.20261020.1", note: "<ul><li>older &amp; done</li></ul>" },
      ],
    });

    const offered = await updates.check();

    expect(offered.state.releaseNotes).toEqual([
      { version: "1.3.0-nightly.20261021.2", items: ["feat: first", "fix: second"], totalItems: 2 },
      { version: "1.3.0-nightly.20261020.1", items: ["older & done"], totalItems: 1 },
    ]);
    expect(offered.state.omittedReleaseCount).toBe(0);

    fake.offer(null);
    const latest = await updates.check();
    expect(latest.state).toMatchObject({ status: "up-to-date", releaseNotes: [] });
  });

  it("keeps the offer after a failed download, so it can be retried", async () => {
    const fake = fakeUpdater();
    const { updates } = controller(fake);
    fake.offer({ version: "1.2.0" });
    await updates.check();
    fake.onDownload(async () => {
      throw new Error("connection reset");
    });

    const failed = await updates.download();

    expect(failed).toMatchObject({
      accepted: true,
      completed: false,
      state: {
        status: "available",
        message: "connection reset",
        errorContext: "download",
        canRetry: true,
      },
    });
    fake.onDownload(async () => undefined);
    expect(await updates.download()).toMatchObject({ completed: true });
  });

  it("reports a failed check as T3 does", async () => {
    const fake = fakeUpdater();
    const { updates } = controller(fake);
    fake.offer(new Error("feed unreachable"));

    const result = await updates.check();

    expect(result.state).toMatchObject({
      status: "error",
      message: "feed unreachable",
      errorContext: "check",
      canRetry: true,
    });
  });

  it("starts the node again when the install cannot quit", async () => {
    const fake = fakeUpdater();
    const { updates, lifecycle } = controller(fake);
    fake.offer({ version: "1.2.0" });
    await updates.check();
    await updates.download();
    fake.onQuit(() => {
      throw new Error("installer missing");
    });

    const result = await updates.install();

    expect(lifecycle).toEqual(["node stopped", "node started"]);
    expect(result.state).toMatchObject({
      status: "downloaded",
      message: "installer missing",
      errorContext: "install",
      canRetry: true,
    });
    updates.stop();
  });

  it("runs one action at a time", async () => {
    const fake = fakeUpdater();
    const { updates } = controller(fake);
    fake.offer({ version: "1.2.0" });
    await updates.check();
    let finish!: () => void;
    fake.onDownload(() => new Promise<void>((resolve) => (finish = resolve)));

    const downloading = updates.download();
    expect(await updates.check()).toMatchObject({ checked: false });
    expect(await updates.download()).toMatchObject({ accepted: false });
    await expect(updates.setChannel("nightly")).rejects.toThrow(
      "Cannot change the desktop update channel to nightly while an update download action is in progress.",
    );
    finish();
    expect(await downloading).toMatchObject({ completed: true });
  });

  it("switches the track: keeps it, and checks at once allowing an older version", async () => {
    const fake = fakeUpdater();
    const { updates, persisted } = controller(fake);
    fake.offer({ version: "0.2.0-nightly.20261020.1" });

    const state = await updates.setChannel("nightly");

    expect(persisted).toEqual(["nightly"]);
    expect(state).toMatchObject({
      channel: "nightly",
      status: "available",
      availableVersion: "0.2.0-nightly.20261020.1",
    });
    expect(fake.calls).toEqual([
      "channel:latest",
      "channel:nightly",
      "downgrade:true",
      "check",
      "downgrade:false",
    ]);
  });

  it("recovers when the updater reports the install failed after quitAndInstall returned", async () => {
    const fake = fakeUpdater();
    const { updates, lifecycle, states } = controller(fake);
    fake.offer({ version: "1.2.0" });
    await updates.check();
    await updates.download();
    expect(await updates.install()).toMatchObject({ accepted: true });

    const recovered = new Promise<void>((resolve) =>
      updates.onState((state) => state.errorContext === "install" && resolve()),
    );
    fake.reportError(new Error("installer exited"));
    await recovered;

    expect(lifecycle).toEqual(["node stopped", "node started"]);
    expect(states.at(-1)).toMatchObject({ status: "downloaded", message: "installer exited" });
    // The action is free again.
    expect(await updates.check()).toMatchObject({ checked: true });
    updates.stop();
  });
});

describe("release notes in the update state (D948)", () => {
  const note = { version: "1.3.0-nightly.20261021.2", items: ["fix: a"], totalItems: 1 };
  const base = {
    ...createBaseUpdateState("1.2.0-nightly.20261020.1", "nightly", null),
    downloadedVersion: "1.3.0-nightly.20261021.2",
    status: "downloaded" as const,
    releaseNotes: [note],
    omittedReleaseCount: 2,
  };

  it("keeps a downloaded version's notes through a check that brings none (T3)", () => {
    const checking = reduceDesktopUpdateStateOnCheckStart(base, "t");
    expect(checking).toMatchObject({ releaseNotes: [note], omittedReleaseCount: 2 });
    const again = reduceDesktopUpdateStateOnUpdateAvailable(checking, note.version, "t");
    expect(again).toMatchObject({
      status: "downloaded",
      releaseNotes: [note],
      omittedReleaseCount: 2,
    });
  });

  it("drops the notes when a check starts without a download", () => {
    const idle = { ...base, downloadedVersion: null, status: "available" as const };
    expect(reduceDesktopUpdateStateOnCheckStart(idle, "t")).toMatchObject({
      releaseNotes: [],
      omittedReleaseCount: 0,
    });
  });
});
