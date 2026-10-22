// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/updates/DesktopUpdates.ts.
// T3's Effect services become one class over an injected updater, so the flow is tested
// without Electron (test/updates.test.ts).
import type {
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@jhin/desktop-api";

import { resolveDefaultDesktopUpdateChannel } from "./channels.ts";
import {
  createBaseUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./machine.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./release-notes.ts";

/** T3's timing: the first check after start, then a check every few minutes (D519). */
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60_000;

/** What the controller needs of electron-updater; `electron-updater.ts` adapts it. */
export interface Updater {
  /** The newest version on the feed, or null when the feed has none newer. */
  check(): Promise<{
    readonly version: string;
    /** electron-updater's `releaseNotes`: a string, or a list per release with nightly's full changelog. */
    readonly releaseNotes?: unknown;
  } | null>;
  /** Downloads the version the last check found; resolves once it is complete. */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Quits the app, installs the download and starts the new version. */
  quitAndInstall(): void;
  setChannel(channel: DesktopUpdateChannel): void;
  setAllowDowngrade(allow: boolean): void;
  /** An error the updater reports by itself, e.g. an install that did not start after `quitAndInstall`. */
  onError(listener: (error: unknown) => void): void;
}

export interface UpdateEnvironment {
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  /** The AppImage the app runs from, if it does (Linux). */
  readonly appImage: string | undefined;
  readonly isDebPackage: boolean;
  /** `JHIN_DISABLE_AUTO_UPDATE` is set. */
  readonly disabledByEnv: boolean;
  /** A packaged `app-update.yml`, or `JHIN_DESKTOP_UPDATE_FEED`. */
  readonly hasFeed: boolean;
  /** `JHIN_DESKTOP_UPDATE_FEED` is set: the feed of tests, also in a build that is not packaged. */
  readonly feedOverride: boolean;
}

/** T3's reasons, in its order; null when updates are possible. */
export function autoUpdateDisabledReason(environment: UpdateEnvironment): string | null {
  if (!environment.hasFeed) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (environment.disabledByEnv) {
    return "Automatic updates are disabled by the JHIN_DISABLE_AUTO_UPDATE setting.";
  }
  if (environment.feedOverride) return null;
  if (!environment.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (environment.platform === "linux" && !environment.appImage && !environment.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

export interface UpdateControllerOptions {
  readonly updater: Updater;
  readonly environment: UpdateEnvironment;
  readonly channel: DesktopUpdateChannel;
  /** Keeps the chosen track (the app's settings file). */
  persistChannel(channel: DesktopUpdateChannel): void;
  /** Runs before the app quits to install: stops the node (D522). */
  beforeInstall(): Promise<void>;
  /** An install that failed to quit: starts the node again. */
  afterFailedInstall(): Promise<void>;
  /** ISO time of a check; injectable for tests. */
  now?(): string;
  log?(message: string, fields?: Record<string, unknown>): void;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return typeof error === "string" && error.trim() !== "" ? error : "An unknown error occurred.";
}

/** The app's update flow: one action at a time, every change reported to listeners. */
export class UpdateController {
  readonly #options: UpdateControllerOptions;
  readonly #disabledReason: string | null;
  readonly #listeners = new Set<(state: DesktopUpdateState) => void>();
  #state: DesktopUpdateState;
  #action: UpdateAction | undefined;
  #startupCheck: ReturnType<typeof setTimeout> | undefined;
  #pollChecks: ReturnType<typeof setInterval> | undefined;

  constructor(options: UpdateControllerOptions) {
    this.#options = options;
    this.#disabledReason = autoUpdateDisabledReason(options.environment);
    this.#state = createBaseUpdateState(
      options.environment.appVersion,
      options.channel,
      this.#disabledReason,
    );
    if (this.enabled) options.updater.setChannel(options.channel);
    // electron-updater reports a failed install asynchronously, after quitAndInstall returned.
    options.updater.onError((error) => {
      if (this.#action === "install") void this.#installFailed(error);
    });
  }

  get enabled(): boolean {
    return this.#disabledReason === null;
  }

  /** Why updates are off, for the menu's "Updates unavailable" dialog. */
  get disabledReason(): string | null {
    return this.#disabledReason;
  }

  get state(): DesktopUpdateState {
    return this.#state;
  }

  onState(listener: (state: DesktopUpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts T3's background checks: one after start, then one every few minutes. */
  start(): void {
    if (!this.enabled || this.#pollChecks !== undefined) return;
    const run = (reason: string) =>
      void this.check(reason).catch((error: unknown) =>
        this.#log("background update check failed", { reason, error: describe(error) }),
      );
    this.#startupCheck = setTimeout(() => run("startup"), AUTO_UPDATE_STARTUP_DELAY_MS);
    this.#pollChecks = setInterval(() => run("poll"), AUTO_UPDATE_POLL_INTERVAL_MS);
  }

  stop(): void {
    clearTimeout(this.#startupCheck);
    clearInterval(this.#pollChecks);
    this.#startupCheck = undefined;
    this.#pollChecks = undefined;
  }

  async check(reason = "manual"): Promise<DesktopUpdateCheckResult> {
    if (!this.enabled || this.#state.status === "downloading" || !this.#begin("check")) {
      return { checked: false, state: this.#state };
    }
    try {
      await this.#check(reason);
      return { checked: true, state: this.#state };
    } finally {
      this.#action = undefined;
    }
  }

  async download(): Promise<DesktopUpdateActionResult> {
    const canDownload =
      this.#state.availableVersion !== null &&
      (this.#state.status === "available" ||
        (this.#state.status === "error" && this.#state.errorContext === "download"));
    if (!this.enabled || !canDownload || !this.#begin("download")) {
      return { accepted: false, completed: false, state: this.#state };
    }
    const version = this.#state.availableVersion!;
    this.#set(reduceDesktopUpdateStateOnDownloadStart(this.#state));
    try {
      await this.#options.updater.download((percent) => {
        // T3 broadcasts whole percents only.
        if (Math.floor(percent) === Math.floor(this.#state.downloadPercent ?? -1)) return;
        this.#set(reduceDesktopUpdateStateOnDownloadProgress(this.#state, percent));
      });
      this.#set(reduceDesktopUpdateStateOnDownloadComplete(this.#state, version));
      this.#log("update downloaded", { version });
      return { accepted: true, completed: true, state: this.#state };
    } catch (error) {
      this.#set(reduceDesktopUpdateStateOnDownloadFailure(this.#state, describe(error)));
      this.#log("update download failed", { version, error: describe(error) });
      return { accepted: true, completed: false, state: this.#state };
    } finally {
      this.#action = undefined;
    }
  }

  async install(): Promise<DesktopUpdateActionResult> {
    const installable =
      this.#state.downloadedVersion !== null &&
      (this.#state.status === "downloaded" ||
        (this.#state.status === "error" &&
          (this.#state.errorContext === null || this.#state.errorContext === "install")));
    if (!this.enabled || !installable || !this.#begin("install")) {
      return { accepted: false, completed: false, state: this.#state };
    }
    this.stop();
    try {
      await this.#options.beforeInstall();
      this.#options.updater.quitAndInstall();
      return { accepted: true, completed: false, state: this.#state };
    } catch (error) {
      // The updater may have reported the same failure already.
      if (this.#action === "install") await this.#installFailed(error);
      return { accepted: true, completed: false, state: this.#state };
    }
  }

  /** The node back, the failure in the state, the action free and the checks running again. */
  async #installFailed(error: unknown): Promise<void> {
    this.#log("update install failed", { error: describe(error) });
    // Released first, so a second report of the same failure is ignored.
    this.#action = "install-recovery";
    await this.#options
      .afterFailedInstall()
      .catch((restart: unknown) =>
        this.#log("node restart after a failed install failed", { error: describe(restart) }),
      );
    this.#set(reduceDesktopUpdateStateOnInstallFailure(this.#state, describe(error)));
    this.#action = undefined;
    this.start();
  }

  /** Switches the track, keeps the choice and checks at once, allowing an older version. */
  async setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateState> {
    if (this.#action !== undefined) {
      throw new Error(
        `Cannot change the desktop update channel to ${channel} while an update ${this.#action} action is in progress.`,
      );
    }
    if (channel === this.#state.channel) return this.#state;
    this.#options.persistChannel(channel);
    this.#set(createBaseUpdateState(this.#state.currentVersion, channel, this.#disabledReason));
    if (!this.enabled) return this.#state;
    this.#action = "channel";
    try {
      this.#options.updater.setChannel(channel);
      this.#options.updater.setAllowDowngrade(true);
      await this.#check("channel-change");
    } finally {
      this.#options.updater.setAllowDowngrade(false);
      this.#action = undefined;
    }
    return this.#state;
  }

  async #check(reason: string): Promise<void> {
    const checkedAt = this.#now();
    this.#set(reduceDesktopUpdateStateOnCheckStart(this.#state, checkedAt));
    try {
      const found = await this.#options.updater.check();
      if (found === null) {
        this.#set(reduceDesktopUpdateStateOnNoUpdate(this.#state, this.#now()));
        this.#log("no updates available", { reason });
      } else if (resolveDefaultDesktopUpdateChannel(found.version) !== this.#state.channel) {
        this.#log("ignoring update that does not match selected channel", {
          version: found.version,
          channel: this.#state.channel,
        });
        this.#set(reduceDesktopUpdateStateOnNoUpdate(this.#state, this.#now()));
      } else {
        // T3's release notes (D948): nightly lists every release since this one.
        const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
          found.releaseNotes,
          found.version,
          this.#state.channel,
        );
        this.#set(
          reduceDesktopUpdateStateOnUpdateAvailable(
            this.#state,
            found.version,
            this.#now(),
            releaseNotes,
            omittedReleaseCount,
          ),
        );
        this.#log("update available", {
          version: found.version,
          reason,
          releaseNoteGroups: releaseNotes.length,
        });
      }
    } catch (error) {
      this.#set(reduceDesktopUpdateStateOnCheckFailure(this.#state, describe(error), this.#now()));
      this.#log("update check failed", { reason, error: describe(error) });
    }
  }

  #begin(action: UpdateAction): boolean {
    if (this.#action !== undefined) return false;
    this.#action = action;
    return true;
  }

  #set(state: DesktopUpdateState): void {
    this.#state = state;
    for (const listener of Array.from(this.#listeners)) listener(state);
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString();
  }

  #log(message: string, fields?: Record<string, unknown>): void {
    this.#options.log?.(message, fields);
  }
}
