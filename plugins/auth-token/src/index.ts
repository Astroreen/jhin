import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { AUTH_VERIFIER_CAPABILITY, type AuthVerifier, type Principal } from "@jhin/auth-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { definePlugin, z } from "@jhin/sdk";

/** The single owner of a node (D22): every permission. */
const OWNER: Principal = { id: "owner", permissions: ["*"] };

/** 32 random bytes in base64url are 43 characters; anything shorter is not a token we made. */
const MIN_TOKEN_LENGTH = 43;

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
    const existing = Fs.existsSync(file) ? Fs.readFileSync(file, "utf8").trim() : "";
    let token: string;
    if (existing.length >= MIN_TOKEN_LENGTH) {
      token = existing;
    } else {
      // A missing, empty or truncated file never becomes a guessable token.
      token = newToken();
      writeToken(file, token);
      // Printed once, when created; afterwards `jhin auth.token.show` prints it.
      process.stderr.write(
        `jhin: created the access token for this node: ${token}\n      (stored in ${file})\n`,
      );
      context.log.warn("access token created", { file, replacedInvalid: existing.length > 0 });
    }

    const verifier: AuthVerifier = {
      async verify(credentials) {
        const given = credentials.token;
        return given !== undefined && given.length >= MIN_TOKEN_LENGTH && sameToken(given, token)
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
      description:
        "Replaces the access token; open connections are dropped and must reconnect with the new one",
      input: z.object({}),
      output: z.object({ token: z.string() }),
      permissions: ["auth.admin"],
      handler: () => {
        token = newToken();
        writeToken(file, token);
        context.log.warn("access token rotated", { file });
        // Transports drop connections opened with the old token.
        context.events.emit("auth.token.rotated", {});
        return { token };
      },
    });
  },
});
