#!/usr/bin/env node
// A stand-in `opencode` executable for tests (D339): `--version` prints
// FAKE_OPENCODE_VERSION, `serve` records its arguments and password in
// FAKE_OPENCODE_LOG, prints the URL of the fake server the test runs
// (FAKE_OPENCODE_URL) as OpenCode prints its own, and runs until stopped.
import * as Fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(`opencode v${process.env.FAKE_OPENCODE_VERSION ?? "2.0.29"}`);
  process.exit(0);
}
if (args[0] === "serve") {
  Fs.writeFileSync(
    process.env.FAKE_OPENCODE_LOG,
    JSON.stringify({
      args,
      password: process.env.OPENCODE_PASSWORD,
      inherited: process.env.OPENCODE_SERVER_PASSWORD ?? null,
    }),
  );
  console.log(`server listening on ${process.env.FAKE_OPENCODE_URL}`);
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else {
  console.error(`unexpected arguments: ${args.join(" ")}`);
  process.exit(2);
}
