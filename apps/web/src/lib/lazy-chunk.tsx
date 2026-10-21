import { Button } from "@jhin/ui";
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * Catches a chunk that failed to load, so only its place shows it. An error
 * of the loaded component itself is not a load failure: it goes on to the
 * boundary above, as it would without the chunk.
 */
class ChunkBoundary extends Component<
  { failed: ReactNode; onError: () => void; loaded: () => boolean; children: ReactNode },
  { error: unknown }
> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(): void {
    if (!this.props.loaded()) this.props.onError();
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    if (this.props.loaded()) throw this.state.error;
    return this.props.failed;
  }
}

/**
 * A component loaded as a chunk of its own on first render (D440). While it
 * loads, `loading` shows in its place; if it fails to load (the network, or a
 * node serving a newer build), `failed` does. A load is one per component, not
 * per instance: `retry` (from any instance) starts a new one and every
 * instance shows it, and so does the next instance to mount after a failure.
 */
export function lazyChunk<P extends object>(
  load: () => Promise<ComponentType<P>>,
  views: {
    loading: (props: P) => ReactNode;
    failed: (props: P, retry: () => void) => ReactNode;
  },
): ComponentType<P> {
  // Whether the current load has its component: errors after that are the component's.
  let resolved = false;
  const fresh = () => {
    resolved = false;
    return lazy(async () => {
      const component = await load();
      resolved = true;
      return { default: component };
    });
  };
  // The current load and its generation change together, outside render.
  let generation = 0;
  let Loaded = fresh();
  let failedGeneration = -1;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const current = () => generation;
  const retry = (seen: number) => {
    if (seen !== generation) return;
    generation += 1;
    Loaded = fresh();
    for (const listener of listeners) listener();
  };
  return function Chunk(props: P) {
    // Reads the current load at each render: the compiler must not keep an element of an old one.
    "use no memo";
    const seen = useSyncExternalStore(subscribe, current);
    // An instance mounting after a failure loads again (one new load for all).
    useEffect(() => {
      if (failedGeneration === generation) retry(generation);
    }, []);
    const Current = Loaded;
    return (
      <ChunkBoundary
        // A new load is a new boundary: every instance leaves its failure behind.
        failed={views.failed(props, () => retry(seen))}
        key={seen}
        loaded={() => resolved}
        onError={() => {
          if (seen === generation) failedGeneration = seen;
        }}
      >
        <Suspense fallback={views.loading(props)}>
          <Current {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  };
}

/** What a chunk that failed to load says in its place, with a way to load it again. */
export function ChunkFailed(props: { retry: () => void; children: ReactNode }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground"
      role="alert"
    >
      <p>{props.children}</p>
      <Button onClick={props.retry} size="xs" variant="outline">
        Try again
      </Button>
    </div>
  );
}
