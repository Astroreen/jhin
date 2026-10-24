export { z } from "zod";

export { createCancelSignal, type CancelSignal } from "./cancel.ts";
export { DisposableStore, toDisposable, type Disposable } from "./disposable.ts";
export {
  CapabilityId,
  DOTTED_ID,
  PLUGIN_API_VERSION,
  PluginId,
  PluginManifest,
  PluginSide,
} from "./manifest.ts";
export {
  PERMISSIONS_DESCRIBE_HOOK,
  describePermissions,
  holdsPermission,
  intersectPermissions,
  isGrant,
  missingPermissions,
  type PermissionDescription,
  type PermissionEntry,
} from "./permissions.ts";
export {
  definePlugin,
  type AfterHook,
  type AroundHook,
  type Awaitable,
  type BeforeHook,
  type CommandDefinition,
  type CommandInfo,
  type Commands,
  type Config,
  type Events,
  type HookOptions,
  type Hooks,
  type Invocation,
  type LogFields,
  type Logger,
  type PluginContext,
  type PluginDefinition,
  type Services,
  type State,
} from "./plugin.ts";
