// Settings per project follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/settings.ts (ProjectSettingsOverrides) and
// packages/shared/src/projectSettings.ts (resolveProjectSettings).
import { z } from "@jhin/sdk";

/** The key of a config section that holds its settings per project (config-ui.md D1462). */
export const PROJECT_SETTINGS_KEY = "projects";
/** The JSON Schema keyword that marks that record, for the settings page's project scope. */
export const PROJECT_SETTINGS_META = "projectSettings";

/**
 * A section's `projects` record: from a project's id to the settings it sets
 * for itself, each optional. Give the keys their own schemas, without
 * defaults: a key an entry leaves out is the node's.
 */
export function projectSettingsRecord<Shape extends z.ZodRawShape>(
  shape: Shape,
  meta: { readonly title?: string; readonly description?: string } = {},
) {
  return z
    .record(z.string(), z.object(shape).strict())
    .default({})
    .meta({
      title: meta.title ?? "Settings per project",
      description:
        meta.description ??
        "A project's own settings, by its id. A setting its entry leaves out is the node's.",
      [PROJECT_SETTINGS_META]: true,
    });
}

type ProjectEntries<Key extends PropertyKey> = Readonly<
  Record<string, Partial<Readonly<Record<Key, unknown>>> | undefined>
>;

/**
 * A section's settings for a project, as T3's `resolveProjectSettings`: each
 * of `keys` its entry sets replaces the node's value whole; the rest stay.
 */
export function resolveProjectSettings<
  Config extends { readonly projects?: ProjectEntries<Key> },
  Key extends keyof Config & string,
>(config: Config, projectId: string | undefined, keys: readonly Key[]): Config {
  const entry = projectId === undefined ? undefined : config.projects?.[projectId];
  if (entry === undefined) return config;
  let resolved: Config | undefined;
  for (const key of keys) {
    // A present undefined is no override (T3's forward-compatible decode).
    if (!Object.hasOwn(entry, key) || entry[key] === undefined) continue;
    resolved ??= { ...config };
    (resolved as Record<string, unknown>)[key] = entry[key];
  }
  return resolved ?? config;
}
