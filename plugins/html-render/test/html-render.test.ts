import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import type { AddressInfo } from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { threadStream } from "@jhin/agent-api";
import {
  HtmlRenderEvents,
  injectHtmlRenderBootstrap,
  type HtmlPreviewResult,
  type HtmlRenderedPayload,
} from "@jhin/preview-api";
import { connectInMemory, createTestKernel, memoryStoragePlugin } from "@jhin/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import htmlRender from "../src/index.ts";
import { isImageBytes, inlineLocalImages } from "../src/inline.ts";
import { isLocalAddress, startPublicProxy } from "../src/proxy.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

// A one-pixel PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let node: Awaited<ReturnType<typeof start>>;
let local: Http.Server;
let localUrl = "";
let localRequests = 0;
const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-html-"));

async function start() {
  const storage = memoryStoragePlugin();
  const kernel = await createTestKernel({
    plugins: [storage, { manifest, definition: htmlRender }],
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  return { kernel, client, log: storage.storage.log };
}

beforeAll(async () => {
  node = await start();
  // A service on this machine the page must not reach.
  local = Http.createServer((_request, response) => {
    localRequests += 1;
    response.end("secret");
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  node.client.close();
  await node.kernel.stop();
  await new Promise((resolve) => local.close(resolve));
});

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected the call to fail");
}

describe("jhin.html-render", () => {
  it("puts the theme and bootstrap into the page's head, not into inert markup", () => {
    const page = injectHtmlRenderBootstrap(
      "<!doctype html><html><!-- <head> --><head><title>x</title></head><body></body></html>",
    );
    expect(page.indexOf('<style id="jhin-theme">')).toBeGreaterThan(page.indexOf("<head>"));
    expect(page).toContain("<!-- <head> --><head><meta charset");
    expect(injectHtmlRenderBootstrap("<p>bare</p>")).toMatch(
      /^<!doctype html><head>.*<p>bare<\/p>$/s,
    );
  });

  it("inlines local images and reports the ones that are not images", async () => {
    const image = Path.join(dir, "dot.png");
    Fs.writeFileSync(image, PNG);
    const fake = Path.join(dir, "secret.png");
    Fs.writeFileSync(fake, "not an image");
    const { html, missing } = await inlineLocalImages(
      `<img src="${image}"><div style="background:url(${fake})"></div><img src="/nowhere/x.png">`,
    );
    expect(html).toContain('src="data:image/png;base64,');
    expect(missing.toSorted()).toEqual([fake, "/nowhere/x.png"].toSorted());
    expect(isImageBytes(Buffer.from("<?xml version='1.0'?><svg xmlns='x'/>"))).toBe(true);
  });

  it("refuses an image over 10 MiB", async () => {
    const huge = Path.join(dir, "huge.png");
    Fs.writeFileSync(huge, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    await expect(inlineLocalImages(`<img src="${huge}">`)).rejects.toThrow(
      "each local image must be at most 10.0 MiB",
    );
  });

  it("counts loopback and private addresses as private", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:c0a8:101",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "fd00::1",
    ]) {
      expect(isLocalAddress(address)).toBe(true);
    }
    expect(isLocalAddress("93.184.216.34")).toBe(false);
  });

  it("refuses through its proxy any address on this machine or a private network", async () => {
    const proxy = await startPublicProxy();
    // A SOCKS5 CONNECT: the reply's second byte is 0 when connected, 2 when refused by rule.
    const connect = (address: Buffer) =>
      new Promise<number>((resolve, reject) => {
        const socket = Net.connect(proxy.port, "127.0.0.1");
        let greeted = false;
        socket.on("error", reject);
        socket.on("data", (data) => {
          if (!greeted) {
            greeted = true;
            const port = Buffer.alloc(2);
            port.writeUInt16BE((local.address() as AddressInfo).port);
            socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, port]));
            return;
          }
          socket.destroy();
          resolve(data[1]!);
        });
        socket.write(Buffer.from([5, 1, 0]));
      });
    try {
      expect(await connect(Buffer.from([1, 127, 0, 0, 1]))).toBe(2);
      const name = Buffer.from("localhost", "latin1");
      expect(await connect(Buffer.concat([Buffer.from([3, name.length]), name]))).toBe(2);
      expect(localRequests).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it("previews a page: its screenshot, height and console, without reaching local services", async () => {
    const result = await node.client.call<HtmlPreviewResult>("html.preview", {
      html: `<!doctype html><div style="height:300px">Chart</div>
        <img src="/nowhere/missing.png">
        <script>
          console.log("checked", getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
          fetch(${JSON.stringify(localUrl)}).catch(() => console.warn("blocked"));
        </script>`,
      width: 390,
    });
    expect(result.width).toBe(390);
    expect(result.contentHeight).toBeGreaterThanOrEqual(300);
    expect(result.screenshot).toMatchObject({ mimeType: "image/png", width: 390 });
    expect(Buffer.from(result.screenshot.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(result.consoleMessages).toContainEqual({ level: "log", text: "checked #0a0a0a" });
    expect(result.missingImages).toEqual(["/nowhere/missing.png"]);
    expect(localRequests).toBe(0);
  });

  it("renders a page into the thread's stream with its heights per width", async () => {
    const stream = threadStream("thread-1");
    await node.log.append(stream, [
      { type: "threads.thread.created", payload: { id: "thread-1" } },
    ]);
    // A turn runs: the page belongs to it.
    await node.log.append(stream, [
      {
        type: "agent.turn.started",
        payload: { turnId: "u1", agentId: "fake", input: { text: "x" } },
      },
    ]);
    // A long turn: its start lies more than one page of events back.
    await node.log.append(
      stream,
      Array.from({ length: 600 }, (_, index) => ({
        type: "agent.item.delta",
        payload: { turnId: "u1", itemId: "m1", kind: "message", text: String(index) },
      })),
    );
    const result = await node.client.call<{
      htmlRender: { renderId: string; heights?: unknown[] };
    }>("html.render", {
      threadId: "thread-1",
      title: "Sales",
      height: 5000,
      html: `<div style="height:200px">Sales</div>`,
    });
    expect(result.htmlRender.heights).toHaveLength(9);
    const events = await node.log.read(stream);
    const rendered = events.at(-1)!;
    expect(rendered.type).toBe(HtmlRenderEvents.rendered);
    const payload = rendered.payload as unknown as HtmlRenderedPayload;
    expect(payload).toMatchObject({
      renderId: result.htmlRender.renderId,
      title: "Sales",
      height: 2000,
    });
    expect(payload.html).toContain('<style id="jhin-theme">');
    expect(payload.turnId).toBe("u1");

    const missing = await rejection(
      node.client.call("html.render", {
        threadId: "thread-1",
        title: "Broken",
        height: 200,
        html: `<img src="/nowhere/x.png">`,
      }),
    );
    expect(missing.message).toBe(
      "These local images could not be read: /nowhere/x.png. Use absolute paths to existing image files, or remove them.",
    );
    // A page past what a thread keeps is refused, counting each use of an image.
    const big = Path.join(dir, "big.png");
    Fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
    const heavy = await rejection(
      node.client.call("html.render", {
        threadId: "thread-1",
        title: "Heavy",
        height: 200,
        html: Array.from({ length: 4 }, () => `<img src="${big}">`).join(""),
      }),
    );
    expect(heavy.message).toMatch(/a page shown in a thread is at most 4\.0 MiB/);
    const unknown = await rejection(
      node.client.call("html.render", {
        threadId: "nope",
        title: "x",
        height: 200,
        html: "<p>x</p>",
      }),
    );
    expect(unknown.message).toBe("Thread nope was not found.");
  });
});
