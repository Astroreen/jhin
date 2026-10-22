// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/browserImport.ts
// (source ids, unavailable and failure reasons and their copy). docs/plans/preview.md, D1204.
import { z } from "@jhin/sdk";

import { BrowserProfileId } from "./browser.ts";

export const BROWSER_IMPORT_SOURCE_IDS = [
  "chrome",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "arc",
  "helium",
  "firefox",
  "safari",
] as const;

export const BrowserImportSourceId = z.enum(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = z.output<typeof BrowserImportSourceId>;

export const BROWSER_IMPORT_UNAVAILABLE_REASONS = [
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
] as const;
export const BrowserImportUnavailableReason = z.enum(BROWSER_IMPORT_UNAVAILABLE_REASONS);
export type BrowserImportUnavailableReason = z.output<typeof BrowserImportUnavailableReason>;

export const BROWSER_IMPORT_FAILURE_REASONS = [
  ...BROWSER_IMPORT_UNAVAILABLE_REASONS,
  "keychainUnavailable",
  "unknownSource",
  "unknownSourceProfile",
  "sessionUnavailable",
  "profileNotSaved",
  "profileLimitReached",
  "readFailed",
] as const;
export const BrowserImportFailureReason = z.enum(BROWSER_IMPORT_FAILURE_REASONS);
export type BrowserImportFailureReason = z.output<typeof BrowserImportFailureReason>;

const TrimmedNonEmpty = z.string().trim().min(1);

export const BrowserImportSourceProfile = z.object({
  directory: TrimmedNonEmpty,
  name: TrimmedNonEmpty,
  cookieCount: z.number().int().optional(),
});
export type BrowserImportSourceProfile = z.output<typeof BrowserImportSourceProfile>;

export const BrowserImportSource = z.object({
  id: BrowserImportSourceId,
  name: TrimmedNonEmpty,
  profiles: z.array(BrowserImportSourceProfile),
  unavailable: BrowserImportUnavailableReason.optional(),
});
export type BrowserImportSource = z.output<typeof BrowserImportSource>;

export const PreviewImportSourcesResult = z.object({ sources: z.array(BrowserImportSource) });
export type PreviewImportSourcesResult = z.output<typeof PreviewImportSourcesResult>;

export const PreviewImportCookiesInput = z.object({
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmpty,
  targetProfileId: BrowserProfileId,
});
export type PreviewImportCookiesInput = z.output<typeof PreviewImportCookiesInput>;

export const PreviewImportCookiesResult = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
  skippedDomains: z.array(z.string()),
});
export type PreviewImportCookiesResult = z.output<typeof PreviewImportCookiesResult>;

const BROWSER_IMPORT_UNAVAILABLE_COPY: Readonly<Record<BrowserImportUnavailableReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing:
    "No encryption key in your Keychain — sign in to that browser once, then retry.",
  needsFullDiskAccess:
    "Give Jhin Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
};

/** T3's copy for every reason an import stops ("T3 Code" reads "Jhin"). */
export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  ...BROWSER_IMPORT_UNAVAILABLE_COPY,
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  profileLimitReached:
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  readFailed: "The browser's cookie database could not be read.",
};
