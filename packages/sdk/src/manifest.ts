import { z } from "zod";

/** Version of the plugin API a manifest's `apiVersion` must match. */
export const PLUGIN_API_VERSION = 1;

/** Lowercase dotted id: `jhin.storage`, `acme.git-panel`. */
export const DOTTED_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export const PluginId = z.string().regex(DOTTED_ID, "must be a lowercase dotted id");
export const CapabilityId = z.string().regex(DOTTED_ID, "must be a lowercase dotted id");
const Version = z.string().regex(SEMVER, "must be a semver version such as 1.2.0");
const Range = z.string().min(1, "must be a semver range such as ^1");

export const PluginSide = z.enum(["server", "client", "both"]);
export type PluginSide = z.infer<typeof PluginSide>;

/** The `"jhin"` field of a plugin's `package.json`. */
export const PluginManifest = z
  .object({
    id: PluginId,
    version: Version,
    apiVersion: z.literal(PLUGIN_API_VERSION),
    name: z.string().optional(),
    description: z.string().optional(),
    side: PluginSide,
    /** Capabilities this plugin implements, with the implemented version. */
    provides: z.record(CapabilityId, Version).default({}),
    /** Capabilities this plugin cannot run without, with accepted ranges. */
    requires: z.record(CapabilityId, Range).default({}),
    /** Capabilities used when present; the plugin still runs without them. */
    optional: z.record(CapabilityId, Range).default({}),
    /** Module path relative to the package root. */
    entry: z.string().min(1),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifest>;
