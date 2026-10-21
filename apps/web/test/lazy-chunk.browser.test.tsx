import { act, Component } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { lazyChunk } from "../src/lib/lazy-chunk.tsx";

function Greeting(props: { name: string }) {
  return <p>Hello {props.name}</p>;
}

/** A load the test answers when it wants: resolve or reject the current attempt. */
function controlledLoad() {
  const attempts: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const load = () =>
    new Promise<typeof Greeting>((resolve, reject) => {
      attempts.push({ resolve: () => resolve(Greeting), reject });
    });
  return { load, attempts };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("lazyChunk (D440)", () => {
  it("shows the loading view in its place until the chunk loads", async () => {
    const { load, attempts } = controlledLoad();
    const Chunk = lazyChunk(load, {
      loading: (props) => <p>loading {props.name}</p>,
      failed: () => <p>failed</p>,
    });
    const container = await mount(<Chunk name="Ada" />);
    expect(container.textContent).toBe("loading Ada");
    await act(async () => attempts[0]!.resolve());
    expect(container.textContent).toBe("Hello Ada");
  });

  it("shows the failed view when it cannot load, and loads again on retry", async () => {
    const { load, attempts } = controlledLoad();
    const Chunk = lazyChunk(load, {
      loading: () => <p>loading</p>,
      failed: (props, retry) => (
        <button onClick={retry} type="button">
          retry {props.name}
        </button>
      ),
    });
    const container = await mount(<Chunk name="Ada" />);
    await act(async () => attempts[0]!.reject(new Error("chunk gone")));
    expect(container.textContent).toBe("retry Ada");

    await act(async () => container.querySelector("button")!.click());
    expect(attempts).toHaveLength(2);
    expect(container.textContent).toBe("loading");
    await act(async () => attempts[1]!.resolve());
    expect(container.textContent).toBe("Hello Ada");
  });

  it("loads again for a later render after a failure", async () => {
    const { load, attempts } = controlledLoad();
    const Chunk = lazyChunk(load, {
      loading: () => <p>loading</p>,
      failed: () => <p>failed</p>,
    });
    const first = await mount(<Chunk name="Ada" />);
    await act(async () => attempts[0]!.reject(new Error("offline")));
    expect(first.textContent).toBe("failed");
    cleanup?.();

    const second = await mount(<Chunk name="Grace" />);
    expect(attempts).toHaveLength(2);
    await act(async () => attempts[1]!.resolve());
    expect(second.textContent).toBe("Hello Grace");
  });

  it("recovers every instance that failed together when one retries", async () => {
    const { load, attempts } = controlledLoad();
    const Chunk = lazyChunk(load, {
      loading: (props) => <p>loading {props.name}</p>,
      failed: (props, retry) => (
        <button onClick={retry} type="button">
          retry {props.name}
        </button>
      ),
    });
    const container = await mount(
      <>
        <Chunk name="Ada" />
        <Chunk name="Grace" />
      </>,
    );
    await act(async () => attempts[0]!.reject(new Error("offline")));
    expect(container.textContent).toBe("retry Adaretry Grace");

    await act(async () => container.querySelector("button")!.click());
    // One new load for both.
    expect(attempts).toHaveLength(2);
    expect(container.textContent).toBe("loading Adaloading Grace");
    await act(async () => attempts[1]!.resolve());
    expect(container.textContent).toBe("Hello AdaHello Grace");
  });

  it("brings a failed instance back when a later one mounts, without a load per render", async () => {
    const { load, attempts } = controlledLoad();
    const Chunk = lazyChunk(load, { loading: () => <p>loading</p>, failed: () => <p>failed</p> });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    await act(async () => root.render(<Chunk name="Ada" />));
    await act(async () => attempts[0]!.reject(new Error("offline")));
    // Re-rendering the failed one (a streaming message's next delta) starts no load.
    await act(async () => root.render(<Chunk name="Ada Lovelace" />));
    expect(container.textContent).toBe("failed");
    expect(attempts).toHaveLength(1);
    // A new message mounts: one new load, and the failed one shows it too.
    await act(async () =>
      root.render(
        <>
          <Chunk name="Ada Lovelace" />
          <Chunk name="Grace" />
        </>,
      ),
    );
    expect(attempts).toHaveLength(2);
    await act(async () => attempts[1]!.resolve());
    expect(container.textContent).toBe("Hello Ada LovelaceHello Grace");
  });

  it("passes a loaded component's own error on, not as a load failure", async () => {
    function Broken(): never {
      throw new Error("bad message");
    }
    const Chunk = lazyChunk(async () => Broken as unknown as typeof Greeting, {
      loading: () => <p>loading</p>,
      failed: () => <p>failed</p>,
    });
    class Above extends Component<{ children: React.ReactNode }, { error?: string }> {
      override state: { error?: string } = {};
      static getDerivedStateFromError(error: Error) {
        return { error: error.message };
      }
      override render() {
        return this.state.error === undefined ? (
          this.props.children
        ) : (
          <p>above: {this.state.error}</p>
        );
      }
    }
    const container = await mount(
      <Above>
        <Chunk name="Ada" />
      </Above>,
    );
    await act(async () => undefined);
    expect(container.textContent).toBe("above: bad message");
  });
});
