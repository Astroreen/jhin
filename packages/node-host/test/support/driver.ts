// Runs a node host in a real Node process for tests. Vitest's module runner
// intercepts import(), which would bypass the host's Node resolve hooks.
//
// stdout, one JSON object per line:
//   {"type":"ready","inspection":{...}}
//   {"type":"event","event":{"type":"kernel.plugin.reloaded","payload":{...}}}
//   {"type":"result","id":1,"value":...} | {"type":"result","id":1,"error":{...}}
// stdin, one JSON object per line:
//   {"id":1,"command":"example.greet","input":{"name":"Ada"}}
//   {"id":2,"stop":true}
import * as Readline from "node:readline";

import { startNodeHost } from "../../src/index.ts";

const options = JSON.parse(process.argv[2] ?? "{}");
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const host = await startNodeHost(options);
host.kernel.events.onAny((event) => send({ type: "event", event }));
send({ type: "ready", inspection: host.inspect() });

for await (const line of Readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as {
    id: number;
    command?: string;
    input?: unknown;
    stop?: boolean;
  };
  if (request.stop === true) {
    await host.stop();
    send({ type: "result", id: request.id, value: null });
    break;
  }
  try {
    send({
      type: "result",
      id: request.id,
      value: await host.kernel.commands.execute(request.command!, request.input ?? {}),
    });
  } catch (error) {
    const info = error as { code?: string; message?: string };
    send({ type: "result", id: request.id, error: { code: info.code, message: info.message } });
  }
}
process.exit(0);
