import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { AUTH_VERIFIER_CAPABILITY, type AuthVerifier, type Principal } from "@jhin/auth-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";

/** The single owner of a node (D22): every permission. */
const OWNER: Principal = { id: "owner", permissions: ["*"] };

const newToken = () => Crypto.randomBytes(32).toString("base64url");

function writeToken(file: string, token: string): void {
  Fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  Fs.chmodSync(file, 0o600);
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && Crypto.timingSafeEqual(a, b);
}

export default definePlugin({
  activate(context) {
    const file = Path.join(
      context.services.get<HostPaths>(HOST_PATHS_CAPABILITY).dataDir(context.plugin.id),
      "token",
    );
    let token: string;
    if (Fs.existsSync(file)) {
      token = Fs.readFileSync(file, "utf8").trim();
    } else {
      token = newToken();
      writeToken(file, token);
      // Printed once, when created; afterwards `jhin auth.token.show` prints it.
      process.stderr.write(
        `jhin: created the access token for this node: ${token}\n      (stored in ${file})\n`,
      );
      context.log.warn("access token created", { file });
    }

    const verifier: AuthVerifier = {
      async verify(credentials) {
        return credentials.token !== undefined && sameToken(credentials.token, token)
          ? OWNER
          : undefined;
      },
    };
    context.services.provide(AUTH_VERIFIER_CAPABILITY, verifier);

    context.commands.register({
      name: "auth.token.show",
      description: "Prints this node's access token",
      input: z.object({}),
      output: z.object({ token: z.string(), file: z.string() }),
      permissions: ["auth.admin"],
      handler: () => ({ token, file }),
    });
    context.commands.register({
      name: "auth.token.rotate",
      description: "Replaces the access token; new connections need the new one",
      input: z.object({}),
      output: z.object({ token: z.string() }),
      permissions: ["auth.admin"],
      handler: () => {
        token = newToken();
        writeToken(file, token);
        context.log.warn("access token rotated", { file });
        return { token };
      },
    });
  },
});
