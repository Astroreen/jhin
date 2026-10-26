// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/browserProfile.ts
// (built-in profiles, resolveBrowserProfiles). docs/plans/preview.md, D953. The settings section
// that edits them is profiles.tsx, a chunk of its own (D1595).
import type { Connections, DeviceSettings } from "@jhin/client-api";
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@jhin/preview-api";
import { z } from "@jhin/sdk";
import type { Dialogs, Toasts } from "@jhin/ui";

/** This device's browser profiles (T3's `browserProfiles`, `browserDefaultProfileId`). */
export const PREVIEW_BROWSER_SECTION = "jhin.preview.browser";
export const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
export const BROWSER_PROFILE_MAX_COUNT = 24;
const UserProfile = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[^\p{Cc}]+$/u),
  name: z.string().trim().min(1).max(BROWSER_PROFILE_NAME_MAX_LENGTH),
});
export const PreviewBrowserSettings = z.object({
  // One broken entry is dropped, not the whole list (the next write would lose the rest).
  profiles: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((entries) =>
      entries
        .flatMap((entry) => {
          const parsed = UserProfile.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, BROWSER_PROFILE_MAX_COUNT),
    ),
  defaultProfileId: z.string().optional().catch(undefined),
});
export type PreviewBrowserSettings = z.output<typeof PreviewBrowserSettings>;

export interface BrowserProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: "persistent" | "incognito";
}

const BUILT_IN_BROWSER_PROFILES: readonly BrowserProfile[] = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

export const isBuiltIn = (id: string) =>
  BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);

/** The built-in profiles, then the user's, each id once (T3's resolveBrowserProfiles). */
export function resolveBrowserProfiles(settings: PreviewBrowserSettings): {
  readonly profiles: readonly BrowserProfile[];
  readonly defaultProfileId: string;
} {
  const seen = new Set(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id));
  const profiles = [...BUILT_IN_BROWSER_PROFILES];
  for (const profile of settings.profiles) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push({ ...profile, kind: "persistent" });
  }
  const chosen = settings.defaultProfileId;
  const defaultProfileId =
    chosen !== undefined &&
    profiles.some((profile) => profile.id === chosen && profile.kind !== "incognito")
      ? chosen
      : DEFAULT_BROWSER_PROFILE_ID;
  return { profiles, defaultProfileId };
}

/** A profile's name, or T3's "Removed profile" for one this device no longer has. */
export function profileName(profiles: readonly BrowserProfile[], profileId: string): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

/** A name not taken yet: "New profile", "New profile 2", … (T3). */
export function freshProfileName(profiles: readonly BrowserProfile[], base: string): string {
  const taken = new Set(profiles.map((profile) => profile.name));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const name = `${base} ${index}`;
    if (!taken.has(name)) return name;
  }
}

export interface ProfilesServices {
  /** Absent in a client without device settings: only the built-in profiles then. */
  readonly settings: DeviceSettings | undefined;
  readonly connections: Connections;
  readonly dialogs: Dialogs | undefined;
  readonly toasts: Toasts | undefined;
  /** This device's profile settings, as they are now. */
  read(): PreviewBrowserSettings;
  /** Clears the profile's partition of the desktop app, when the page runs in one (D1323). */
  clearInApp?(profileId: string): Promise<void>;
  use(): PreviewBrowserSettings;
}
