import type { z } from "zod";

import type { Disposable } from "./disposable.ts";
import type { PluginManifest } from "./manifest.ts";

export type Awaitable<T> = T | Promise<T>;

export interface LogFields {
  readonly [field: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/**
 * Who runs a command and with which rights.
 *
 * An absent `caller` means trusted in-process code and skips permission
 * checks. Every remote surface (RPC, CLI over a connection, MCP) must set a
 * caller.
 */
export interface Invocation {
  readonly traceId?: string;
  readonly caller?: {
    readonly id: string;
    readonly permissions: readonly string[];
  };
}

export interface CommandDefinition<I extends z.ZodType, O extends z.ZodType> {
  /** Lowercase dotted name, public API: `threads.create`. */
  readonly name: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  /** Permissions a caller must hold. */
  readonly permissions?: readonly string[];
  handler(input: z.output<I>, invocation: Invocation): Awaitable<z.input<O>>;
}

export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly plugin: string;
  readonly permissions: readonly string[];
  /** JSON Schema of the input, as consumed by RPC, CLI and MCP surfaces. */
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

export interface Commands {
  register<I extends z.ZodType, O extends z.ZodType>(
    definition: CommandDefinition<I, O>,
  ): Disposable;
  execute(name: string, input: unknown, invocation?: Invocation): Promise<unknown>;
  list(): readonly CommandInfo[];
}

export interface Services {
  /** Registers the implementation of a capability listed in this plugin's `provides`. */
  provide<T>(capability: string, implementation: T): Disposable;
  /** Returns a capability listed in `requires`; throws when it is not provided. */
  get<T>(capability: string): T;
  /** Returns a capability listed in `requires` or `optional`, or undefined. */
  tryGet<T>(capability: string): T | undefined;
}

export interface HookOptions {
  /** Lower runs first (outermost for `around`). Default 0. */
  readonly order?: number;
}

export type BeforeHook<I> = (input: I) => Awaitable<I>;
export type AfterHook<I, O> = (output: O, input: I) => Awaitable<O>;
export type AroundHook<I, O> = (input: I, next: (input: I) => Promise<O>) => Promise<O>;

export interface Hooks {
  before<I>(name: string, hook: BeforeHook<I>, options?: HookOptions): Disposable;
  after<I, O>(name: string, hook: AfterHook<I, O>, options?: HookOptions): Disposable;
  around<I, O>(name: string, hook: AroundHook<I, O>, options?: HookOptions): Disposable;
  /** Runs `implementation` through every registered hook of `name`. */
  run<I, O>(name: string, input: I, implementation: (input: I) => Awaitable<O>): Promise<O>;
}

export interface Config {
  /** Declares a config section; values are validated and defaulted by the schema. */
  define<S extends z.ZodType>(section: string, schema: S): Disposable;
  get<T = unknown>(section: string): T;
  /**
   * Called when the merged raw value of the section changes (a layer was set).
   * Schema defaults are not part of the comparison. If the new value fails
   * validation the listener is not called and the error is logged; `get`
   * throws `CONFIG_INVALID` until a layer fixes it.
   */
  onDidChange<T = unknown>(section: string, listener: (value: T) => void): Disposable;
}

export interface Events {
  /** Event types are namespaced: `agent.turn.started`. */
  emit(type: string, payload?: unknown): void;
  on(type: string, listener: (payload: unknown) => void): Disposable;
}

/** Plugin-scoped key-value state that survives a reload of the plugin. */
export interface State {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface PluginContext {
  readonly plugin: { readonly id: string; readonly version: string };
  readonly manifest: PluginManifest;
  /** Disposed when the plugin deactivates. Registrations through `ctx` land here automatically. */
  readonly subscriptions: { add<T extends Disposable>(item: T): T };
  readonly services: Services;
  readonly hooks: Hooks;
  readonly commands: Commands;
  readonly config: Config;
  readonly events: Events;
  readonly state: State;
  readonly log: Logger;
}

export interface PluginDefinition {
  activate(context: PluginContext): Awaitable<void>;
  deactivate?(): Awaitable<void>;
}

/** The default export of a plugin's entry module. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
