import { PLUGIN_API_VERSION, type PluginDefinition } from "@jhin/sdk";

/** A plugin compiled into the web app; same manifest and lifecycle as any other. */
export interface BuiltinPlugin {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
    readonly apiVersion: number;
    readonly side: "client";
    readonly provides?: Readonly<Record<string, string>>;
    readonly requires?: Readonly<Record<string, string>>;
    readonly optional?: Readonly<Record<string, string>>;
    readonly entry: string;
  };
  readonly definition: PluginDefinition;
}

export function builtin(
  id: string,
  edges: Pick<BuiltinPlugin["manifest"], "provides" | "requires" | "optional">,
  definition: PluginDefinition,
): BuiltinPlugin {
  return {
    manifest: {
      id,
      version: "0.1.0",
      apiVersion: PLUGIN_API_VERSION,
      side: "client",
      entry: "builtin",
      ...edges,
    },
    definition,
  };
}
