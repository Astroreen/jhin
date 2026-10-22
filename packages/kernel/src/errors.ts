export type KernelErrorCode =
  | "MANIFEST_INVALID"
  | "DUPLICATE_PLUGIN"
  | "CAPABILITY_CONFLICT"
  | "CAPABILITY_MISSING"
  | "VERSION_MISMATCH"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_UNAVAILABLE"
  | "MODULE_INVALID"
  | "ACTIVATION_FAILED"
  | "CAPABILITY_NOT_DECLARED"
  | "SERVICE_NOT_PROVIDED"
  | "SERVICE_ALREADY_PROVIDED"
  | "COMMAND_NAME_INVALID"
  | "COMMAND_DUPLICATE"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_INPUT_INVALID"
  | "COMMAND_OUTPUT_INVALID"
  | "PERMISSION_DENIED"
  | "CONFIG_SECTION_DUPLICATE"
  | "CONFIG_SECTION_UNKNOWN"
  | "CONFIG_INVALID"
  | "EVENT_TYPE_INVALID"
  | "PLUGIN_NOT_FOUND"
  | "KERNEL_STATE";

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: KernelErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

/** A plain, serialisable view of an error for inspect output and events. */
export interface ErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof KernelError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) return { code: error.name, message: error.message };
  return { code: "UNKNOWN", message: String(error) };
}
