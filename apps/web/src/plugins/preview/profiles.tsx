// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/contracts/src/browserProfile.ts
// (built-in profiles, resolveBrowserProfiles) and the BrowserProfilesSetting of
// apps/web/src/components/settings/IntegrationsSettings.tsx (with its "Import from" menu and
// importBrowserCookiesIntoTarget). docs/plans/preview.md, D953 and D1205.
import type { Connections, DeviceSettings, NodeConnection } from "@jhin/client-api";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  type BrowserImportSource,
  type PreviewImportCookiesResult,
  type PreviewImportSourcesResult,
} from "@jhin/preview-api";
import { z } from "@jhin/sdk";
import {
  Badge,
  Button,
  Input,
  Menu,
  MenuGroup,
  MenuGroupLabel,
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
import { useRef, useState } from "react";

import {
  BrowserImportWizard,
  importFailureReason,
  type ImportOutcome,
  type WizardTarget,
} from "./browser-import.tsx";

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
  /** Clears the profile's partition of the desktop app, when the page runs in one (D1323). */
  clearInApp?(profileId: string): Promise<void>;
  use(): PreviewBrowserSettings;
}

/** Forgets a profile on every node this client is connected to (T3 clears every environment). */
async function clearOnNodes(services: ProfilesServices, profileId: string): Promise<void> {
  const open = services.connections.list().filter((node) => node.state === "open");
  const [inApp, ...results] = await Promise.allSettled([
    services.clearInApp?.(profileId),
    ...open.map((node) => node.client.call("preview.profile.clear", { profileId })),
  ]);
  if (inApp?.status === "rejected") throw new Error("Not cleared in the app.");
  // Every node is tried; the error names the ones that did not clear.
  const failed = open.filter((_node, index) => results[index]?.status === "rejected");
  if (failed.length > 0) {
    throw new Error(`Not cleared on ${failed.map((node) => node.label).join(", ")}.`);
  }
}

/** One connected node's browsers to import from (D1205). */
interface NodeSources {
  readonly node: NodeConnection;
  readonly sources: readonly BrowserImportSource[];
}

/** T3 lists a browser unless it is missing or cannot be read on this platform at all. */
const importable = (sources: readonly BrowserImportSource[]) =>
  sources.filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );

