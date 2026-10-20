// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/DiffWorkerPoolProvider.tsx.
import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { PREFERRED_HIGHLIGHTER, resolveDiffThemeName, type DiffThemeName } from "./rendering.ts";
import { useResolvedTheme } from "./theme.ts";

const DIFF_WORKER_IDLE_TTL_MS = 30_000;
function resolveDiffWorkerPoolSize() {
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}
let sharedWorkerPool:
  | {
      readonly pool: WorkerPoolManager;
      consumers: number;
      idleTimer: ReturnType<typeof setTimeout> | undefined;
    }
  | undefined;

function acquireDiffWorkerPool(themeName: DiffThemeName, poolSize: number) {
  const entry = (sharedWorkerPool ??= {
    pool: new WorkerPoolManager(
      {
        workerFactory: () => new DiffsWorker(),
        poolSize,
        totalASTLRUCacheSize: 240,
      },
      {
        theme: themeName,
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      },
    ),
    consumers: 0,
    idleTimer: undefined,
  });
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) return;
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) return;
        await workerPool.setRenderOptions({ ...current, theme: themeName });
      } catch (cause) {
        console.error(`Diff worker could not switch to ${themeName}`, cause);
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

// Plain-text views do not queue a highlight task that could retry a blank first render.
function DiffWorkerReady({ children }: { children?: ReactNode }) {
  const workerPool = useWorkerPool();
  const [readyPool, setReadyPool] = useState<WorkerPoolManager>();
  const ready = workerPool
    ? readyPool === workerPool || workerPool.isInitialized() || !workerPool.isWorkingPool()
    : typeof window === "undefined";

  useEffect(() => {
    if (ready || !workerPool) return;
    let mounted = true;
    const finish = () => {
      if (mounted) setReadyPool(workerPool);
    };
    void workerPool.initialize().then(finish, finish);
    return () => {
      mounted = false;
    };
  }, [ready, workerPool]);

  return ready ? (
    children
  ) : (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-muted-foreground"
      role="status"
    >
      Loading code...
    </div>
  );
}

// One subscribe function for every provider: a new identity would release and reacquire the pool.
const poolSize = resolveDiffWorkerPoolSize();
const subscribers = new Map<DiffThemeName, (onStoreChange: () => void) => () => void>();
function subscriberFor(themeName: DiffThemeName) {
  let subscribe = subscribers.get(themeName);
  if (subscribe === undefined) {
    subscribe = (onStoreChange) => {
      const entry = acquireDiffWorkerPool(themeName, poolSize);
      onStoreChange();
      return () => {
        entry.consumers -= 1;
        if (entry.consumers !== 0) return;
        entry.idleTimer = setTimeout(() => {
          entry.idleTimer = undefined;
          entry.pool.terminate();
          if (sharedWorkerPool === entry) sharedWorkerPool = undefined;
        }, DIFF_WORKER_IDLE_TTL_MS);
      };
    };
    subscribers.set(themeName, subscribe);
  }
  return subscribe;
}

/** Highlighting off the main thread, in a pool shared by every diff on the page. */
export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const diffThemeName = resolveDiffThemeName(useResolvedTheme());
  const workerPool = useSyncExternalStore(
    subscriberFor(diffThemeName),
    () => sharedWorkerPool?.pool,
    () => undefined,
  );

  return (
    <WorkerPoolContext value={workerPool}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      <DiffWorkerReady>{children}</DiffWorkerReady>
    </WorkerPoolContext>
  );
}
