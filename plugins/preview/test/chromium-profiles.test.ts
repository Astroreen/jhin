import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Chromium } from "../src/chromium.ts";

/** A page whose title is the cookie it got; `/login` sets one. */
let server: Http.Server;
let origin = "";
const profilesDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-profiles-real-"));

beforeAll(async () => {
  server = Http.createServer((request, response) => {
    if (request.url === "/login") {
      response.setHeader("set-cookie", "session=alice; Max-Age=3600; Path=/");
    }
    response.setHeader("content-type", "text/html");
    response.end(`<title>${request.headers.cookie ?? "no cookie"}</title>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  Fs.rmSync(profilesDir, { recursive: true, force: true });
});

async function titleAt(chromium: Chromium, profileId: string, path: string): Promise<string> {
  const { page } = await chromium.newPage(false, profileId);
  await page.goto(`${origin}${path}`);
  const title = await page.title();
  await page.close();
  return title;
}

describe("a profile keeps its login (D952, real Chromium)", () => {
  it("across a browser restart, for itself only, until it is cleared", async () => {
    const first = new Chromium({ profilesDir });
    await titleAt(first, "work", "/login");
    await first.close();

    const second = new Chromium({ profilesDir });
    expect(await titleAt(second, "work", "/")).toBe("session=alice");
    expect(await titleAt(second, "default", "/")).toBe("no cookie");
    expect(await titleAt(second, "incognito", "/")).toBe("no cookie");
    await second.clearProfile("work");
    expect(await titleAt(second, "work", "/")).toBe("no cookie");
    await second.close();
  });
});
