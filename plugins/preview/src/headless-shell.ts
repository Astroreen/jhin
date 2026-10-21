// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/preview/PreviewBrowser.ts
// (the pinned release, its checks and the safe unpacking) and apps/server/src/zipArchive.ts,
// without Effect. docs/plans/preview.md, D951.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Yauzl from "yauzl";

// To bump the pin, pick a version from
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
// download each platform's chrome-headless-shell zip, and replace the version and every byte count
// and SHA-256 below.
const VERSION = "154.0.8037.92";
const ARCHIVES = {
  linux64: {
    bytes: 120_477_194,
    sha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
  },
  "linux-arm64": {
    bytes: 121_182_296,
    sha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
  },
  "mac-arm64": {
    bytes: 99_221_129,
    sha256: "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929",
  },
  "mac-x64": {
    bytes: 104_748_425,
    sha256: "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4",
  },
  win32: {
    bytes: 114_295_943,
    sha256: "56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7",
  },
  win64: {
    bytes: 120_822_223,
    sha256: "3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568",
  },
} as const;

function chromePlatform(platform: NodeJS.Platform, arch: string) {
  switch (platform) {
    case "linux":
      return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
    case "darwin":
      return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
    case "win32":
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === "ia32" ? "win32" : arch === "x64" || arch === "arm64" ? "win64" : null;
    default:
      return null;
  }
}

