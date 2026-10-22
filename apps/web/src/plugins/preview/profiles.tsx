// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/browserProfile.ts
// (built-in profiles, resolveBrowserProfiles) and the BrowserProfilesSetting of
// apps/web/src/components/settings/IntegrationsSettings.tsx. docs/plans/preview.md, D953.
import type { Connections, DeviceSettings } from "@jhin/client-api";
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@jhin/preview-api";
import { z } from "@jhin/sdk";
import {
  Badge,
  Button,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  SettingsRow,
  SettingsSection,
  cn,
  type Dialogs,
  type Toasts,
} from "@jhin/ui";
import { MoreVerticalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

/** This device's browser profiles (T3's `browserProfiles`, `browserDefaultProfileId`). */
export const PREVIEW_BROWSER_SECTION = "jhin.preview.browser";
const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
const BROWSER_PROFILE_MAX_COUNT = 24;
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

const isBuiltIn = (id: string) => BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);

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
  use(): PreviewBrowserSettings;
}

/** Forgets a profile on every node this client is connected to (T3 clears every environment). */
async function clearOnNodes(services: ProfilesServices, profileId: string): Promise<void> {
  const open = services.connections.list().filter((node) => node.state === "open");
  const results = await Promise.allSettled(
    open.map((node) => node.client.call("preview.profile.clear", { profileId })),
  );
  // Every node is tried; the error names the ones that did not clear.
  const failed = open.filter((_node, index) => results[index]?.status === "rejected");
  if (failed.length > 0) {
    throw new Error(`Not cleared on ${failed.map((node) => node.label).join(", ")}.`);
  }
}

/** T3's "Browser profiles" row of the browser settings. */
export function BrowserProfilesSection(props: { readonly services: ProfilesServices }) {
  const { services } = props;
  const settings = services.use();
  const { profiles, defaultProfileId } = resolveBrowserProfiles(settings);
  const listed = profiles.filter((profile) => profile.kind !== "incognito");
  const [busy, setBusy] = useState(false);
  const patch = (values: Partial<PreviewBrowserSettings>) =>
    services.settings?.patch(PREVIEW_BROWSER_SECTION, values);
  const atLimit = settings.profiles.length >= BROWSER_PROFILE_MAX_COUNT;

  const create = () => {
    const current = services.read();
    if (current.profiles.length >= BROWSER_PROFILE_MAX_COUNT) return;
    const name = freshProfileName(resolveBrowserProfiles(current).profiles, "New profile");
    patch({ profiles: [...current.profiles, { id: crypto.randomUUID(), name }] });
  };
  const rename = (id: string, next: string) => {
    const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
    if (name === "") return;
    patch({
      profiles: services
        .read()
        .profiles.map((profile) => (profile.id === id ? { ...profile, name } : profile)),
    });
  };
  const failed = (title: string, error: unknown) =>
    services.toasts?.show({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  const clear = async (profile: BrowserProfile) => {
    setBusy(true);
    try {
      await clearOnNodes(services, profile.id);
      services.toasts?.show({ type: "success", title: `Cleared ${profile.name}'s data` });
    } catch (error) {
      failed(`Could not clear ${profile.name}'s data`, error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (profile: BrowserProfile) => {
    const confirmed =
      services.dialogs === undefined
        ? true
        : await services.dialogs.confirm({
            title: `Remove “${profile.name}”?`,
            description: "Its cookies, logins and site data are deleted on every connected node.",
            confirmLabel: "Remove",
            variant: "destructive",
          });
    if (!confirmed) return;
    setBusy(true);
    try {
      await clearOnNodes(services, profile.id);
      const current = services.read();
      patch({
        profiles: current.profiles.filter((item) => item.id !== profile.id),
        ...(current.defaultProfileId === profile.id ? { defaultProfileId: undefined } : {}),
      });
    } catch (error) {
      failed(`Could not remove ${profile.name}`, error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Browser">
      <SettingsRow
        control={
          <Button disabled={busy || atLimit} onClick={create} size="sm" variant="outline">
            <PlusIcon />
            Add profile
          </Button>
        }
        description="Profiles separate cookies and logins. Incognito data is cleared when the browser closes."
        title="Browser profiles"
      >
        <ul
          aria-label="Browser profiles"
          className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60"
        >
          {listed.map((profile, index) => {
            const builtIn = isBuiltIn(profile.id);
            const isDefault = profile.id === defaultProfileId;
            return (
              <li
                className={cn(
                  "flex items-center gap-3 px-3 py-2",
                  index > 0 && "border-t border-border/60",
                )}
                key={profile.id}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {builtIn ? (
                    <span className="truncate text-sm text-foreground">{profile.name}</span>
                  ) : (
                    <Input
                      aria-label={`Rename ${profile.name}`}
                      className="w-full max-w-56"
                      defaultValue={profile.name}
                      disabled={busy}
                      key={profile.name}
                      maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                      onBlur={(event) => {
                        // An empty name is not taken: the field shows the name again.
                        if (event.currentTarget.value.trim() === "") {
                          event.currentTarget.value = profile.name;
                        } else rename(profile.id, event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      size="sm"
                    />
                  )}
                  {isDefault ? <Badge>Default</Badge> : null}
                </span>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        aria-label={`${profile.name} options`}
                        disabled={busy}
                        size="icon-xs"
                        variant="ghost"
                      />
                    }
                  >
                    <MoreVerticalIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      disabled={isDefault}
                      onClick={() => patch({ defaultProfileId: profile.id })}
                    >
                      Set as default
                    </MenuItem>
                    <MenuItem onClick={() => void clear(profile)}>Clear cookies and cache</MenuItem>
                    {builtIn ? null : (
                      <>
                        <MenuSeparator />
                        <MenuItem onClick={() => void remove(profile)} variant="destructive">
                          Remove profile and data
                        </MenuItem>
                      </>
                    )}
                  </MenuPopup>
                </Menu>
              </li>
            );
          })}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}
