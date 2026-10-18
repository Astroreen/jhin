import * as Path from "node:path";

import type { Logger } from "@jhin/sdk";
import { pino, type Logger as Pino } from "pino";

export interface NodeLogger extends Logger {
  /** Absolute path of the JSON log file. */
  readonly file: string;
  /** Writes buffered lines; call before exit. */
  flush(): void;
}

function adapt(target: Pino): Logger {
  return {
    debug: (message, fields) => target.debug(fields ?? {}, message),
    info: (message, fields) => target.info(fields ?? {}, message),
    warn: (message, fields) => target.warn(fields ?? {}, message),
    error: (message, fields) => target.error(fields ?? {}, message),
    child: (fields) => adapt(target.child(fields)),
  };
}

/**
 * JSON lines (pino) with `nodeId` on every line and `plugin` on every plugin's
 * lines; `traceId` is added by whoever handles a traced request (D37).
 */
export function createNodeLogger(options: {
  logsDir: string;
  nodeId: string;
  level?: string;
}): NodeLogger {
  const file = Path.join(options.logsDir, "node.log");
  const destination = pino.destination({ dest: file, mkdir: true, sync: true });
  const root = pino(
    {
      level: options.level ?? "info",
      base: { nodeId: options.nodeId },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
  return { ...adapt(root), file, flush: () => destination.flushSync() };
}