export interface HeadlessShellRelease {
  readonly version: string;
  readonly platform: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export function headlessShellRelease(
  platform: NodeJS.Platform,
  arch: string,
): HeadlessShellRelease | null {
  const chrome = chromePlatform(platform, arch);
  return chrome === null
    ? null
    : {
        version: VERSION,
        platform: chrome,
        url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip`,
        ...ARCHIVES[chrome],
      };
}

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

/** The install failed; the next request starts it again. */
class HeadlessShellInstallError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`Jhin could not install its headless browser: ${detail} Try again.`, options);
  }
}

/** The install runs; asking again later finds it done. */
class HeadlessShellInstallingError extends Error {
  constructor(downloadedBytes: number, totalBytes: number, unpacking: boolean) {
    const progress = unpacking
      ? "unpacking"
      : `${megabytes(downloadedBytes)} of ${megabytes(totalBytes)} MB downloaded`;
    super(`Jhin is installing its headless browser (${progress}). Try again in a minute.`);
  }
}

export interface HeadlessShellOptions {
  /** Where browsers are kept: `<root>/<platform>/<version>/`. */
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly release: HeadlessShellRelease | null;
  /** How long a caller waits on an install in progress (T3: 45 s, under a tool call's 60 s). */
  readonly waitMs?: number;
  readonly fetch?: typeof fetch;
}

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const STAGING_STALE_AFTER_MS = 60 * 60_000;

function openZip(file: string): Promise<Yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    Yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip)
          reject(
            new HeadlessShellInstallError("Could not open the verified archive.", { cause: error }),
          );
        else resolve(zip);
      },
    );
  });
}

function nextEntry(zip: Yauzl.ZipFile): Promise<Yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (cause: unknown) => {
      cleanup();
      reject(new HeadlessShellInstallError("The archive could not be read.", { cause }));
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function readEntry(zip: Yauzl.ZipFile, entry: Yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (cause, readable) => {
      if (cause || !readable) {
        reject(new HeadlessShellInstallError("Could not read an archive member.", { cause }));
      } else resolve(readable);
    });
  });
}

/**
 * T3's pinned `chrome-headless-shell` (D951): the first request downloads it
 * from Chrome for Testing into Jhin's home, checks its size and SHA-256 and
 * unpacks it safely; requests meanwhile wait a while, then get the progress.
 */
export function createHeadlessShell(options: HeadlessShellOptions) {
  const platform = options.platform ?? process.platform;
  const release = options.release;
  const waitMs = options.waitMs ?? 45_000;
  const download = options.fetch ?? fetch;
  const executableName =
    platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  // Absolute, so the unpacking's containment check compares like with like.
  const installRoot = Path.resolve(options.root, release?.platform ?? `${platform}`);
  const progress = { downloadedBytes: 0, unpacking: false };
  let installing: Promise<string> | undefined;
  /** Stops a download in progress when the plugin goes (rule 5). */
  const stopped = new AbortController();

  function installed(found: HeadlessShellRelease): string | undefined {
    const executable = Path.join(installRoot, found.version, executableName);
    try {
      const info = Fs.statSync(executable);
      return info.isFile() && (platform === "win32" || (info.mode & 0o111) !== 0)
        ? executable
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function fetchArchive(found: HeadlessShellRelease, archivePath: string): Promise<void> {
    let response: Response;
    try {
      response = await download(found.url, {
        signal: AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), stopped.signal]),
      });
    } catch (cause) {
      throw new HeadlessShellInstallError(
        "The download from storage.googleapis.com failed. Check this machine's network access.",
        { cause },
      );
    }
    if (!response.ok || response.body === null) {
      throw new HeadlessShellInstallError(
        `The download from storage.googleapis.com failed (HTTP ${response.status}).`,
      );
    }
    const length = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (
      (encoding === undefined || encoding === "identity") &&
      length !== null &&
      Number(length) !== found.bytes
    ) {
      throw new HeadlessShellInstallError("The download size did not match the pinned release.");
    }
    const hash = Crypto.createHash("sha256");
    const file = await Fs.promises.open(archivePath, "wx", 0o600);
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        progress.downloadedBytes += chunk.byteLength;
        if (progress.downloadedBytes > found.bytes) {
          throw new HeadlessShellInstallError("The download was larger than the pinned release.");
        }
        hash.update(chunk);
        await file.write(chunk);
      }
    } catch (cause) {
      if (cause instanceof HeadlessShellInstallError) throw cause;
      // A connection reset, the 15 min timeout or a full disk mid-download.
      throw new HeadlessShellInstallError(
        "The download from storage.googleapis.com stopped. Check this machine's network access and free disk space.",
        { cause },
      );
    } finally {
      await file.close();
    }
    if (progress.downloadedBytes !== found.bytes || hash.digest("hex") !== found.sha256) {
      throw new HeadlessShellInstallError(
        "The download failed its size or SHA-256 check. Nothing was installed.",
      );
    }
  }

  async function extract(found: HeadlessShellRelease, archivePath: string, destination: string) {
    const zip = await openZip(archivePath);
    try {
      const unsafe = () =>
        new HeadlessShellInstallError("The archive contains an unexpected or unsafe entry.");
      const root = `chrome-headless-shell-${found.platform}/`;
      await Fs.promises.mkdir(destination);
      let foundExecutable = false;
      for (;;) {
        const entry = await nextEntry(zip);
        if (entry === null) break;
        const unixMode = entry.externalFileAttributes >>> 16;
        const unixType = unixMode & 0o170000;
        const isDirectory = entry.fileName.endsWith("/");
        const relative = entry.fileName.startsWith(root) ? entry.fileName.slice(root.length) : null;
        const target = relative === null ? null : Path.resolve(destination, relative);
        if (
          relative === null ||
          target === null ||
          (relative !== "" && !target.startsWith(`${destination}${Path.sep}`)) ||
          relative.split("/").includes("..") ||
          (unixType !== 0 && unixType !== (isDirectory ? 0o040000 : 0o100000)) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          throw unsafe();
        }
        if (isDirectory) {
          await Fs.promises.mkdir(target, { recursive: true });
          continue;
        }
        await Fs.promises.mkdir(Path.dirname(target), { recursive: true });
        await pipeline(await readEntry(zip, entry), Fs.createWriteStream(target, { flags: "wx" }));
        // The binary and its shared libraries carry exec bits in the archive.
        if (platform !== "win32" && (unixMode & 0o777) !== 0) {
          await Fs.promises.chmod(target, unixMode & 0o777);
        }
        if (relative === executableName) foundExecutable = true;
      }
      if (!foundExecutable) {
        throw new HeadlessShellInstallError("The archive does not contain chrome-headless-shell.");
      }
    } finally {
      zip.close();
    }
  }

  async function install(found: HeadlessShellRelease): Promise<string> {
    await Fs.promises.mkdir(installRoot, { recursive: true });
    // Staging shares the install root's filesystem so publishing is one rename.
    const staging = await Fs.promises.mkdtemp(Path.join(installRoot, ".install-"));
    try {
      const archivePath = Path.join(staging, "download.zip");
      const unpacked = Path.join(staging, "browser");
      await fetchArchive(found, archivePath);
      progress.unpacking = true;
      try {
        await extract(found, archivePath, unpacked);
      } catch (cause) {
        if (cause instanceof HeadlessShellInstallError) throw cause;
        throw new HeadlessShellInstallError(
          "Could not unpack the browser. Check free disk space in Jhin's home directory.",
          { cause },
        );
      }
      const destination = Path.join(installRoot, found.version);
      // Another node of this home may have published the same version meanwhile, and
      // may be running it: a finished install is kept, not replaced.
      if (installed(found) === undefined) {
        await Fs.promises.rm(destination, { recursive: true, force: true });
        await Fs.promises.rename(unpacked, destination);
      }
    } finally {
      await Fs.promises.rm(staging, { recursive: true, force: true });
    }
    // Two nodes can share a home, so a staging directory touched within the
    // last hour may be another node's install in progress and stays.
    for (const name of await Fs.promises.readdir(installRoot)) {
      if (name === found.version) continue;
      const target = Path.join(installRoot, name);
      try {
        if (name.startsWith(".install-")) {
          const info = await Fs.promises.stat(target);
          if (Date.now() - info.mtimeMs < STAGING_STALE_AFTER_MS) continue;
        }
        await Fs.promises.rm(target, { recursive: true, force: true });
      } catch {
        // Another node's install, or a file in use: left for the next install.
      }
    }
    return Path.join(installRoot, found.version, executableName);
  }

  return {
    /** Stops a download in progress; the plugin calls it when it goes. */
    dispose(): void {
      stopped.abort();
    },
    /** The installed executable, if any, without installing. */
    installed: (): string | undefined => (release === null ? undefined : installed(release)),
    /**
     * The installed executable. The first call starts the install; callers
     * wait for it up to a bound and then get its progress, while it goes on.
     */
    async executable(): Promise<string> {
      if (release === null) {
        throw new HeadlessShellInstallError(
          `Chrome for Testing has no headless shell for ${platform}-${process.arch}.`,
        );
      }
      const ready = installed(release);
      if (ready !== undefined) return ready;
      if (installing === undefined) {
        progress.downloadedBytes = 0;
        progress.unpacking = false;
        const started = install(release);
        installing = started;
        // Settled, it is done: the next request looks at the disk again, and a failed
        // or removed install starts anew.
        const settle = () => {
          if (installing === started) installing = undefined;
        };
        started.then(settle, settle);
      }
      const current = installing;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<"waiting">((resolve) => {
        timer = setTimeout(() => resolve("waiting"), waitMs);
      });
      try {
        const result = await Promise.race([current, waited]);
        if (result === "waiting") {
          throw new HeadlessShellInstallingError(
            progress.downloadedBytes,
            release.bytes,
            progress.unpacking,
          );
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