async function listSources(node: NodeConnection): Promise<readonly BrowserImportSource[]> {
  const result = await node.client.call<PreviewImportSourcesResult>("preview.import.sources", {});
  return result.sources;
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
  // T3's "Import from": every open node's browsers, each read on its node (D1205).
  const [sources, setSources] = useState<readonly NodeSources[] | null>(null);
  const [importSession, setImportSession] = useState<{
    readonly node: NodeConnection;
    readonly source: BrowserImportSource;
  } | null>(null);
  const importInFlight = useRef(false);
  const loadSources = () => {
    const open = services.connections.list().filter((node) => node.state === "open");
    void Promise.all(
      open.map(async (node) => ({
        node,
        sources: await listSources(node).catch(() => [] as readonly BrowserImportSource[]),
      })),
    ).then(setSources);
  };
  const refreshSource = async (
    node: NodeConnection,
    sourceId: BrowserImportSource["id"],
  ): Promise<BrowserImportSource | undefined> => {
    try {
      const latest = await listSources(node);
      setSources((previous) =>
        (previous ?? []).map((entry) =>
          entry.node.id === node.id ? { node, sources: latest } : entry,
        ),
      );
      return latest.find((source) => source.id === sourceId);
    } catch {
      return undefined;
    }
  };
  /** T3's importBrowserCookiesIntoTarget: a new profile is kept only once cookies landed in it. */
  const runImport = async (
    node: NodeConnection,
    source: BrowserImportSource,
    input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
  ): Promise<ImportOutcome> => {
    const exists = (profileId: string) =>
      resolveBrowserProfiles(services.read()).profiles.some((profile) => profile.id === profileId);
    if (input.target.kind === "existing" && !exists(input.target.profileId)) {
      return { kind: "blocked", reason: "readFailed" };
    }
    if (importInFlight.current) return { kind: "blocked", reason: "readFailed" };
    importInFlight.current = true;
    setBusy(true);
    try {
      const result = await node.client.call<PreviewImportCookiesResult>("preview.import.cookies", {
        sourceId: source.id,
        sourceProfileDirectory: input.sourceProfileDirectory,
        targetProfileId: input.target.profileId,
      });
      let targetName = input.target.kind === "existing" ? input.target.name : source.name;
      if (input.target.kind === "new" && result.imported > 0) {
        const current = services.read();
        // The wizard refuses a new target at the cap, but it can be reached while the
        // import runs: the profile's cookies go again rather than stay unreachable.
        const failure =
          current.profiles.length >= BROWSER_PROFILE_MAX_COUNT
            ? ("profileLimitReached" as const)
            : services.settings === undefined
              ? ("profileNotSaved" as const)
              : undefined;
        if (failure !== undefined) {
          await node.client
            .call("preview.profile.clear", { profileId: input.target.profileId })
            .catch(() => undefined);
          return { kind: "blocked", reason: failure };
        }
        targetName = freshProfileName(resolveBrowserProfiles(current).profiles, source.name);
        patch({
          profiles: [...current.profiles, { id: input.target.profileId, name: targetName }],
        });
      }
      return {
        kind: "imported",
        imported: result.imported,
        skipped: result.skipped,
        skippedDomains: result.skippedDomains,
        targetName,
      };
    } catch (error) {
      return { kind: "blocked", reason: importFailureReason(error) };
    } finally {
      importInFlight.current = false;
      setBusy(false);
    }
  };

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
          <Menu onOpenChange={(open) => open && loadSources()}>
            <MenuTrigger render={<Button disabled={busy} size="sm" variant="outline" />}>
              <PlusIcon />
              Add profile
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={atLimit} onClick={create}>
                Blank profile
              </MenuItem>
              {atLimit ? (
                <MenuItem disabled>You&rsquo;ve reached the profile limit</MenuItem>
              ) : null}
              <MenuSeparator />
              {sources === null ? (
                <MenuGroup>
                  <MenuGroupLabel>Import from</MenuGroupLabel>
                  <MenuItem disabled>Looking for browsers…</MenuItem>
                </MenuGroup>
              ) : sources.length === 0 ? (
                <MenuGroup>
                  <MenuGroupLabel>Import from</MenuGroupLabel>
                  <MenuItem disabled>Connect to a node to import cookies</MenuItem>
                </MenuGroup>
              ) : (
                sources.map(({ node, sources: nodeSources }) => (
                  <MenuGroup key={node.id}>
                    <MenuGroupLabel>
                      {sources.length > 1 ? `Import from ${node.label}` : "Import from"}
                    </MenuGroupLabel>
                    {importable(nodeSources).length === 0 ? (
                      <MenuItem disabled>No supported browsers found</MenuItem>
                    ) : (
                      importable(nodeSources).map((source) => (
                        <MenuItem
                          key={source.id}
                          onClick={() => setImportSession({ node, source })}
                        >
                          {source.name}
                        </MenuItem>
                      ))
                    )}
                  </MenuGroup>
                ))
              )}
            </MenuPopup>
          </Menu>
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
      {importSession ? (
        <BrowserImportWizard
          source={importSession.source}
          destinationName={importSession.node.label}
          targetProfiles={listed.map((profile) => ({ id: profile.id, name: profile.name }))}
          canCreateProfile={services.settings !== undefined && !atLimit}
          onImport={(input) => runImport(importSession.node, importSession.source, input)}
          onRefreshSource={() => refreshSource(importSession.node, importSession.source.id)}
          onClose={() => setImportSession(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
