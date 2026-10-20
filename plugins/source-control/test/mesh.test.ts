import * as Fs from "node:fs";

import { MESH_STREAMS_CAPABILITY } from "@jhin/mesh-api";
import {
  SOURCE_CONTROL_STREAM,
  type ProjectStatus,
  type StatusSnapshot,
} from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import {
  createMemoryNetwork,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  startMeshNode,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import agent from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import sourceControl from "../src/index.ts";
import { repository, temp, write } from "./support.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop();
});

describe("source control of a mesh member (D501, D503)", () => {
  it("follows a member's source-control stream through the connected node's relay", async () => {
    const network = createMemoryNetwork();
    const a = startMeshNode(network, "a");
    const storage = memoryStoragePlugin();
    const c = startMeshNode(network, "c", { log: storage.storage.log });
    stops.push(() => [a, c].forEach((node) => node.dispose()));
    const data = temp("jhin-sc-mesh-");
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("host.paths", {
          home: data,
          dataDir: (id: string) => {
            Fs.mkdirSync(`${data}/${id}`, { recursive: true });
            return `${data}/${id}`;
          },
        }),
        storage,
        mockCapability(MESH_STREAMS_CAPABILITY, c.meshStreams),
        { manifest: manifest("threads"), definition: threads },
        { manifest: manifest("agent-fake"), definition: agent },
        { manifest: manifest("source-control"), definition: sourceControl },
      ],
    });
    stops.push(() => kernel.stop());
    c.use(kernel);
    await c.join(a);
    const { client } = a.connect();
    stops.push(() => client.close());
    const onC = <T>(method: string, params: unknown = {}) =>
      client.call<T>("mesh.call", { node: "c", method, params });

    const dir = repository();
    const { id: projectId } = await onC<{ id: string }>("projects.create", { path: dir });
    const snapshot = await onC<StatusSnapshot>("git.status", { projectId });
    const { stream } = await client.call<{ stream: string }>("mesh.relay", {
      node: "c",
      stream: SOURCE_CONTROL_STREAM,
    });
    const dirty = new Promise<StoredEvent>((resolve, reject) => {
      const subscription = client.subscribe(
        stream,
        { after: snapshot.head, onError: reject },
        (event) => {
          const status = event.payload as unknown as ProjectStatus;
          if (status.projectId !== projectId || status.workingTree?.fileCount !== 1) return;
          subscription.dispose();
          resolve(event);
        },
      );
    });
    write(dir, "notes.md", "a\nb\n");
    const event = await dirty;
    expect(event.type).toBe("source-control.status.changed");
    expect(event.sequence).toBeGreaterThan(snapshot.head);
    expect(await storage.storage.log.head(SOURCE_CONTROL_STREAM)).toBeGreaterThanOrEqual(
      event.sequence,
    );
  });
});
