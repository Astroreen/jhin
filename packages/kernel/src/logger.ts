import type { Logger } from "@jhin/sdk";

/** Used when the host does not inject a logger. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};
